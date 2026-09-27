/* config.js — the one place the frontend decides where the backend lives.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The API base used to be a hardcoded template literal duplicated in api.js and
 * auth.js:
 *
 *     const API_BASE = `http://${hostname}:8000`;
 *
 * That has two consequences that only show up off the developer's laptop.
 * First, it is plain http, so the moment the site is served from an https host
 * every single API call is blocked as mixed content — the app renders and then
 * does nothing, with no error a user can see. Second, the port and scheme were
 * unreachable from a build or a deployment: there was no way to point the same
 * files at a real backend without editing two source files.
 *
 * Resolution order below is deliberately "explicit wins, local default last",
 * so an existing local checkout behaves EXACTLY as it did before this file
 * existed, and a deployment only has to set one value.
 *
 * To deploy: either set window.__API_BASE before this script, or add
 *     <meta name="moneykal-api-base" content="https://api.example.com">
 * to the page head. Nothing else in the frontend needs to change.
 */
(function () {
  'use strict';

  function clean(value) {
    return String(value).trim().replace(/\/+$/, '');
  }

  function resolve() {
    // 1. An explicit global, set by a deploy-time snippet or an env-injected
    //    inline script. Highest priority so a build can always override.
    if (window.__API_BASE) return clean(window.__API_BASE);

    // 2. A meta tag, which is the same override without needing a script.
    var meta = document.querySelector('meta[name="moneykal-api-base"]');
    if (meta && meta.content && meta.content.indexOf('__') !== 0) {
      return clean(meta.content);
    }

    // 3. Served over https with no override configured. Falling back to
    //    http://host:8000 here is the mixed-content trap described above, so
    //    assume the conventional deployment shape instead: the backend behind
    //    /api on the same origin. Same-origin also sidesteps CORS entirely.
    if (window.location.protocol === 'https:') {
      return window.location.origin + '/api';
    }

    // 4. Local development — byte-for-byte the previous behaviour.
    var host = (!window.location.hostname || window.location.hostname === 'localhost')
      ? '127.0.0.1'
      : window.location.hostname;
    return 'http://' + host + ':8000';
  }

  var base = resolve();

  // Exposed on window because several modules (home.js among them) already
  // read window.API_BASE, and because it is genuinely useful to be able to
  // check the resolved value from the console during a demo.
  window.API_BASE = base;
  window.MONEYKAL_API_BASE = base;
})();
