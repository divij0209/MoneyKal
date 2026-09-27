import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The sidebar icons from twin-app/dashboard.html, transcribed to react-native-svg.
 *
 * Same 20x20 viewBox, same paths, same 1.4 stroke weight as the web markup, so
 * the tab bar reads as the same product as the desktop sidebar.
 */

export type IconName =
  | 'overview'
  | 'hisaab'
  | 'ask'
  | 'simulate'
  | 'alerts'
  | 'reports'
  | 'agents'
  | 'about'
  | 'more'
  | 'liveLife';

export interface TabIconProps {
  name: IconName;
  color: string;
  size?: number;
}

export function TabIcon({ name, color, size = 22 }: TabIconProps) {
  const stroke = color;
  const sw = 1.4;

  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      {name === 'overview' && (
        <>
          <Rect x="2.5" y="2.5" width="6" height="6" rx="1" stroke={stroke} strokeWidth={sw} />
          <Rect x="11.5" y="2.5" width="6" height="6" rx="1" stroke={stroke} strokeWidth={sw} />
          <Rect x="2.5" y="11.5" width="6" height="6" rx="1" stroke={stroke} strokeWidth={sw} />
          <Rect x="11.5" y="11.5" width="6" height="6" rx="1" stroke={stroke} strokeWidth={sw} />
        </>
      )}

      {name === 'hisaab' && (
        <>
          <Rect x="2.5" y="4" width="15" height="12" rx="1.5" stroke={stroke} strokeWidth={sw} />
          <Path d="M2.5 8h15M6 12h4" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        </>
      )}

      {name === 'ask' && (
        <Path
          d="M3 4.5h14v9H8.5L5 16.5v-3H3v-9Z"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
      )}

      {name === 'simulate' && (
        <>
          <Path d="M3 6h14M3 10h14M3 14h9" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
          <Circle cx="8" cy="6" r="1.6" fill={stroke} />
          <Circle cx="13" cy="10" r="1.6" fill={stroke} />
          <Circle cx="6" cy="14" r="1.6" fill={stroke} />
        </>
      )}

      {name === 'alerts' && (
        <>
          <Path d="M10 2.5 17.5 16h-15L10 2.5Z" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
          <Path d="M10 8v3.5M10 13.5v.1" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        </>
      )}

      {name === 'reports' && (
        <>
          <Path d="M5 2.5h7l3 3v12H5v-15Z" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
          <Path d="M7.5 9h5M7.5 12h5M7.5 15h3" stroke={stroke} strokeWidth={1.2} strokeLinecap="round" />
        </>
      )}

      {name === 'agents' && (
        <>
          <Circle cx="6.5" cy="6.5" r="2.3" stroke={stroke} strokeWidth={sw} />
          <Circle cx="14" cy="6.5" r="2.3" stroke={stroke} strokeWidth={sw} />
          <Circle cx="10" cy="14" r="2.3" stroke={stroke} strokeWidth={sw} />
          <Path d="M8 8.3 8.6 11.6M12 8.3l-.6 3.3M8.5 6.5h3" stroke={stroke} strokeWidth={1.2} />
        </>
      )}

      {name === 'about' && (
        <>
          <Circle cx="10" cy="10" r="7" stroke={stroke} strokeWidth={sw} />
          <Path d="M10 9.2v4.3M10 6.8v.1" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        </>
      )}

      {name === 'more' && (
        <>
          <Circle cx="4.5" cy="10" r="1.5" fill={stroke} />
          <Circle cx="10" cy="10" r="1.5" fill={stroke} />
          <Circle cx="15.5" cy="10" r="1.5" fill={stroke} />
        </>
      )}

      {/* The live.life.fully portal glyph from the sidebar's .llf-portal__icon,
          scaled from its 24x24 viewBox to the 20x20 the others use. */}
      {name === 'liveLife' && (
        <>
          <Circle cx="10" cy="10" r="7.5" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
          <Path
            d="M13 7l-1.75 4.25L7 13l1.75-4.25z"
            stroke={stroke}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </Svg>
  );
}
