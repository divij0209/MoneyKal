import React from 'react';
import Svg, { Circle, Path, Polyline, Rect } from 'react-native-svg';

/**
 * The Daily Home icon set, transcribed from the `ICONS` map in
 * twin-app/js/home.js.
 *
 * Same 24x24 viewBox, same paths, same 1.7 stroke weight, so a section reads
 * identically on both clients. No icon library is used — introducing one would
 * bring in a visual vocabulary MoneyKal does not have.
 */

export type GlyphName =
  | 'wallet'
  | 'trend'
  | 'piggy'
  | 'spark'
  | 'calendar'
  | 'target'
  | 'plus'
  | 'chevronLeft'
  | 'chevronRight'
  | 'arrowRight'
  | 'close'
  | 'external'
  | 'mic'
  | 'stop'
  /* Added for the Home action row and the More hub. Traced from the same
     sidebar glyph set in twin-app/dashboard.html so they match the tab bar. */
  | 'receipt'
  | 'ledger'
  | 'simulate'
  | 'chat'
  | 'settings'
  | 'report';

export interface GlyphProps {
  name: GlyphName;
  color: string;
  size?: number;
  strokeWidth?: number;
}

export function Glyph({ name, color, size = 18, strokeWidth = 1.7 }: GlyphProps) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {name === 'wallet' && (
        <>
          <Path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5z" {...common} />
          <Path d="M3 8h18" {...common} />
          <Circle cx="17" cy="12.5" r="1.2" fill={color} />
        </>
      )}

      {name === 'trend' && (
        <>
          <Polyline points="3 17 9 11 13 15 21 7" {...common} />
          <Polyline points="15 7 21 7 21 13" {...common} />
        </>
      )}

      {name === 'piggy' && (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6h4" {...common} />
        </>
      )}

      {name === 'spark' && (
        <>
          <Path d="M12 2.5l2 5.5 5.5 2-5.5 2-2 5.5-2-5.5L4.5 10l5.5-2z" {...common} />
          <Path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" {...common} />
        </>
      )}

      {name === 'calendar' && (
        <>
          <Rect x="3" y="5" width="18" height="16" rx="2" {...common} />
          <Path d="M3 10h18M8 3v4M16 3v4" {...common} />
        </>
      )}

      {name === 'target' && (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Circle cx="12" cy="12" r="5" {...common} />
          <Circle cx="12" cy="12" r="1.4" fill={color} />
        </>
      )}

      {name === 'plus' && <Path d="M12 5v14M5 12h14" {...common} strokeWidth={2.2} />}

      {name === 'chevronLeft' && <Path d="m15 18-6-6 6-6" {...common} strokeWidth={2} />}
      {name === 'chevronRight' && <Path d="m9 18 6-6-6-6" {...common} strokeWidth={2} />}
      {name === 'arrowRight' && (
        <>
          <Path d="M5 12h14" {...common} strokeWidth={2} />
          <Polyline points="12 5 19 12 12 19" {...common} strokeWidth={2} />
        </>
      )}
      {name === 'close' && <Path d="M18 6 6 18M6 6l12 12" {...common} strokeWidth={2} />}
      {name === 'external' && <Path d="M7 17 17 7M9 7h8v8" {...common} strokeWidth={2} />}

      {/* VARTA. Both are traced from #iconVoiceMic and #iconVoiceStop in
          twin-app/dashboard.html, at the 2.0 weight the overlay uses rather
          than this file's 1.7 default — they sit inside a 72px button, where
          the lighter stroke reads as thin. */}
      {name === 'mic' && (
        <>
          <Path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" {...common} strokeWidth={2} />
          <Path d="M19 10v2a7 7 0 0 1-14 0v-2" {...common} strokeWidth={2} />
          <Path d="M12 19v4M8 23h8" {...common} strokeWidth={2} />
        </>
      )}
      {name === 'stop' && <Rect x="6" y="6" width="12" height="12" fill={color} />}

      {/* Tax Calculator — the `navTax` document glyph from dashboard.html. */}
      {name === 'receipt' && (
        <>
          <Path d="M7.5 2.5h9l2 2v17h-13v-17l2-2Z" {...common} />
          <Path d="M9 8.5h6M9 12h6M9 15.5h3" {...common} />
        </>
      )}

      {/* Hisaab — the ledger glyph from the sidebar. */}
      {name === 'ledger' && (
        <>
          <Rect x="3" y="5" width="18" height="14" rx="2" {...common} />
          <Path d="M3 9.5h18M7.5 14h5" {...common} />
        </>
      )}

      {/* Simulate — the sidebar's rows-with-nodes glyph. */}
      {name === 'simulate' && (
        <>
          <Path d="M3.5 7h17M3.5 12h17M3.5 17h11" {...common} />
          <Circle cx="9.5" cy="7" r="1.9" fill={color} />
          <Circle cx="15.5" cy="12" r="1.9" fill={color} />
          <Circle cx="7" cy="17" r="1.9" fill={color} />
        </>
      )}

      {/* Ask Twin — the sidebar's speech bubble. */}
      {name === 'chat' && (
        <Path d="M3.5 5h17v11h-10l-4 3.5V16h-3V5Z" {...common} />
      )}

      {name === 'settings' && (
        <>
          <Circle cx="12" cy="12" r="3.2" {...common} />
          <Path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1 5.3 5.3" {...common} />
        </>
      )}

      {name === 'report' && (
        <>
          <Path d="M6 2.5h8l4 4v15H6v-19Z" {...common} />
          <Path d="M9 11h6M9 14.5h6M9 18h3.5" {...common} />
        </>
      )}
    </Svg>
  );
}

/**
 * Icon per insight type, so the section reads at a glance. Anything unmapped
 * falls back to the generic spark — a new backend rule therefore renders
 * correctly with no app change, exactly as on the web.
 */
export const INSIGHT_GLYPHS: Record<string, GlyphName> = {
  upcoming_pressure: 'calendar',
  buffer_thin: 'wallet',
  goal_behind: 'target',
  goal_on_track: 'target',
  goal_pace: 'target',
  no_goal: 'target',
  savings_improving: 'piggy',
  onboarding: 'spark',
  insufficient_history: 'spark',
};

/** Priority wording, from PRIORITY_LABEL in twin-app/js/home.js. */
export const PRIORITY_LABEL: Record<string, string> = {
  high: 'Needs attention',
  medium: 'Worth knowing',
  low: 'FYI',
};

/**
 * Category marks for the upcoming list, from CATEGORY_MARKS in
 * twin-app/js/home.js. The spending overview uses its own icons, which the
 * backend supplies per category — those are not duplicated here.
 */
export const CATEGORY_MARKS: Record<string, string> = {
  'Utilities & Bills': '⚡',
  Subscriptions: '📺',
  'Rent / Housing': '🏠',
  'Travel & Transport': '🚕',
  'Health & Medical': '🩺',
  Shopping: '🛍️',
  Groceries: '🛒',
  'Food & Dining': '🍽️',
  Entertainment: '🎬',
  Taxes: '🧾',
  'Professional fees': '💼',
  'Software/Tools': '🧰',
};

/** Where a non-manual row came from. Keyed on the backend's `source` value, so
 *  a future 'sms' or 'whatsapp' detector needs only one entry here. */
export const SOURCE_LABELS: Record<string, string> = {
  gmail: 'From email',
};

/** The category list the web's "Add an upcoming payment" form offers
 *  (UPCOMING_CATEGORIES in twin-app/js/home.js). */
export const UPCOMING_CATEGORIES = [
  'Utilities & Bills',
  'Subscriptions',
  'Rent / Housing',
  'Travel & Transport',
  'Health & Medical',
  'Shopping',
  'Groceries',
  'Food & Dining',
  'Entertainment',
  'Taxes',
  'Professional fees',
  'Software/Tools',
  'Other expense',
] as const;

/** Goal categories, from the #dhGoalCategory select in twin-app/dashboard.html. */
export const GOAL_CATEGORIES = [
  { value: 'emergency_fund', label: 'Emergency fund' },
  { value: 'travel', label: 'Travel' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'investment', label: 'Investment' },
  { value: 'custom', label: 'Custom' },
] as const;

export const RECURRENCE_OPTIONS = [
  { value: 'none', label: 'One-off' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
] as const;
