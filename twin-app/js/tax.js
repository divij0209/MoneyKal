/* ==========================================================================
   TAX CALCULATOR — Individual persona
   Step 1: collection of every head of income.

   Two rules this file follows strictly:

   1. No statutory figure lives here. Slabs, limits, exemptions and section
      labels all arrive from GET /tax/config, which reads backend config.
      When a Budget changes a number, this file does not change.

   2. Visibility is gated on the REAL profile key. applyPersonaNav() in
      startup.js maps every non-startup persona to "individual", so relying on
      data-persona would expose this to Enterprise/CFO users. The nav item
      ships hidden and is revealed only for key === 'individual'.
   ========================================================================== */

(function () {
  'use strict';

  let cfg = null;            // /tax/config payload for the active year
  let currentYear = null;
  let dirty = false;
  let collectTimer = null;
  let propertyRows = [];     // client-side model for the repeatable property list
  let initialised = false;

  /* ---------------- helpers ---------------- */

  const $ = (id) => document.getElementById(id);

  function money(n) {
    const v = Number(n) || 0;
    const sign = v < 0 ? '-' : '';
    return sign + '₹' + Math.abs(Math.round(v)).toLocaleString('en-IN');
  }

  function num(id) {
    const el = $(id);
    if (!el) return 0;
    const v = parseFloat(el.value);
    return isNaN(v) ? 0 : v;
  }

  function checked(id) {
    const el = $(id);
    return !!(el && el.checked);
  }

  function val(id) {
    const el = $(id);
    return el ? el.value : '';
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  /* Translation, for the two native dialogs below. The DOM engine cannot
     reach confirm() text, and window.t returns its input unchanged in
     English, so this is a no-op until Hindi is selected. */
  function t(s) { return typeof window.t === 'function' ? window.t(s) : s; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------------- field help ----------------
     Every sentence shown here arrives in cfg.field_guidance, keyed by the
     field's dotted path in TaxProfileInput and carried in the markup as
     data-help. Rule 1 at the top of this file applies to prose as much as to
     arithmetic: the limits and rates quoted to the user are rendered by the
     backend from the same config the engine computes with, so a Budget that
     moves a figure moves the explanation with it. */

  let openHelp = null;      // { button, tip } for the one tooltip on screen
  let helpTipSeq = 0;

  function closeHelp() {
    if (!openHelp) return;
    openHelp.tip.remove();
    openHelp.button.classList.remove('is-open');
    openHelp.button.setAttribute('aria-expanded', 'false');
    openHelp.button.removeAttribute('aria-describedby');
    openHelp = null;
  }

  /**
   * Place the tip against its button in viewport coordinates: below where
   * there is room, above where there is not, and always clear of both edges.
   * The arrow is then pointed back at the button's centre.
   */
  function positionHelp(button, tip) {
    const GAP = 8;        // between button and tip
    const MARGIN = 12;    // smallest gap left against a viewport edge
    const btn = button.getBoundingClientRect();
    const box = tip.getBoundingClientRect();

    const roomBelow = window.innerHeight - btn.bottom - GAP - MARGIN;
    const above = box.height > roomBelow && btn.top - GAP - box.height > MARGIN;
    tip.classList.toggle('is-above', above);
    tip.style.top = `${above ? btn.top - GAP - box.height : btn.bottom + GAP}px`;

    const left = Math.max(
      MARGIN,
      Math.min(btn.left - 8, window.innerWidth - MARGIN - box.width)
    );
    tip.style.left = `${left}px`;
    tip.style.setProperty('--tax-help-arrow', `${btn.left + btn.width / 2 - left}px`);
  }

  function showHelp(button, text) {
    closeHelp();

    const tip = document.createElement('div');
    tip.className = 'tax-help__tip';
    tip.id = `tax-help-tip-${++helpTipSeq}`;
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;

    // The tip is appended to <body> and positioned fixed rather than nested
    // beside its field: every income head is an overflow:hidden accordion,
    // which would otherwise crop the tip at the section edge.
    document.body.appendChild(tip);
    button.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-describedby', tip.id);
    openHelp = { button, tip };

    positionHelp(button, tip);
  }

  function buildHelpButton(text) {
    const wrap = document.createElement('span');
    wrap.className = 'tax-help';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tax-help__btn';
    button.setAttribute('aria-label', 'What goes in this field?');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'i';

    // Every field here sits inside its own <label>, so a plain click would
    // reach the control and toggle it. Both handlers are needed: preventing
    // the default on mousedown stops the label activation, and stopping the
    // click keeps it from reaching the delegated view listener.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openHelp && openHelp.button === button) closeHelp();
      else showHelp(button, text);
    });

    wrap.appendChild(button);
    return wrap;
  }

  /**
   * Attach a help button to every [data-help] field inside `root` that does
   * not already have one. Safe to call repeatedly — the property list is
   * re-rendered often, and only its new fields pick up a button.
   */
  function renderFieldHelp(root) {
    const scope = root || $('view-tax');
    if (!scope || !cfg || !cfg.field_guidance) return;

    scope.querySelectorAll('[data-help]').forEach((field) => {
      const text = cfg.field_guidance[field.dataset.help];
      if (!text) return;

      const label = field.closest('label');
      const span = label && label.querySelector(':scope > span');
      if (!span || span.querySelector('.tax-help')) return;

      span.appendChild(buildHelpButton(text));
    });
  }

  /** Rebuild every help button — used when the tax year, and so the text, changes. */
  function refreshFieldHelp() {
    const view = $('view-tax');
    if (!view) return;
    closeHelp();
    view.querySelectorAll('.tax-help').forEach((el) => el.remove());
    renderFieldHelp(view);
  }

  /* ---------------- filing guides ----------------
     The step-by-step ITR walkthrough, also served by /tax/config so the due
     dates and thresholds it quotes stay with the rest of the calendar.
     Steps carry their link as data rather than markup, so everything below
     goes through esc() and nothing from the server is trusted as HTML. */

  function filingStepHtml(step, index) {
    const link = step.link
      ? ` <a class="tax-filing-step__link" href="${esc(step.link.url)}"`
        + ` target="_blank" rel="noopener">${esc(step.link.label)}</a>`
      : '';
    return `
      <li class="tax-filing-step">
        <span class="tax-filing-step__number">${index + 1}</span>
        <div class="tax-filing-step__body">
          <div class="tax-filing-step__title">${esc(step.title)}</div>
          <p class="tax-filing-step__detail">${esc(step.detail)}${link}</p>
        </div>
      </li>`;
  }

  function renderFilingGuides() {
    const section = $('taxFilingGuides');
    const grid = $('taxFilingGuidesGrid');
    if (!section || !grid) return;

    const guides = (cfg && cfg.filing_guides) || [];
    section.hidden = !guides.length;

    const heading = section.querySelector('.tax-filing-guides__title');
    if (heading) {
      heading.textContent = guides.length === 1
        ? 'Step-by-step filing guide'
        : 'Step-by-step filing guides';
    }

    grid.innerHTML = guides.map((guide) => `
      <details class="tax-filing-guide">
        <summary class="tax-filing-guide__summary">
          <span class="tax-filing-guide__heading">
            <span class="tax-filing-guide__title">${esc(guide.title)}</span>
            <span class="tax-filing-guide__subtitle">${esc(guide.subtitle)}</span>
          </span>
          <span class="tax-filing-guide__count">${guide.steps.length} steps</span>
        </summary>
        <ol class="tax-filing-steps">${guide.steps.map(filingStepHtml).join('')}</ol>
      </details>`).join('');
  }

  /* ---------------- conditional sections ----------------
     Any [data-requires="checkboxId"] block shows only while that box is
     ticked, so the form stays short until a head is actually claimed. */

  function syncConditionals() {
    document.querySelectorAll('#view-tax [data-requires]').forEach((block) => {
      block.hidden = !checked(block.dataset.requires);
    });

    // Salary: simple mode swaps the whole CTC structuring block out.
    const simple = checked('txSalarySimple');
    document.querySelectorAll('#view-tax [data-simple-mode="on"]').forEach((el) => { el.hidden = !simple; });
    document.querySelectorAll('#view-tax [data-simple-mode="off"]').forEach((el) => { el.hidden = simple; });

    // 44AD asks for the cash/digital split; 44ADA does not.
    const scheme = val('txPresumptiveScheme');
    document.querySelectorAll('#view-tax [data-scheme]').forEach((el) => {
      el.hidden = el.dataset.scheme !== scheme;
    });
  }

  /* ---------------- allowance rows ----------------
     Built from config so the labels and statutory limits shown are whatever
     the backend says they are. */

  const ALLOWANCE_FIELDS = [
    { key: 'conveyance_allowance', id: 'Conveyance', mode: 'fixed' },
    { key: 'food_coupons', id: 'FoodCoupons', mode: 'count', countLabel: 'meals/day' },
    { key: 'children_education_allowance', id: 'ChildEdu', mode: 'count', countLabel: 'children' },
    { key: 'children_hostel_allowance', id: 'ChildHostel', mode: 'count', countLabel: 'children' },
    { key: 'uniform_allowance', id: 'Uniform', mode: 'fixed' },
    { key: 'leave_travel_concession', id: 'Ltc', mode: 'fixed' },
    { key: 'gift_vouchers', id: 'Gift', mode: 'fixed' }
  ];

  const EXTRA_REIMBURSEMENTS = [
    { id: 'Telephone', label: 'Telephone / Internet reimbursement' },
    { id: 'MedicalPremium', label: 'Employer-paid medical premium' },
    { id: 'ProfCourse', label: 'Professional course reimbursement' },
    { id: 'HealthClub', label: 'Health club / sports reimbursement' }
  ];

  function limitHint(exemption) {
    if (!exemption) return '';
    if (exemption.annual_limit) return `Exempt up to ${money(exemption.annual_limit)}/yr`;
    if (exemption.per_month_per_child) {
      return `Exempt ${money(exemption.per_month_per_child)}/month/child, max ${exemption.max_children}`;
    }
    if (exemption.per_meal) return `Exempt ${money(exemption.per_meal)} per meal`;
    return 'Exempt to the extent actually spent';
  }

  function renderAllowances() {
    const host = $('txAllowances');
    if (!host || !cfg) return;
    const ex = cfg.salary_exemptions || {};

    const rows = ALLOWANCE_FIELDS.map((f) => {
      const e = ex[f.key] || {};
      const label = e.label || f.key;
      const input = f.mode === 'count'
        ? `<input type="number" class="ob-input tax-allowance__input" id="tx${f.id}Count"
                  min="0" placeholder="0" aria-label="${esc(label)} ${esc(f.countLabel || '')}">
           <span class="tax-allowance__unit">${esc(f.countLabel || '')}</span>`
        : `<input type="number" class="ob-input tax-allowance__input" id="tx${f.id}Amount"
                  min="0" placeholder="0" aria-label="${esc(label)} annual amount">
           <span class="tax-allowance__unit">per year</span>`;

      return `
        <div class="tax-allowance">
          <label class="tax-allowance__toggle">
            <input type="checkbox" id="tx${f.id}Enabled">
            <span>${esc(label)}</span>
          </label>
          <div class="tax-allowance__value">${input}</div>
          <div class="tax-allowance__hint">${esc(limitHint(e))}</div>
        </div>`;
    }).join('');

    const extras = EXTRA_REIMBURSEMENTS.map((f) => `
        <div class="tax-allowance">
          <label class="tax-allowance__toggle">
            <input type="checkbox" id="tx${f.id}Enabled">
            <span>${esc(f.label)}</span>
          </label>
          <div class="tax-allowance__value">
            <input type="number" class="ob-input tax-allowance__input" id="tx${f.id}Amount"
                   min="0" placeholder="0" aria-label="${esc(f.label)}">
            <span class="tax-allowance__unit">per year</span>
          </div>
          <div class="tax-allowance__hint">Exempt to the extent actually spent for official purposes</div>
        </div>`).join('');

    host.innerHTML = rows + extras;
  }

  /* ---------------- deductions checklist ----------------
     Built entirely from /tax/config, so a Budget that changes a limit or adds
     a section needs no change here. Deductions whose amount is derived rather
     than entered (employer NPS, savings interest) are excluded — they come
     from the salary structure and the Other Sources head. */

  const DERIVED_DEDUCTIONS = ['80CCD_2', '80TTA', '80TTB'];

  function deductionInputId(key) {
    return 'txDed_' + key.replace(/[^A-Za-z0-9_]/g, '_');
  }

  function renderDeductions() {
    const host = $('txDeductions');
    if (!host || !cfg) return;

    const all = cfg.deductions || {};
    const keys = Object.keys(all).filter((k) => DERIVED_DEDUCTIONS.indexOf(k) === -1);

    const intro = $('taxDeductionsIntro');
    if (intro) {
      intro.textContent =
        'Almost every deduction below is available under the old regime only. '
        + 'Employer NPS and savings-interest relief are picked up automatically '
        + 'from your salary structure and Other Sources.';
    }

    host.innerHTML = keys.map((k) => {
      const d = all[k];
      const id = deductionInputId(k);
      const limitTxt = d.limit
        ? `Limit ${money(d.limit)}`
        : (d.limit_senior ? `Limit ${money(d.limit_senior)}` : 'No monetary cap');
      const seniorTxt = d.limit_senior && d.limit && d.limit_senior !== d.limit
        ? ` · ${money(d.limit_senior)} for senior citizens`
        : '';
      const severeTxt = d.limit_severe ? ` · ${money(d.limit_severe)} if severe` : '';

      // Only the deductions whose ceiling actually moves need these toggles.
      const seniorToggle = (k === '80D_parents')
        ? `<label class="tax-deduction__flag">
             <input type="checkbox" id="${id}_senior"><span>Parents are senior citizens</span>
           </label>` : '';
      const severeToggle = (d.limit_severe)
        ? `<label class="tax-deduction__flag">
             <input type="checkbox" id="${id}_severe"><span>Severe disability</span>
           </label>` : '';

      return `
        <div class="tax-deduction">
          <div class="tax-deduction__main">
            <div class="tax-deduction__id">
              <span class="tax-deduction__section">${esc(d.section)}</span>
              <span class="tax-deduction__label">${esc(d.short_label)}</span>
            </div>
            <input type="number" class="ob-input tax-deduction__input" id="${id}"
                   min="0" placeholder="0" aria-label="${esc(d.short_label)} amount">
          </div>
          <div class="tax-deduction__meta">
            <span class="tax-deduction__limit">${esc(limitTxt + seniorTxt + severeTxt)}</span>
            ${seniorToggle}${severeToggle}
          </div>
          <div class="tax-deduction__desc">${esc(d.label)}</div>
        </div>`;
    }).join('');
  }

  function buildDeductionEntries() {
    const all = (cfg && cfg.deductions) || {};
    const entries = [];
    Object.keys(all).forEach((k) => {
      if (DERIVED_DEDUCTIONS.indexOf(k) !== -1) return;
      const id = deductionInputId(k);
      const amount = num(id);
      if (!amount) return;
      entries.push({
        key: k,
        amount: amount,
        is_senior_citizen_claim: checked(id + '_senior'),
        is_severe_disability: checked(id + '_severe')
      });
    });
    return entries;
  }

  function applySavedDeductions(d) {
    if (!d) return;
    setValue('txEmployeePf', d.employee_pf_contribution);
    setValue('txHomeLoanPrincipal', d.home_loan_principal);
    (d.entries || []).forEach((e) => {
      const id = deductionInputId(e.key);
      setValue(id, e.amount);
      setChecked(id + '_senior', e.is_senior_citizen_claim);
      setChecked(id + '_severe', e.is_severe_disability);
    });
  }

  /* ---------------- house property rows ---------------- */

  function renderProperties() {
    const host = $('txProperties');
    if (!host) return;

    if (!propertyRows.length) {
      host.innerHTML = '<p class="tax-hint">No property added yet.</p>';
      return;
    }

    host.innerHTML = propertyRows.map((p, i) => `
      <div class="tax-property" data-index="${i}">
        <div class="tax-property__head">
          <input type="text" class="ob-input tax-property__label" value="${esc(p.label)}"
                 data-field="label" placeholder="Property name">
          <select class="ob-input tax-property__type" data-field="property_type">
            <option value="self_occupied"${p.property_type === 'self_occupied' ? ' selected' : ''}>Self-occupied</option>
            <option value="let_out"${p.property_type === 'let_out' ? ' selected' : ''}>Let out</option>
            <option value="deemed_let_out"${p.property_type === 'deemed_let_out' ? ' selected' : ''}>Deemed let out</option>
          </select>
          <button type="button" class="btn btn-outline tax-property__remove" data-remove="${i}"
                  aria-label="Remove property">Remove</button>
        </div>
        <div class="tax-grid tax-grid--3">
          <label class="tax-field"${p.property_type === 'self_occupied' ? ' hidden' : ''}>
            <span>Annual rent received</span>
            <input type="number" class="ob-input" data-field="annual_rent_received"
                   data-help="house_property.annual_rent_received"
                   min="0" value="${p.annual_rent_received || ''}" placeholder="0">
          </label>
          <label class="tax-field"${p.property_type === 'self_occupied' ? ' hidden' : ''}>
            <span>Municipal taxes paid</span>
            <input type="number" class="ob-input" data-field="municipal_taxes_paid"
                   data-help="house_property.municipal_taxes_paid"
                   min="0" value="${p.municipal_taxes_paid || ''}" placeholder="0">
          </label>
          <label class="tax-field">
            <span>Housing loan interest</span>
            <input type="number" class="ob-input" data-field="housing_loan_interest"
                   data-help="house_property.housing_loan_interest"
                   min="0" value="${p.housing_loan_interest || ''}" placeholder="0">
          </label>
        </div>
      </div>`).join('');

    // Rows are rebuilt wholesale on every change, so their help buttons are
    // attached here rather than by each of the callers.
    renderFieldHelp(host);
  }

  function addProperty() {
    propertyRows.push({
      label: `Property ${propertyRows.length + 1}`,
      property_type: 'self_occupied',
      annual_rent_received: 0,
      municipal_taxes_paid: 0,
      housing_loan_interest: 0,
      tds_deducted: 0
    });
    renderProperties();
    scheduleCollect();
  }

  /* ---------------- payload assembly ---------------- */

  function component(idBase, mode) {
    if (mode === 'count') {
      return {
        enabled: checked(`tx${idBase}Enabled`),
        mode: 'count',
        count: num(`tx${idBase}Count`),
        amount: 0,
        percent_of_basic_da: 0
      };
    }
    return {
      enabled: checked(`tx${idBase}Enabled`),
      mode: 'fixed',
      amount: num(`tx${idBase}Amount`),
      count: 0,
      percent_of_basic_da: 0
    };
  }

  function buildPayload() {
    const simple = checked('txSalarySimple');

    return {
      taxpayer: {
        age: num('txAge') || 30,
        city: val('txCity'),
        is_metro: checked('txIsMetro'),
        tax_year: currentYear
      },
      salary: {
        enabled: checked('txSalaryEnabled'),
        use_simple_mode: simple,
        gross_salary_simple: num('txGrossSimple'),
        annual_ctc: num('txCtc'),
        basic_percent_of_ctc: num('txBasicPct'),
        da_percent_of_ctc: num('txDaPct'),
        gratuity_applicable: checked('txGratuity'),
        employer_nps: checked('txEmployerNps'),
        employer_pf: checked('txEmployerPf'),
        hra: {
          enabled: checked('txHraEnabled'),
          mode: 'percent',
          percent_of_basic_da: num('txHraPct'),
          amount: 0,
          count: 0
        },
        rent_paid_annual: num('txRentPaid'),
        conveyance_allowance: component('Conveyance', 'fixed'),
        food_coupons: component('FoodCoupons', 'count'),
        children_education_allowance: component('ChildEdu', 'count'),
        children_hostel_allowance: component('ChildHostel', 'count'),
        uniform_allowance: component('Uniform', 'fixed'),
        leave_travel_concession: component('Ltc', 'fixed'),
        gift_vouchers: component('Gift', 'fixed'),
        telephone_internet: component('Telephone', 'fixed'),
        employer_medical_premium: component('MedicalPremium', 'fixed'),
        professional_course: component('ProfCourse', 'fixed'),
        health_club: component('HealthClub', 'fixed'),
        motor_car: {
          enabled: checked('txCarEnabled'),
          car_owner: val('txCarOwner') || 'employer',
          expense_bearer: val('txCarExpense') || 'employer',
          usage: val('txCarUsage') || 'mixed',
          engine_type: val('txCarEngine') || 'small',
          chauffeur_provided: checked('txCarChauffeur'),
          months_available: num('txCarMonths') || 12,
          actual_cost_of_car: 0,
          annual_running_expenses: 0,
          driver_salary_annual: 0,
          actual_reimbursement: 0,
          employee_recovery: 0,
          transferred_to_employee: false,
          completed_years: 0,
          amount_paid_on_transfer: 0
        },
        tds_deducted: simple ? num('txSalaryTdsSimple') : num('txSalaryTds')
      },
      house_property: {
        enabled: checked('txHouseEnabled'),
        properties: propertyRows
      },
      pgbp: {
        enabled: checked('txPgbpEnabled'),
        presumptive: {
          enabled: checked('txPresumptiveEnabled'),
          scheme: val('txPresumptiveScheme') || '44AD',
          gross_turnover: num('txTurnover'),
          cash_receipts: num('txCashReceipts'),
          digital_receipts: num('txDigitalReceipts'),
          declared_profit_override: null
        },
        regular: {
          enabled: checked('txRegularEnabled'),
          gross_receipts: num('txBizReceipts'),
          total_expenses: num('txBizExpenses'),
          depreciation: num('txBizDepreciation'),
          net_profit_override: null
        },
        tds_deducted: num('txPgbpTds')
      },
      capital_gains: {
        enabled: checked('txCapitalEnabled'),
        stcg_111a: num('txStcg111a'),
        ltcg_112a: num('txLtcg112a'),
        stcg_other: num('txStcgOther'),
        ltcg_other: num('txLtcgOther'),
        brought_forward_stcl: num('txBfStcl'),
        brought_forward_ltcl: num('txBfLtcl'),
        tds_deducted: num('txCapitalTds')
      },
      other_sources: {
        enabled: checked('txOtherEnabled'),
        savings_interest: num('txSavingsInterest'),
        fd_interest: num('txFdInterest'),
        other_interest: num('txOtherInterest'),
        dividend_income: num('txDividend'),
        winnings: num('txWinnings'),
        family_pension: num('txFamilyPension'),
        other_income: num('txOtherIncome'),
        tds_deducted: num('txOtherTds')
      },
      deductions: {
        entries: buildDeductionEntries(),
        employee_pf_contribution: num('txEmployeePf'),
        home_loan_principal: num('txHomeLoanPrincipal')
      },
      advance_tax_paid: num('txAdvanceTax'),
      self_assessment_tax_paid: num('txSelfAssessmentTax')
    };
  }

  /* ---------------- restoring saved inputs ---------------- */

  function setChecked(id, v) { const el = $(id); if (el) el.checked = !!v; }
  function setValue(id, v) {
    const el = $(id);
    if (el && v !== null && v !== undefined && v !== 0) el.value = v;
  }

  function applyComponent(idBase, c) {
    if (!c) return;
    setChecked(`tx${idBase}Enabled`, c.enabled);
    if (c.mode === 'count') setValue(`tx${idBase}Count`, c.count);
    else setValue(`tx${idBase}Amount`, c.amount);
  }

  function applySaved(inputs) {
    if (!inputs || !Object.keys(inputs).length) return;

    const t = inputs.taxpayer || {};
    setValue('txAge', t.age);
    setValue('txCity', t.city);
    setChecked('txIsMetro', t.is_metro);

    const s = inputs.salary || {};
    setChecked('txSalaryEnabled', s.enabled);
    setChecked('txSalarySimple', s.use_simple_mode);
    setValue('txGrossSimple', s.gross_salary_simple);
    setValue('txCtc', s.annual_ctc);
    if (s.basic_percent_of_ctc) $('txBasicPct').value = s.basic_percent_of_ctc;
    if (s.da_percent_of_ctc) $('txDaPct').value = s.da_percent_of_ctc;
    setChecked('txGratuity', s.gratuity_applicable);
    setChecked('txEmployerNps', s.employer_nps);
    setChecked('txEmployerPf', s.employer_pf);
    if (s.hra) {
      setChecked('txHraEnabled', s.hra.enabled);
      setValue('txHraPct', s.hra.percent_of_basic_da);
    }
    setValue('txRentPaid', s.rent_paid_annual);
    setValue('txSalaryTds', s.tds_deducted);
    setValue('txSalaryTdsSimple', s.tds_deducted);

    applyComponent('Conveyance', s.conveyance_allowance);
    applyComponent('FoodCoupons', s.food_coupons);
    applyComponent('ChildEdu', s.children_education_allowance);
    applyComponent('ChildHostel', s.children_hostel_allowance);
    applyComponent('Uniform', s.uniform_allowance);
    applyComponent('Ltc', s.leave_travel_concession);
    applyComponent('Gift', s.gift_vouchers);
    applyComponent('Telephone', s.telephone_internet);
    applyComponent('MedicalPremium', s.employer_medical_premium);
    applyComponent('ProfCourse', s.professional_course);
    applyComponent('HealthClub', s.health_club);

    const car = s.motor_car || {};
    setChecked('txCarEnabled', car.enabled);
    if (car.car_owner) $('txCarOwner').value = car.car_owner;
    if (car.expense_bearer) $('txCarExpense').value = car.expense_bearer;
    if (car.usage) $('txCarUsage').value = car.usage;
    if (car.engine_type) $('txCarEngine').value = car.engine_type;
    setChecked('txCarChauffeur', car.chauffeur_provided);
    if (car.months_available !== undefined) $('txCarMonths').value = car.months_available;

    const hp = inputs.house_property || {};
    setChecked('txHouseEnabled', hp.enabled);
    propertyRows = Array.isArray(hp.properties) ? hp.properties : [];
    renderProperties();

    const p = inputs.pgbp || {};
    setChecked('txPgbpEnabled', p.enabled);
    if (p.presumptive) {
      setChecked('txPresumptiveEnabled', p.presumptive.enabled);
      if (p.presumptive.scheme) $('txPresumptiveScheme').value = p.presumptive.scheme;
      setValue('txTurnover', p.presumptive.gross_turnover);
      setValue('txCashReceipts', p.presumptive.cash_receipts);
      setValue('txDigitalReceipts', p.presumptive.digital_receipts);
    }
    if (p.regular) {
      setChecked('txRegularEnabled', p.regular.enabled);
      setValue('txBizReceipts', p.regular.gross_receipts);
      setValue('txBizExpenses', p.regular.total_expenses);
      setValue('txBizDepreciation', p.regular.depreciation);
    }
    setValue('txPgbpTds', p.tds_deducted);

    const cg = inputs.capital_gains || {};
    setChecked('txCapitalEnabled', cg.enabled);
    setValue('txStcg111a', cg.stcg_111a);
    setValue('txLtcg112a', cg.ltcg_112a);
    setValue('txStcgOther', cg.stcg_other);
    setValue('txLtcgOther', cg.ltcg_other);
    setValue('txBfStcl', cg.brought_forward_stcl);
    setValue('txBfLtcl', cg.brought_forward_ltcl);
    setValue('txCapitalTds', cg.tds_deducted);

    const os = inputs.other_sources || {};
    setChecked('txOtherEnabled', os.enabled);
    setValue('txSavingsInterest', os.savings_interest);
    setValue('txFdInterest', os.fd_interest);
    setValue('txOtherInterest', os.other_interest);
    setValue('txDividend', os.dividend_income);
    setValue('txWinnings', os.winnings);
    setValue('txFamilyPension', os.family_pension);
    setValue('txOtherIncome', os.other_income);
    setValue('txOtherTds', os.tds_deducted);
  }

  /* ---------------- summary rendering ---------------- */

  function renderSummary(result) {
    if (!result) return;

    setText('taxGti', money(result.gross_total_income));
    setText('taxTotalTds', money(result.tds ? result.tds.total_prepaid : result.total_tds));

    const list = $('taxSummaryHeads');
    if (list) {
      const active = (result.heads || []).filter((h) => h.gross || h.net || (h.line_items || []).length);
      list.innerHTML = active.length
        ? active.map((h) => `
            <li class="tax-summary__head">
              <div class="tax-summary__head-top">
                <span class="tax-summary__head-label">${esc(h.label)}</span>
                <span class="tax-summary__head-net">${money(h.net)}</span>
              </div>
              ${h.exempt ? `<div class="tax-summary__head-sub">
                  <span>Gross ${money(h.gross)}</span>
                  <span>Exempt ${money(h.exempt)}</span>
                </div>` : ''}
              ${(h.line_items || []).length ? `
                <details class="tax-summary__detail">
                  <summary>Breakdown</summary>
                  <ul>
                    ${h.line_items.map((li) => `
                      <li>
                        <span>${esc(li.label)}${li.section ? ` <em>${esc(li.section)}</em>` : ''}</span>
                        <span>${money(li.amount)}</span>
                        ${li.note ? `<small>${esc(li.note)}</small>` : ''}
                      </li>`).join('')}
                  </ul>
                </details>` : ''}
            </li>`).join('')
        : '<li class="tax-summary__empty">Tick a head of income to begin.</li>';
    }

    // Per-head totals shown on each collapsed accordion header
    document.querySelectorAll('#view-tax [data-head-amount]').forEach((el) => {
      const head = (result.heads || []).find((h) => h.head === el.dataset.headAmount);
      el.textContent = head && (head.net || head.gross) ? money(head.net) : 'N/A';
    });

    renderComparison(result);
    renderAdvice(result);
    renderHra(result);
    renderDeductionsSummary(result);
    renderTdsSummary(result);

    const warnPanel = $('taxWarningsPanel');
    const warnList = $('taxWarnings');
    const warnings = result.warnings || [];
    if (warnPanel && warnList) {
      warnPanel.hidden = warnings.length === 0;
      warnList.innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');
    }

    if (result.disclaimer) setText('taxDisclaimer', result.disclaimer);
  }

  /* ---------------- HRA breakdown ----------------
     Shows all three limbs rather than just the answer: the exemption is the
     lowest of them, and seeing which one bit is what makes the number
     actionable (and is the hook for the Step 5 optimisation advice). */

  function renderHra(result) {
    const panel = $('taxHraPanel');
    const body = $('taxHraBody');
    if (!panel || !body) return;

    const salary = (result.heads || []).find((h) => h.head === 'salary');
    const hra = salary && salary.hra_exemption;

    // Nothing to show unless HRA is actually in play, or rent is paid without
    // HRA (in which case the note pointing at 80GG is worth surfacing).
    if (!hra || (!hra.applicable && !(hra.notes || []).length)) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    if (!hra.applicable) {
      body.innerHTML = `<ul class="tax-hra__notes">
        ${(hra.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}
      </ul>`;
      return;
    }

    body.innerHTML = `
      <div class="tax-hra__result">
        <span class="tax-hra__result-label">Exempt</span>
        <span class="tax-hra__result-value">${money(hra.exempt_amount)}</span>
      </div>
      <p class="tax-hra__lead">Lowest of these three:</p>
      <ul class="tax-hra__limbs">
        ${(hra.limbs || []).map((l) => `
          <li class="tax-hra__limb${l.is_binding ? ' is-binding' : ''}">
            <div class="tax-hra__limb-top">
              <span>${esc(l.label)}</span>
              <span class="tax-hra__limb-amount">${money(l.amount)}</span>
            </div>
            <small>${esc(l.formula)}</small>
          </li>`).join('')}
      </ul>
      <div class="tax-hra__taxable">
        <span>Taxable HRA</span>
        <span>${money(hra.taxable_hra)}</span>
      </div>
      ${(hra.notes || []).length ? `<ul class="tax-hra__notes">
        ${hra.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
      </ul>` : ''}`;
  }

  /* ---------------- regime comparison ----------------
     The headline output. Every line is shown for both regimes so the two
     columns can be read across — the point is not just which is cheaper but
     why, and the rows that differ are what answer that. */

  // Keep the decimal only where the rate actually has one — 12.5% must not
  // round to 13%, but 20% should not read as 20.0%.
  function pct(n) {
    const v = Number(n || 0) * 100;
    return (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) + '%';
  }

  function regimeCard(r, isRecommended, saving) {
    const rows = [
      ['Gross Total Income', r.gross_total_income, false],
      ['HRA exemption', -r.hra_exemption, !r.hra_exemption],
      ['Allowance exemptions', -r.allowances_exempt, !r.allowances_exempt],
      ['Standard deduction', -r.standard_deduction, !r.standard_deduction],
      ['Professional tax', -r.professional_tax, !r.professional_tax],
      ['Chapter VI-A deductions', -r.chapter_via_deductions, false],
      ['Total Income', r.total_income, false, 'is-subtotal'],
      ['Tax at slab rates', r.tax_on_normal_income, false],
      ['Tax at special rates', r.tax_on_special_income, !r.tax_on_special_income],
      [`Rebate (${esc(r.rebate_section || '87A')})`, -r.rebate, !r.rebate],
      [`Surcharge${r.surcharge_rate ? ' @ ' + pct(r.surcharge_rate) : ''}`, r.surcharge, !r.surcharge],
      ['Marginal relief on surcharge', -r.surcharge_marginal_relief, !r.surcharge_marginal_relief],
      [`Cess @ ${pct(r.cess_rate)}`, r.cess, false]
    ];

    const slabRows = (r.slab_bands || []).map((b) => `
      <li>
        <span>${money(b.from_amount)} to ${b.to_amount ? money(b.to_amount) : 'above'} @ ${pct(b.rate)}</span>
        <span>${money(b.tax)}</span>
      </li>`).join('');

    const specialRows = (r.special_rate_items || []).map((s) => `
      <li>
        <span>${esc(s.label)}${s.section ? ` <em>${esc(s.section)}</em>` : ''} @ ${pct(s.rate)}</span>
        <span>${money(s.tax)}</span>
        ${s.exemption_applied ? `<small>${money(s.exemption_applied)} annual exemption applied</small>` : ''}
        ${s.basic_exemption_setoff ? `<small>${money(s.basic_exemption_setoff)} basic exemption set off</small>` : ''}
      </li>`).join('');

    return `
      <div class="tax-compare__head">
        <div class="tax-compare__title">
          <h3>${esc(r.label)}</h3>
          ${isRecommended
            ? `<span class="tax-compare__badge">Lower by ${money(saving)}</span>`
            : ''}
        </div>
        <div class="tax-compare__liability">${money(r.total_tax_liability)}</div>
        <div class="tax-compare__effective">
          Effective rate ${(Number(r.effective_rate || 0) * 100).toFixed(1)}% of gross income
        </div>
      </div>

      <ul class="tax-compare__rows">
        ${rows.filter((x) => !x[2]).map((x) => `
          <li class="${x[3] || ''}">
            <span>${x[0]}</span>
            <span>${money(x[1])}</span>
          </li>`).join('')}
      </ul>

      <div class="tax-compare__total">
        <span>Total tax liability</span>
        <span>${money(r.total_tax_liability)}</span>
      </div>
      <div class="tax-compare__paid">
        <span>Less: tax already paid</span>
        <span>${money(r.prepaid_tax)}</span>
      </div>
      <div class="tax-compare__net ${r.is_refund ? 'is-refund' : ''}">
        <span>${r.is_refund ? 'Refund due' : 'Payable'}</span>
        <span>${money(Math.abs(r.net_payable))}</span>
      </div>

      ${(slabRows || specialRows) ? `
        <details class="tax-compare__detail">
          <summary>How the tax was worked out</summary>
          <ul>
            ${slabRows}
            ${specialRows}
          </ul>
        </details>` : ''}

      ${(r.notes || []).length ? `
        <ul class="tax-compare__notes">
          ${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
        </ul>` : ''}`;
  }

  function renderComparison(result) {
    const wrap = $('taxCompare');
    if (!wrap) return;
    const c = result.comparison;
    if (!c) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    const oldEl = $('taxCompareOld');
    const newEl = $('taxCompareNew');
    const oldWins = c.recommended_regime === 'old';

    if (oldEl) {
      oldEl.innerHTML = regimeCard(c.old, oldWins, c.saving);
      oldEl.classList.toggle('is-recommended', oldWins);
    }
    if (newEl) {
      newEl.innerHTML = regimeCard(c.new, !oldWins, c.saving);
      newEl.classList.toggle('is-recommended', !oldWins);
    }

    const verdict = $('taxCompareVerdict');
    if (verdict) {
      const isDefault = c.recommended_regime === c.default_regime;
      verdict.innerHTML = esc(c.summary)
        + (isDefault
            ? ' This is the default regime, so no election is needed.'
            : ' You must opt in to this regime when filing.');
    }
  }

  /* ---------------- recommendations + ITR form ---------------- */

  const CATEGORY_LABEL = {
    regime: 'Regime',
    deduction: 'Deductions',
    hra: 'HRA',
    capital_gains: 'Capital gains',
    compliance: 'Compliance',
    structure: 'Salary structure'
  };

  function renderAdvice(result) {
    const wrap = $('taxAdvice');
    const list = $('taxRecs');
    if (!wrap || !list) return;

    const recs = result.recommendations || [];
    const itr = result.itr_form;

    if (!recs.length && !itr) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    list.innerHTML = recs.map((r) => `
      <li class="tax-rec tax-rec--${esc(r.priority)}">
        <div class="tax-rec__top">
          <span class="tax-rec__cat">${esc(CATEGORY_LABEL[r.category] || r.category)}</span>
          ${r.estimated_saving
            ? `<span class="tax-rec__saving">~${money(r.estimated_saving)}</span>`
            : ''}
        </div>
        <div class="tax-rec__title">${esc(r.title)}</div>
        <p class="tax-rec__detail">${esc(r.detail)}</p>
        ${r.action ? `<p class="tax-rec__action">${esc(r.action)}</p>` : ''}
      </li>`).join('');

    const itrPanel = $('taxItrPanel');
    const itrBody = $('taxItrBody');
    if (!itrPanel || !itrBody) return;
    if (!itr) {
      itrPanel.hidden = true;
      return;
    }
    itrPanel.hidden = false;

    itrBody.innerHTML = `
      <div class="tax-itr__form">${esc(itr.name)}</div>
      <p class="tax-itr__desc">${esc(itr.description)}</p>
      ${(itr.reasons || []).length ? `
        <ul class="tax-itr__reasons">
          ${itr.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}
        </ul>` : ''}
      ${(itr.ruled_out || []).length ? `
        <details class="tax-itr__ruled">
          <summary>Why not a simpler form?</summary>
          <ul>
            ${itr.ruled_out.map((x) => `
              <li><strong>${esc(x.form)}</strong>: ${esc(x.reason)}</li>`).join('')}
          </ul>
        </details>` : ''}
      ${(itr.warnings || []).length ? `
        <p class="tax-itr__warning">${esc(itr.warnings[itr.warnings.length - 1])}</p>` : ''}`;
  }

  /* ---------------- deductions & TDS summaries ---------------- */

  function renderDeductionsSummary(result) {
    const panel = $('taxDeductionsPanel');
    const body = $('taxDeductionsBody');
    const headAmt = $('taxDeductionsHeadAmount');
    const d = result.deductions;

    if (headAmt) {
      headAmt.textContent = d && d.total_old_regime ? money(d.total_old_regime) : 'N/A';
    }
    if (!panel || !body) return;

    if (!d || !(d.entries || []).length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    body.innerHTML = `
      <div class="tax-ded-totals">
        <div class="tax-ded-total">
          <span>Old regime</span>
          <strong>${money(d.total_old_regime)}</strong>
        </div>
        <div class="tax-ded-total tax-ded-total--muted">
          <span>New regime</span>
          <strong>${money(d.total_new_regime)}</strong>
        </div>
      </div>
      <ul class="tax-ded-list">
        ${d.entries.map((e) => `
          <li class="tax-ded-item${e.is_capped ? ' is-capped' : ''}">
            <div class="tax-ded-item__top">
              <span class="tax-ded-item__section">${esc(e.section)}</span>
              <span class="tax-ded-item__amount">${money(e.qualifying_old)}</span>
            </div>
            <div class="tax-ded-item__sub">
              <span>${esc(e.short_label)}</span>
              ${e.is_capped
                ? `<em>claimed ${money(e.claimed)}, capped</em>`
                : (e.headroom ? `<em>${money(e.headroom)} unused</em>` : '')}
            </div>
          </li>`).join('')}
      </ul>
      ${d.restricted_to_gti
        ? '<p class="tax-ded-note">Restricted to Gross Total Income, so deductions cannot create a loss.</p>'
        : ''}`;
  }

  function renderTdsSummary(result) {
    const t = result.tds;
    const headAmt = $('taxPrepaidHeadAmount');
    if (headAmt) {
      headAmt.textContent = t && t.total_prepaid ? money(t.total_prepaid) : 'N/A';
    }

    const list = $('txTdsBreakdown');
    if (!list) return;
    if (!t || !(t.by_head || []).length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = `
      <li class="tax-tds-heading">TDS picked up from your income heads</li>
      ${t.by_head.map((e) => `
        <li><span>${esc(e.label)}</span><span>${money(e.amount)}</span></li>`).join('')}
      <li class="tax-tds-total"><span>Total already paid</span><span>${money(t.total_prepaid)}</span></li>`;
  }

  /* ---------------- live recompute ---------------- */

  async function collectNow() {
    try {
      const result = await window.api.collectTaxIncome(buildPayload());
      clearLocked();
      renderSummary(result);
    } catch (err) {
      if (err.status === 402 && err.detail && err.detail.error === 'purchase_required') {
        renderLocked(err.detail);
        return;
      }
      console.error('Tax income collection failed:', err);
    }
  }

  /* ---------------- locked results ----------------
     The tax year has not been unlocked (bought, or included in ACT), so the
     server sent no figures at all — POST /tax/collect answered 402. Inputs
     stay fully usable and saveable; the result areas are cleared and a lock
     panel explains how to see them. The blurred cards are decoration with no
     numbers in them, so nothing real can be read through the blur. */

  let locked = null;

  function lockPriceText(minor) {
    return '₹' + ((Number(minor) || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  function lockPreviewCard() {
    return `
      <div class="tax-lock__card">
        <span class="tax-lock__bar" style="width:45%"></span>
        <span class="tax-lock__big"></span>
        <span class="tax-lock__bar" style="width:80%"></span>
        <span class="tax-lock__bar" style="width:65%"></span>
        <span class="tax-lock__bar" style="width:72%"></span>
      </div>`;
  }

  function renderLocked(detail) {
    const view = $('view-tax');
    if (!view) return;
    locked = detail;
    view.classList.add('is-locked');

    let panel = $('taxLock');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'taxLock';
      panel.className = 'tax-lock';
      const compare = $('taxCompare');
      compare.parentNode.insertBefore(panel, compare);
      panel.addEventListener('click', (e) => {
        if (!locked || !window.billingView) return;
        if (e.target.closest('[data-tax-unlock]')) {
          window.billingView.buy(locked.sku, locked.subject_ref, { stay: true });
        } else if (e.target.closest('[data-tax-act]')) {
          window.billingView.openUpgrade();
        }
      });
    }
    panel.hidden = false;

    // Clear anything an earlier, unlocked year left on screen.
    ['taxCompare', 'taxDeductionsPanel', 'taxHraPanel', 'taxWarningsPanel'].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = true;
    });
    setText('taxGti', '₹ ••,•••');
    setText('taxTotalTds', '₹ ••,•••');
    const heads = $('taxSummaryHeads');
    if (heads) heads.innerHTML = '';
    document.querySelectorAll('#view-tax [data-head-amount]').forEach((el) => { el.textContent = '…'; });
    setText('taxDeductionsHeadAmount', '…');
    setText('taxPrepaidHeadAmount', '…');

    panel.innerHTML = `
      <div class="tax-lock__preview" aria-hidden="true">${lockPreviewCard()}${lockPreviewCard()}</div>
      <div class="tax-lock__panel">
        <span class="tax-lock__icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none"><rect x="4" y="9" width="12" height="8.5" rx="1.5"
            stroke="currentColor" stroke-width="1.5"/><path d="M6.8 9V6.5a3.2 3.2 0 0 1 6.4 0V9"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </span>
        <h3>Unlock your tax result</h3>
        <p>Fill in your details as usual. Your tax, the regime that costs less and your likely return form appear once this tax year is unlocked.</p>
        <p class="tax-lock__year"><span>Tax year</span> <b>${esc(String(detail.subject_ref || '').replace(/^FY(?=\d)/, 'FY '))}</b></p>
        <div class="tax-lock__actions">
          <button type="button" class="btn btn--primary" data-tax-unlock><span>Unlock for</span> ${lockPriceText(detail.price_minor)}</button>
          ${detail.included_in_act ? `<button type="button" class="btn" data-tax-act>Get ACT, every tax year included</button>` : ''}
        </div>
      </div>`;
  }

  function clearLocked() {
    if (!locked) return;
    locked = null;
    const view = $('view-tax');
    if (view) view.classList.remove('is-locked');
    const panel = $('taxLock');
    if (panel) panel.hidden = true;
  }

  // A purchase or an ACT upgrade made anywhere may unlock the year on screen.
  document.addEventListener('mk:billingchange', () => {
    if (initialised) collectNow();
  });

  function scheduleCollect() {
    dirty = true;
    setText('taxSaveState', 'Unsaved changes');
    clearTimeout(collectTimer);
    collectTimer = setTimeout(collectNow, 350);
  }

  /* ---------------- config-driven labels ---------------- */

  function applyConfigLabels() {
    if (!cfg) return;

    setText('taxActBadge', cfg.labels ? cfg.labels.act : '');
    if (cfg.disclaimer) setText('taxDisclaimer', cfg.disclaimer);

    const cg = cfg.capital_gains || {};
    if (cg.stcg_111a) {
      setText('lblStcg111a',
        `Short-term (${cg.stcg_111a.section_1961}, ${(cg.stcg_111a.rate * 100).toFixed(0)}%)`);
    }
    if (cg.ltcg_112a) {
      setText('lblLtcg112a',
        `Long-term (${cg.ltcg_112a.section_1961}, ${(cg.ltcg_112a.rate * 100).toFixed(1)}%, `
        + `first ${money(cg.ltcg_112a.annual_exemption)} exempt)`);
    }

    const p = cfg.presumptive || {};
    const scheme = val('txPresumptiveScheme') || '44AD';
    if (p[scheme]) {
      const s = p[scheme];
      setText('txPresumptiveHint', scheme === '44AD'
        ? `Deemed profit: ${(s.deemed_profit_percent_cash * 100).toFixed(0)}% of cash receipts, `
          + `${(s.deemed_profit_percent_digital * 100).toFixed(0)}% of digital. `
          + `Turnover ceiling ${money(s.turnover_limit)}.`
        : `Deemed profit: ${(s.deemed_profit_percent * 100).toFixed(0)}% of gross receipts. `
          + `Receipts ceiling ${money(s.turnover_limit)}.`);
    }

    updateBasicDaHint();
  }

  function updateBasicDaHint() {
    const el = $('txBasicDaHint');
    if (!el) return;

    const total = num('txBasicPct') + num('txDaPct');
    const floor = ((cfg && cfg.labour_code_basic_da_floor) || 0) * 100;
    const short = floor > 0 && total < floor;

    el.textContent = short
      ? `Basic + DA is ${total}% of CTC. The Labour Codes expect at least ${floor}%.`
      : `Basic + DA is ${total}% of CTC.`;
    el.classList.toggle('tax-hint--warn', short);
  }

  /* ---------------- year switching ---------------- */

  async function loadYear(year) {
    cfg = await window.api.fetchTaxConfig(year);
    currentYear = cfg.tax_year;

    const sel = $('taxYearSelect');
    if (sel && !sel.options.length) {
      sel.innerHTML = (cfg.available_years || []).map((y) => {
        const isCurrent = y === cfg.tax_year;
        const label = isCurrent && cfg.labels
          ? `${cfg.labels.fy} (${cfg.labels.ay})`
          : y.replace('FY', 'FY ');
        return `<option value="${esc(y)}"${isCurrent ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('');
    }

    renderAllowances();
    renderDeductions();
    applyConfigLabels();

    // Help text and the filing guides are year-specific — the sections and
    // limits they quote change with the governing Act — so both are rebuilt
    // here rather than once at startup.
    refreshFieldHelp();
    renderFilingGuides();

    const saved = await window.api.fetchTaxProfile(currentYear);
    applySaved(saved.inputs);
    applySavedDeductions(saved.inputs && saved.inputs.deductions);
    setValue('txAdvanceTax', saved.inputs && saved.inputs.advance_tax_paid);
    setValue('txSelfAssessmentTax', saved.inputs && saved.inputs.self_assessment_tax_paid);

    syncConditionals();
    setText('taxSaveState', saved.exists ? 'Saved' : '');
    dirty = false;
    await collectNow();
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    const view = $('view-tax');
    if (!view) return;

    // An open help tooltip is dismissed by anything that means "I'm done
    // reading": a click elsewhere, Escape, or a resize that would leave it
    // pointing at the wrong place.
    document.addEventListener('click', (e) => {
      if (openHelp && !e.target.closest('.tax-help, .tax-help__tip')) closeHelp();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openHelp) {
        const btn = openHelp.button;
        closeHelp();
        btn.focus();
      }
    });
    // Fixed coordinates go stale the moment the page moves under them, so a
    // scroll or resize dismisses the tip rather than leaving it stranded.
    window.addEventListener('resize', closeHelp);
    window.addEventListener('scroll', closeHelp, { capture: true, passive: true });

    // One delegated listener for every input in the view — new fields added to
    // the markup are picked up without extra wiring.
    view.addEventListener('input', (e) => {
      if (e.target.closest('.tax-property')) syncPropertyFromDom(e.target);
      if (e.target.id === 'txBasicPct' || e.target.id === 'txDaPct') updateBasicDaHint();
      scheduleCollect();
    });

    view.addEventListener('change', (e) => {
      if (e.target.closest('.tax-property')) {
        syncPropertyFromDom(e.target);
        if (e.target.dataset.field === 'property_type') renderProperties();
      }
      syncConditionals();
      if (e.target.id === 'txPresumptiveScheme') applyConfigLabels();
      scheduleCollect();
    });

    view.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-remove]');
      if (removeBtn) {
        propertyRows.splice(parseInt(removeBtn.dataset.remove, 10), 1);
        renderProperties();
        scheduleCollect();
      }
    });

    const addBtn = $('btnAddProperty');
    if (addBtn) addBtn.addEventListener('click', addProperty);

    const saveBtn = $('btnTaxSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        setText('taxSaveState', 'Saving…');
        try {
          const res = await window.api.saveTaxProfile(buildPayload(), currentYear);
          renderSummary(res.result);
          dirty = false;
          setText('taxSaveState', 'Saved');
        } catch (err) {
          setText('taxSaveState', err.message || 'Could not save');
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    const resetBtn = $('btnTaxReset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (dirty && !confirm(t('Discard the values entered on this screen?'))) return;
        view.querySelectorAll('input').forEach((el) => {
          if (el.type === 'checkbox') el.checked = false;
          else el.value = '';
        });
        $('txAge').value = 30;
        $('txBasicPct').value = 30;
        $('txDaPct').value = 20;
        $('txCarMonths').value = 12;
        propertyRows = [];
        renderProperties();
        syncConditionals();
        updateBasicDaHint();
        scheduleCollect();
      });
    }

    const yearSel = $('taxYearSelect');
    if (yearSel) {
      yearSel.addEventListener('change', async () => {
        if (dirty && !confirm(t('You have unsaved changes. Switch tax year anyway?'))) {
          yearSel.value = currentYear;
          return;
        }
        await loadYear(yearSel.value);
      });
    }
  }

  function syncPropertyFromDom(target) {
    const row = target.closest('.tax-property');
    if (!row) return;
    const i = parseInt(row.dataset.index, 10);
    const field = target.dataset.field;
    if (isNaN(i) || !field || !propertyRows[i]) return;
    propertyRows[i][field] = target.type === 'number'
      ? (parseFloat(target.value) || 0)
      : target.value;
  }

  /* ---------------- entry point ----------------
     Called from app.js once the real profile key is known. Everything stays
     hidden — and no tax endpoint is ever called — for any other persona. */

  /**
   * Onboarding writes "individual", but profiles created through other paths
   * carry a per-user "custom_<username>" key. Both are Individuals; "startup"
   * and "enterprise" are not. Mirrors backend/routers/startup.py and the
   * matching guard in backend/routers/tax.py.
   */
  function isIndividualKey(key) {
    return !!key && (key === 'individual' || String(key).indexOf('custom_') === 0);
  }

  async function initForProfile(profileKey) {
    const nav = $('navTax');
    if (!isIndividualKey(profileKey)) {
      if (nav) nav.hidden = true;
      return;
    }
    if (nav) nav.hidden = false;
    if (initialised) return;
    initialised = true;

    try {
      wire();
      await loadYear(null);
    } catch (err) {
      console.error('Tax Calculator failed to initialise:', err);
      setText('taxSaveState', 'Could not load the tax calculator');
    }
  }

  window.taxCalculator = { initForProfile, refresh: collectNow };
})();
