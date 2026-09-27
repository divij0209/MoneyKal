/* ==========================================================================
   MoneyKal PIN — the client half of the device unlock layer.

   WHAT THIS FILE IS ALLOWED TO HOLD
   --------------------------------
   The DEVICE TOKEN, and nothing else. That token is a signed statement from
   the server that "this browser completed a password login on <date>"; it is
   not a credential, it opens nothing on its own, and every API route except
   /auth/pin/unlock rejects it outright.

   WHAT THIS FILE MUST NEVER HOLD
   ------------------------------
   The PIN, any hash or transformation of the PIN, and any "attempts
   remaining" counter. All three live on the server. A four-digit PIN is ten
   thousand candidates: verified here, the hash would be handed to whoever
   opened devtools and the counter would be theirs to edit. `unlock()` below
   passes the typed PIN straight to the server and keeps no copy — it is never
   assigned to a variable that outlives the call, never logged, and never put
   in storage.

   The access token is NOT managed here. js/pin-gate.js owns its lifetime,
   because the rule it enforces ("a PIN on every page load") is a property of
   the page load, not of this module.
   ========================================================================== */
(function (global) {
  'use strict';

  var API = (global.API_BASE) || '';

  /* The device record. A plain object under one key:
       { token, expires_at (ISO), username }
     `username` is here so the lock screen can say whose account it is about
     to unlock — login.html already remembers the same address under
     `moneykal_remembered_user`, so this discloses nothing new. */
  var DEVICE_KEY = 'moneykal_device';

  function readJSON(store, key) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      // Private mode, disabled storage, or a value someone hand-edited into
      // something that is not JSON. All three mean "no remembered device",
      // which is the safe reading: the password path still works.
      return null;
    }
  }

  function getDevice() {
    var rec = readJSON(global.localStorage, DEVICE_KEY);
    if (!rec || typeof rec.token !== 'string' || !rec.token) return null;
    return rec;
  }

  function setDevice(token, expiresInSeconds, username) {
    var rec = {
      token: token,
      // Stored as an absolute instant so a reopen days later can tell the user
      // how long is left without asking the server. It is a DISPLAY value and
      // a fast path only — the token carries its own `exp`, and the server is
      // what actually enforces it. A clock someone winds back buys nothing.
      expires_at: new Date(Date.now() + (expiresInSeconds || 0) * 1000).toISOString(),
      username: username || ''
    };
    try {
      global.localStorage.setItem(DEVICE_KEY, JSON.stringify(rec));
    } catch (e) { /* private mode: the device simply is not remembered */ }
    return rec;
  }

  function clearDevice() {
    try { global.localStorage.removeItem(DEVICE_KEY); } catch (e) { /* no-op */ }
  }

  /** True when the three-day window has demonstrably passed. Unreadable or
   *  missing expiry reads as NOT expired, so the decision falls to the server
   *  rather than to a local value that could be wrong in either direction. */
  function isExpired(rec) {
    rec = rec || getDevice();
    if (!rec || !rec.expires_at) return false;
    var t = Date.parse(rec.expires_at);
    return !isNaN(t) && t <= Date.now();
  }

  /** Whole days left on the device token, floored, never negative. */
  function daysLeft(rec) {
    rec = rec || getDevice();
    if (!rec || !rec.expires_at) return null;
    var t = Date.parse(rec.expires_at);
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor((t - Date.now()) / 86400000));
  }

  /* ---------------------------------------------------------------- errors */

  /** An Error carrying the HTTP status, so callers can tell a wrong PIN (401)
   *  from a lockout (429) from the service being unreachable. */
  function httpError(status, message, retryAfter) {
    var err = new Error(message);
    err.status = status;
    if (retryAfter) err.retryAfter = retryAfter;
    return err;
  }

  async function readDetail(res, fallback) {
    try {
      var body = await res.json();
      if (body && typeof body.detail === 'string' && body.detail) return body.detail;
    } catch (e) { /* non-JSON body — fall through */ }
    return fallback;
  }

  function networkError(err) {
    // fetch() rejects with TypeError when the request never completed at all.
    return (err instanceof TypeError)
      ? httpError(0, 'Cannot reach the MoneyKal service. Check your connection and try again.')
      : err;
  }

  function bearer() {
    var sess = readJSON(global.localStorage, 'twin_session') || {};
    return sess.token ? { 'Authorization': 'Bearer ' + sess.token } : {};
  }

  /* ------------------------------------------------------------------ API */

  /**
   * Trade (device token + PIN) for an access token.
   *
   * The PIN arrives as an argument, goes into the request body, and is gone
   * when this function returns. Nothing here keeps it.
   */
  async function unlock(pin) {
    var rec = getDevice();
    if (!rec) throw httpError(401, 'This device needs to sign in with a password again.');

    var res;
    try {
      res = await fetch(API + '/auth/pin/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_token: rec.token, pin: pin })
      });
    } catch (err) {
      throw networkError(err);
    }

    if (!res.ok) {
      var retry = Number(res.headers.get('Retry-After') || 0);
      throw httpError(res.status, await readDetail(res, 'That PIN is not correct.'), retry);
    }
    return res.json();
  }

  /** Whether this account has a PIN. Requires a signed-in session. */
  async function status() {
    var res;
    try {
      res = await fetch(API + '/auth/pin/status', { headers: bearer() });
    } catch (err) {
      throw networkError(err);
    }
    if (!res.ok) throw httpError(res.status, await readDetail(res, 'Could not read your PIN settings.'));
    return res.json();
  }

  /**
   * Create or replace the account PIN.
   *
   * `password` is required by the server — installing a PIN is a credential
   * change, so a borrowed access token alone must not be able to do it. It is
   * passed through and not retained.
   */
  async function setPin(pin, password) {
    var res;
    try {
      res = await fetch(API + '/auth/pin/set', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, bearer()),
        body: JSON.stringify({ pin: pin, password: password })
      });
    } catch (err) {
      throw networkError(err);
    }
    if (!res.ok) {
      var retry = Number(res.headers.get('Retry-After') || 0);
      throw httpError(res.status, await readDetail(res, 'Could not save your PIN.'), retry);
    }
    return res.json();
  }

  /** Turn the PIN off. The remembered device goes with it — without a PIN a
   *  device token can no longer unlock anything, so keeping one would only
   *  strand this browser on a lock screen it can never pass. */
  async function clearPin() {
    var res;
    try {
      res = await fetch(API + '/auth/pin', { method: 'DELETE', headers: bearer() });
    } catch (err) {
      throw networkError(err);
    }
    if (!res.ok) throw httpError(res.status, await readDetail(res, 'Could not turn off your PIN.'));
    clearDevice();
    return res.json();
  }

  /* ------------------------------------------------------------ validation */

  var WEAK = [
    '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888',
    '9999', '1234', '4321', '0123', '1212', '1122', '2580', '1004',
    '000000', '111111', '123456', '654321', '121212', '112233', '123123'
  ];

  /**
   * The same rules the server applies, checked here first so a typo is
   * answered instantly instead of after a round trip. This is a CONVENIENCE,
   * not the enforcement: /auth/pin/set re-checks every one of these, because
   * anything decided in a browser can be skipped.
   *
   * Returns null when the PIN is acceptable, or a message to show.
   */
  function validate(pin) {
    pin = (pin || '').trim();
    if (!/^[0-9]*$/.test(pin)) return 'Your PIN must be digits only.';
    if (pin.length !== 4 && pin.length !== 6) return 'Choose a 4- or 6-digit PIN.';
    if (WEAK.indexOf(pin) !== -1) return 'That PIN is too easy to guess. Choose a less obvious one.';
    // Every digit the same — 4444, 888888. The server rejects these too.
    if (/^(.)\1*$/.test(pin)) return 'That PIN is too easy to guess. Choose a less obvious one.';
    return null;
  }

  global.MKPin = {
    getDevice: getDevice,
    setDevice: setDevice,
    clearDevice: clearDevice,
    isExpired: isExpired,
    daysLeft: daysLeft,
    unlock: unlock,
    status: status,
    setPin: setPin,
    clearPin: clearPin,
    validate: validate
  };
})(window);
