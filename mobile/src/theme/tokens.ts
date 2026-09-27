/**
 * MoneyKal design tokens.
 *
 * THREE COLOURS. Off-white, black, cyan. Everything below is one of those
 * three, or a neutral step between the first two.
 *
 * The hexes are MoneyKal's own, not new inventions:
 *
 *   off-white  #F4F2EE  `--c-sage` in twin-app/css/landing.css, described
 *                       there as "muted warm gray/off-white"
 *   black      #0B0C0C  a hair off `--c-charcoal` #121212, so the dark ground
 *                       reads as ink rather than as a grey card
 *   cyan       #00E5FF  `--accent` across app-theme.css and landing.css
 *   deep cyan  #00707F  the light-mode cyan. landing.css already does this
 *                       swap (`--c-cyan: #009999` under [data-theme="light"])
 *                       because #00E5FF on an off-white page is ~1.4:1 and
 *                       illegible. This is the same move, one step darker so
 *                       body-size text clears 4.5:1.
 *
 * Light is the primary theme — MoneyKal on a phone is a daylight product, and
 * the off-white ground is the brand's own. Dark is the same three colours with
 * the ground and the ink exchanged.
 *
 * What is deliberately NOT here: any fourth hue. Categorical charts separate
 * their series by stepping the cyan's lightness and by the neutral ramp, not
 * by reaching for orange and magenta. Positive/negative are carried by cyan
 * vs. neutral-grey, which is how the web already does it — never red/green.
 */

export type ThemeName = 'light' | 'dark';

export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;

  ink: string;
  inkMuted: string;
  inkFaint: string;

  line: string;
  lineStrong: string;
  navHoverText: string;

  accent: string;
  accentTint: string;
  primary: string;
  primaryDark: string;
  primaryText: string;
  primaryTint: string;

  warn: string;
  warnTint: string;
  statusGood: string;
  statusWarning: string;
  statusSerious: string;
  statusCritical: string;
  statusNeutral: string;

  chartBlue: string;
  chartOrange: string;
  chartAqua: string;
  chartYellow: string;
  chartMagenta: string;
  chartViolet: string;
  chartGreen: string;
  chartRed: string;
  chartGrid: string;
  chartAxis: string;

  sidebarBg: string;
  cardBg: [string, string];
  cardBgSolid: string;
  cardBorderHover: string;
  navActiveBg: [string, string];
  btnBg: [string, string];
  btnBgSolid: string;
  onAccent: string;
  accentBorder: string;
  accentHover: string;
  pos: string;
  neg: string;
  posTint: string;
  negTint: string;
  ringTrack: string;

  /* -------------------------------------------------------------- additions
     The "feature panel" — the one dark, high-contrast surface a light screen
     is allowed, carrying the screen's hero figure. It is what stops the
     dashboard from being a flat page of grey boxes, and it is the single
     place the bright cyan can be used at full strength on a light theme,
     because it sits on ink rather than on off-white. */
  panel: string;
  panelInk: string;
  panelInkMuted: string;
  panelLine: string;
  panelAccent: string;
  /**
   * Skeleton placeholder fill.
   *
   * Deliberately a solid step off the page rather than a low-alpha tint. A
   * placeholder that is only 5% darker than the ground does not read as
   * "loading" — it reads as an empty screen, which is exactly how a slow or
   * failing request gets mistaken for a broken app.
   */
  skeleton: string;
}

/** Light — off-white ground, black ink, deep cyan. The default. */
export const lightPalette: Palette = {
  bg: '#F4F2EE',
  surface: '#FAF9F6',
  surface2: '#FFFFFF',
  surface3: '#EAE7E1',

  ink: '#111312',
  inkMuted: '#5C605D',
  inkFaint: '#8C918C',

  line: 'rgba(17,19,18,0.10)',
  lineStrong: 'rgba(17,19,18,0.20)',
  navHoverText: '#111312',

  accent: '#00707F',
  accentTint: 'rgba(0,112,127,0.10)',
  primary: '#00707F',
  primaryDark: '#00565F',
  primaryText: '#FFFFFF',
  primaryTint: 'rgba(0,112,127,0.10)',

  warn: '#8A5A2B',
  warnTint: 'rgba(138,90,43,0.10)',
  statusGood: '#00707F',
  statusWarning: '#8A5A2B',
  statusSerious: '#8A5A2B',
  statusCritical: '#8A5A2B',
  statusNeutral: '#8C918C',

  /* Chart series. Cyan first, then steps down its own lightness ramp, then
     the neutral ramp. No new hues. */
  chartBlue: '#00707F',
  chartOrange: '#00A0B5',
  chartAqua: '#5FC7D4',
  chartYellow: '#A9B0AD',
  chartMagenta: '#004A54',
  chartViolet: '#767C79',
  chartGreen: '#00707F',
  chartRed: '#8C918C',
  chartGrid: 'rgba(17,19,18,0.07)',
  chartAxis: '#8C918C',

  sidebarBg: '#FAF9F6',
  cardBg: ['#FFFFFF', '#FAF9F6'],
  cardBgSolid: '#FFFFFF',
  cardBorderHover: 'rgba(0,112,127,0.45)',
  navActiveBg: ['rgba(0,112,127,0.12)', 'rgba(0,112,127,0.02)'],
  btnBg: ['#00808F', '#00707F'],
  btnBgSolid: '#00707F',
  onAccent: '#FFFFFF',
  accentBorder: 'rgba(0,112,127,0.30)',
  accentHover: 'rgba(0,112,127,0.16)',
  pos: '#00707F',
  neg: '#5C605D',
  posTint: 'rgba(0,112,127,0.12)',
  negTint: 'rgba(17,19,18,0.06)',
  ringTrack: 'rgba(17,19,18,0.09)',

  panel: '#0B0C0C',
  panelInk: '#F4F2EE',
  panelInkMuted: 'rgba(244,242,238,0.62)',
  panelLine: 'rgba(244,242,238,0.14)',
  panelAccent: '#00E5FF',
  skeleton: '#E2DED6',
};

/** Dark — black ground, off-white ink, brand cyan at full strength. */
export const darkPalette: Palette = {
  bg: '#0B0C0C',
  surface: '#111313',
  surface2: '#171A1A',
  surface3: '#1F2323',

  ink: '#F4F2EE',
  inkMuted: '#A5AAA8',
  inkFaint: '#6E7472',

  line: 'rgba(244,242,238,0.09)',
  lineStrong: 'rgba(244,242,238,0.18)',
  navHoverText: '#F4F2EE',

  accent: '#00E5FF',
  accentTint: 'rgba(0,229,255,0.12)',
  primary: '#00E5FF',
  primaryDark: '#5CEFFF',
  primaryText: '#00090B',
  primaryTint: 'rgba(0,229,255,0.12)',

  warn: '#D9B48A',
  warnTint: 'rgba(217,180,138,0.12)',
  statusGood: '#00E5FF',
  statusWarning: '#D9B48A',
  statusSerious: '#D9B48A',
  statusCritical: '#D9B48A',
  statusNeutral: '#6E7472',

  chartBlue: '#00E5FF',
  chartOrange: '#00A8BF',
  chartAqua: '#8CEEFA',
  chartYellow: '#A5AAA8',
  chartMagenta: '#006D7D',
  chartViolet: '#565C5A',
  chartGreen: '#00E5FF',
  chartRed: '#A5AAA8',
  chartGrid: 'rgba(244,242,238,0.06)',
  chartAxis: '#6E7472',

  sidebarBg: '#0B0C0C',
  cardBg: ['#141717', '#0E1010'],
  cardBgSolid: '#111313',
  cardBorderHover: 'rgba(0,229,255,0.40)',
  navActiveBg: ['rgba(0,229,255,0.16)', 'rgba(0,229,255,0.02)'],
  btnBg: ['#5CEFFF', '#00E5FF'],
  btnBgSolid: '#00E5FF',
  onAccent: '#00090B',
  accentBorder: 'rgba(0,229,255,0.32)',
  accentHover: 'rgba(0,229,255,0.22)',
  pos: '#00E5FF',
  neg: '#A5AAA8',
  posTint: 'rgba(0,229,255,0.12)',
  negTint: 'rgba(244,242,238,0.07)',
  ringTrack: 'rgba(244,242,238,0.10)',

  /* On dark the "feature panel" cannot be darker than the page, so it steps
     up instead — a raised ink surface. Same role, inverted mechanics. */
  panel: '#171A1A',
  panelInk: '#F4F2EE',
  panelInkMuted: 'rgba(244,242,238,0.62)',
  panelLine: 'rgba(244,242,238,0.12)',
  panelAccent: '#00E5FF',
  skeleton: '#1F2323',
};

export const palettes: Record<ThemeName, Palette> = {
  dark: darkPalette,
  light: lightPalette,
};

/**
 * Elevation.
 *
 * Deliberately shallow. A financial product reads as trustworthy through
 * alignment and hairlines, not through drop shadows, so `card` is barely
 * there and exists mainly to lift a sheet off the page. `panel` is the one
 * genuinely raised surface.
 */
export const elevation = {
  card: {
    light: {
      shadowColor: '#111312',
      shadowOpacity: 0.05,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
    dark: {
      shadowColor: '#000000',
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 3 },
      elevation: 2,
    },
  },
  panel: {
    light: {
      shadowColor: '#111312',
      shadowOpacity: 0.18,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 10 },
      elevation: 6,
    },
    dark: {
      shadowColor: '#000000',
      shadowOpacity: 0.5,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 10 },
      elevation: 6,
    },
  },
} as const;

/**
 * Spacing scale — a 4pt grid. Section rhythm on a screen is `xxxl` between
 * groups and `lg` within one; that single rule is what makes the layouts
 * read as designed rather than as stacked.
 */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 44,
} as const;

/**
 * Corner radii. Used sparingly and consistently: `md` for controls and rows,
 * `lg` for surfaces, `xl` for the feature panel and sheets. Nothing in the
 * app is more rounded than `xl` except a deliberate pill.
 */
export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/** Minimum touch target. Not a web concern; non-negotiable on a phone. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH_SIZE = 44;
