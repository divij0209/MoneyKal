/* ==========================================================================
   Filing progress — presentation only.

   Reads the per-section figure that js/tax.js has already written onto each
   accordion header and reflects how many of the seven sections carry one.

   It computes no tax figure, calls no endpoint, and writes to no form field
   or saved state — it only mirrors what is already on the screen. tax.js does
   not know this file exists: the link between them is a MutationObserver on
   the text tax.js writes, so neither has to call the other.
   ========================================================================== */

(function () {
  'use strict';

  /* The placeholders tax.js shows for a section that has no figure yet:
     '…' before the first collect, 'N/A' once the server says the head is
     empty. Anything else is a real amount. */
  var PLACEHOLDERS = ['', '…', 'N/A'];

  function update() {
    var cells = document.querySelectorAll('#view-tax .tax-head__amount');
    if (!cells.length) return;

    var done = 0;
    for (var i = 0; i < cells.length; i++) {
      if (PLACEHOLDERS.indexOf(cells[i].textContent.trim()) === -1) done++;
    }

    var count = document.getElementById('taxProgressCount');
    if (count) {
      /* Built from a template rather than concatenation, because Hindi puts
         the total first ("7 में से 6"). js/i18n.js translates the template;
         when it is absent, or the language is English, t() hands back the
         English source and the result is identical to before. */
      var tpl = cells.length === 1
        ? '{done} of {total} section'
        : '{done} of {total} sections';
      if (typeof window.t === 'function') tpl = window.t(tpl);
      count.textContent = tpl
        .replace('{done}', done)
        .replace('{total}', cells.length);
    }

    var track = document.getElementById('taxProgressBar');
    if (track) {
      track.style.setProperty('--tax-progress', (done / cells.length * 100) + '%');
      track.setAttribute('aria-valuenow', String(done));
      track.setAttribute('aria-valuemax', String(cells.length));
    }
  }

  function start() {
    var host = document.getElementById('taxForms');
    if (!host) return;

    update();

    /* tax.js rewrites every header figure on each collect. Watching that text
       keeps the indicator in step with the real state without hooking into
       its render path. The nodes written here sit outside #taxForms, so this
       cannot observe its own writes. */
    if (typeof MutationObserver === 'function') {
      new MutationObserver(update).observe(host, {
        subtree: true,
        childList: true,
        characterData: true
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
