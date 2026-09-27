import { TextStyle } from 'react-native';

/**
 * MoneyKal typography.
 *
 * Two faces, and only two:
 *
 *   Poppins — headings, hero figures, section titles. The geometric face that
 *             carries the brand voice. Never used below 16px, never used for
 *             a paragraph.
 *   Inter   — body copy, navigation, labels, forms, and every financial
 *             number. Inter's tabular figures are what make a column of
 *             rupee amounts line up, which is why the money lives here and
 *             not in the display face.
 *
 * The web ships Outfit + Inter + IBM Plex Mono; this client consolidates the
 * display face on Poppins and folds the mono role into Inter's tabular
 * figures, so the app carries two families instead of four. The `mono`
 * variant name is kept because ~5 call sites ask for it by role ("digits that
 * must line up"), and that role is now served by Inter + `fontVariant:
 * tabular-nums` rather than by a separate monospace family.
 *
 * Font *families* in React Native are per-weight PostScript names, not a
 * family plus a numeric weight — hence the explicit constants below.
 */

export const fontFamily = {
  /* ---------------------------------------------------------------- Poppins */
  display: 'Poppins_600SemiBold',
  displayBold: 'Poppins_700Bold',
  displayMedium: 'Poppins_500Medium',
  displayRegular: 'Poppins_400Regular',

  /* ------------------------------------------------------------------ Inter */
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',

  /**
   * "Digits in a column." Inter, not a monospace family — `tabular` on the
   * Text primitive supplies the fixed advance width. Kept under this name so
   * the call sites that ask for the role keep reading correctly.
   */
  mono: 'Inter_400Regular',
  monoMedium: 'Inter_500Medium',
  monoSemiBold: 'Inter_600SemiBold',

  /**
   * VARTA's status line. The web reaches for a display serif here; this
   * client stays inside the two-face rule and uses Poppins at its lightest
   * useful weight, which reads as the same "spoken aloud" register without
   * introducing a third family.
   */
  serif: 'Poppins_400Regular',
} as const;

/**
 * The type scale. Named by role rather than size so a screen asks for "the
 * label above a number" instead of picking 11px by feel.
 *
 * Hierarchy is carried by size and weight contrast — 40px hero against an
 * 11px label — which is what lets the layouts drop most of their card
 * chrome and still read as structured.
 */
export const typeScale = {
  /** The one number a screen is about: a balance, a Freedom Balance, a
   *  net tax position. One per screen, at most. */
  hero: {
    fontFamily: fontFamily.displayBold,
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: -1.4,
  },
  /** Page-level heading, e.g. the Home greeting. */
  display: {
    fontFamily: fontFamily.display,
    fontSize: 27,
    lineHeight: 34,
    letterSpacing: -0.7,
  },
  /** Section heading inside a screen. */
  title: {
    fontFamily: fontFamily.display,
    fontSize: 19,
    lineHeight: 26,
    letterSpacing: -0.4,
  },
  /** Card / block heading. */
  heading: {
    fontFamily: fontFamily.display,
    fontSize: 15.5,
    lineHeight: 21,
    letterSpacing: -0.2,
  },
  /** Body copy. */
  body: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 21.5,
    letterSpacing: -0.1,
  },
  /** Secondary body copy — captions, helper text, row subtitles. */
  bodySmall: {
    fontFamily: fontFamily.body,
    fontSize: 12.8,
    lineHeight: 18.5,
    letterSpacing: -0.05,
  },
  /** The uppercase eyebrow above a data block. Inter, tracked out. */
  label: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 10.5,
    lineHeight: 14,
    letterSpacing: 1.1,
    textTransform: 'uppercase' as const,
  },
  /** A headline figure inside a section — not the screen's hero. */
  metric: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    lineHeight: 33,
    letterSpacing: -0.8,
  },
  /** A figure inside a stat tile or a row. */
  metricSmall: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.4,
  },
  /** Anything where digits must line up in a column — ledger rows, tax
   *  breakdowns, calendars. Pair with `tabular` on <Text>. */
  mono: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13.5,
    lineHeight: 19,
    letterSpacing: -0.1,
  },
  /** Button text. */
  button: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 14.5,
    lineHeight: 20,
    letterSpacing: 0,
  },
  /** Bottom tab bar label. */
  tab: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 0.1,
  },
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof typeScale;
