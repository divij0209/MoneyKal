import * as Linking from 'expo-linking';
import type { LinkingOptions } from '@react-navigation/native';

import { APP_SCHEME } from '../config/env';
import type { RootStackParamList } from './types';

/**
 * Deep links.
 *
 * The prefixes cover both shapes the app can be opened with: the custom
 * `moneykal://` scheme used by standalone builds, and whatever URL Expo Go
 * happens to be serving in development (`Linking.createURL('')` returns the
 * right one for the current runtime).
 *
 * The OAuth return trip is the reason this exists. The backend's Gmail
 * callback redirects a mobile-initiated flow to
 *
 *     moneykal://gmail/callback?status=success
 *
 * (backend/routers/gmail.py, `_return_url`). That path is not mapped to a
 * screen here on purpose: the flow is opened with expo-web-browser's auth
 * session, which resolves the redirect back to the caller directly, so routing
 * it as navigation as well would take the user somewhere they didn't ask to go
 * mid-flow. The prefix registration is what lets the OS hand control back to
 * the app at all.
 */
export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [Linking.createURL('/'), `${APP_SCHEME}://`],
  config: {
    screens: {
      App: {
        screens: {
          Tabs: {
            screens: {
              Home: 'home',
              Hisaab: 'hisaab',
              Ask: 'ask',
              Simulate: 'simulate',
            },
          },
          LiveLife: 'live-life',
          Settings: 'settings',
          /* The pushed screens that are destinations in their own right —
             each is something a notification, a shortcut or a support link
             would reasonably want to open directly. Voice is deliberately
             absent: it is a mode, and deep-linking into a live microphone
             session is not something a link should be able to do. */
          Tax: 'tax',
          Reports: 'reports',
          MarketPulse: 'market-pulse',
          Profile: 'profile',
        },
      },
    },
  },
};

/** The redirect URI handed to the backend when starting Gmail OAuth. Must
 *  match MOBILE_REDIRECT_SCHEME in the backend's .env. */
export const GMAIL_REDIRECT_URL = `${APP_SCHEME}://gmail/callback`;
