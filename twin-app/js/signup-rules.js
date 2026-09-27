/* ==========================================================================
   MoneyKal — sign-up field rules

   Every field in the registration wizard is required, and each one is checked
   for what it actually is: a 10-digit Indian mobile number, a GSTIN whose check
   digit adds up, a goal date that is in the future, an amount that is not
   negative. js/auth.js calls MKSignup.validate(formId) before it submits a
   step; nothing is sent while any field on that step is invalid.

   HOW ERRORS ARE SHOWN
     Every invalid field on the step is marked at once (red border, a message
     directly under it, aria-invalid), and focus moves to the first one, so a
     person fixes the form in one pass instead of discovering problems one
     submit at a time. A message clears as soon as the field is corrected.

   WHAT THIS IS NOT
     The server remains the authority. The account rules below mirror
     backend/routers/auth.py exactly (email shape, 8–128 character password,
     the common-password list), and the GSTIN rule mirrors the pattern
     backend/routers/onboarding.py accepts plus the check digit from
     backend/services/gst_service.py — so the form never accepts something the
     server would then reject. Messages are fixed strings so js/i18n.js can
     translate them.
   ========================================================================== */
(function () {
  'use strict';

  var MAX_AMOUNT = 1e12;   // ₹1 lakh crore: far above any real figure, below float trouble

  function str(v) { return (v == null ? '' : String(v)).trim(); }

  /* ------------------------------------------------------------ primitives */

  var LETTER = /\p{L}/u;

  function name(v) {
    v = str(v);
    if (!v) return 'Enter your full name.';
    if (v.length < 2 || v.length > 60) return 'Your name must be 2 to 60 characters.';
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(v)) return 'Use letters only in your name.';
    return null;
  }

  var COMMON_PASSWORDS = [
    'password', 'password1', 'password123', '12345678', '123456789',
    '1234567890', 'qwertyui', 'qwerty123', 'iloveyou', 'welcome1',
    'abc12345', 'letmein1', 'admin123', 'moneykal', 'changeme'
  ];

  function email(v) {
    v = str(v).toLowerCase();
    if (!v) return 'Enter your email address.';
    if (v.length > 254) return 'That email address is too long.';
    if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v)) return 'Enter a valid email address, like name@example.com.';
    return null;
  }

  function password(v) {
    v = str(v);
    if (!v) return 'Create a password.';
    if (v.length < 8) return 'Use at least 8 characters.';
    if (v.length > 128) return 'Use 128 characters or fewer.';
    if (COMMON_PASSWORDS.indexOf(v.toLowerCase()) !== -1) return 'That password is too common. Choose something harder to guess.';
    return null;
  }

  function mobile(v) {
    v = str(v);
    if (!v) return 'Enter your mobile number.';
    if (!/^\d+$/.test(v)) return 'Use digits only in the mobile number.';
    if (v.length !== 10) return 'A mobile number must be exactly 10 digits.';
    if (!/^[6-9]/.test(v)) return 'Indian mobile numbers start with 6, 7, 8 or 9.';
    return null;
  }

  function words(emptyMsg, min, max, badMsg) {
    return function (v) {
      v = str(v);
      if (!v) return emptyMsg;
      if (v.length < min || v.length > max || !LETTER.test(v)) return badMsg;
      return null;
    };
  }

  function city(v) {
    v = str(v);
    if (!v) return 'Enter your city.';
    if (v.length < 2 || v.length > 50 || !/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(v)) return 'Use letters only in the city name.';
    return null;
  }

  /** A rupee amount. `positive` requires more than zero. */
  function amount(emptyMsg, positive) {
    return function (v) {
      v = str(v);
      if (!v) return emptyMsg;
      var n = Number(v);
      if (!isFinite(n)) return 'Enter a number.';
      if (n < 0) return 'The amount cannot be negative.';
      if (positive && n <= 0) return 'The amount must be more than 0.';
      if (n > MAX_AMOUNT) return 'That amount is too large.';
      return null;
    };
  }

  function wholeNumber(emptyMsg, min, max, rangeMsg) {
    return function (v) {
      v = str(v);
      if (!v) return emptyMsg;
      if (!/^\d+$/.test(v)) return 'Use a whole number.';
      var n = Number(v);
      if (n < min || n > max) return rangeMsg;
      return null;
    };
  }

  function futureDate(v) {
    v = str(v);
    if (!v) return 'Choose a target date.';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return 'Choose a valid date.';
    var picked = new Date(+m[1], +m[2] - 1, +m[3]);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    if (picked <= today) return 'Choose a date in the future.';
    var limit = new Date(today); limit.setFullYear(limit.getFullYear() + 100);
    if (picked > limit) return 'Choose a date within the next 100 years.';
    return null;
  }

  function selected(msg) {
    return function (v) { return str(v) ? null : msg; };
  }

  /* GSTIN: the pattern the onboarding API accepts, plus the Luhn mod-36 check
     digit (see gstin_check_digit in backend/services/gst_service.py). A valid
     check digit proves the number is well-formed, not that it is registered. */
  var GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function gstinCheckDigit(first14) {
    var factor = 2, total = 0, mod = GSTIN_CHARS.length;
    for (var i = first14.length - 1; i >= 0; i--) {
      var idx = GSTIN_CHARS.indexOf(first14.charAt(i));
      if (idx < 0) return null;
      var addend = factor * idx;
      factor = factor === 2 ? 1 : 2;
      total += Math.floor(addend / mod) + (addend % mod);
    }
    return GSTIN_CHARS.charAt((mod - (total % mod)) % mod);
  }

  function gstin(v) {
    v = str(v).toUpperCase().replace(/\s+/g, '');
    if (!v) return 'Enter your GST number.';
    if (v.length !== 15) return 'A GSTIN has exactly 15 characters.';
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z\d]$/.test(v)) {
      return 'That is not a valid GSTIN: 2-digit state code, 10-character PAN, then 3 characters.';
    }
    if (gstinCheckDigit(v.slice(0, 14)) !== v.charAt(14)) {
      return 'That GSTIN does not add up. Check it for a typo.';
    }
    return null;
  }

  /* ---------------------------------------------------------- the wizard */

  var FORMS = {
    accountForm: {
      regName: name,
      regEmail: email,
      regPassword: password
    },
    individualForm: {
      indOccupation: words('Enter your occupation or role.', 2, 60, 'Your occupation must be 2 to 60 characters.'),
      indMobile: mobile,
      indCity: city,
      indIncome: amount('Enter your monthly income (0 if none).'),
      indSavings: amount('Enter your total savings (0 if none).'),
      indExpenses: amount('Enter your monthly fixed expenses (0 if none).'),
      indLoans: amount('Enter your outstanding loans (0 if none).'),
      indInvestments: amount('Enter your existing investments (0 if none).'),
      indInsurance: amount('Enter your insurance coverage (0 if none).'),
      indDependents: wholeNumber('Enter your number of dependents (0 if none).', 0, 20, 'Dependents must be between 0 and 20.'),
      indGoalTitle: words('Name your financial goal.', 2, 80, 'Your goal must be 2 to 80 characters.'),
      indGoalTarget: amount('Enter your goal amount.', true),
      indGoalDate: futureDate
    },
    startupProfileForm: {
      suCompanyName: words('Enter your startup name.', 2, 100, 'The startup name must be 2 to 100 characters.'),
      suIndustry: selected('Select your industry.'),
      suBusinessModel: selected('Select your business model.'),
      suStage: selected('Select your stage.'),
      suHeadcount: wholeNumber('Enter your team size.', 1, 100000, 'Team size must be at least 1.'),
      suGstNumber: gstin
    },
    startupFinForm: {
      suCurrentCash: amount('Enter your cash in bank (0 if none).'),
      suMonthlyRevenue: amount('Enter your monthly revenue (0 if none).'),
      suMonthlyBurn: amount('Enter your monthly burn (0 if none).'),
      suTotalFunding: amount('Enter the total funding raised (0 if none).'),
      suDebt: amount('Enter your debt and liabilities (0 if none).')
    }
  };

  /* -------------------------------------------------------------- display */

  function fieldOf(input) {
    return input.closest('.mk-field') || input.parentNode;
  }

  function showError(input, message) {
    var field = fieldOf(input);
    var id = input.id + 'Error';
    var slot = document.getElementById(id);
    if (!slot) {
      // A <span> rather than a <p>: .mk-field is a <label>, which may only
      // contain phrasing content.
      slot = document.createElement('span');
      slot.id = id;
      slot.className = 'mk-field__error';
      slot.setAttribute('role', 'alert');
      field.appendChild(slot);
    }
    slot.textContent = message;
    field.classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', id);
  }

  function clearError(input) {
    var field = fieldOf(input);
    var slot = document.getElementById(input.id + 'Error');
    if (slot) slot.remove();
    field.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    if (input.getAttribute('aria-describedby') === input.id + 'Error') input.removeAttribute('aria-describedby');
  }

  function check(input, rule) {
    var message = rule(input.value);
    if (message) showError(input, message);
    else clearError(input);
    return !message;
  }

  /** Validate every field of one wizard step. Returns true when all pass. */
  function validate(formId) {
    var rules = FORMS[formId];
    if (!rules) return true;
    var firstBad = null;
    Object.keys(rules).forEach(function (id) {
      var input = document.getElementById(id);
      if (!input) return;
      input.dataset.touched = '1';
      if (!check(input, rules[id]) && !firstBad) firstBad = input;
    });
    if (firstBad) {
      try { firstBad.focus({ preventScroll: true }); } catch (e) { firstBad.focus(); }
      fieldOf(firstBad).scrollIntoView({ block: 'center', behavior: 'smooth' });
      return false;
    }
    return true;
  }

  /* --------------------------------------------------------------- wiring */

  function wire() {
    Object.keys(FORMS).forEach(function (formId) {
      var rules = FORMS[formId];
      Object.keys(rules).forEach(function (id) {
        var input = document.getElementById(id);
        if (!input) return;

        // Shape the value as it is typed, so the common mistakes never happen.
        input.addEventListener('input', function () {
          if (id === 'indMobile') {
            var digits = input.value.replace(/\D/g, '').slice(0, 10);
            if (digits !== input.value) input.value = digits;
          } else if (id === 'suGstNumber') {
            var g = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15);
            if (g !== input.value) input.value = g;
          } else if (id === 'indDependents' || id === 'suHeadcount') {
            var w = input.value.replace(/\D/g, '');
            if (w !== input.value) input.value = w;
          }
          // Once a field has been judged, keep its message in step with it.
          if (input.dataset.touched) check(input, rules[id]);
        });

        input.addEventListener('change', function () {
          if (input.dataset.touched) check(input, rules[id]);
        });

        input.addEventListener('blur', function () {
          if (str(input.value)) {
            input.dataset.touched = '1';
            check(input, rules[id]);
          }
        });
      });
    });

    // The date picker itself refuses past dates; the rule above is still the check.
    var goalDate = document.getElementById('indGoalDate');
    if (goalDate) {
      var t = new Date(); t.setDate(t.getDate() + 1);
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      goalDate.min = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.MKSignup = {
    validate: validate,
    rules: { name: name, email: email, password: password, mobile: mobile, city: city, gstin: gstin, futureDate: futureDate }
  };
})();
