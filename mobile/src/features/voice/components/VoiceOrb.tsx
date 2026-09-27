import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import type { VartaState } from '../useVarta';

/**
 * The VARTA orb.
 *
 * Transcribed from `.voice-orb` and its state classes in
 * twin-app/css/styles.css, with the cyan ramp that app-theme.css layers over
 * them. The web's base stylesheet paints the orb blue, red and green for the
 * three states and the theme then overrides all three to stay inside
 * MoneyKal's black/white/cyan palette — so the cyan values are the ones that
 * ship, and they are what is reproduced here.
 *
 * The colours are fixed rather than themed, which matches the web: the overlay
 * sets its own near-black ground (`rgba(10,10,12,0.95)`) regardless of the
 * light/dark toggle, so VARTA is a dark stage on both.
 *
 * Animation uses React Native's own `Animated` rather than Reanimated, which
 * is in the project but not yet used by any screen. Every motion here is a
 * transform or an opacity, all of which the native driver handles off the JS
 * thread, so the heavier dependency would buy nothing and would make this the
 * first screen to depend on the worklets Babel plugin being configured.
 */

const ORB_SIZE = 140;
const CONTAINER = 200;
/** `ripple` grows the ring from 140px to 300px. */
const RIPPLE_SCALE = 300 / ORB_SIZE;

/** The three gradients, as `radial-gradient(circle at X% Y%, from, to)`. */
const GRADIENTS: Record<VartaState, { fx: string; fy: string; from: string; to: string }> = {
  idle: { fx: '30%', fy: '30%', from: '#d7fbff', to: '#00e5ff' },
  listening: { fx: '30%', fy: '30%', from: '#d7fbff', to: '#00e5ff' },
  processing: { fx: '50%', fy: '0%', from: '#ffffff', to: '#00b8cc' },
  speaking: { fx: '70%', fy: '30%', from: '#eafdff', to: '#00c8dc' },
};

/** The `box-shadow` glow, drawn as a fading halo because React Native has no
 *  coloured outer shadow that works the same way on both platforms. */
const GLOW_OPACITY: Record<VartaState, number> = {
  idle: 0.4,
  listening: 0.4,
  processing: 0.45,
  speaking: 0.6,
};

const RING_COLOR = 'rgba(0,229,255,0.5)';

interface Props {
  state: VartaState;
}

export function VoiceOrb({ state }: Props) {
  /* Scale is shared by three different behaviours — breathing while
     listening, the dip inside the processing spin, and the speaking pulse —
     so each effect owns it exclusively and resets it on the way out. */
  const scale = useRef(new Animated.Value(1)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const ringA = useRef(new Animated.Value(0)).current;
  const ringB = useRef(new Animated.Value(0)).current;

  /* ------------------------------------------------------------ listening */
  useEffect(() => {
    if (state !== 'listening') return;

    // `orb-breathe`: 2s, alternating, 1 -> 1.05.
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.05,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    // `ripple`: 2s, linear-ish, the second ring offset by 1s exactly as the
    // `.delay` class does.
    const ripple = (value: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, {
            toValue: 1,
            duration: 2000,
            easing: Easing.bezier(0, 0.2, 0.8, 1),
            useNativeDriver: true,
          }),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      );

    const a = ripple(ringA, 0);
    const b = ripple(ringB, 1000);
    breathe.start();
    a.start();
    b.start();

    return () => {
      breathe.stop();
      a.stop();
      b.stop();
      scale.setValue(1);
      ringA.setValue(0);
      ringB.setValue(0);
    };
  }, [state, scale, ringA, ringB]);

  /* ----------------------------------------------------------- processing */
  useEffect(() => {
    if (state !== 'processing') return;

    // `orb-spin`: 1.5s linear, full turn, scaling to 0.95 at the halfway point.
    const rotate = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1500,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const dip = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 0.95,
          duration: 750,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 750,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]),
    );
    rotate.start();
    dip.start();

    return () => {
      rotate.stop();
      dip.stop();
      spin.setValue(0);
      scale.setValue(1);
    };
  }, [state, spin, scale]);

  /* ------------------------------------------------------------- speaking */
  useEffect(() => {
    if (state !== 'speaking') return;

    /* `startOrbPulseSimulation()` in voice.js: a fresh random scale between
       1.0 and 1.35 every 100ms. Reproduced rather than replaced — the web's
       pulse is not driven by the audio either, and matching it keeps the two
       clients recognisably the same product. Real amplitude data is available
       from expo-audio, but it would be a new behaviour, not this one. */
    const id = setInterval(() => {
      Animated.timing(scale, {
        toValue: 1 + Math.random() * 0.35,
        duration: 100,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }, 100);

    return () => {
      clearInterval(id);
      Animated.timing(scale, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
    };
  }, [state, scale]);

  /* ------------------------------------------------------------ idle rest */
  useEffect(() => {
    if (state !== 'idle') return;
    scale.setValue(1);
    spin.setValue(0);
    ringA.setValue(0);
    ringB.setValue(0);
  }, [state, scale, spin, ringA, ringB]);

  const gradient = GRADIENTS[state];

  const ringStyle = (value: Animated.Value) => ({
    position: 'absolute' as const,
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    borderWidth: 2,
    borderColor: RING_COLOR,
    opacity: value.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    transform: [
      { scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, RIPPLE_SCALE] }) },
    ],
  });

  return (
    <View
      style={{
        width: CONTAINER,
        height: CONTAINER,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* Ripples sit behind the orb and only exist while listening. */}
      {state === 'listening' ? (
        <>
          <Animated.View style={ringStyle(ringA)} />
          <Animated.View style={ringStyle(ringB)} />
        </>
      ) : null}

      <Animated.View
        style={{
          transform: [
            { scale },
            {
              rotate: spin.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', '360deg'],
              }),
            },
          ],
        }}
      >
        <Svg width={CONTAINER} height={CONTAINER} viewBox={`0 0 ${CONTAINER} ${CONTAINER}`}>
          <Defs>
            <RadialGradient id="orb" cx="50%" cy="50%" r="50%" fx={gradient.fx} fy={gradient.fy}>
              <Stop offset="0%" stopColor={gradient.from} />
              <Stop offset="100%" stopColor={gradient.to} />
            </RadialGradient>
            {/* Stands in for `box-shadow: 0 0 Npx rgba(0,229,255,α)`. */}
            <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
              <Stop offset="55%" stopColor="#00e5ff" stopOpacity={GLOW_OPACITY[state]} />
              <Stop offset="100%" stopColor="#00e5ff" stopOpacity={0} />
            </RadialGradient>
          </Defs>

          <Circle cx={CONTAINER / 2} cy={CONTAINER / 2} r={CONTAINER / 2} fill="url(#glow)" />
          <Circle cx={CONTAINER / 2} cy={CONTAINER / 2} r={ORB_SIZE / 2} fill="url(#orb)" />
        </Svg>
      </Animated.View>
    </View>
  );
}
