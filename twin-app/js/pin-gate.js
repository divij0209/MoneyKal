/* ==========================================================================
   MoneyKal PIN gate — runs FIRST, on every load of an authenticated page.

   THE RULE IT ENFORCES
   --------------------
   On a device that chose "Keep me signed in":

     * a REFRESH asks for the PIN;
     * opening MoneyKal when no tab of it is unlocked — a reopened browser, a
       tab opened after every MoneyKal tab was closed, a bookmark, a pasted
       URL — asks for the PIN;
     * opening a NEW TAB while MoneyKal is already unlocked in another tab of
       this browser does not. The person is demonstrably at an unlocked
       session already; making them prove it again adds friction, not safety.

   WHY IT IS NOT AN OVERLAY
   ------------------------
   A lock drawn over the page is theatre: the session is still usable, the app
   scripts still run, and deleting a DOM node walks straight past it. This gate
   decides before the app exists. When a load is not authorised it stops the
   document parsing — so no app script ever runs on a locked load — and
   navigates to unlock.html. The access token itself is removed whenever no
   unlocked tab remains: when the last one closes, and again by the lock
   screen if it finds nothing alive (which is what cleans up after a crash).

   HOW A LOAD BECOMES AUTHORISED
   -----------------------------
   Only by a single-use pass in this tab's sessionStorage, written by
   unlock.html (after a correct PIN, or after a live unlocked tab vouched for
   this one) or by the sign-in form (after a correct password). The gate
   consumes it on sight, and honours it only for a few seconds, so it
   authorises exactly one load.

   HOW TABS KNOW ABOUT EACH OTHER
   ------------------------------
   Two mechanisms, for two different questions:

     "Is an unlocked tab alive right now?"  — asked by a new tab. Answered over
       a BroadcastChannel by every authorised page still open. Only a running
       page can answer, so a crashed or closed tab can never vouch for anyone.
       Asked from unlock.html, because the answer is asynchronous and this file
       must decide synchronously.

     "Am I the last unlocked tab?"  — asked by a page as it goes away, when
       nothing asynchronous can run. Answered by a small registry of open tab
       ids in localStorage. An entry left behind by a crash only means the
       token is not removed on close; the next load's liveness check removes
       it before anything can use it.

   WHY IT IS A PLAIN SCRIPT IN <head>
   ----------------------------------
   It must run before js/app.js, which reads the session at parse time and
   would otherwise start fetching. No `defer`, no `async`, no module: this
   file has to be synchronous and first, and depends on nothing.
   ========================================================================== */
(function () {
  'use strict';

  var DEVICE_KEY  = 'moneykal_device';
  var SESSION_KEY = 'twin_session';
  var PASS_KEY    = 'moneykal_unlock_pass';
  var TABS_KEY    = 'moneykal_unlocked_tabs';
  var CHANNEL     = 'moneykal-unlock';

  /* How long a pass stays valid after it is written. It only has to cover the
     navigation from the lock screen (or the sign-in form) to the page it opens,
     which is well under a second on any real connection. A pass older than
     this was never consumed by the load it was meant for, and must not
     authorise whatever loads next. Expiring fails closed: the worst case is
     being asked for the PIN once more. */
  var PASS_TTL_MS = 30 * 1000;

  function safeGet(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function safeSet(store, key, value) {
    try { store.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function safeRemove(store, key) {
    try { store.removeItem(key); } catch (e) { /* no-op */ }
  }

  function hasRememberedDevice() {
    var raw = safeGet(window.localStorage, DEVICE_KEY);
    if (!raw) return false;
    try {
      var rec = JSON.parse(raw);
      return !!(rec && typeof rec.token === 'string' && rec.token);
    } catch (e) {
      // Unparseable. Treat it as no remembered device and clear it, so a
      // corrupted value cannot wedge someone out of their own account.
      safeRemove(window.localStorage, DEVICE_KEY);
      return false;
    }
  }

  function hasSession() {
    try {
      return !!JSON.parse(safeGet(window.localStorage, SESSION_KEY) || '{}').token;
    } catch (e) {
      return false;
    }
  }

  function readTabs() {
    try {
      var tabs = JSON.parse(safeGet(window.localStorage, TABS_KEY) || '{}');
      return (tabs && typeof tabs === 'object') ? tabs : {};
    } catch (e) {
      return {};
    }
  }

  function writeTabs(tabs) {
    if (Object.keys(tabs).length) safeSet(window.localStorage, TABS_KEY, JSON.stringify(tabs));
    else safeRemove(window.localStorage, TABS_KEY);
  }

  /** "reload" for F5 / the reload button; anything else otherwise. */
  function navigationType() {
    try {
      var entries = window.performance.getEntriesByType('navigation');
      if (entries && entries.length && entries[0].type) return entries[0].type;
    } catch (e) { /* fall through to the legacy interface */ }
    try {
      if (window.performance.navigation.type === 1) return 'reload';
    } catch (e) { /* no-op */ }
    return 'navigate';
  }

  /** Path + query + hash, built from location — never from a parameter — so
   *  the lock screen can only ever send someone back inside this app. */
  function here() {
    return window.location.pathname.split('/').pop() +
           window.location.search + window.location.hash;
  }

  /* ------------------------------------------------------------ unlocked */

  function registerUnlockedTab() {
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    var tabs = readTabs();
    tabs[id] = Date.now();
    writeTabs(tabs);

    /* Vouch for new tabs. Answered only while this page still has a session
       and the device is still remembered — a page whose session was ended
       elsewhere (logout, PIN turned off) must not wave anyone through. */
    var channel = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = function (event) {
        var msg = event && event.data;
        if (msg && msg.type === 'ping' && hasSession() && hasRememberedDevice()) {
          channel.postMessage({ type: 'pong', id: msg.id });
        }
      };
    } catch (e) {
      // No BroadcastChannel: new tabs simply ask for the PIN. Fails closed.
    }

    window.addEventListener('pagehide', function () {
      var remaining = readTabs();
      delete remaining[id];
      writeTabs(remaining);
      if (channel) { try { channel.close(); } catch (e) { /* no-op */ } channel = null; }

      /* The token goes only when this was the last unlocked tab. Closing one
         of several must not sign the others out.

         Re-checked at fire time: if the PIN was turned off while this page
         was open, the device is no longer remembered and there is no lock
         screen to return to, so clearing the session would only sign the
         user out. Explicit logout clears both itself, before this runs. */
      if (!Object.keys(remaining).length && hasRememberedDevice()) {
        safeRemove(window.localStorage, SESSION_KEY);
      }
    });

    /* A page restored from the back/forward cache ran none of the above on
       the way back in: its pagehide already deregistered it, and may have
       removed the token. Treat the restore as a fresh arrival. */
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) lock('check');
    });
  }

  /* -------------------------------------------------------------- locked */

  function lock(reason) {
    // Hidden first, so even if a frame paints before the navigation commits
    // it is a blank one.
    try { document.documentElement.style.visibility = 'hidden'; } catch (e) { /* no-op */ }

    /* Tell anything that still runs that this load is on its way out.
       dashboard.html's boot script and js/app.js both send a caller with no
       session to login.html; on a locked load that would race this
       navigation and could win. */
    window.__mkPinLocked = true;

    /* Stop parsing the document, then navigate. window.stop() aborts the
       parser, so no script after this one — none of the app — ever runs on a
       locked load. It also cancels any navigation already in progress, which
       is why it is called BEFORE replace() and not after. */
    try { window.stop(); } catch (e) { /* no-op */ }

    var url = 'unlock.html?next=' + encodeURIComponent(here());
    // `check` asks the lock screen to see whether an unlocked tab is alive and,
    // if one is, to let this tab straight through. A refresh never asks: a
    // refresh is exactly when the PIN is wanted.
    if (reason === 'check') url += '&check=1';

    // replace(), not assign(): the locked page must not sit in history where
    // Back would return to it.
    window.location.replace(url);
  }

  /* ---------------------------------------------------------------- decide */

  /* A device that never opted in is untouched: no lock screen, no change of
     any kind to how this app has always behaved. */
  if (!hasRememberedDevice()) return;

  /* Consume the single-use pass. Read and delete in the same breath — if this
     load is authorised, the NEXT one must not be. */
  var pass = safeGet(window.sessionStorage, PASS_KEY);
  safeRemove(window.sessionStorage, PASS_KEY);

  var issued = Number(pass);
  var age = Date.now() - issued;
  // A missing, non-numeric, future-dated or expired pass is no pass at all.
  var passValid = pass !== null && isFinite(issued) && issued > 0 && age >= 0 && age <= PASS_TTL_MS;

  if (passValid) {
    registerUnlockedTab();
  } else {
    lock(navigationType() === 'reload' ? 'reload' : 'check');
  }
})();
