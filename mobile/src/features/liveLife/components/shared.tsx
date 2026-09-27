import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Text } from '../../../components';

/**
 * The pieces every live.life.fully section is built from.
 *
 * These use fixed light-on-dark colours rather than theme tokens, matching the
 * web: `#llf` is a full-screen overlay that sets its own dark ground and does
 * not follow the light/dark toggle. The experience is one place, and it looks
 * the same whichever theme the rest of the app is in.
 *
 * The ink is MoneyKal's own off-white (#F4F2EE) rather than pure white, so
 * this reads as the same product as the rest of the app rather than as a
 * separate one that happens to be dark.
 */

export const INK = '#F4F2EE';
export const INK_MUTED = 'rgba(244,242,238,0.70)';
export const INK_FAINT = 'rgba(244,242,238,0.46)';
export const HAIRLINE = 'rgba(244,242,238,0.13)';

/**
 * The panel fill.
 *
 * Was a translucent `rgba(12,14,20,0.58)` blur-over-scene — glassmorphism,
 * which the current direction drops. Now an opaque near-black: the backdrop
 * behind it is a still gradient, so there is nothing worth showing through,
 * and an opaque ground is what makes the type on it dependable.
 */
export const SURFACE = '#0c1014';

/** The one accent. MoneyKal cyan — see the note on BACKDROP_ACCENTS. */
export const ACCENT = '#00e5ff';

/**
 * The "needs care" tone.
 *
 * Warm sand, not amber or red. The palette is off-white, black and cyan; a
 * caution here has to be a neutral warmed slightly, and on this near-black
 * ground sand reads more clearly than the orange it replaces.
 */
export const SAND = '#E8C79A';

/** @deprecated Retained so no import breaks; points at the opaque fill. */
export const GLASS = SURFACE;

/** The web's `.llf-card` — a translucent panel over the scene. */
export function LlfCard({
  children,
  tint,
  style,
}: {
  children: React.ReactNode;
  /** `--llf-tint`: the stash or category accent, as a left rail. */
  tint?: string;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          gap: 10,
          padding: 18,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: tint ? `${tint}44` : HAIRLINE,
          backgroundColor: SURFACE,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {tint ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: tint,
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

/** The web's `.llf-sec__label` — the small caps label above each section. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      variant="label"
      style={{ color: INK_FAINT, letterSpacing: 1.2, textTransform: 'uppercase' }}
    >
      {children}
    </Text>
  );
}

/** The web's `.llf-chip`, in its three tones. */
export function LlfChip({
  label,
  tone = 'plain',
  accent,
}: {
  label: string;
  tone?: 'plain' | 'accent' | 'warn';
  accent?: string;
}) {
  const color =
    tone === 'accent' ? accent || ACCENT : tone === 'warn' ? SAND : INK_MUTED;
  return (
    <View
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tone === 'plain' ? HAIRLINE : `${color}55`,
        backgroundColor: tone === 'plain' ? 'transparent' : `${color}1f`,
      }}
    >
      <Text variant="label" style={{ color }}>
        {label}
      </Text>
    </View>
  );
}

export function LlfButton({
  label,
  onPress,
  variant = 'default',
  accent = ACCENT,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'default' | 'ghost';
  accent?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        paddingHorizontal: 16,
        paddingVertical: 11,
        borderRadius: 999,
        borderWidth: variant === 'ghost' ? 0 : 1,
        borderColor: variant === 'primary' ? accent : HAIRLINE,
        backgroundColor:
          variant === 'primary' ? `${accent}26` : variant === 'ghost' ? 'transparent' : 'rgba(244,242,238,0.05)',
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        variant="label"
        style={{ color: variant === 'primary' ? accent : INK_MUTED }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------ progress art */

/** `PROG_PATHS` in twin-app/js/live-life.js, verbatim. */
const PROG_PATHS: Record<string, string> = {
  flight: 'M 14 86 Q 200 2 386 58',
  road: 'M 16 92 C 118 92 88 26 200 26 S 296 86 386 86',
  wave: 'M 10 68 Q 57 26 104 68 T 198 68 T 292 68 T 386 68',
  trail: 'M 12 92 L 92 72 L 66 56 L 168 40 L 142 28 L 262 18 L 240 12 L 386 8',
};

/** `PROG_CAPTIONS`, verbatim. */
const PROG_CAPTIONS: Record<string, string> = {
  flight: 'Distance to your destination',
  road: 'How far down the road you are',
  wave: 'How close the wave is to shore',
  trail: 'How far up the trail you are',
};

/**
 * Rough path lengths in the 400×100 viewBox, used to drive the dash offset.
 *
 * The web measures the real length with `getTotalLength()` and then walks a
 * marker along it with `getPointAtLength()`. react-native-svg exposes neither
 * reliably, so the lengths are precomputed here and the travelling marker is
 * left out — the track, the accent fill, the percentage and the caption all
 * behave as they do on the web. An approximate length only shifts where the
 * fill stops by a pixel or two; the percentage shown is the backend's own.
 */
const PROG_LENGTHS: Record<string, number> = {
  flight: 404,
  road: 396,
  wave: 396,
  trail: 396,
};

export function ProgressArt({
  art,
  percentage,
  accent,
}: {
  art?: string | null;
  percentage?: number | null;
  accent: string;
}) {
  const kind = art && PROG_PATHS[art] ? art : 'road';
  const pct = Math.max(0, Math.min(percentage ?? 0, 100));
  const len = PROG_LENGTHS[kind];

  return (
    <View style={{ gap: 6 }}>
      <Text variant="heading" style={{ color: accent }}>
        {pct.toFixed(0)}%
      </Text>

      <Svg
        width="100%"
        height={64}
        viewBox="0 0 400 100"
        accessibilityLabel={`${pct.toFixed(0)} percent funded`}
      >
        <Path
          d={PROG_PATHS[kind]}
          stroke="rgba(244,242,238,0.18)"
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        />
        <Path
          d={PROG_PATHS[kind]}
          stroke={accent}
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${len}`}
          strokeDashoffset={len * (1 - pct / 100)}
        />
      </Svg>

      <Text variant="label" style={{ color: INK_FAINT }}>
        {PROG_CAPTIONS[kind]}
      </Text>
    </View>
  );
}
