import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { Text } from '../../components';
import { useTheme } from '../../theme';
import { DONUT_MAX_SLICES, abbrevINR, donutPalette, fmt } from './constants';
import type { StartupBreakdownItem } from '../../api/types';

/**
 * The dashboard's three chart forms, transcribed from `svgTrendChart`,
 * `svgDonutChart` and `svgProgressRing` in twin-app/js/startup.js.
 *
 * They draw values the backend computed; none of them derives a figure. The
 * only arithmetic is geometry — turning a number into a coordinate.
 *
 * Marks follow the shared spec: 2px lines, ~4px markers ringed in the surface
 * colour so overlapping points stay separable, a recessive grid, and a legend
 * carrying name + value + share so identity never rests on colour alone. The
 * web's SVG `<title>` hover has no equivalent here, which is exactly why the
 * donut legend prints the numbers rather than relying on a tooltip.
 */

/* ------------------------------------------------------------ trend chart */

export interface TrendSeries {
  label: string;
  color: string;
  points: (number | null)[];
  area?: boolean;
  dashed?: boolean;
}

interface TrendProps {
  series: TrendSeries[];
  xLabels: string[];
  currency: string;
  height?: number;
  /** A horizontal marker — the web uses this for the cash-out line. */
  refLine?: { value: number; label: string; color?: string } | null;
}

const PAD = { top: 14, right: 16, bottom: 26, left: 56 };
const VIEW_W = 600;

export function TrendChart({
  series,
  xLabels,
  currency,
  height = 200,
  refLine = null,
}: TrendProps) {
  const theme = useTheme();

  const allY: number[] = [];
  let maxLen = 0;
  for (const s of series) {
    for (const y of s.points) if (typeof y === 'number') allY.push(y);
    maxLen = Math.max(maxLen, s.points.length);
  }
  if (refLine) allY.push(refLine.value);

  // The web returns null rather than drawing a chart from a single point.
  if (!allY.length || maxLen < 2) return null;

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  const yMin = Math.min(0, ...allY);
  let yMax = Math.max(...allY);
  if (yMax === yMin) yMax = yMin + 1;
  yMax += (yMax - yMin) * 0.14; // headroom, as the web adds

  const xFor = (i: number) => PAD.left + (maxLen === 1 ? 0 : (i / (maxLen - 1)) * plotW);
  const yFor = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const GRID = 4;
  const gridLines = Array.from({ length: GRID + 1 }, (_, g) => {
    const val = yMin + (yMax - yMin) * (g / GRID);
    return { y: yFor(val), label: `${currency}${abbrevINR(val)}` };
  });

  const step = Math.max(1, Math.round(maxLen / Math.min(6, maxLen)));

  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${VIEW_W} ${height}`}>
      {gridLines.map((g, i) => (
        <G key={`g${i}`}>
          <Line
            x1={PAD.left}
            y1={g.y}
            x2={VIEW_W - PAD.right}
            y2={g.y}
            stroke={theme.colors.chartGrid}
            strokeWidth={1}
          />
          <SvgText
            x={PAD.left - 8}
            y={g.y + 3}
            textAnchor="end"
            fontSize={10}
            fill={theme.colors.chartAxis}
          >
            {g.label}
          </SvgText>
        </G>
      ))}

      {refLine ? (
        <G>
          <Line
            x1={PAD.left}
            y1={yFor(refLine.value)}
            x2={VIEW_W - PAD.right}
            y2={yFor(refLine.value)}
            stroke={refLine.color || theme.colors.statusCritical}
            strokeWidth={1.2}
            strokeDasharray="3,3"
          />
          <SvgText
            x={VIEW_W - PAD.right}
            y={yFor(refLine.value) - 4}
            textAnchor="end"
            fontSize={10}
            fill={refLine.color || theme.colors.statusCritical}
          >
            {refLine.label}
          </SvgText>
        </G>
      ) : null}

      {series.map((s, si) => {
        const coords = s.points.map((y, i) =>
          typeof y === 'number' ? ([xFor(i), yFor(y)] as [number, number]) : null,
        );

        let d = '';
        let started = false;
        let firstX: number | null = null;
        let lastX = 0;
        for (const c of coords) {
          if (!c) {
            started = false;
            continue;
          }
          d += `${started ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)} `;
          started = true;
          if (firstX === null) firstX = c[0];
          lastX = c[0];
        }

        const baselineY = yFor(Math.max(yMin, 0));

        return (
          <G key={`s${si}`}>
            {s.area && d && firstX !== null ? (
              <Path
                d={`${d}L${lastX.toFixed(1)},${baselineY.toFixed(1)} L${firstX.toFixed(1)},${baselineY.toFixed(1)} Z`}
                fill={s.color}
                opacity={0.12}
              />
            ) : null}
            {d ? (
              <Path
                d={d.trim()}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dashed ? '5,4' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {coords.map((c, i) =>
              c ? (
                <Circle
                  key={`p${i}`}
                  cx={c[0]}
                  cy={c[1]}
                  r={4}
                  fill={s.color}
                  stroke={theme.colors.surface}
                  strokeWidth={2}
                />
              ) : null,
            )}
          </G>
        );
      })}

      {xLabels.map((l, i) =>
        i % step === 0 && l ? (
          <SvgText
            key={`x${i}`}
            x={xFor(i)}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill={theme.colors.chartAxis}
          >
            {l}
          </SvgText>
        ) : null,
      )}
    </Svg>
  );
}

/** A legend row per series — required whenever more than one is plotted. */
export function ChartLegend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  const theme = useTheme();
  if (items.length < 2) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.lg }}>
      {items.map((it) => (
        <View key={it.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View
            style={{
              width: 14,
              height: it.dashed ? 0 : 3,
              borderRadius: 2,
              backgroundColor: it.dashed ? 'transparent' : it.color,
              borderTopWidth: it.dashed ? 2 : 0,
              borderStyle: it.dashed ? 'dashed' : 'solid',
              borderTopColor: it.color,
            }}
          />
          <Text variant="label" color="faint">
            {it.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ donut */

/**
 * The categorical donut.
 *
 * Capped at five slices plus an "Other" bucket, hues assigned in fixed order
 * and never cycled — both the web's rules. The legend always prints name,
 * amount and share, so a slice is identified by its label rather than by
 * telling two greys apart.
 */
export function DonutChart({
  items,
  currency,
  size = 140,
}: {
  items: StartupBreakdownItem[];
  currency: string;
  size?: number;
}) {
  const theme = useTheme();
  if (!items?.length) return null;

  const palette = donutPalette(theme.colors, theme.name);

  const sorted = [...items].sort((a, b) => b.amount - a.amount);
  const sliced = sorted.slice(0, DONUT_MAX_SLICES);
  const rest = sorted.slice(DONUT_MAX_SLICES);
  if (rest.length) {
    sliced.push({ category: 'Other', amount: rest.reduce((s, i) => s + i.amount, 0) });
  }

  const total = sliced.reduce((s, i) => s + i.amount, 0) || 1;
  const r = size / 2;
  const strokeW = size * 0.24;
  const rInner = r - strokeW / 2;
  // A 2px surface gap between segments, expressed as the web's angular gap.
  const gapDeg = sliced.length > 1 ? 2.5 : 0;

  let angle = -90;
  const slices = sliced.map((it, idx) => {
    const sweepFull = (it.amount / total) * 360;
    const sweep = Math.max(0, sweepFull - gapDeg);
    const a0 = (angle * Math.PI) / 180;
    const a1 = ((angle + sweep) * Math.PI) / 180;
    const seg = {
      key: `${it.category}-${idx}`,
      category: it.category,
      amount: it.amount,
      pct: (it.amount / total) * 100,
      color: palette[idx % palette.length],
      d: `M${(r + rInner * Math.cos(a0)).toFixed(2)},${(r + rInner * Math.sin(a0)).toFixed(2)} A${rInner.toFixed(2)},${rInner.toFixed(2)} 0 ${sweep > 180 ? 1 : 0} 1 ${(r + rInner * Math.cos(a1)).toFixed(2)},${(r + rInner * Math.sin(a1)).toFixed(2)}`,
    };
    angle += sweepFull;
    return seg;
  });

  return (
    <View style={{ gap: theme.spacing.md }}>
      <View style={{ alignItems: 'center' }}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {slices.map((s) => (
            <Path
              key={s.key}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={strokeW}
            />
          ))}
        </Svg>
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        {slices.map((s) => (
          <View
            key={`l-${s.key}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing.md,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <View
                style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: s.color }}
              />
              <Text variant="bodySmall" color="muted" numberOfLines={1} style={{ flex: 1 }}>
                {s.category}
              </Text>
            </View>
            <Text variant="bodySmall" tabular>
              {currency}
              {fmt(s.amount)} · {s.pct.toFixed(0)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ---------------------------------------------------------- progress ring */

export function ProgressRing({
  pct,
  color,
  size = 104,
  strokeW = 10,
  label,
}: {
  pct: number | null | undefined;
  color: string;
  size?: number;
  strokeW?: number;
  /** Overrides the "NN%" centre text — the health hero shows a raw score. */
  label?: string;
}) {
  const theme = useTheme();
  const r = (size - strokeW) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (circumference * clamped) / 100;
  const centre = label ?? (pct === null || pct === undefined ? '—' : `${Math.round(clamped)}%`);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={theme.colors.surface2}
          strokeWidth={strokeW}
        />
        <Circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeDasharray={`${dash.toFixed(1)} ${circumference.toFixed(1)}`}
          transform={`rotate(-90 ${c} ${c})`}
        />
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center' }}>
        <Text variant="mono" style={{ fontSize: size * 0.19 }}>
          {centre}
        </Text>
      </View>
    </View>
  );
}
