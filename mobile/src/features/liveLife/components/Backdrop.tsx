import React from 'react';
import { useWindowDimensions, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, RadialGradient, Stop } from 'react-native-svg';

import { BACKDROP_SKY } from '../constants';

/**
 * The ground behind live.life.fully.
 *
 * ONE still gradient and one soft glow. That is the whole file.
 *
 * What it replaces, and why:
 *
 *   - a 30MB looping `background.mp4`, decoded and crossfaded on every open;
 *   - a procedural scene layer with seeded parallax silhouettes;
 *   - fourteen drifting particles on an infinite animation;
 *   - six sky gradients rotating on an eleven-second beat.
 *
 * All of it went. The current web direction (see the header comment in
 * twin-app/css/live-life.css) asks for "a subtle premium glow instead of a
 * colorful AI aurora" and an experience that is "always cinematic dark" with
 * cyan as the resting accent. A decorative animation that never stops is also
 * the single most reliable way to make a financial product look like a demo,
 * and it burns battery for the entire time the screen is open.
 *
 * The result is calmer, starts instantly, ships nothing, and — because there
 * is no moving footage under it — lets the large off-white type on top stay
 * genuinely legible rather than merely legible-on-average.
 *
 * Rendered once and never re-rendered: it takes no props that change.
 */
export function Backdrop() {
  const { width, height } = useWindowDimensions();

  const [top, mid, horizon] = BACKDROP_SKY;

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="llf-sky" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={top} />
            <Stop offset="0.55" stopColor={mid} />
            <Stop offset="1" stopColor={horizon} />
          </LinearGradient>

          {/* The "subtle premium glow" — one soft cyan bloom low on the
              screen, well under the type. Not a light leak, not an aurora. */}
          <RadialGradient id="llf-glow" cx="50%" cy="100%" r="75%">
            <Stop offset="0" stopColor="#00e5ff" stopOpacity={0.16} />
            <Stop offset="1" stopColor="#00e5ff" stopOpacity={0} />
          </RadialGradient>
        </Defs>

        <Rect x={0} y={0} width={width} height={height} fill="url(#llf-sky)" />
        <Rect x={0} y={0} width={width} height={height} fill="url(#llf-glow)" />
      </Svg>
    </View>
  );
}
