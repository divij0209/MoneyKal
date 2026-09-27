/* ==========================================================================
   MoneyKal — account centre

   One dialog, opened from every avatar in the app, for everything about the
   person signed in: who they are, what MoneyKal knows about their money, how
   the product behaves for them, and how to leave.

   WHAT THIS REPLACES
   ------------------
   Two different dropdowns. The Overview header's had grown a profile-picture
   panel; the shared topbar's still offered only "Signed in / Log out". The
   same avatar therefore did different things depending on which view you were
   on. This is declared once in dashboard.html and wired to both, so the
   Individual and Startup/CFO journeys are identical by construction.

   WHAT IT REUSES — deliberately, nothing here is new infrastructure
   ----------------------------------------------------------------
     · GET  /profile/me                  the profile, avatar and initials
     · PUT  /onboard/individual/update   the individual editor
     · PUT  /onboard/startup/update      the startup editor
     · js/avatar.js                      picture upload / replace / remove
     · window.setLanguage / currentLang  the existing translation engine
     · window.toggleTheme / currentTheme the existing theme store
     · #btnLogout                        the existing session teardown

   FIELD RENDERING
   ---------------
   Fields are described as data and rendered from the profile, so the
   Individual and Startup forms are the same code with different descriptors
   and no figure is ever hardcoded. Only fields the user actually changed are
   sent, which keeps a save from overwriting something another tab edited.
   ========================================================================== */
(function () {
  'use strict';

  var state = { profile: null, dirty: {}, loaded: false };

  function $(id) { return document.getElementById(id); }
  function T(s) { return window.t ? window.t(s) : s; }

  /* -------------------------------------------------------- field descriptors
     `key` is the field name the update route expects. `path` says where to
     read the current value from on the profile payload. */

  var INDIVIDUAL_DETAILS = [
    { key: 'full_name',  label: 'Full name',  type: 'text',  hint: 'Used to greet you and on your reports.' },
    { key: 'email',      label: 'Email',      type: 'email', hint: 'Your sign-in address.' },
    { key: 'mobile',     label: 'Mobile',     type: 'tel' },
    { key: 'occupation', label: 'Occupation', type: 'text',  hint: 'Used to read how stable your income is.' },
    { key: 'city',       label: 'City',       type: 'text',  hint: 'Sets the HRA metro cap in the tax engine.' }
  ];

  var INDIVIDUAL_MONEY = [
    { key: 'monthly_income',       label: 'Monthly income',     type: 'money' },
    { key: 'monthly_expenses',     label: 'Monthly expenses',   type: 'money' },
    { key: 'total_savings',        label: 'Total savings',      type: 'money' },
    { key: 'outstanding_loans',    label: 'Outstanding loans',  type: 'money' },
    { key: 'existing_investments', label: 'Investments',        type: 'money' },
    { key: 'insurance_coverage',   label: 'Life cover',         type: 'money' },
    { key: 'dependents',           label: 'Dependents',         type: 'int' },
    { key: 'goal_title',           label: 'Primary goal',       type: 'text' },
    { key: 'goal_target_amount',   label: 'Goal target',        type: 'money' }
  ];

  var STARTUP_DETAILS = [
    { key: 'founder_name',   label: 'Founder name',  type: 'text' },
    { key: 'founder_email',  label: 'Email',         type: 'email' },
    { key: 'founder_mobile', label: 'Mobile',        type: 'tel' },
    { key: 'company_name',   label: 'Company',       type: 'text' },
    { key: 'industry',       label: 'Industry',      type: 'text' },
    { key: 'location',       label: 'Location',      type: 'text' },
    { key: 'website',        label: 'Website',       type: 'text' }
  ];

  var STARTUP_MONEY = [
    { key: 'monthly_revenue',   label: 'Monthly revenue', type: 'money' },
    { key: 'fixed_costs',       label: 'Fixed costs',     type: 'money' },
    { key: 'variable_costs',    label: 'Variable costs',  type: 'money' },
    { key: 'current_cash',      label: 'Cash balance',    type: 'money' },
    { key: 'headcount',         label: 'Headcount',       type: 'int' },
    { key: 'stage',             label: 'Stage',           type: 'text' },
    { key: 'gst_number',        label: 'GSTIN',           type: 'text' }
  ];

  var PREFS = [
    { key: 'whatsapp_phone', label: 'WhatsApp number', type: 'tel',
      hint: 'Only used if you turn on WhatsApp alerts. Leave blank to remove it.' }
  ];

  function isStartup() {
    return !!(state.profile && state.profile.key === 'startup');
  }

  /** Read a field's current value out of whichever shape holds it. */
  function currentValue(key) {
    var p = state.profile || {};
    if (key === 'whatsapp_phone') return p.whatsapp_phone || '';
    if (isStartup()) return (p.details || {})[key];
    return (p.raw_inputs || {})[key];
  }

  /* ------------------------------------------------------------------ render */

  function fieldHtml(f) {
    var raw = currentValue(f.key);
    var val = (raw === null || raw === undefined) ? '' : String(raw);
    var inputType = (f.type === 'money' || f.type === 'int') ? 'number' : f.type;
    var extra = f.type === 'money' ? ' min="0" step="1"'
              : f.type === 'int' ? ' min="0" step="1"' : '';
    return '' +
      '<label class="acct__field">' +
        '<span class="acct__label">' + T(f.label) + '</span>' +
        '<input class="acct__input" type="' + inputType + '"' + extra +
               ' data-acct-key="' + f.key + '" value="' + escapeAttr(val) + '">' +
        (f.hint ? '<span class="acct__fieldhint">' + T(f.hint) + '</span>' : '') +
      '</label>';
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderFields() {
    var details = isStartup() ? STARTUP_DETAILS : INDIVIDUAL_DETAILS;
    var money = isStartup() ? STARTUP_MONEY : INDIVIDUAL_MONEY;

    var d = $('acctDetails');
    var m = $('acctMoney');
    var p = $('acctPrefs');
    if (d) d.innerHTML = details.map(fieldHtml).join('');
    if (m) m.innerHTML = money.map(fieldHtml).join('');
    if (p) p.innerHTML = PREFS.map(fieldHtml).join('');

    // One delegated listener per container, so re-rendering cannot stack them.
    [d, m, p].forEach(function (box) {
      if (!box || box.dataset.bound) return;
      box.dataset.bound = '1';
      box.addEventListener('input', function (e) {
        var key = e.target && e.target.getAttribute('data-acct-key');
        if (!key) return;
        state.dirty[key] = e.target.value;
        setStatus('');
      });
    });
  }

  function renderIdentity() {
    var p = state.profile || {};
    var raw = p.raw_inputs || {};
    var det = p.details || {};
    var name = (isStartup() ? det.founder_name : raw.full_name) || p.persona || 'Signed in';
    var email = (isStartup() ? det.founder_email : raw.email) || accountEmail() || '';

    if ($('acctName')) $('acctName').textContent = name;
    if ($('acctEmail')) $('acctEmail').textContent = email || T('MoneyKal account');
    if ($('acctPersona')) {
      $('acctPersona').textContent = isStartup() ? T('Startup / CFO') : T('Individual');
    }
    if ($('acctMoneyLede')) {
      $('acctMoneyLede').textContent = isStartup()
        ? T('The figures behind your burn, runway and fundraise readiness. Change one and every projection follows.')
        : T('The figures every projection, the tax engine and your Risk DNA are computed from. Change one and the whole app follows.');
    }
  }

  /** The signed-in address, read from the stored session rather than guessed. */
  function accountEmail() {
    try {
      return (JSON.parse(localStorage.getItem('twin_session') || '{}').username) || '';
    } catch (e) { return ''; }
  }

  function paintPrefs() {
    var lang = window.currentLang || 'en';
    document.querySelectorAll('[data-acct-lang]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-acct-lang') === lang);
    });
    var theme = document.documentElement.getAttribute('data-theme') || 'light';
    document.querySelectorAll('[data-acct-theme]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-acct-theme') === theme);
    });
  }

  function setStatus(text, kind) {
    var el = $('acctStatus');
    if (!el) return;
    el.textContent = text ? T(text) : '';
    el.className = 'acct__status' + (kind ? ' is-' + kind : '');
  }

  /* -------------------------------------------------------------------- load */

  async function load(force) {
    if (state.loaded && !force) return;
    try {
      var p = await window.api.fetchProfile();
      state.profile = p;
      state.loaded = true;
      state.dirty = {};
      renderIdentity();
      renderFields();
      if (window.mkAvatar) window.mkAvatar.hydrate(p);
    } catch (err) {
      setStatus('Could not load your account just now.', 'bad');
    }
    paintPrefs();
  }

  /* -------------------------------------------------------------------- save */

  async function save() {
    var keys = Object.keys(state.dirty);
    if (!keys.length) { setStatus('Nothing to save.'); return; }

    var payload = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = state.dirty[k];
      var spec = allFields().filter(function (f) { return f.key === k; })[0];
      if (spec && (spec.type === 'money' || spec.type === 'int')) {
        if (v === '') continue;                    // blank means "leave it"
        var n = Number(v);
        if (!isFinite(n) || n < 0) {
          setStatus('Enter a number of zero or more for ' + spec.label + '.', 'bad');
          return;
        }
        payload[k] = spec.type === 'int' ? Math.round(n) : n;
      } else {
        payload[k] = v;
      }
    }
    if (!Object.keys(payload).length) { setStatus('Nothing to save.'); return; }

    var btn = $('acctSave');
    if (btn) btn.disabled = true;
    setStatus('Saving…');
    try {
      await window.api.updateProfileDetails(payload, isStartup() ? 'startup' : 'individual');
      state.dirty = {};
      setStatus('Saved.', 'good');
      await load(true);
      // The rest of the app reads the profile at render time, so tell it to
      // repaint rather than asking the user to reload.
      document.dispatchEvent(new CustomEvent('mk:profileupdated'));
    } catch (err) {
      setStatus((err && err.message) || 'Could not save those changes.', 'bad');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function allFields() {
    return INDIVIDUAL_DETAILS.concat(INDIVIDUAL_MONEY, STARTUP_DETAILS, STARTUP_MONEY, PREFS);
  }

  /* -------------------------------------------------------------- open/close */

  var lastFocus = null;

  function open() {
    var dlg = $('acct');
    if (!dlg) return;
    lastFocus = document.activeElement;
    dlg.hidden = false;
    document.body.classList.add('acct-open');
    load();
    paintPrefs();
    // Re-read every time: the PIN can be changed from another tab, or turned
    // off from the lock screen, while this dialog sits closed.
    loadPin(true);
    var first = dlg.querySelector('.acct__close');
    if (first) first.focus();
  }

  function close() {
    var dlg = $('acct');
    if (!dlg || dlg.hidden) return;
    dlg.hidden = true;
    document.body.classList.remove('acct-open');
    setStatus('');
    // A PIN or password typed but not submitted must not survive the close.
    pinFormOpen(false);
    pinStatusMsg('');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function selectTab(name) {
    document.querySelectorAll('[data-acct-tab]').forEach(function (b) {
      var on = b.getAttribute('data-acct-tab') === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('[data-acct-pane]').forEach(function (s) {
      s.classList.toggle('is-active', s.getAttribute('data-acct-pane') === name);
    });
  }


  /* ==================================================================== PIN

     The Security pane's MoneyKal PIN card.

     Everything that decides anything is on the server: whether a PIN exists
     (GET /auth/pin/status), whether a new one is acceptable and whether the
     account password is right (POST /auth/pin/set). This code renders that
     state and collects input. It never holds the PIN beyond the request it is
     sent in, never stores it, and never logs it.
     ==================================================================== */

  var pinState = { set: false, setAt: null, deviceDays: 3, loaded: false };

  function pinStatusMsg(text, kind) {
    var el = $('acctPinStatus');
    if (!el) return;
    el.textContent = text ? T(text) : '';
    el.className = 'acct-pin__status' + (kind ? ' acct-pin__status--' + kind : '');
  }

  /** A date the way the rest of the account dialog writes them. */
  function pinNiceDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function paintPin() {
    var badge = $('acctPinBadge');
    var lede = $('acctPinLede');
    var setBtn = $('acctPinSetBtn');
    var offBtn = $('acctPinOffBtn');
    if (!badge) return;

    badge.textContent = pinState.set ? T('PIN on') : T('Not set');
    badge.className = 'acct-pin__badge acct-pin__badge--' + (pinState.set ? 'on' : 'off');

    if (setBtn) setBtn.textContent = pinState.set ? T('Change PIN') : T('Set up PIN');
    if (offBtn) offBtn.hidden = !pinState.set;

    if (lede) {
      var days = pinState.deviceDays || 3;
      lede.textContent = pinState.set
        ? T('Your PIN unlocks MoneyKal on a device you chose to stay signed in on, and is asked for every time the app is opened or refreshed. It is checked on our servers and never stored on your device. Your password is still required every ' + days + ' days.')
        : T('Set a 4- or 6-digit PIN to unlock MoneyKal on a device you chose to stay signed in on, instead of typing your password each time. It is checked on our servers and never stored on your device. Your password is still required every ' + days + ' days.');
    }

    if (pinState.set && pinState.setAt) {
      var when = pinNiceDate(pinState.setAt);
      if (when) pinStatusMsg('Last changed ' + when + '.');
    }
  }

  async function loadPin(force) {
    if (!window.MKPin || !$('acctPin')) return;
    if (pinState.loaded && !force) { paintPin(); return; }
    try {
      var st = await window.MKPin.status();
      pinState.set = !!st.pin_set;
      pinState.setAt = st.pin_set_at || null;
      pinState.deviceDays = st.device_days || 3;
      pinState.loaded = true;
      paintPin();
    } catch (err) {
      // A PIN card that cannot read its own state must not imply "no PIN" --
      // that would invite someone to "set up" a PIN they already have and be
      // confused by the result. Say what actually happened.
      var badge = $('acctPinBadge');
      if (badge) {
        badge.textContent = T('Unavailable');
        badge.className = 'acct-pin__badge acct-pin__badge--off';
      }
      pinStatusMsg(err.message || 'Could not read your PIN settings.', 'err');
    }
  }

  /** Empty every PIN field. Called on cancel, on success, and when the dialog
   *  closes, so a typed PIN or password is never left sitting in the DOM. */
  function pinClearInputs() {
    ['acctPinNew', 'acctPinConfirm', 'acctPinPassword'].forEach(function (id) {
      var el = $(id);
      if (el) el.value = '';
    });
  }

  function pinFormOpen(open) {
    var form = $('acctPinForm');
    if (!form) return;
    form.hidden = !open;
    var actions = $('acctPinActions');
    if (actions) actions.hidden = open;
    if (open) {
      pinStatusMsg('');
      var first = $('acctPinNew');
      if (first) first.focus();
    } else {
      pinClearInputs();
    }
  }

  async function pinSave() {
    var newEl = $('acctPinNew');
    var confirmEl = $('acctPinConfirm');
    var passEl = $('acctPinPassword');
    var saveBtn = $('acctPinSave');
    if (!newEl || !confirmEl || !passEl) return;

    var pin = newEl.value;
    var confirmPin = confirmEl.value;
    var password = passEl.value;

    // Checked here so a typo is answered instantly. The server re-checks every
    // one of these -- this is convenience, not enforcement.
    var problem = window.MKPin.validate(pin);
    if (problem) { pinStatusMsg(problem, 'err'); newEl.focus(); return; }
    if (pin !== confirmPin) {
      pinStatusMsg('Those two PINs are different.', 'err');
      confirmEl.focus();
      return;
    }
    if (!password) {
      pinStatusMsg('Enter your account password to confirm.', 'err');
      passEl.focus();
      return;
    }

    if (saveBtn) saveBtn.disabled = true;
    pinStatusMsg('Saving...');

    try {
      var res = await window.MKPin.setPin(pin, password);
      pinState.set = true;
      pinState.setAt = res.pin_set_at || new Date().toISOString();

      // Out of the DOM the moment the request has been answered.
      pinClearInputs();
      pinFormOpen(false);
      paintPin();
      pinStatusMsg('PIN saved. It will be asked for the next time this device is opened.', 'ok');
    } catch (err) {
      pinStatusMsg(err.message || 'Could not save your PIN.', 'err');
      // Only the password is cleared on failure: the PIN they typed is
      // probably the one they meant, and a wrong password is the usual cause.
      passEl.value = '';
      passEl.focus();
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function pinTurnOff() {
    var msg = T('Turn off your PIN? This device will ask for your password instead.');
    if (!window.confirm(msg)) return;

    var offBtn = $('acctPinOffBtn');
    if (offBtn) offBtn.disabled = true;
    pinStatusMsg('Turning off...');

    try {
      await window.MKPin.clearPin();
      pinState.set = false;
      pinState.setAt = null;
      paintPin();
      pinStatusMsg('PIN turned off. This device will ask for your password.', 'ok');
    } catch (err) {
      pinStatusMsg(err.message || 'Could not turn off your PIN.', 'err');
    } finally {
      if (offBtn) offBtn.disabled = false;
    }
  }

  function bootPin() {
    if (!$('acctPin')) return;

    var setBtn = $('acctPinSetBtn');
    if (setBtn) setBtn.addEventListener('click', function () { pinFormOpen(true); });

    var cancelBtn = $('acctPinCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      pinFormOpen(false);
      pinStatusMsg('');
    });

    var offBtn = $('acctPinOffBtn');
    if (offBtn) offBtn.addEventListener('click', pinTurnOff);

    var form = $('acctPinForm');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      pinSave();
    });

    // Digits only, whatever arrives -- a paste, an autofill, a phone keyboard.
    ['acctPinNew', 'acctPinConfirm'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () {
        var cleaned = el.value.replace(/[^0-9]/g, '').slice(0, 6);
        if (cleaned !== el.value) el.value = cleaned;
      });
    });
  }

  /* -------------------------------------------------------------------- boot */

  function boot() {
    document.querySelectorAll('[data-account-open]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); open(); });
    });
    document.querySelectorAll('[data-account-close]').forEach(function (b) {
      b.addEventListener('click', close);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
    document.querySelectorAll('[data-acct-tab]').forEach(function (b) {
      b.addEventListener('click', function () { selectTab(b.getAttribute('data-acct-tab')); });
    });

    document.querySelectorAll('[data-acct-lang]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (window.setLanguage) window.setLanguage(b.getAttribute('data-acct-lang'));
        paintPrefs();
      });
    });
    document.querySelectorAll('[data-acct-theme]').forEach(function (b) {
      b.addEventListener('click', function () {
        var want = b.getAttribute('data-acct-theme');
        var now = document.documentElement.getAttribute('data-theme') || 'light';
        if (want !== now && window.toggleTheme) window.toggleTheme();
        paintPrefs();
      });
    });
    // Keep the segmented controls right when the language or theme is changed
    // from the topbar buttons instead of from in here.
    document.addEventListener('mk:languagechange', paintPrefs);

    // Named saveBtn, not save: `save` is the function above and shadowing it
    // here would make the click handler call the element.
    var saveBtn = $('acctSave');
    if (saveBtn) saveBtn.addEventListener('click', function () { save(); });

    bootPin();

    var logout = $('acctLogout');
    if (logout) {
      logout.addEventListener('click', function () {
        close();
        var b = document.getElementById('btnLogout');   // owns session teardown
        if (b) b.click();
      });
    }
  }

  window.mkAccount = { open: open, close: close, reload: function () { return load(true); } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
