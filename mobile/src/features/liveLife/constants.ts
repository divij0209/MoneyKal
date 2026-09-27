/**
 * live.life.fully — the scenery constants and the small bits of display logic.
 *
 * Transcribed from twin-app/js/live-life.js and live-life-scenes.js. Nothing
 * here touches financial data: every figure on this screen arrives from the
 * backend already formatted.
 */

/**
 * The accent.
 *
 * ONE colour, and it is the brand's.
 *
 * The web used to rotate six accents on an eleven-second beat because a
 * single looping clip played behind everything and the colour was the only
 * thing that could change. That is no longer the direction: the current
 * stylesheet (twin-app/css/live-life.css) states it plainly — the experience
 * is "always cinematic dark", "the cyan the app is built on is still here and
 * is the resting accent", and it asks for "a subtle premium glow instead of a
 * colorful AI aurora".
 *
 * So the sunset/violet/neon rotation is retired. It was the loudest thing in
 * the app and the only place MoneyKal used a hue outside off-white, black and
 * cyan. The array shape is kept — `useAccentCycle` still indexes it — so the
 * change is one value rather than a refactor of every consumer.
 */
export const BACKDROP_ACCENTS = ['#00e5ff'] as const;

/** How long each accent holds. Only one accent remains, so this now just
 *  keeps `useAccentCycle`'s interval honest rather than driving a rotation. */
export const ACCENT_INTERVAL_MS = 11_000;

/**
 * The ground.
 *
 * A single still gradient — deep ink at the top easing to a barely-there cyan
 * cast at the horizon. Replaces the six rotating sky gradients for the same
 * reason as above, and replaces the 30MB background clip and the drifting
 * particle field entirely: this is a financial product's calm room, not a
 * screensaver.
 */
export const BACKDROP_SKY: [string, string, string] = ['#05060a', '#08131a', '#0d2630'];

/** The web's quick-check amounts, in order. */
export const QUICK_AMOUNTS = [2000, 10000, 25000, 60000] as const;

/** `VERDICT_LABEL` in twin-app/js/live-life.js. */
export const VERDICT_LABEL: Record<string, string> = {
  comfortable: 'Comfortable',
  stretch: 'A stretch',
  not_yet: 'Not yet',
  unknown: 'Unknown',
};

/** The category a stash starts in when the user has none yet. */
export const DEFAULT_CATEGORY = 'experience_trips';

/**
 * `money()` on the web — used only for the quick-amount chips, which are
 * client-side constants rather than backend figures. Every other number on
 * this screen uses its `*_display` string.
 */
export function money(currency: string, value: number): string {
  return `${currency}${Math.round(value).toLocaleString('en-IN')}`;
}

/**
 * `formatDate()` in live-life.js, which renders a stash's target date as
 * "1 Dec 2026" with en-GB.
 *
 * The web appends 'T00:00:00' before parsing to keep the date local; the
 * components are split out here instead, which achieves the same thing without
 * depending on how the runtime parses a bare date string.
 */
export function formatStashDate(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "1 day to go" / "12 days to go", as the adventure card pluralises. */
export function daysToGoUnit(days?: number | null): string {
  return days === 1 ? 'day to go' : 'days to go';
}

/** The viewer's own date as YYYY-MM-DD — what `local_date` expects. */
export function localDateKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* -------------------------------------------------- procedural scenery ---
   Transcribed from live-life-scenes.js. Deterministic, so a scene does not
   re-scramble its mountains every time the experience opens — it should feel
   like a place, not noise. */

/** The web's `rng()` — a linear congruential generator seeded per layer. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The scene viewBox the paths are drawn in. */
export const SCENE_W = 1440;
export const SCENE_H = 900;

/** `ridge()` — a jagged ridge line across the frame, closed to the bottom. */
export function ridge(rand: () => number, baseY: number, amp: number, n: number): string {
  const step = (SCENE_W + 80) / n;
  let d = `M -40 ${SCENE_H} L -40 ${baseY.toFixed(0)}`;
  for (let i = 0; i <= n; i++) {
    const x = -40 + i * step;
    const peak = baseY - rand() * amp - (i % 2 ? amp * 0.22 : 0);
    d += ` L ${x.toFixed(0)} ${peak.toFixed(0)}`;
  }
  return `${d} L ${SCENE_W + 40} ${SCENE_H} Z`;
}

/** `band()` — a soft rolling band: sea, cloud deck, dunes. */
export function band(rand: () => number, baseY: number, amp: number, n: number): string {
  const step = (SCENE_W + 80) / n;
  let d = `M -40 ${SCENE_H} L -40 ${baseY.toFixed(0)}`;
  for (let i = 1; i <= n; i++) {
    const x = -40 + i * step;
    const cx = x - step / 2;
    const cy = baseY - amp + rand() * amp * 2;
    d += ` Q ${cx.toFixed(0)} ${cy.toFixed(0)} ${x.toFixed(0)} ${baseY.toFixed(0)}`;
  }
  return `${d} L ${SCENE_W + 40} ${SCENE_H} Z`;
}
