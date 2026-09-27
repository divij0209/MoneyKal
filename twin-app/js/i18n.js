/* ==========================================================================
   MoneyKal — translation engine

   One mechanism translates the whole site: static markup, text injected by
   JavaScript, input placeholders, titles and aria labels.

   How it works
   ------------
   The dictionary in js/i18n-strings.js is keyed on the English source text
   (the gettext approach) rather than on invented ids. That has two payoffs
   here. Nothing needs a data-i18n attribute, so a page with several hundred
   strings does not have to be annotated element by element; and a string
   rendered later by JavaScript translates by the same rule as one written in
   the HTML, because both are just English text in the DOM.

   Only exact dictionary hits are translated. Anything not in the dictionary is
   left exactly as it is, so an untranslated string degrades to English rather
   than to a broken key. Numbers, currency and product names are never touched.

   A MutationObserver keeps dynamically rendered UI in step, which is what
   makes Hisaab, the tax calculator, live.life.fully and the chat translate
   without each renderer knowing about language at all.

   Public API
   ----------
     window.t(text)          translate one string, for use inside renderers
     window.setLanguage(lc)  switch language and repaint
     window.currentLang      'en' | 'hi'
   ========================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'moneykal_lang';
  var SUPPORTED = ['en', 'hi'];

  /* Elements whose text is never content. */
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, SVG: 1 };

  /* Attributes worth translating when they carry visible or announced text. */
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];

  function dict() {
    return (window.MK_STRINGS || {});
  }

  function read() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      return SUPPORTED.indexOf(v) >= 0 ? v : 'en';
    } catch (e) {
      return 'en';
    }
  }

  var lang = read();
  window.currentLang = lang;

  /** Translate one string. Returns it unchanged when there is no entry.
   *
   *  Markup wraps long sentences across lines, so the text node carries the
   *  newlines and indentation from the source file. The lookup collapses all
   *  whitespace to single spaces, which is how the string reads on screen and
   *  therefore how it is written in the dictionary. */
  function t(text) {
    if (lang === 'en' || !text) return text;
    var key = String(text).replace(/\s+/g, ' ').trim();
    if (!key) return text;
    var entry = dict()[key];
    if (!entry) return text;
    var out = entry[lang];
    if (!out) return text;
    // Preserve the original leading/trailing whitespace so inline layout,
    // which often depends on a single space between elements, is unchanged.
    var lead = String(text).match(/^\s*/)[0];
    var tail = String(text).match(/\s*$/)[0];
    return lead + out + tail;
  }

  /* ---------------------------------------------------------------- DOM pass
     Each translated node keeps its English source on the element, so switching
     back to English restores the original rather than trying to translate in
     reverse. */

  function translateTextNode(node) {
    var parent = node.parentNode;
    if (!parent || SKIP_TAGS[parent.nodeName]) return;
    if (parent.closest && parent.closest('[data-i18n-skip]')) return;

    var src = node.__mkSource;
    if (src === undefined) {
      src = node.nodeValue;
      // Only remember nodes that actually carry words.
      if (!/[A-Za-zऀ-ॿ]{2}/.test(src || '')) return;
      node.__mkSource = src;
    }
    var next = lang === 'en' ? src : t(src);
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function translateAttrs(elp) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!elp.hasAttribute || !elp.hasAttribute(a)) continue;
      var store = '__mkAttr_' + a;
      var src = elp[store];
      if (src === undefined) {
        src = elp.getAttribute(a);
        elp[store] = src;
      }
      var next = lang === 'en' ? src : t(src);
      if (elp.getAttribute(a) !== next) elp.setAttribute(a, next);
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1) return;
    if (SKIP_TAGS[root.nodeName]) return;

    translateAttrs(root);

    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var batch = [];
    while (w.nextNode()) batch.push(w.currentNode);
    for (var i = 0; i < batch.length; i++) translateTextNode(batch[i]);

    var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var j = 0; j < els.length; j++) translateAttrs(els[j]);
  }

  /* ------------------------------------------------------------- public API */

  function apply() {
    if (!document.body) return;
    walk(document.body);
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);
    paintToggle();
  }

  function setLanguage(next) {
    if (SUPPORTED.indexOf(next) < 0 || next === lang) return;
    lang = next;
    window.currentLang = lang;
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* private mode */ }
    apply();
    document.dispatchEvent(new CustomEvent('mk:languagechange', { detail: { lang: lang } }));
  }

  function toggleLanguage() { setLanguage(lang === 'en' ? 'hi' : 'en'); }

  /** Every EN | हिं control on the page, matched by id or by class. The
   *  marketing pages carry one in the nav; the app carries one in the shared
   *  topbar and one in the Overview's own header, which is why this returns a
   *  list rather than a single element. */
  function toggles() {
    return document.querySelectorAll('#lang-toggle, .lang-toggle');
  }

  /** The EN | हिं control shows which language a click would give you. */
  function paintToggle() {
    var list = toggles();
    for (var i = 0; i < list.length; i++) {
      list[i].innerHTML = lang === 'en'
        ? '<b>EN</b> | हिं'
        : 'EN | <b>हिं</b>';
      // Translated like anything else, so the control announces itself in the
      // language currently on screen.
      list[i].setAttribute('aria-label',
        lang === 'en' ? 'Switch to Hindi' : t('Switch to English'));
    }
  }

  window.t = t;
  window.setLanguage = setLanguage;
  window.toggleLanguage = toggleLanguage;
  window.applyTranslations = apply;

  /* ------------------------------------------------------------- observation
     Renderers replace whole subtrees, so watch for added nodes and translate
     them on the next frame. Batched, because Hisaab and the tax calculator can
     add hundreds of nodes in one pass. */

  var pending = null;
  function schedule(nodes) {
    if (lang === 'en' && !pending) return;   // nothing to do in English
    if (pending) { pending = pending.concat(nodes); return; }
    pending = nodes.slice();
    requestAnimationFrame(function () {
      var batch = pending; pending = null;
      for (var i = 0; i < batch.length; i++) walk(batch[i]);
    });
  }

  function observe() {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(function (records) {
      var added = [];
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        for (var j = 0; j < r.addedNodes.length; j++) added.push(r.addedNodes[j]);
        if (r.type === 'characterData' && r.target) added.push(r.target);
      }
      if (added.length) schedule(added);
    }).observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
  }

  function boot() {
    apply();
    observe();
    var list = toggles();
    for (var i = 0; i < list.length; i++) {
      list[i].addEventListener('click', toggleLanguage);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ------------------------------------------------------------------ theme
     The theme control used to live in this file. It still does, because both
     pages bind it by the same id and app-shell.js expects it to already be
     wired when it loads. */
  var theme = 'light';
  try { theme = localStorage.getItem('moneykal_theme') === 'dark' ? 'dark' : 'light'; } catch (e) {}
  window.currentTheme = theme;

  function applyTheme(next) {
    document.documentElement.setAttribute('data-theme', next);
    var sun = document.getElementById('theme-icon-sun');
    var moon = document.getElementById('theme-icon-moon');
    if (sun && moon) {
      sun.style.display = next === 'light' ? 'none' : 'block';
      moon.style.display = next === 'light' ? 'block' : 'none';
    }
  }

  window.applyTheme = applyTheme;
  window.toggleTheme = function () {
    window.currentTheme = window.currentTheme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('moneykal_theme', window.currentTheme); } catch (e) {}
    applyTheme(window.currentTheme);
  };

  function bindTheme() {
    applyTheme(window.currentTheme);
    var b = document.getElementById('theme-toggle');
    if (b) b.addEventListener('click', window.toggleTheme);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindTheme);
  } else {
    bindTheme();
  }
})();
