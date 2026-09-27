/* ==========================================================================
   MoneyKal — the lock screen.

   Trades (device token + PIN) for an access token and hands control back to
   the page the user was trying to reach.

   The PIN is read from the field, sent, and cleared. It is never assigned to
   anything that outlives the submit handler, never written to storage, and
   never logged — not even on the failure paths, where a "helpful" console
   line would put it in plain sight.
   ========================================================================== */
(function () {
  'use strict';

  var form     = document.getElementById('pinForm');
  var input    = document.getElementById('pinInput');
  var btn      = document.getElementById('btnUnlock');
  var errorEl  = document.getElementById('pinError');
  var accountEl = document.getElementById('pinAccount');
  var expiryEl = document.getElementById('pinExpiry');
  var altBtn   = document.getElementById('btnUsePassword');

  if (!form || !input) return;

  /* ------------------------------------------------------------ where next */

  /**
   * The page to return to after unlocking.
   *
   * `next` comes from a URL, so it is treated as hostile: only a bare
   * in-app page name with an optional query and hash is accepted. That
   * rejects `//evil.com`, `https://evil.com`, `/etc/passwd` and `../` alike,
   * so this screen can never be used to bounce someone off the site — the
   * classic open-redirect on a login page, where the URL a user checks looks
   * legitimate and the destination is not.
   */
  function safeNext() {
    var raw = '';
    try {
      raw = new URLSearchParams(window.location.search).get('next') || '';
    } catch (e) { /* no URLSearchParams: fall through to the default */ }

    if (!raw) return 'dashboard.html';
    if (raw.indexOf('..') !== -1) return 'dashboard.html';
    if (!/^[A-Za-z0-9._-]+\.html(\?[^#]*)?(#.*)?$/.test(raw)) return 'dashboard.html';
    return raw;
  }

  /* ---------------------------------------------------------------- chrome */

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  function hideError() {
    if (errorEl) errorEl.style.display = 'none';
  }

  function setBusy(busy) {
    btn.disabled = busy;
    btn.classList.toggle('is-loading', busy);
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    input.disabled = busy;
  }

  /** Back to the password form, with this device forgotten. */
  function toPassword(reason) {
    window.MKPin.clearDevice();
    try { localStorage.removeItem('twin_session'); } catch (e) { /* no-op */ }
    var url = 'login.html';
    if (reason) url += '?notice=' + encodeURIComponent(reason);
    window.location.replace(url);
  }

  /* ------------------------------------------------------------ first paint */

  var device = window.MKPin.getDevice();

  if (!device) {
    // The head script already covers this; belt and braces for the case where
    // the record is removed between that script and this one.
    window.location.replace('login.html');
    return;
  }

  if (window.MKPin.isExpired(device)) {
    // Three days are up. The server would refuse anyway, so do not make the
    // user type a PIN to be told that.
    toPassword('Three days have passed, so please sign in with your password.');
    return;
  }

  if (device.username && accountEl) {
    accountEl.textContent = device.username;
    accountEl.classList.add('pin-sub--account');
  }

  (function paintExpiry() {
    if (!expiryEl) return;
    var days = window.MKPin.daysLeft(device);
    if (days === null) return;
    expiryEl.textContent = days === 0
      ? 'Your password will be required again today.'
      : 'Your password will be required again in ' +
        days + (days === 1 ? ' day.' : ' days.');
    expiryEl.hidden = false;
  })();

  /* ------------------------------------------------- is a tab unlocked? */

  /* Asked before the form is shown. js/pin-gate.js explains the rule; in
     short, a new tab opened while MoneyKal is unlocked in another tab goes
     straight through, and anything else asks for the PIN.

     Only a page that is actually running can answer, over a BroadcastChannel,
     so a closed or crashed tab can never vouch for this one. No answer within
     the window means no unlocked tab — the safe reading. */
  var CHECK_MS = 350;
  var unlocking = false;

  function askForUnlockedTab(timeoutMs) {
    return new Promise(function (resolve) {
      var channel;
      try {
        channel = new BroadcastChannel('moneykal-unlock');
      } catch (e) {
        resolve(false);                     // unsupported: ask for the PIN
        return;
      }
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      var done = false;
      function finish(alive) {
        if (done) return;
        done = true;
        try { channel.close(); } catch (e) { /* no-op */ }
        resolve(alive);
      }
      channel.onmessage = function (event) {
        var msg = event && event.data;
        if (msg && msg.type === 'pong' && msg.id === id) finish(true);
      };
      channel.postMessage({ type: 'ping', id: id });
      setTimeout(function () { finish(false); }, timeoutMs);
    });
  }

  function hasSession() {
    try { return !!JSON.parse(localStorage.getItem('twin_session') || '{}').token; }
    catch (e) { return false; }
  }

  function reveal() {
    document.documentElement.classList.remove('pin-checking');
    // Deferred a frame because iOS ignores focus set during parse.
    setTimeout(function () { try { input.focus(); } catch (e) { /* no-op */ } }, 60);
  }

  var wantsCheck = false;
  try { wantsCheck = new URLSearchParams(window.location.search).get('check') === '1'; }
  catch (e) { /* no URLSearchParams: always ask for the PIN */ }

  askForUnlockedTab(CHECK_MS).then(function (alive) {
    if (unlocking) return;

    if (alive && wantsCheck && hasSession()) {
      // Another tab is unlocked right now: this new tab joins it without a PIN.
      // Same single-use, short-lived pass a correct PIN would have produced.
      sessionStorage.setItem('moneykal_unlock_pass', String(Date.now()));
      window.location.replace(safeNext());
      return;
    }

    if (!alive) {
      /* No MoneyKal tab is unlocked. Any session still in storage belongs to
         nobody — typically a tab that crashed or was killed before it could
         clean up — so it is removed before the PIN is asked for, along with
         the registry entries such a tab left behind. */
      try {
        localStorage.removeItem('twin_session');
        localStorage.removeItem('moneykal_unlocked_tabs');
      } catch (e) { /* no-op */ }
    }

    // A refresh (no `check`), or no unlocked tab: the PIN it is.
    reveal();
  });

  /* ----------------------------------------------------------------- input */

  // Digits only, whatever arrives — a paste, an autofill, a phone keyboard
  // that offers punctuation.
  input.addEventListener('input', function () {
    var cleaned = input.value.replace(/[^0-9]/g, '').slice(0, 6);
    if (cleaned !== input.value) input.value = cleaned;
    hideError();
  });

  /* ---------------------------------------------------------------- submit */

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideError();

    var pin = input.value;

    // Shape only. Strength is not checked here: an account may hold a PIN that
    // was set before a value was added to the weak list, and refusing to even
    // TRY it would lock its owner out of their own device.
    if (!/^[0-9]{4}$|^[0-9]{6}$/.test(pin)) {
      showError('Enter your 4- or 6-digit PIN.');
      input.focus();
      return;
    }

    setBusy(true);
    unlocking = true;

    try {
      var data = await window.MKPin.unlock(pin);

      // Gone the moment it has been sent — out of the field, out of the local,
      // and out of the browser's form-restore buffer on a back navigation.
      pin = null;
      input.value = '';

      /* Hand the session to the next page load.

         The access token goes to localStorage because that is where the whole
         app already looks for it. The single-use pass goes to sessionStorage,
         where js/pin-gate.js consumes it to authorise exactly ONE document
         load — so the next refresh comes back here, which is the point of the
         PIN. */
      localStorage.setItem('twin_session', JSON.stringify({
        token: data.access_token,
        userId: data.user_id,
        username: data.username,
        profileKey: data.profile_key
      }));
      // The pass is a timestamp, not a bare flag: js/pin-gate.js honours it only
      // for a few seconds, so a pass that is never consumed — a navigation that
      // is abandoned, or a stale cached page that does not run the gate — cannot
      // quietly authorise some later load instead.
      sessionStorage.setItem('moneykal_unlock_pass', String(Date.now()));

      // The device token is NOT replaced. The server does not reissue it on
      // unlock — the three-day window runs from the password login and must
      // not slide — so the record on file stays exactly as it was.

      // replace(), not assign(): the lock screen must not be a Back target.
      window.location.replace(safeNext());
    } catch (err) {
      setBusy(false);
      unlocking = false;
      input.value = '';

      if (err.status === 429) {
        var wait = err.retryAfter
          ? ' Try again in about ' + Math.ceil(err.retryAfter / 60) + ' minute(s), or use your password.'
          : '';
        showError((err.message || 'Too many incorrect PINs.') + wait);
        // A locked-out PIN field invites more wrong guesses it will not
        // accept. The password is the way through, so point at it.
        if (altBtn) altBtn.focus();
        return;
      }

      if (err.status === 401 &&
          /password again/i.test(err.message || '')) {
        // The device token expired, or the PIN was turned off from another
        // session. Neither is recoverable here.
        toPassword(err.message);
        return;
      }

      showError(err.message || 'That PIN is not correct.');
      input.focus();
    }
  });

  /* ------------------------------------------------------------- fall back */

  if (altBtn) {
    altBtn.addEventListener('click', function () {
      // An explicit choice to stop using the PIN on this browser, so the
      // remembered device goes too. The next password sign-in can opt back in.
      toPassword();
    });
  }
})();
