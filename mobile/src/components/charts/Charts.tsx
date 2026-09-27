import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import { useTheme } from '../../theme';
import { Text } from '../primitives/Text';

/**
 * MoneyKal's charts.
 *
 * Three rules, and they are what keep these from looking like a component
 * library's defaults:
 *
 *  1. ONE HUE. Series separate by stepping the cyan's lightness and then the
 *     neutral ramp (`chartBlue → chartOrange → chartAqua → chartMagenta →
 *     chartYellow → chartViolet`, all of which are cyan-or-grey in this
 *     palette — see src/theme/tokens.ts). Never a categorical rainbow.
 *  2. NO CHART JUNK. No gridlines behind a sparkline, no axis box, no legend
 *     where a direct label fits, no value printed on every bar.
 *  3. ONE ENTRANCE, THEN STILL. Each chart animates once on mount and then
 *     holds. Nothing here loops.
 *
 * All four take pre-computed numbers and pre-formatted display strings. They
 * do no currency formatting — that is the server's job everywhere in this app.
 */

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Entrance timing shared by every chart, so they feel like one family. */
const ENTER_MS = 620;
const EASE = Easing.out(Easing.cubic);

function useEnter(deps: unknown[] = []) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: ENTER_MS,
      easing: EASE,
      // Stroke/geometry interpolation cannot run on the native driver.
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return progress;
}

/* ========================================================================== *
 * Sparkline — a trend, with no axes at all.
 * ========================================================================== */

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Fills the area under the line with a fading wash. */
  filled?: boolean;
  /** Marks the final point. Use when the chart is about "where it ended". */
  showEndDot?: boolean;
  strokeWidth?: number;
  style?: ViewStyle;
}

export function Sparkline({
  data,
  width = 120,
  height = 40,
  color,
  filled = true,
  showEndDot = true,
  strokeWidth = 2,
  style,
}: SparklineProps) {
  const theme = useTheme();
  const stroke = color ?? theme.colors.accent;
  const progress = useEnter([data.length, width, height]);

  if (!data || data.length < 2) {
    return <View style={[{ width, height }, style]} />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = strokeWidth;
  const innerH = height - pad * 2;

  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = pad + innerH - ((value - min) / span) * innerH;
    return { x, y };
  });

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = points[points.length - 1];

  // A dash offset animated from the full path length to zero draws the line on.
  const approxLength = points.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const prev = points[i - 1];
    return sum + Math.hypot(p.x - prev.x, p.y - prev.y);
  }, 0);

  const gradientId = `spark-${Math.round(width)}-${Math.round(height)}`;

  return (
    <View style={[{ width, height }, style]}>
      <Svg width={width} height={height}>
        {filled ? (
          <>
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={stroke} stopOpacity={0.22} />
                <Stop offset="1" stopColor={stroke} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <AnimatedPath d={area} fill={`url(#${gradientId})`} opacity={progress} />
          </>
        ) : null}

        <AnimatedPath
          d={line}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={approxLength}
          strokeDashoffset={progress.interpolate({
            inputRange: [0, 1],
            outputRange: [approxLength, 0],
          })}
        />

        {showEndDot ? (
          <AnimatedCircle
            cx={last.x}
            cy={last.y}
            r={strokeWidth + 1}
            fill={stroke}
            opacity={progress}
          />
        ) : null}
      </Svg>
    </View>
  );
}

/* ========================================================================== *
 * Donut — a composition, with the total in the middle.
 * ========================================================================== */

export interface DonutSlice {
  label: string;
  value: number;
  /** Pre-formatted, e.g. "₹28,450" or "32%". */
  display?: string;
  color?: string;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  /** Big text in the hole. */
  centerValue?: string;
  centerLabel?: string;
  style?: ViewStyle;
}

export function DonutChart({
  slices,
  size = 168,
  thickness = 22,
  centerValue,
  centerLabel,
  style,
}: DonutChartProps) {
  const theme = useTheme();
  const progress = useEnter([slices.length, size]);

  const ramp = [
    theme.colors.chartBlue,
    theme.colors.chartOrange,
    theme.colors.chartAqua,
    theme.colors.chartMagenta,
    theme.colors.chartYellow,
    theme.colors.chartViolet,
  ];

  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let offset = 0;
  const arcs = slices.map((slice, i) => {
    const fraction = total > 0 ? Math.max(0, slice.value) / total : 0;
    const arc = { slice, fraction, offset, color: slice.color ?? ramp[i % ramp.length] };
    offset += fraction;
    return arc;
  });

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size}>
        {/* Track, so a partial composition still reads as a ring. */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={theme.colors.ringTrack}
          strokeWidth={thickness}
          fill="none"
        />
        <G rotation={-90} origin={`${center}, ${center}`}>
          {arcs.map((arc, i) => (
            <AnimatedCircle
              key={`${arc.slice.label}-${i}`}
              cx={center}
              cy={center}
              r={radius}
              stroke={arc.color}
              strokeWidth={thickness}
              strokeLinecap="butt"
              fill="none"
              strokeDasharray={`${circumference * arc.fraction} ${circumference}`}
              strokeDashoffset={progress.interpolate({
                inputRange: [0, 1],
                outputRange: [circumference, -circumference * arc.offset],
              })}
            />
          ))}
        </G>
      </Svg>

      {centerValue || centerLabel ? (
        <View
          pointerEvents="none"
          style={{
            ...({ position: 'absolute' } as const),
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: thickness,
          }}
        >
          {centerValue ? (
            <Text
              variant="metricSmall"
              tabular
              center
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {centerValue}
            </Text>
          ) : null}
          {centerLabel ? (
            <Text variant="label" color="faint" center numberOfLines={2}>
              {centerLabel}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The legend that goes with a donut. Rows, not chips — a row can carry a
 *  value, which is what makes the legend worth its space. */
export function DonutLegend({ slices }: { slices: DonutSlice[] }) {
  const theme = useTheme();
  const ramp = [
    theme.colors.chartBlue,
    theme.colors.chartOrange,
    theme.colors.chartAqua,
    theme.colors.chartMagenta,
    theme.colors.chartYellow,
    theme.colors.chartViolet,
  ];

  return (
    <View style={{ gap: theme.spacing.md }}>
      {slices.map((slice, i) => (
        <View
          key={`${slice.label}-${i}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: slice.color ?? ramp[i % ramp.length],
            }}
          />
          <Text variant="bodySmall" color="muted" numberOfLines={1} style={{ flex: 1 }}>
            {slice.label}
          </Text>
          {slice.display ? (
            <Text variant="bodySmall" tabular style={{ fontFamily: theme.fonts.bodyMedium }}>
              {slice.display}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/* ========================================================================== *
 * Bars — a comparison across a small number of periods or categories.
 * ========================================================================== */

export interface BarDatum {
  label: string;
  value: number;
  /** Draws in the accent rather than the neutral. For "this month", "today". */
  highlight?: boolean;
}

export interface BarChartProps {
  data: BarDatum[];
  height?: number;
  /** Shown above the tallest bar, e.g. the max value. */
  showBaseline?: boolean;
  style?: ViewStyle;
}

export function BarChart({ data, height = 120, showBaseline = true, style }: BarChartProps) {
  const theme = useTheme();
  const progress = useEnter([data.length, height]);

  if (!data.length) return <View style={[{ height }, style]} />;

  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const labelH = 18;
  const plotH = height - labelH;

  return (
    <View style={style}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: plotH, gap: 6 }}>
        {data.map((d, i) => {
          const ratio = Math.abs(d.value) / max;
          return (
            <View key={`${d.label}-${i}`} style={{ flex: 1, justifyContent: 'flex-end' }}>
              <Animated.View
                style={{
                  height: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, Math.max(2, ratio * plotH)],
                  }),
                  borderRadius: theme.radius.sm,
                  backgroundColor: d.highlight
                    ? theme.colors.accent
                    : theme.colors.chartGrid,
                  borderWidth: d.highlight ? 0 : 1,
                  borderColor: theme.colors.line,
                }}
              />
            </View>
          );
        })}
      </View>

      {showBaseline ? (
        <View
          style={{
            height: 1,
            backgroundColor: theme.colors.line,
            marginTop: 4,
          }}
        />
      ) : null}

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
        {data.map((d, i) => (
          <View key={`${d.label}-label-${i}`} style={{ flex: 1 }}>
            <Text
              variant="label"
              center
              numberOfLines={1}
              style={{
                fontSize: 9,
                letterSpacing: 0.4,
                color: d.highlight ? theme.colors.accent : theme.colors.inkFaint,
              }}
            >
              {d.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ========================================================================== *
 * Bar meter — one horizontal bar in a list. The "category spend" row.
 * ========================================================================== */

export interface BarMeterProps {
  /** 0-1. */
  fraction: number;
  color?: string;
  height?: number;
  style?: ViewStyle;
}

export function BarMeter({ fraction, color, height = 5, style }: BarMeterProps) {
  const theme = useTheme();
  const progress = useEnter([fraction]);
  const clamped = Math.max(0, Math.min(Number.isFinite(fraction) ? fraction : 0, 1));

  return (
    <View
      style={[
        {
          height,
          borderRadius: height / 2,
          backgroundColor: theme.colors.ringTrack,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <Animated.View
        style={{
          height: '100%',
          borderRadius: height / 2,
          backgroundColor: color ?? theme.colors.accent,
          width: progress.interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', `${clamped * 100}%`],
          }),
        }}
      />
    </View>
  );
}

/* ========================================================================== *
 * Regime bars — the paired old-vs-new comparison the Tax screen needs.
 * ========================================================================== */

export interface ComparisonBarsProps {
  left: { label: string; value: number; display: string };
  right: { label: string; value: number; display: string };
  /** Which side wins. Drawn in the accent; the other stays neutral. */
  winner: 'left' | 'right';
  style?: ViewStyle;
}

export function ComparisonBars({ left, right, winner, style }: ComparisonBarsProps) {
  const theme = useTheme();
  const progress = useEnter([left.value, right.value]);
  const max = Math.max(left.value, right.value, 1);

  const rows = [
    { ...left, isWinner: winner === 'left' },
    { ...right, isWinner: winner === 'right' },
  ];

  return (
    <View style={[{ gap: theme.spacing.lg }, style]}>
      {rows.map((row) => (
        <View key={row.label} style={{ gap: theme.spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm }}>
            <Text
              variant="bodySmall"
              style={{
                flex: 1,
                fontFamily: row.isWinner ? theme.fonts.bodySemiBold : theme.fonts.body,
                color: row.isWinner ? theme.colors.ink : theme.colors.inkMuted,
              }}
              numberOfLines={1}
            >
              {row.label}
            </Text>
            <Text
              variant="metricSmall"
              tabular
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              style={{ color: row.isWinner ? theme.colors.accent : theme.colors.inkMuted }}
            >
              {row.display}
            </Text>
          </View>

          <View
            style={{
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.colors.ringTrack,
              overflow: 'hidden',
            }}
          >
            <Animated.View
              style={{
                height: '100%',
                borderRadius: 4,
                backgroundColor: row.isWinner ? theme.colors.accent : theme.colors.lineStrong,
                width: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', `${(row.value / max) * 100}%`],
                }),
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

/* ========================================================================== *
 * Slab ladder — the tax slab breakdown, as a stack rather than a table.
 * ========================================================================== */

export interface SlabRow {
  band: string;
  rate: string;
  taxable: string;
  tax: string;
  /** 0-1 share of the total tax this band contributed. */
  share: number;
  active: boolean;
}

export function SlabLadder({ rows }: { rows: SlabRow[] }) {
  const theme = useTheme();

  return (
    <View>
      {rows.map((row, i) => (
        <View
          key={`${row.band}-${i}`}
          style={{
            paddingVertical: theme.spacing.md,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: theme.colors.line,
            opacity: row.active ? 1 : 0.45,
            gap: theme.spacing.sm,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
            <Text variant="bodySmall" style={{ flex: 1 }} numberOfLines={1}>
              {row.band}
            </Text>
            <Text variant="label" color="faint">
              {row.rate}
            </Text>
            <Text
              variant="bodySmall"
              tabular
              style={{ fontFamily: theme.fonts.bodySemiBold, minWidth: 72, textAlign: 'right' }}
              numberOfLines={1}
            >
              {row.tax}
            </Text>
          </View>
          {row.active ? <BarMeter fraction={row.share} height={4} /> : null}
        </View>
      ))}
    </View>
  );
}

/* ========================================================================== *
 * Axis-less grouped columns — income vs expense per period.
 * ========================================================================== */

export interface FlowDatum {
  label: string;
  income: number;
  expense: number;
}

export function FlowChart({
  data,
  height = 140,
  style,
}: {
  data: FlowDatum[];
  height?: number;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const progress = useEnter([data.length, height]);

  if (!data.length) return <View style={[{ height }, style]} />;

  const max = Math.max(...data.flatMap((d) => [d.income, d.expense]), 1);
  const labelH = 18;
  const plotH = height - labelH;

  return (
    <View style={style}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: plotH, gap: 10 }}>
        {data.map((d, i) => (
          <View
            key={`${d.label}-${i}`}
            style={{ flex: 1, flexDirection: 'row', gap: 3, alignItems: 'flex-end' }}
          >
            {(
              [
                { key: 'in', value: d.income, color: theme.colors.accent },
                { key: 'out', value: d.expense, color: theme.colors.lineStrong },
              ] as const
            ).map((bar) => (
              <View key={bar.key} style={{ flex: 1, justifyContent: 'flex-end' }}>
                <Animated.View
                  style={{
                    height: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, Math.max(2, (bar.value / max) * plotH)],
                    }),
                    borderTopLeftRadius: 3,
                    borderTopRightRadius: 3,
                    backgroundColor: bar.color,
                  }}
                />
              </View>
            ))}
          </View>
        ))}
      </View>

      <View style={{ height: 1, backgroundColor: theme.colors.line, marginTop: 4 }} />

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        {data.map((d, i) => (
          <View key={`${d.label}-l-${i}`} style={{ flex: 1 }}>
            <Text
              variant="label"
              center
              numberOfLines={1}
              style={{ fontSize: 9, letterSpacing: 0.4 }}
              color="faint"
            >
              {d.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The two-swatch key that goes under a FlowChart. */
export function FlowLegend({ inLabel, outLabel }: { inLabel: string; outLabel: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
      {[
        { label: inLabel, color: theme.colors.accent },
        { label: outLabel, color: theme.colors.lineStrong },
      ].map((item) => (
        <View
          key={item.label}
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}
        >
          <View
            style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color }}
          />
          <Text variant="label" color="faint">
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A thin vertical rule used to separate paired stats. */
export function StatRule() {
  const theme = useTheme();
  return (
    <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: theme.colors.line }} />
  );
}

/** Re-exported so screens can draw a bare axis line without importing Svg. */
export { Svg, Line, Path };
