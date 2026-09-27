/* ==========================================================================
   MoneyKal — shared shell behaviour

   One theme for the whole app. The Overview owns the theme (data-ov-theme /
   moneykal_ov_theme) and its toggle is left untouched; this file makes the
   topbar control on every other view drive that same state by delegating to
   the Overview's own button, and mirrors the value onto the app-wide
   `data-theme` so i18n.js and the shared stylesheet stay in agreement.
   ========================================================================== */
(function () {
  const OV_KEY = 'moneykal_ov_theme';

  function currentTheme() {
    return document.documentElement.getAttribute('data-ov-theme') === 'light' ? 'light' : 'dark';
  }

  /** Keep the legacy app-wide theme flag and the topbar icon in step with the
   *  single source of truth, so nothing else has to know which one won. */
  function mirror() {
    const t = currentTheme();
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('moneykal_theme', t); } catch (e) { /* private mode */ }
    if (typeof window.currentTheme !== 'undefined') window.currentTheme = t;

    const sun = document.getElementById('theme-icon-sun');
    const moon = document.getElementById('theme-icon-moon');
    if (sun && moon) {
      // Show the icon of the theme you would switch *to*, matching the Overview.
      sun.style.display = t === 'dark' ? 'block' : 'none';
      moon.style.display = t === 'dark' ? 'none' : 'block';
    }
  }

  mirror();

  const topbarBtn = document.getElementById('theme-toggle');
  if (topbarBtn) {
    // Registered at parse time, before i18n.js binds its own handler on
    // DOMContentLoaded, so this runs first and suppresses the old toggle —
    // there is exactly one theme state in the app.
    topbarBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const ovBtn = document.getElementById('ovThemeBtn');
      if (ovBtn) {
        ovBtn.click();                       // reuse the Overview's own logic
      } else {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-ov-theme', next);
        try { localStorage.setItem(OV_KEY, next); } catch (err) { /* private mode */ }
      }
      mirror();
    }, true);
  }

  // If the theme is changed from the Overview's control, mirror that too.
  try {
    new MutationObserver(mirror).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-ov-theme']
    });
  } catch (e) { /* very old browser — the click path above still mirrors */ }
})();
