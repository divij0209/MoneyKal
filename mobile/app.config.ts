import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * MoneyKal — Expo app configuration.
 *
 * This file runs in Node at build/start time, so `process.env` is genuinely
 * available here. Reading the API URL at *this* layer rather than relying on
 * bundler inlining is deliberate: the value lands in `extra`, and the app
 * reads it back through expo-constants. One resolution path, no surprises
 * between dev, preview and production builds.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'MoneyKal',
  slug: 'moneykal',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  // The app follows the device theme by default, exactly as the web app does
  // when no explicit choice has been stored.
  userInterfaceStyle: 'automatic',
  // The OAuth return trip depends on this. `moneykal://gmail/callback` is what
  // backend/routers/gmail.py redirects a mobile-initiated flow to.
  scheme: 'moneykal',
  assetBundlePatterns: ['**/*'],

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.zenith.moneykal',
    infoPlist: {
      // Set here rather than left to the expo-image-picker config plugin.
      // In expo-image-picker@57.0.14 the plugin calls
      //   IOSConfig.Permissions.createPermissionsPlugin({...})(config, {...})
      // and throws the return value away instead of reassigning `config`, so
      // the usage strings never reach Info.plist. iOS terminates an app that
      // touches the camera without NSCameraUsageDescription, which would be a
      // crash on a real device rather than a prompt. Declaring them here is
      // authoritative and unaffected by that bug.
      NSCameraUsageDescription:
        'MoneyKal uses the camera so you can scan a receipt into Hisaab.',
      NSPhotoLibraryUsageDescription:
        'MoneyKal reads receipts from your photos so you can add them to Hisaab.',
      // VARTA. Declared here as well as through the expo-audio plugin below:
      // iOS terminates an app that starts an AVAudioSession recording route
      // without NSMicrophoneUsageDescription, and the camera strings above
      // are already set this way because a plugin dropped them once.
      NSMicrophoneUsageDescription:
        'MoneyKal uses the microphone so you can ask VARTA a question out loud.',
      // Declared here as well as via the expo-local-authentication plugin, for
      // the same reason the camera strings are: iOS terminates an app that
      // reaches Face ID without a usage string.
      NSFaceIDUsageDescription:
        'MoneyKal uses Face ID to unlock the app without typing your passcode.',
    },
  },

  android: {
    package: 'com.zenith.moneykal',
    adaptiveIcon: {
      backgroundColor: '#000000',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // CAMERA is declared here because expo-image-picker's config plugin never
    // adds it. On Android that plugin only adds RECORD_AUDIO, and it *blocks*
    // CAMERA when `cameraPermission: false` — it has no path that grants it
    // (node_modules/expo-image-picker/plugin/build/withImagePicker.js). Expo Go
    // hid this, because Expo Go's own manifest already declares CAMERA. A
    // development or standalone build has no such luck: without this line
    // requestCameraPermissionsAsync() in Hisaab's ReceiptScanner is denied
    // before the OS ever shows a prompt, and "Scan a receipt" silently fails.
    // `android.permissions` unions with what plugins add, so nothing is lost.
    permissions: ['android.permission.CAMERA'],
    // NOTE: local development talks to the FastAPI dev server over plain HTTP.
    // Expo Go and debug builds already permit cleartext, so nothing is needed
    // here today. A *release* standalone build pointed at an http:// host would
    // need `expo-build-properties` with android.usesCleartextTraffic — but the
    // right fix then is an https backend, not a relaxed app.
  },

  web: {
    favicon: './assets/favicon.png',
  },

  plugins: [
    [
      'expo-splash-screen',
      {
        // MoneyKal's dark ground and cyan accent, so the very first frame is
        // already the product rather than a white flash.
        backgroundColor: '#000000',
        image: './assets/splash-icon.png',
        imageWidth: 180,
        resizeMode: 'contain',
        dark: {
          backgroundColor: '#000000',
          image: './assets/splash-icon.png',
        },
      },
    ],
    'expo-secure-store',
    'expo-font',
    // The native date picker used by the goal and upcoming-payment sheets.
    '@react-native-community/datetimepicker',
    [
      // Biometric unlock for the MoneyKal passcode. The passcode always
      // remains the fallback, so a device without enrolled biometrics loses
      // nothing.
      'expo-local-authentication',
      {
        faceIDPermission: 'MoneyKal uses Face ID to unlock the app without typing your passcode.',
      },
    ],
    [
      // VARTA's microphone. `expo-audio` adds RECORD_AUDIO on Android and the
      // usage string on iOS.
      //
      // Background modes stay OFF deliberately. VARTA is a foreground
      // conversation: you look at the orb while you talk to it. Enabling
      // background audio would add a UIBackgroundModes entry that App Review
      // asks you to justify, in exchange for a capability the feature does
      // not have on the web either.
      'expo-audio',
      {
        microphonePermission:
          'MoneyKal uses the microphone so you can ask VARTA a question out loud.',
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      // Hisaab's receipt scanning. The prompts say what the access is for —
      // a bare "MoneyKal would like to use your camera" tells the user
      // nothing about why, and iOS review expects a real reason.
      'expo-image-picker',
      {
        cameraPermission: 'MoneyKal uses the camera so you can scan a receipt into Hisaab.',
        photosPermission:
          'MoneyKal reads receipts from your photos so you can add them to Hisaab.',
      },
    ],
  ],

  experiments: {
    // Lets `@/...` imports in tsconfig.json resolve through Metro too.
    tsconfigPaths: true,
  },

  extra: {
    /**
     * Base URL of the existing FastAPI backend.
     *
     * An empty string — never null — when the env var is absent. Expo
     * serialises this config to JSON, and a `null` here comes back from
     * expo-constants as `{}`, which is truthy and has no string methods. The
     * empty string is falsy and is still a string, so the reader in
     * src/config/env.ts can treat it uniformly.
     *
     * Empty means "not configured", and the app then derives the host from the
     * Expo dev server it was loaded from — the right answer on a physical
     * device with nothing to edit. See src/config/env.ts.
     */
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
    apiPort: process.env.EXPO_PUBLIC_API_PORT ?? '8000',

    /**
     * Which EAS profile produced this build ('' for a local `expo start`).
     *
     * Read by src/config/env.ts to decide whether Settings may re-point the
     * API base URL at runtime. Development and preview builds get that
     * convenience; a production build must not, because a switch that
     * redirects authenticated requests to an arbitrary host would hand a
     * user's bearer token to whoever chose the address.
     */
    easBuildProfile: process.env.EAS_BUILD_PROFILE ?? '',

    /**
     * Links this config to the EAS project @divij0209/moneykal.
     *
     * `eas build:configure` writes this automatically into a static app.json,
     * but it cannot edit a dynamic config, so it is set by hand here. The value
     * is the project ID EAS issued and must match the `slug` above.
     */
    eas: {
      projectId: '84950e06-b6a1-4831-a6a5-a0614c3cee34',
    },
  },
});
