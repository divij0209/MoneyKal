// auth.js - Handles logic for login.html and register.html

/* Resolved by js/config.js, which must load first. Kept as a local const so
   every existing reference in this file is unchanged. The fallback keeps the
   file working if it is ever loaded on a page that forgot config.js. */
const API_BASE = (typeof window !== 'undefined' && window.API_BASE)
  ? window.API_BASE
  : `http://${(!window.location.hostname || window.location.hostname === 'localhost') ? '127.0.0.1' : window.location.hostname}:8000`;

// ---------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------

/**
 * Toggle a button's in-flight state.
 *
 * These buttons carry inner markup (a label span plus an arrow icon), so the
 * previous approach of assigning textContent wiped their contents and the icon
 * never came back. The CSS `.is-loading` state hides the label and layers a
 * spinner over it instead, leaving the markup and the button width untouched.
 */
function setBtnLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('is-loading', loading);
  if (loading) {
    btn.setAttribute('aria-busy', 'true');
  } else {
    btn.removeAttribute('aria-busy');
  }
}

/** Show a success message in a `.mk-alert` container. */
function showSuccess(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ---------------------------------------------------------
// Terms & Conditions gate
//
// js/terms-consent.js owns the checkbox state, the inline validation message
// and the dialog. This wrapper is what the two submit handlers call, and it
// fails open when that script is absent so a load failure cannot lock anyone
// out of an account they already have.
// ---------------------------------------------------------
function termsGate(checkboxId) {
  if (!window.MKTerms) return true;
  return window.MKTerms.validate({ checkboxId });
}

/** Merges the acceptance record into a request body, when one was given. */
function withTerms(payload, checkboxId) {
  const accepted = window.MKTerms && window.MKTerms.acceptancePayload(checkboxId);
  return accepted ? Object.assign({}, payload, accepted) : payload;
}

// ---------------------------------------------------------
// Login Flow
// ---------------------------------------------------------
const loginForm = document.getElementById('loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('loginError');

    // Checked before anything else happens: no button spinner, no request,
    // no session written until the Terms have been accepted.
    if (!termsGate('loginTerms')) return;

    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value.trim();
    const btn = document.getElementById('btnLogin');

    setBtnLoading(btn, true);

    try {
      // `remember_device` is what makes the server mint a device token. It is
      // optional and defaults to false, so a backend that predates the PIN
      // simply ignores it and this form behaves exactly as it always did.
      const rememberDevice = !!(document.getElementById('rememberDevice') || {}).checked;

      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withTerms({
          username: email,
          password: password,
          remember_device: rememberDevice
        }, 'loginTerms'))
      });

      if (!res.ok) {
        // Distinguish a rejected credential from a server fault. Both used to
        // surface as 'Invalid credentials', which sent people off resetting a
        // password that was never actually wrong.
        if (res.status === 401) throw new Error('That User ID and password do not match.');
        if (res.status >= 500) throw new Error('Something went wrong on our end. Please try again in a moment.');
        let detail = '';
        try { detail = (await res.json()).detail; } catch (e) { /* non-JSON body */ }
        throw new Error(typeof detail === 'string' && detail ? detail : 'Unable to sign in. Please try again.');
      }

      const data = await res.json();

      // Remember the User ID only — never the password.
      const remember = document.getElementById('rememberMe');
      if (remember && remember.checked) {
        localStorage.setItem('moneykal_remembered_user', email);
      } else {
        localStorage.removeItem('moneykal_remembered_user');
      }

      localStorage.setItem('twin_session', JSON.stringify({
        token: data.access_token,
        userId: data.user_id,
        username: data.username,
        profileKey: data.profile_key
      }));

      /* "Keep me signed in on this device".

         The server returns a device token only when it was asked for. With a
         PIN already on the account there is nothing more to do here; without
         one, the setup step below collects it — and that step needs the
         password, which is why it is handled on this page while the value
         typed above is still in a local and has not been stored anywhere. */
      if (data.device_token) {
        window.MKPin.setDevice(data.device_token, data.device_expires_in, data.username || email);

        if (!data.pin_set) {
          setBtnLoading(btn, false);
          openPinSetup(password, data);
          return;
        }
      } else {
        // Either the box was not ticked or this is an older backend. Any
        // device record from a previous sign-in no longer matches the session
        // that is now live, so it goes.
        window.MKPin.clearDevice();
      }

      goAfterLogin(data);
    } catch (err) {
      // fetch() rejects with a TypeError when the request never completed at
      // all — server down, or blocked before a response was readable.
      const msg = (err instanceof TypeError)
        ? 'Cannot reach the MoneyKal service. Check your connection and try again.'
        : err.message;
      showError('loginError', msg);
      setBtnLoading(btn, false);
    }
  });
}

// ---------------------------------------------------------
// Where a completed sign-in goes.
//
// One place, because three paths now reach it: an ordinary sign-in, a sign-in
// that set up a PIN on the way, and one that skipped the PIN step.
// ---------------------------------------------------------
function goAfterLogin(data) {
  /* Authorise the page this is about to navigate to.

     js/pin-gate.js demands a PIN for every load of an app page on a
     remembered device. The password was just typed, which is a STRONGER
     proof than the PIN, so making someone follow it with a PIN two seconds
     later would be nothing but friction. The pass is single-use, so the
     protection returns on the very next load — including a refresh of the
     page we are about to open. */
  if (window.MKPin && window.MKPin.getDevice()) {
    // A timestamp, honoured by js/pin-gate.js for a few seconds only. See the
    // matching note in js/unlock.js.
    try { sessionStorage.setItem('moneykal_unlock_pass', String(Date.now())); } catch (e) { /* private mode */ }
  }

  if (data.profile_key && data.profile_key.trim() !== '') {
    window.location.href = 'dashboard.html';
  } else {
    window.location.href = 'register.html?resume=true';
  }
}

// ---------------------------------------------------------
// First-time PIN setup, shown after a successful sign-in when the user asked
// to stay signed in and the account has no PIN yet.
//
// THE PASSWORD
//   POST /auth/pin/set requires it: installing a PIN is a credential change,
//   and a borrowed access token must not be able to make one. The value lives
//   in the `password` parameter below for as long as this step is on screen —
//   in memory, in one closure, on the same page load that typed it. It is
//   never written to storage, never put in a URL, and released on exit.
//
// THE PIN
//   Read from the field, sent, and cleared. Nothing keeps it.
// ---------------------------------------------------------
function openPinSetup(password, loginData) {
  const panel = document.getElementById('pinSetup');
  if (!panel) { goAfterLogin(loginData); return; }   // markup absent: don't strand anyone

  const form = document.getElementById('pinSetupForm');
  const newEl = document.getElementById('pinSetupNew');
  const confirmEl = document.getElementById('pinSetupConfirm');
  const btn = document.getElementById('btnPinSetup');
  const skip = document.getElementById('btnPinSkip');

  panel.hidden = false;
  document.body.classList.add('pin-setup-open');
  setTimeout(() => { try { newEl.focus(); } catch (e) { /* no-op */ } }, 60);

  // Digits only, whatever arrives — a paste, an autofill, a phone keyboard.
  [newEl, confirmEl].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', () => {
      const cleaned = el.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (cleaned !== el.value) el.value = cleaned;
      hideError('pinSetupError');
    });
  });

  /** Clear the fields and drop the password reference before navigating. */
  function finish(go) {
    if (newEl) newEl.value = '';
    if (confirmEl) confirmEl.value = '';
    password = null;
    go();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('pinSetupError');

    const pin = newEl.value;
    const problem = window.MKPin.validate(pin);
    if (problem) { showError('pinSetupError', problem); newEl.focus(); return; }
    if (pin !== confirmEl.value) {
      showError('pinSetupError', 'Those two PINs are different.');
      confirmEl.value = '';
      confirmEl.focus();
      return;
    }

    setBtnLoading(btn, true);
    try {
      await window.MKPin.setPin(pin, password);
      finish(() => goAfterLogin(loginData));
    } catch (err) {
      setBtnLoading(btn, false);
      showError('pinSetupError', err.message || 'Could not save your PIN.');
      // The PIN they typed is probably the one they meant; only the confirm
      // field is cleared so the correction is a single retype.
      confirmEl.value = '';
      newEl.focus();
    }
  });

  if (skip) {
    skip.addEventListener('click', () => {
      /* Declining the PIN means declining the unlock layer. The device token
         is dropped: without a PIN it cannot open anything, and keeping it
         would send this browser to a lock screen it could never pass. This
         session continues as an ordinary password sign-in. */
      window.MKPin.clearDevice();
      finish(() => goAfterLogin(loginData));
    });
  }
}

// ---------------------------------------------------------
// A notice handed over by the lock screen — "use password instead", or the
// three days ran out. Shown on the sign-in form so the redirect is explained
// rather than silent.
// ---------------------------------------------------------
(function showLockNotice() {
  let notice = '';
  try {
    notice = new URLSearchParams(window.location.search).get('notice') || '';
  } catch (e) { return; }
  if (!notice) return;

  // Rendered with textContent by showError, so the value is inserted as text
  // and never as markup.
  showError('loginError', notice.slice(0, 200));

  // Drop the parameter so a refresh does not repeat the message.
  try {
    window.history.replaceState({}, '', window.location.pathname);
  } catch (e) { /* no-op */ }
})();

// ---------------------------------------------------------
// Registration Flow (Wizard)
// ---------------------------------------------------------
let selectedAccountType = 'individual'; // default
let currentStep = 1;

// Parse query params to optionally preselect type (e.g. ?type=startup)
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('type')) {
  selectedAccountType = urlParams.get('type').toLowerCase();
}

// Step 1: Type Selection
const typeOptions = document.querySelectorAll('#typeOptions .ob-option');
if (typeOptions.length > 0) {
  
  // Apply initial selection
  typeOptions.forEach(opt => {
    if (opt.dataset.type.toLowerCase() === selectedAccountType) {
      opt.classList.add('is-selected');
    } else {
      opt.classList.remove('is-selected');
    }
  });

  typeOptions.forEach(opt => {
    opt.addEventListener('click', () => {
      typeOptions.forEach(o => o.classList.remove('is-selected'));
      opt.classList.add('is-selected');
      selectedAccountType = opt.dataset.type.toLowerCase();
    });
  });

  const btnNext1 = document.getElementById('btnNext1');
  if (btnNext1) {
    btnNext1.addEventListener('click', () => {
      setStep(2);
    });
  }
}

// Wizard Step Navigation
function setStep(step) {
  document.querySelectorAll('.step-view').forEach(v => v.classList.remove('is-active'));
  currentStep = step;
  hideError('regError');
  // A banner from the previous step should not linger on the next one.
  if (step !== 3) hideError('regSuccess');
  
  if (step === 1) {
    document.getElementById('step1').classList.add('is-active');
  } else if (step === 2) {
    document.getElementById('step2').classList.add('is-active');
  } else if (step === 3) {
    document.getElementById(`step3-${selectedAccountType}`).classList.add('is-active');
  } else if (step === 4) {
    document.getElementById(`step4-${selectedAccountType}`).classList.add('is-active');
  } else if (step === 5) {
    document.getElementById(`step5-${selectedAccountType}`).classList.add('is-active');
  }

  updateStepRail(step);
}

// Coarse progress for the register rail. The startup path has five internal
// steps but only three stages that mean anything to a person, so steps 4 and
// 5 both read as stage 3 rather than inventing extra segments.
function updateStepRail(step) {
  const rail = document.getElementById('stepRail');
  if (!rail) return;

  const stage = step >= 3 ? 3 : step;
  rail.querySelectorAll('.step-rail__seg').forEach((seg) => {
    const n = Number(seg.dataset.seg);
    seg.classList.toggle('is-done', n < stage);
    seg.classList.toggle('is-current', n === stage);
  });

  const count = document.getElementById('stepCount');
  if (count) count.innerHTML = `<em>0${stage}</em> / 03`;
}

// Resume onboarding if needed
if (urlParams.has('zoho')) {
  const zohoStatus = urlParams.get('zoho');
  const savedState = JSON.parse(localStorage.getItem('twin_onboarding_state') || '{}');
  if (savedState.accountType) selectedAccountType = savedState.accountType;
  
  if (zohoStatus === 'success') {
    savedState.zohoConnected = true;
    localStorage.setItem('twin_onboarding_state', JSON.stringify(savedState));
    
    // Inject real data pulled from Zoho Books
    const cash = parseFloat(urlParams.get('cash') || 0);
    const rev = parseFloat(urlParams.get('rev') || 0);
    const burn = parseFloat(urlParams.get('burn') || 0);

    document.getElementById('suCurrentCash').value = cash;
    document.getElementById('suMonthlyRevenue').value = rev;
    document.getElementById('suMonthlyBurn').value = burn;
    document.getElementById('zohoMsg').style.display = 'block';
    
    if (cash === 0 && rev === 0 && burn === 0) {
      document.getElementById('zohoMsg').textContent = '✅ Zoho Books connected! (Note: No active transactions found, please fill manually)';
    } else {
      document.getElementById('zohoMsg').textContent = '✅ Zoho Books connected. We imported your real data. Please review.';
    }
    
    document.getElementById('step5Title').textContent = 'Confirm Financial Details';
    
    updateCalculations();
    setStep(5);
  } else {
    alert("Zoho connection failed or was cancelled. Please try again or use Manual Entry.");
    setStep(4);
  }
} else if (urlParams.has('resume') && urlParams.get('resume') === 'true') {
  const savedState = JSON.parse(localStorage.getItem('twin_onboarding_state') || '{}');
  if (savedState.accountType) selectedAccountType = savedState.accountType;
  
  if (!savedState.startupProfileCompleted) {
    setStep(3);
  } else if (!savedState.financialSetupCompleted) {
    setStep(4);
  } else {
    setStep(3); // fallback
  }
}

// Helper: Make authenticated POST request
async function authFetch(endpoint, payload) {
  const sess = JSON.parse(localStorage.getItem('twin_session') || '{}');
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sess.token}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'An error occurred on the server.');
  }
  return res.json();
}

// Step 2: Create Account
const accountForm = document.getElementById('accountForm');
if (accountForm) {
  accountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('regError');

    // The account is not created until the Terms have been accepted and every
    // field is valid. Both are checked on the same submit so every problem is
    // shown at once; the field check runs second so focus lands on the first
    // invalid field rather than on the Terms box.
    const termsOk = termsGate('regTerms');
    const fieldsOk = !window.MKSignup || window.MKSignup.validate('accountForm');
    if (!termsOk || !fieldsOk) return;

    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    const btn = document.getElementById('btnCreateAccount');

    setBtnLoading(btn, true);

    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withTerms({ username: email, password: password }, 'regTerms'))
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Registration failed');
      }

      const data = await res.json();
      // Store token immediately to proceed with profile building
      localStorage.setItem('twin_session', JSON.stringify({
        token: data.access_token,
        userId: data.user_id,
        username: data.username,
        profileKey: data.profile_key
      }));

      showSuccess('regSuccess', "Account created. Let's set up your financial brain.");
      setStep(3);
    } catch (err) {
      showError('regError', err.message);
    } finally {
      setBtnLoading(btn, false);
    }
  });
}

// Step 3: Complete Individual Profile
const indForm = document.getElementById('individualForm');
if (indForm) {
  indForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('regError');
    // Every field on this step is required and checked (js/signup-rules.js).
    // Nothing is sent, and no spinner starts, until they all pass.
    if (window.MKSignup && !window.MKSignup.validate('individualForm')) return;
    const btn = document.getElementById('btnIndSubmit');
    setBtnLoading(btn, true);

    const sess = JSON.parse(localStorage.getItem('twin_session') || '{}');
    const regNameEl = document.getElementById('regName');
    const regEmailEl = document.getElementById('regEmail');

    const payload = {
      full_name: regNameEl ? regNameEl.value.trim() : 'Individual User',
      email: regEmailEl ? regEmailEl.value.trim() : (sess.username || ''),
      mobile: (document.getElementById('indMobile')?.value || '').trim(),
      occupation: (document.getElementById('indOccupation')?.value || '').trim(),
      city: (document.getElementById('indCity')?.value || '').trim(),
      monthly_income: Number(document.getElementById('indIncome')?.value || 0),
      total_savings: Number(document.getElementById('indSavings')?.value || 0),
      monthly_expenses: Number(document.getElementById('indExpenses')?.value || 0),
      outstanding_loans: Number(document.getElementById('indLoans')?.value || 0),
      existing_investments: Number(document.getElementById('indInvestments')?.value || 0),
      insurance_coverage: Number(document.getElementById('indInsurance')?.value || 0),
      dependents: Number(document.getElementById('indDependents')?.value || 0),
      goal_title: (document.getElementById('indGoalTitle')?.value || '').trim() || 'Financial Independence',
      goal_target_amount: Number(document.getElementById('indGoalTarget')?.value || 0),
      goal_target_date: document.getElementById('indGoalDate')?.value || null
    };

    try {
      await authFetch('/onboard/confirm', payload);
      sess.profileKey = 'individual';
      localStorage.setItem('twin_session', JSON.stringify(sess));
      window.location.href = 'dashboard.html';
    } catch (err) {
      showError('regError', err.message);
      setBtnLoading(btn, false);
    }
  });
}

// Step 3: Complete Startup Profile
const suProfileForm = document.getElementById('startupProfileForm');
if (suProfileForm) {
  suProfileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    hideError('regError');
    // Every field on this step is required and checked (js/signup-rules.js).
    // Nothing is sent, and no spinner starts, until they all pass.
    if (window.MKSignup && !window.MKSignup.validate('startupProfileForm')) return;

    const state = JSON.parse(localStorage.getItem('twin_onboarding_state') || '{}');
    state.accountType = 'startup';
    state.companyName = document.getElementById('suCompanyName').value;
    state.industry = document.getElementById('suIndustry').value;
    state.businessModel = document.getElementById('suBusinessModel').value;
    state.stage = document.getElementById('suStage').value;
    state.headcount = Number(document.getElementById('suHeadcount').value || 1);
    state.gstNumber = (document.getElementById('suGstNumber')?.value || '').trim().toUpperCase();
    state.startupProfileCompleted = true;
    
    localStorage.setItem('twin_onboarding_state', JSON.stringify(state));
    setStep(4);
  });
}

// Step 4: Financial Setup Choice
let selectedFinType = 'manual';
const finSetupOptions = document.querySelectorAll('#finSetupOptions .ob-option');
if (finSetupOptions.length > 0) {
  finSetupOptions.forEach(opt => {
    opt.addEventListener('click', () => {
      finSetupOptions.forEach(o => o.classList.remove('is-selected'));
      opt.classList.add('is-selected');
      selectedFinType = opt.dataset.finType;
    });
  });

  const btnNext4 = document.getElementById('btnNext4Startup');
  if (btnNext4) {
    btnNext4.addEventListener('click', () => {
      const state = JSON.parse(localStorage.getItem('twin_onboarding_state') || '{}');
      if (selectedFinType === 'zoho') {
        // Trigger real Zoho OAuth Flow
        setBtnLoading(btnNext4, true);
        
        // Save state so we can resume properly when callback returns
        state.zohoConnected = false; 
        localStorage.setItem('twin_onboarding_state', JSON.stringify(state));
        
        window.location.href = `${API_BASE}/api/zoho/auth`;
      } else {
        document.getElementById('zohoMsg').style.display = 'none';
        document.getElementById('step5Title').textContent = 'Enter Financial Details';
        state.zohoConnected = false;
        localStorage.setItem('twin_onboarding_state', JSON.stringify(state));
        setStep(5);
      }
    });
  }
}

// Auto-calculations for Step 5
function updateCalculations() {
  const cash = Number(document.getElementById('suCurrentCash').value || 0);
  const rev = Number(document.getElementById('suMonthlyRevenue').value || 0);
  const burn = Number(document.getElementById('suMonthlyBurn').value || 0);
  
  const netCashFlow = rev - burn;
  const runway = (netCashFlow < 0 && cash > 0) ? (cash / Math.abs(netCashFlow)).toFixed(1) : '\u221E';
  
  // 'en-IN' is explicit on purpose. A bare toLocaleString() formats in the
  // VIEWER's locale, so this panel rendered Western grouping on a US-configured
  // laptop and the team could not know what a reviewer would actually see.
  document.getElementById('calcCashFlow').textContent = (netCashFlow < 0 ? '-' : '+') + '\u20B9' + Math.abs(netCashFlow).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  document.getElementById('calcCashFlow').style.color = netCashFlow < 0 ? 'var(--mk-danger)' : 'var(--mk-cyan)';
  document.getElementById('calcRunway').textContent = runway;
  document.getElementById('calcRunway').style.color = (runway !== '\u221E' && runway < 6) ? 'var(--mk-danger)' : 'var(--mk-cyan)';
}

const calcInputs = ['suCurrentCash', 'suMonthlyRevenue', 'suMonthlyBurn'];
calcInputs.forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateCalculations);
});

// Step 5: Final Submission
const suFinForm = document.getElementById('startupFinForm');
if (suFinForm) {
  suFinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('regError');
    // Every field on this step is required and checked (js/signup-rules.js).
    // Nothing is sent, and no spinner starts, until they all pass.
    if (window.MKSignup && !window.MKSignup.validate('startupFinForm')) return;
    const btn = document.getElementById('btnSuSubmit');
    setBtnLoading(btn, true);

    const state = JSON.parse(localStorage.getItem('twin_onboarding_state') || '{}');
    state.financialSetupCompleted = true;
    localStorage.setItem('twin_onboarding_state', JSON.stringify(state));

    const payload = {
      founder: { name: "Founder", email: "", mobile: "", preferred_language: "English" },
      company: { 
        name: state.companyName || "My Startup", 
        industry: state.industry || "",
        business_model: state.businessModel || "", 
        founded_year: new Date().getFullYear(), 
        stage: state.stage || "", 
        location: "", 
        website: "", 
        headcount: state.headcount || 1,
        gst_number: state.gstNumber || null
      },
      revenue: {
        is_pre_revenue: (Number(document.getElementById('suMonthlyRevenue').value || 0) === 0),
        monthly_revenue: Number(document.getElementById('suMonthlyRevenue').value || 0),
        revenue_streams: [], revenue_growth_pct: null, paying_customers: 0
      },
      expenses: {
        fixed_costs: Number(document.getElementById('suMonthlyBurn').value || 0), // Assumed as total for simplification
        variable_costs: 0
      },
      cash: {
        current_cash: Number(document.getElementById('suCurrentCash').value || 0),
        monthly_burn: Number(document.getElementById('suMonthlyBurn').value || 0)
      },
      debt: { business_loans_debt: Number(document.getElementById('suDebt').value || 0) },
      funding: { 
        total_funding: Number(document.getElementById('suTotalFunding').value || 0), 
        last_round: "", 
        currently_fundraising: false, 
        fundraising_target: null 
      },
      team: { planned_hires: 0, cost_per_hire: 0 },
      goals: [],
      current_decision: ""
    };

    try {
      await authFetch('/onboard/startup', payload);
      
      // Update session with new profileKey
      const sess = JSON.parse(localStorage.getItem('twin_session') || '{}');
      sess.profileKey = 'startup';
      localStorage.setItem('twin_session', JSON.stringify(sess));
      
      // Mark global onboarding complete
      state.onboardingCompleted = true;
      localStorage.setItem('twin_onboarding_state', JSON.stringify(state));
      
      window.location.href = 'dashboard.html';
    } catch (err) {
      showError('regError', err.message);
      setBtnLoading(btn, false);
    }
  });
}


// The Enterprise / CFO onboarding handler was removed with the persona.
// Its form no longer exists in register.html and POST /onboard/enterprise
// returns 410; leaving the listener would have kept a path to an endpoint
// whose only remaining effect was to lock an account out of sign-in.

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function togglePasswordVisibility(inputId, iconEl) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-eye-off"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  } else {
    input.type = 'password';
    iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-eye"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  }

  // Revealing is a mid-typing action, so put the caret back where it was
  // rather than dropping focus on the page body.
  const caret = input.value.length;
  input.focus();
  if (input.setSelectionRange) input.setSelectionRange(caret, caret);
  syncPasswordMascot(input);
}

// ---------------------------------------------------------
// Password mascot: the monkey covers its eyes exactly when there
// is something to see. While the field is masked your password is
// a row of dots, so it watches quite happily; the moment you reveal
// the characters it claps its hands over its eyes and looks away.
// ---------------------------------------------------------
function syncPasswordMascot(input) {
  const wrapper = input.closest('.password-wrapper');
  const mascot = wrapper && wrapper.querySelector('.password-mascot');
  if (!mascot) return;

  mascot.classList.toggle('is-covering', input.type !== 'password');
}

document.querySelectorAll('.password-wrapper input').forEach((input) => {
  syncPasswordMascot(input);
});

// Excel Registration Helpers
// ---------------------------------------------------------
function setupRegistrationExcelHandlers() {
  const fileInd = document.getElementById('regExcelFileInd');
  const fileSu = document.getElementById('regExcelFileSu');

  /* The Excel template links are plain anchors, so they cannot interpolate the
     API base the way js/app.js does for the same endpoint. They used to be
     hardcoded to http://127.0.0.1:8000, which on anyone else's machine points
     at THEIR localhost. The markup now carries the path alone and the base is
     prefixed here; if this never runs the href stays a same-origin path, which
     404s locally rather than reaching out to a stranger's port 8000. */
  document.querySelectorAll('a[data-api-href]').forEach((a) => {
    const path = a.getAttribute('href') || '';
    if (path.startsWith('/') && window.API_BASE) a.href = window.API_BASE + path;
  });

  async function handleRegUpload(file, persona) {
    if (!file) return;
    const sess = JSON.parse(localStorage.getItem('twin_session') || '{}');
    if (!sess.token) {
      alert('Please complete Step 1 (account creation) first.');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API_BASE}/onboard/excel/upload?persona_override=${persona}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sess.token}` },
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Excel upload failed');

      let msg = data.message || 'Excel data uploaded successfully.';
      if (data.errors && data.errors.length > 0) {
        msg += '\n\nSkipped fields due to errors:\n' + data.errors.map(err => `• ${err.field}: ${err.error}`).join('\n');
      }
      alert(msg + '\n\nRedirecting to dashboard...');
      window.location.href = 'dashboard.html';
    } catch (err) {
      alert(`Upload error: ${err.message}`);
    }
  }

  fileInd?.addEventListener('change', (e) => handleRegUpload(e.target.files[0], 'individual'));
  fileSu?.addEventListener('change', (e) => handleRegUpload(e.target.files[0], 'startup'));
}

document.addEventListener('DOMContentLoaded', setupRegistrationExcelHandlers);

// ---------------------------------------------------------
// Forgot-password modal
//
// NOTE: the backend does not expose a password-reset route yet. This talks to
// POST /auth/forgot-password, which is where that route should land. Until it
// exists the request 404s and the modal says so plainly rather than showing a
// "check your inbox" confirmation for an email nobody sent.
// ---------------------------------------------------------
(function setupForgotPassword() {
  const modal = document.getElementById('forgotModal');
  if (!modal) return;

  const openBtn   = document.getElementById('btnForgotOpen');
  const form      = document.getElementById('forgotForm');
  const input     = document.getElementById('forgotEmail');
  const btn       = document.getElementById('btnForgot');
  const formView  = document.getElementById('forgotFormView');
  const sentView  = document.getElementById('forgotSentView');
  const sentTo    = document.getElementById('forgotSentTarget');
  let lastFocused = null;

  function open() {
    lastFocused = document.activeElement;
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    // Carry over whatever they already typed on the sign-in form.
    const typed = (document.getElementById('authEmail') || {}).value;
    if (typed && !input.value) input.value = typed.trim();
    setTimeout(() => input.focus(), 60);
  }

  function close() {
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    hideError('forgotError');
    setBtnLoading(btn, false);
    // Reset to the request view so a reopen does not land on the confirmation.
    formView.classList.add('is-active');
    sentView.classList.remove('is-active');
    if (lastFocused) lastFocused.focus();
  }

  openBtn?.addEventListener('click', open);
  modal.querySelectorAll('[data-forgot-close]').forEach((el) => el.addEventListener('click', close));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('forgotError');

    const value = input.value.trim();
    if (!value) {
      showError('forgotError', 'Enter the User ID on your account.');
      input.focus();
      return;
    }

    setBtnLoading(btn, true);
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: value })
      });

      if (res.status === 404 || res.status === 405 || res.status === 501) {
        throw new Error('Password reset is not available yet. Please contact support to regain access.');
      }
      if (!res.ok) {
        throw new Error('Could not send the reset link. Please try again shortly.');
      }

      sentTo.textContent = value;
      formView.classList.remove('is-active');
      sentView.classList.add('is-active');
    } catch (err) {
      const msg = (err instanceof TypeError)
        ? 'Cannot reach the MoneyKal service. Check your connection and try again.'
        : err.message;
      showError('forgotError', msg);
    } finally {
      setBtnLoading(btn, false);
    }
  });
})();

// ---------------------------------------------------------
// Restore a remembered User ID on the sign-in form
// ---------------------------------------------------------
(function restoreRememberedUser() {
  const field = document.getElementById('authEmail');
  const box   = document.getElementById('rememberMe');
  if (!field || !box) return;

  let saved = null;
  try { saved = localStorage.getItem('moneykal_remembered_user'); } catch (e) { /* private mode */ }
  if (saved) {
    field.value = saved;
    box.checked = true;
    document.getElementById('authPassword')?.focus();
  }
})();
