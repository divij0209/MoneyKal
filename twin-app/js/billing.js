/* ==========================================================================
   TWIN — Plans & Billing

   Renders GET /billing/me, /billing/catalog and /billing/orders into
   #view-billing, and runs checkout: POST /billing/orders prices a purchase,
   POST /billing/orders/{id}/upi-qr issues its UPI QR, and
   POST /billing/orders/{id}/pay takes payment and grants it.

   Prices, limits, what each plan includes, which services a persona can buy
   and which payment methods exist all come from the backend
   (backend/core/config/pricing_config.py); nothing here hardcodes a price, a
   duration or a method.

   Checkout offers one method: a UPI QR, drawn by the server from the order's
   real total. Paying it is simulated — the ten seconds of "waiting",
   "processing" and "verifying" are presentation, and the screen says as much
   throughout — but the confirmation behind them is a real request, and only
   its success shows a success screen. Nothing is charged.

   This page never collects card, UPI or bank details. A real gateway's own
   hosted checkout will collect those when one is connected.

   Words and figures are kept in separate elements, so js/i18n.js can translate
   every label by exact match without a figure ever breaking the lookup.

   Other modules open this page through window.billingView:
     open()                 render the page (called by switchView)
     openUpgrade()          jump to the Upgrade tab
     buy(sku, subjectRef)   start checkout for one item
   After a purchase it dispatches 'mk:billingchange' with the new account state.

   Reuses escapeHtml from app.js, loaded before this file.
   ========================================================================== */

(function () {
  'use strict';

  const S = {
    me: null,
    catalog: null,
    orders: [],
    coins: null,            // GET /billing/coins
    loadError: null,
    tab: 'plan',            // plan | upgrade | coins | history
    cycle: 'yearly',        // monthly | yearly, on the Upgrade tab
    taxYear: null,
    // { token, stage, order, method, intent, phase, startedAt, timer,
    //   busy, locked, confirmSent, receiptPending, error, receipt }
    // stage: creating | review | requoting | qr | paying | failed | blocked | success
    checkout: null,
    prompt: null            // the 402 detail an upgrade prompt is explaining
  };
  let wired = false;

  /* Upgrade prompt copy, keyed by the feature the server named in its 402.
     Figures (limits, dates, prices) are rendered as separate elements, so
     every sentence here translates by exact match. */
  const PROMPTS = {
    ask_twin: {
      title: "You've used this month's free questions",
      body: 'Get ACT for unlimited Tathya and Varta questions, or wait until your free questions reset.'
    },
    simulations: {
      title: "You've used this month's free simulations",
      body: 'Get ACT for unlimited simulations, or wait until your free simulations reset.'
    },
    auto_sweep: {
      title: 'Auto-sweep is part of ACT',
      body: 'Upgrade to have MoneyKal move your unspent budget into your goals for you.'
    },
    gmail_ingest: {
      title: 'Gmail import is part of ACT',
      body: 'Upgrade to import bills and payments from Gmail automatically. Everything already imported stays in Hisaab.'
    },
    tax_calculator: {
      title: 'Unlock your tax result',
      body: 'Pay once for this tax year, or get ACT, which includes every tax year.'
    }
  };
  const PROMPT_FALLBACK = {
    title: 'This is part of ACT',
    body: 'Upgrade to ACT to use this feature.'
  };

  const $ = id => document.getElementById(id);

  const TABS = [
    { key: 'plan', label: 'My Plan' },
    { key: 'upgrade', label: 'Upgrade' },
    { key: 'coins', label: 'Kal Coins' },
    { key: 'history', label: 'History' }
  ];

  const STATUS = {
    none: { label: 'Free forever', tone: 'neutral' },
    active: { label: 'Active', tone: 'good' },
    expired: { label: 'Expired', tone: 'muted' },
    cancelled: { label: 'Cancelled', tone: 'muted' }
  };

  const ACCESS = {
    locked: { label: 'Locked', tone: 'muted' },
    purchased: { label: 'Purchased', tone: 'good' },
    included_in_act: { label: 'Included in ACT', tone: 'good' }
  };

  /* Checkout offers whatever the server says it accepts — today one method, a
     demo UPI QR (backend/core/config/pricing_config.py). The labels below are
     only a fallback, and for naming the retired methods on an older receipt. */
  const METHOD_LABELS = {
    upi_qr: 'UPI QR',
    coins: 'Kal Coins',
    upi: 'UPI',
    card: 'Card',
    netbanking: 'Net banking'
  };
  const METHOD_HINTS = {
    upi_qr: 'Scan using any UPI app'
  };
  const DEFAULT_METHOD = 'upi_qr';

  function methods() {
    const list = (S.me && S.me.payment_methods) || [];
    return list.length ? list : [{ key: DEFAULT_METHOD, label: METHOD_LABELS[DEFAULT_METHOD] }];
  }

  /* The simulated payment, in milliseconds from the moment the QR appears.
     The stages are theatre; the confirmation at CONFIRM_AT is a real request,
     and the success screen waits for it however long it takes. */
  const SIM = {
    received: 3000,     // "Waiting for payment…"  ->  "Payment received"
    verifying: 7000,    // "Processing payment…"   ->  "Verifying payment…"
    confirmAt: 7000,    // POST /pay goes out here
    successAt: 9000,    // earliest the success screen may appear
    total: 10000        // the progress bar reaches full here
  };
  const SIM_PHASES = [
    { key: 'waiting', label: 'Waiting for payment…' },
    { key: 'received', label: 'Payment received' },
    { key: 'verifying', label: 'Verifying payment…' }
  ];
  const PAY_FAILED = 'Something went wrong while processing your payment. Please try again.';

  /* ---------------- formatting ---------------- */

  function money(minor) {
    const rupees = (Number(minor) || 0) / 100;
    // Whole rupees print without decimals; anything else prints both paise
    // digits, so a coin reads ₹0.10 rather than ₹0.1.
    const digits = rupees % 1 ? 2 : 0;
    return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function date(iso) {
    if (!iso) return '—';
    // The backend sends naive UTC timestamps; mark them as UTC before parsing.
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function taxYear(key) {
    // "FY2026-27" -> "FY 2026-27"
    return String(key || '').replace(/^FY(?=\d)/, 'FY ');
  }

  function chip(state) {
    return `<span class="bl-chip bl-chip--${state.tone}">${escapeHtml(state.label)}</span>`;
  }

  function isAct() { return S.me && S.me.tier === 'act'; }

  function pass(sku) {
    return (S.catalog.tiers.act.passes || []).find(p => p.sku === sku) || null;
  }

  function taxService() {
    return (S.catalog.services || []).find(s => s.sku === 'tax_calculator') || null;
  }

  function serviceRows(sku) {
    return (S.me.services || []).filter(s => s.sku === sku);
  }

  /* ---------------- My Plan ---------------- */

  function currentPlanHtml() {
    const me = S.me;
    const status = STATUS[me.subscription_status] || STATUS.none;
    const plan = me.plan || {};
    const current = plan.sku ? pass(plan.sku) : null;

    let details = '';
    if (plan.expires_at) {
      const endLabel = isAct() ? 'Ends on' : 'Ended on';
      details = `
        <dl class="bl-facts">
          ${current ? `<div><dt>Pass</dt><dd>${escapeHtml(current.label)}</dd></div>` : ''}
          <div><dt>${endLabel}</dt><dd>${date(plan.expires_at)}</dd></div>
          ${isAct() ? `<div><dt>Days left</dt><dd>${plan.days_left}</dd></div>` : ''}
        </dl>`;
    }

    const lead = isAct()
      ? 'Automation, unlimited questions and simulations, and every premium feature are unlocked.'
      : me.subscription_status === 'none'
        ? 'You are on the free plan. Seeing your money is always free.'
        : 'Your ACT pass has ended, so you are back on the free plan.';

    return `
      <div class="panel bl-current">
        <span class="bl-eyebrow">Current plan</span>
        <div class="bl-current__row">
          <span class="bl-current__name">${isAct() ? 'ACT' : 'SEE'}</span>
          ${chip(status)}
        </div>
        <p class="bl-muted">${lead}</p>
        ${details}
        <div class="bl-actions">
          <button type="button" class="btn btn--primary" data-bl="goto" data-tab="upgrade">
            ${isAct() ? 'Extend ACT' : 'Upgrade to ACT'}
          </button>
        </div>
        ${isAct() ? `<p class="bl-fine">Passes do not renew by themselves. Buying again adds the days on top of your end date.</p>` : ''}
      </div>`;
  }

  function usageHtml() {
    const quotas = Object.values(S.me.quotas || {});
    const resets = quotas.length ? quotas[0].resets_on : null;
    const rows = quotas.map(q => {
      if (q.unlimited) {
        return `
          <div class="bl-meter">
            <div class="bl-meter__head">
              <span>${escapeHtml(q.label)}</span>
              <span class="bl-meter__value"><span>Unlimited</span></span>
            </div>
            <div class="bl-meter__track"><span class="bl-meter__fill is-full"></span></div>
          </div>`;
      }
      const pct = q.limit ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
      return `
        <div class="bl-meter${q.remaining === 0 ? ' is-exhausted' : ''}">
          <div class="bl-meter__head">
            <span>${escapeHtml(q.label)}</span>
            <span class="bl-meter__value">${q.used} / ${q.limit}</span>
          </div>
          <div class="bl-meter__track" role="progressbar" aria-valuemin="0"
               aria-valuemax="${q.limit}" aria-valuenow="${q.used}">
            <span class="bl-meter__fill" style="width:${pct}%"></span>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="panel bl-usage">
        <div class="panel__head"><h3>This month's usage</h3></div>
        ${rows}
        ${resets && !isAct() ? `<p class="bl-fine"><span>Free allowances reset on</span> ${date(resets)}</p>` : ''}
      </div>`;
  }

  function taxAccessHtml() {
    const svc = taxService();
    const rows = serviceRows('tax_calculator');
    if (!svc || !rows.length) return '';
    return `
      <div class="panel bl-section">
        <div class="panel__head"><h3>Tax Calculator</h3></div>
        <ul class="bl-list">
          ${rows.map(r => `
            <li class="bl-list__row">
              <span class="bl-list__main">${escapeHtml(taxYear(r.subject_ref))}</span>
              ${chip(ACCESS[r.access] || ACCESS.locked)}
              ${r.access === 'locked'
                ? `<button type="button" class="btn bl-btn-sm" data-bl="buy" data-sku="tax_calculator"
                     data-subject="${escapeHtml(r.subject_ref)}"><span>Unlock for</span> ${money(svc.price_minor)}</button>`
                : `<button type="button" class="btn bl-btn-sm" data-bl="open-tax">Open</button>`}
            </li>`).join('')}
        </ul>
      </div>`;
  }

  function planTabHtml() {
    return `
      <div class="bl-grid">
        ${currentPlanHtml()}
        ${usageHtml()}
      </div>
      ${taxAccessHtml()}`;
  }

  /* ---------------- Upgrade ---------------- */

  function cycleHtml() {
    const monthly = pass('act_monthly');
    const yearly = pass('act_yearly');
    let saving = '';
    if (monthly && yearly) {
      // Twelve monthly passes against one yearly pass. Rounded down (365/30 is
      // 12.2) so the saving is never overstated. Derived from the catalog so
      // it follows any price change.
      const passesPerYear = Math.floor(yearly.duration_days / monthly.duration_days);
      const diff = monthly.price_minor * passesPerYear - yearly.price_minor;
      // "You save", not "Save": the dictionary already translates "Save" as the
      // verb on form buttons.
      if (diff > 0) saving = `<span class="bl-save"><span>You save</span> ${money(diff)}</span>`;
    }
    return `
      <div class="bl-cycle" role="radiogroup" aria-label="Billing period">
        <button type="button" role="radio" aria-checked="${S.cycle === 'monthly'}"
                class="bl-cycle__opt${S.cycle === 'monthly' ? ' is-active' : ''}" data-bl="cycle" data-cycle="monthly">Monthly</button>
        <button type="button" role="radio" aria-checked="${S.cycle === 'yearly'}"
                class="bl-cycle__opt${S.cycle === 'yearly' ? ' is-active' : ''}" data-bl="cycle" data-cycle="yearly">Yearly ${saving}</button>
      </div>`;
  }

  function featureList(items) {
    return `<ul class="bl-features">${items.map(text => `
      <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none"
        stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${escapeHtml(text)}</span></li>`).join('')}</ul>`;
  }

  function plansHtml() {
    const see = S.catalog.tiers.see;
    const act = S.catalog.tiers.act;
    const chosen = pass(S.cycle === 'monthly' ? 'act_monthly' : 'act_yearly');

    return `
      <div class="bl-plans">
        <article class="bl-plan">
          <span class="bl-eyebrow">SEE</span>
          <div class="bl-plan__price">${money(0)}</div>
          <p class="bl-plan__per">Free forever</p>
          ${featureList(see.features || [])}
          <div class="bl-plan__foot">
            ${isAct() ? '' : `<span class="bl-current-tag">Your current plan</span>`}
          </div>
        </article>

        <article class="bl-plan bl-plan--act">
          <span class="bl-eyebrow">ACT</span>
          <div class="bl-plan__price">${chosen ? money(chosen.price_minor) : '—'}</div>
          <p class="bl-plan__per">${S.cycle === 'monthly' ? 'For 30 days' : 'For 365 days'}</p>
          ${featureList((act.features || []).map(f => f.description))}
          <div class="bl-plan__foot">
            ${chosen ? `
              <button type="button" class="btn btn--primary btn--block" data-bl="buy" data-sku="${escapeHtml(chosen.sku)}">
                ${isAct() ? 'Extend ACT' : 'Get ACT'}
              </button>` : ''}
          </div>
        </article>
      </div>
      <p class="bl-fine">Passes do not renew by themselves. Buying again adds the days on top of your end date.</p>`;
  }

  function taxOfferHtml() {
    const svc = taxService();
    if (!svc) return '';
    const years = svc.subjects || [];
    if (!S.taxYear || !years.includes(S.taxYear)) S.taxYear = years[0];
    const row = serviceRows('tax_calculator').find(r => r.subject_ref === S.taxYear);
    const access = row ? row.access : 'locked';

    return `
      <div class="panel bl-section bl-service">
        <div class="bl-service__text">
          <span class="bl-eyebrow">Pay per use</span>
          <h3>${escapeHtml(svc.label)}</h3>
          <p class="bl-muted">${escapeHtml(svc.description)}</p>
          ${svc.included_in_act ? `<span class="bl-chip bl-chip--good">Free with ACT</span>` : ''}
        </div>
        <div class="bl-service__buy">
          <div class="bl-plan__price">${money(svc.price_minor)}</div>
          <p class="bl-plan__per">Per tax year</p>
          <select class="ob-input bl-select" data-bl="tax-year" aria-label="Tax year">
            ${years.map(y => `<option value="${escapeHtml(y)}"${y === S.taxYear ? ' selected' : ''}>${escapeHtml(taxYear(y))}</option>`).join('')}
          </select>
          ${access === 'locked'
            ? `<button type="button" class="btn btn--primary btn--block" data-bl="buy" data-sku="tax_calculator"
                 data-subject="${escapeHtml(S.taxYear)}">Buy</button>`
            : `<div class="bl-owned">${chip(ACCESS[access])}</div>`}
        </div>
      </div>`;
  }

  function upgradeTabHtml() {
    return cycleHtml() + plansHtml() + taxOfferHtml();
  }

  /* ---------------- Kal Coins ----------------
     Renders GET /billing/coins: the balance, each way to earn with this
     user's progress, and the ledger. The rules and amounts come from the
     backend (pricing_config.COIN_RULES); nothing here decides who earns. */

  const COIN_REASONS = {
    profile_completed: 'Profile completed',
    friend_invite: 'Friend joined',
    act_yearly: 'ACT Yearly bonus',
    checkout: 'Used at checkout'
  };

  function earnRowHtml(r) {
    if (r.key === 'profile_completed') {
      return `
        <li class="bl-list__row">
          <span class="bl-list__main">${escapeHtml(r.label)}</span>
          ${r.status === 'earned' ? chip({ label: 'Earned', tone: 'good' }) : `<span class="bl-coins">+${r.coins}</span>`}
        </li>`;
    }
    if (r.key === 'friend_invite') {
      const terms = `Credited ${r.wait_days} days after they join, once they have been active on ${r.min_active_days} different days and added ${r.min_entries} entries. Up to ${r.monthly_limit} friends a month.`;
      return `
        <li class="bl-list__row bl-list__row--stack">
          <div class="bl-list__line">
            <span class="bl-list__main">${escapeHtml(r.label)}</span>
            <span class="bl-coins">+${r.coins}</span>
          </div>
          <p class="bl-fine bl-list__terms">${escapeHtml(terms)}</p>
          <dl class="bl-facts bl-facts--inline">
            <div><dt>Friends waiting</dt><dd>${r.waiting_count}</dd></div>
            <div><dt>Friends credited</dt><dd>${r.earned_count}</dd></div>
          </dl>
        </li>`;
    }
    return `
      <li class="bl-list__row">
        <span class="bl-list__main">${escapeHtml(r.label)}</span>
        <span class="bl-coins">+${r.coins}</span>
      </li>`;
  }

  function coinHistoryHtml(history) {
    if (!history.length) {
      return `<p class="empty-note">No coins yet.</p>`;
    }
    return `
      <div class="bl-scroll">
        <table class="bl-table">
          <thead><tr><th>Date</th><th>Activity</th><th class="num">Coins</th><th class="num">Balance</th></tr></thead>
          <tbody>
            ${history.map(h => `
              <tr>
                <td>${date(h.created_at)}</td>
                <td><span>${escapeHtml(COIN_REASONS[h.reason] || 'Adjustment')}</span></td>
                <td class="num ${h.coins > 0 ? 'bl-coins' : ''}">${h.coins > 0 ? '+' : '−'}${Math.abs(h.coins)}</td>
                <td class="num">${h.balance_after}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function coinsTabHtml() {
    if (!S.coins) {
      return `<div class="panel"><p class="empty-note">Loading your coins…</p></div>`;
    }
    const k = S.coins;
    return `
      <div class="bl-grid">
        <div class="panel bl-current">
          <span class="bl-eyebrow">Your balance</span>
          <div class="bl-current__row">
            <span class="bl-current__name">${k.balance.toLocaleString('en-IN')}</span>
          </div>
          <p class="bl-muted">Kal Coins reward you for good money habits. Use them to pay less for MoneyKal.</p>
          <dl class="bl-facts">
            <div><dt>Worth</dt><dd>${money(k.value_minor)}</dd></div>
            <div><dt>Value of 1 coin</dt><dd>${money(k.coin_value_minor)}</dd></div>
          </dl>
          ${k.balance > 0 ? `
            <div class="bl-actions">
              <button type="button" class="btn btn--primary" data-bl="goto" data-tab="upgrade">Use coins</button>
            </div>` : ''}
        </div>
        <div class="panel">
          <div class="panel__head"><h3>How to earn</h3></div>
          <ul class="bl-list">${k.rules.map(earnRowHtml).join('')}</ul>
        </div>
      </div>
      <div class="panel bl-section">
        <div class="panel__head"><h3>Coin history</h3></div>
        ${coinHistoryHtml(k.history || [])}
      </div>
      <div class="panel bl-section">
        <div class="panel__head"><h3>How coins work</h3></div>
        <ul class="bl-rules">
          <li>Use coins at checkout to pay for MoneyKal plans and services.</li>
          <li>Coins can cover the whole price, but never more than it.</li>
          <li>Coins cannot be sent to anyone, gifted, bought or turned into cash.</li>
        </ul>
      </div>`;
  }

  /* ---------------- History ---------------- */

  function orderLabel(o) {
    if (o.kind === 'service' && o.subject_ref) {
      const svc = (S.catalog.services || []).find(s => s.sku === o.sku);
      return `<span>${escapeHtml(svc ? svc.label : o.sku)}</span> · ${escapeHtml(taxYear(o.subject_ref))}`;
    }
    const p = pass(o.sku);
    return `<span>${escapeHtml(p ? p.label : o.sku)}</span>`;
  }

  function methodLabel(key) {
    if (!key) return '—';
    const m = methods().find(x => x.key === key);
    return (m && m.label) || METHOD_LABELS[key] || key;
  }

  function orderMethodLabel(o) {
    return (o && o.payment_method_label) || methodLabel(o && o.payment_method);
  }

  function historyTabHtml() {
    if (!S.orders.length) {
      return `<div class="panel"><p class="empty-note">No payments yet.</p></div>`;
    }
    return `
      <div class="panel">
        <div class="bl-scroll">
          <table class="bl-table">
            <thead><tr>
              <th>Date</th><th>Item</th><th>Method</th><th class="num">Coins used</th><th class="num">Paid</th><th>Status</th>
            </tr></thead>
            <tbody>
              ${S.orders.map(o => `
                <tr>
                  <td>${date(o.paid_at)}</td>
                  <td>${orderLabel(o)}</td>
                  <td><span>${escapeHtml(orderMethodLabel(o))}</span></td>
                  <td class="num">${o.coins_redeemed || 0}</td>
                  <td class="num">${money(o.payable_minor)}</td>
                  <td>${chip({ label: o.payment_mode === 'demo' ? 'Paid (demo)' : 'Paid', tone: 'good' })}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  /* ---------------- Checkout ---------------- */

  const DEMO_NOTE = 'Demo Payment • No real money will be charged';

  function isDemo() {
    return !!(S.me && S.me.payment_mode === 'demo');
  }

  function planLine(o) {
    // "ACT Monthly · 30 days", from the duration the server priced the order
    // at rather than a length written down again here.
    if (!o.duration_days) return orderLabel(o);
    return `${orderLabel(o)} · <span>${o.duration_days}</span> <span>days</span>`;
  }

  /* The QR as one SVG path: a horizontal run of dark modules per subpath.
     Always black on white, whatever the theme — an inverted QR does not scan. */
  function qrSvgHtml(qr) {
    if (!qr || !qr.rows || !qr.rows.length) return '';
    const n = qr.size || qr.rows.length;
    let d = '';
    qr.rows.forEach((row, r) => {
      let c = 0;
      while (c < n) {
        if (row[c] === '1') {
          let len = 1;
          while (c + len < n && row[c + len] === '1') len++;
          d += `M${c} ${r}h${len}v1h-${len}z`;
          c += len;
        } else {
          c++;
        }
      }
    });
    // The quiet zone the standard asks for: four clear modules on every side.
    // It is drawn into the SVG rather than left to the card's padding, so the
    // code keeps it whatever the card around it does.
    const pad = 4;
    return `
      <svg class="bl-qr__svg" viewBox="${-pad} ${-pad} ${n + pad * 2} ${n + pad * 2}"
           shape-rendering="crispEdges" role="img" aria-label="UPI payment QR code">
        <rect x="${-pad}" y="${-pad}" width="${n + pad * 2}" height="${n + pad * 2}" fill="#ffffff"/>
        <path d="${d}" fill="#000000"/>
      </svg>`;
  }

  function stepsHtml(phase) {
    const at = SIM_PHASES.findIndex(p => p.key === phase);
    return `
      <ol class="bl-steps" id="blSteps">
        ${SIM_PHASES.map((p, i) => {
          const state = i < at ? 'is-done' : i === at ? 'is-active' : '';
          return `
            <li class="bl-step ${state}" data-step="${p.key}">
              <span class="bl-step__dot" aria-hidden="true"></span>
              <span class="bl-step__label">${escapeHtml(p.label)}</span>
            </li>`;
        }).join('')}
      </ol>
      <p class="sr-only" role="status" id="blQrStatus">${escapeHtml(SIM_PHASES[Math.max(0, at)].label)}</p>`;
  }

  /* Moves the marker rather than replacing the list, so the only thing that
     changes is the class on three <li>s and one line of status text — which is
     also the only part worth announcing. */
  function paintSteps(phase) {
    const list = $('blSteps');
    if (!list) return;
    const at = SIM_PHASES.findIndex(p => p.key === phase);
    SIM_PHASES.forEach((p, i) => {
      const li = list.querySelector(`[data-step="${p.key}"]`);
      if (!li) return;
      li.classList.toggle('is-done', i < at);
      li.classList.toggle('is-active', i === at);
    });
    const status = $('blQrStatus');
    if (status && at >= 0) status.textContent = SIM_PHASES[at].label;
  }

  function qrHtml(c) {
    const o = c.order;
    const intent = c.intent || {};
    return `
      <div class="bl-qr">
        <span class="bl-qr__amount">${money(o.payable_minor)}</span>
        <p class="bl-qr__plan">${planLine(o)}</p>
        <div class="bl-qr__code">${qrSvgHtml(intent.qr)}</div>
        <p class="bl-qr__hint">Scan using any UPI app</p>
        <p class="bl-qr__ref"><span>Ref</span> ${escapeHtml(intent.transaction_reference || '')}</p>
      </div>
      <div class="bl-progress" role="progressbar" aria-label="Payment progress">
        <span class="bl-progress__bar" id="blQrBar"></span>
      </div>
      ${stepsHtml(c.phase)}
      <p class="bl-demo-note">${escapeHtml(DEMO_NOTE)}</p>
      <div class="bl-modal__buttons">
        <button type="button" class="btn" data-bl="close" ${c.locked ? 'disabled' : ''}>Cancel</button>
      </div>`;
  }

  function reviewHtml(c) {
    const o = c.order;
    const busy = c.stage === 'requoting' || c.stage === 'paying' || c.busy;
    const available = (S.me && S.me.kal_coins && S.me.kal_coins.balance) || 0;
    const usingCoins = o.coins_redeemed > 0;
    const coveredByCoins = o.payable_minor === 0;

    // Shown whenever there are coins to use, or coins already on the order.
    const coinOption = (available > 0 || usingCoins) ? `
      <label class="bl-coinopt${usingCoins ? ' is-selected' : ''}">
        <input type="checkbox" data-bl="coins" ${usingCoins ? 'checked' : ''} ${busy ? 'disabled' : ''}>
        <span class="bl-method__text">
          <span class="bl-method__label">Use Kal Coins</span>
          <span class="bl-method__hint"><span>Available</span> ${available.toLocaleString('en-IN')}${usingCoins ? ` · <span>Using</span> ${o.coins_redeemed.toLocaleString('en-IN')}` : ''}</span>
        </span>
      </label>` : '';

    const method = coveredByCoins
      ? `<p class="bl-fine">Kal Coins cover the full price. No payment is needed.</p>`
      : `
      <fieldset class="bl-methods" ${busy ? 'disabled' : ''}>
        <legend class="bl-eyebrow">Payment method</legend>
        ${methods().map(m => `
          <label class="bl-method${c.method === m.key ? ' is-selected' : ''}">
            <input type="radio" name="blMethod" value="${m.key}" data-bl="method" ${c.method === m.key ? 'checked' : ''}>
            <span class="bl-method__text">
              <span class="bl-method__label">${escapeHtml(m.label)}</span>
              <span class="bl-method__hint">${escapeHtml(METHOD_HINTS[m.key] || '')}</span>
            </span>
          </label>`).join('')}
      </fieldset>
      ${isDemo() ? `<p class="bl-demo-note">${escapeHtml(DEMO_NOTE)}</p>` : ''}`;

    const payLabel = busy
      ? '<span>Please wait…</span>'
      : coveredByCoins ? '<span>Pay with Kal Coins</span>' : `<span>Pay</span> ${money(o.payable_minor)}`;

    return `
      <div class="bl-summary">
        <span class="bl-eyebrow">Order summary</span>
        <div class="bl-summary__row"><span>${planLine(o)}</span><span>${money(o.gross_minor)}</span></div>
        ${o.coin_discount_minor > 0 ? `
          <div class="bl-summary__row"><span>Kal Coins</span><span>− ${money(o.coin_discount_minor)}</span></div>` : ''}
        <div class="bl-summary__row bl-summary__total"><span>Total to pay</span><span>${money(o.payable_minor)}</span></div>
      </div>

      ${coinOption}
      ${method}
      ${c.error ? `<p class="bl-alert" role="alert">${escapeHtml(c.error)}</p>` : ''}

      <div class="bl-modal__buttons">
        <button type="button" class="btn" data-bl="close" ${busy ? 'disabled' : ''}>Cancel</button>
        <button type="button" class="btn btn--primary" data-bl="pay" ${busy ? 'disabled' : ''}>${payLabel}</button>
      </div>`;
  }

  function failedHtml(c) {
    return `
      <div class="bl-failed">
        <span class="bl-failed__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 7v6M12 16.5v.5" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" fill="none"
            stroke="currentColor" stroke-width="1.6"/></svg>
        </span>
        <p class="bl-muted">${escapeHtml(c.error || PAY_FAILED)}</p>
      </div>
      <div class="bl-modal__buttons">
        <button type="button" class="btn" data-bl="close">Close</button>
        ${c.order ? `<button type="button" class="btn btn--primary" data-bl="retry-pay">Try again</button>` : ''}
      </div>`;
  }

  const TITLES = {
    creating: 'Checkout',
    review: 'Checkout',
    requoting: 'Checkout',
    paying: 'Checkout',
    qr: 'Complete payment',
    failed: 'Payment not completed',
    blocked: 'Checkout',
    success: 'Payment successful'
  };

  function checkoutHtml() {
    const c = S.checkout;
    if (!c) return '';
    const demo = isDemo();
    let body;

    if (c.stage === 'creating') {
      body = `<p class="empty-note">Preparing your order…</p>`;
    } else if (c.stage === 'blocked') {
      body = `
        <p class="bl-alert">${escapeHtml(c.error)}</p>
        <div class="bl-modal__buttons">
          <button type="button" class="btn" data-bl="close">Close</button>
        </div>`;
    } else if (c.stage === 'success') {
      body = successHtml(c);
    } else if (c.stage === 'failed') {
      body = failedHtml(c);
    } else if (c.stage === 'qr') {
      body = qrHtml(c);
    } else {
      body = reviewHtml(c);
    }

    const closable = !c.locked && c.stage !== 'paying';
    return `
      <div class="bl-modal" role="dialog" aria-modal="true" aria-labelledby="blCheckoutTitle">
        <div class="bl-modal__backdrop" ${closable ? 'data-bl="close"' : ''}></div>
        <div class="bl-modal__card" tabindex="-1" id="blCheckoutCard">
          <div class="bl-modal__head">
            <h3 id="blCheckoutTitle">${escapeHtml(TITLES[c.stage] || 'Checkout')}</h3>
            ${closable ? `
              <button type="button" class="bl-modal__close" data-bl="close" aria-label="Close">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor"
                  stroke-width="1.6" stroke-linecap="round"/></svg>
              </button>` : ''}
          </div>
          ${demo && c.stage !== 'success' && c.stage !== 'qr' ? `<span class="bl-demo-tag">Demo mode</span>` : ''}
          ${body}
        </div>
      </div>`;
  }

  function successHtml(c) {
    const o = c.receipt;
    const plan = S.me.plan || {};
    let granted;
    if (o.kind === 'act_pass') {
      granted = `
        <p class="bl-success__line">ACT activated successfully</p>
        <p class="bl-muted"><span>Valid for</span> ${plan.days_left != null ? `<span>${plan.days_left}</span> <span>days</span>` : ''}<span>, until</span> ${date(plan.expires_at)}</p>`;
    } else {
      granted = `<p class="bl-muted"><span>Tax Calculator unlocked for</span> ${escapeHtml(taxYear(o.subject_ref))}</p>`;
    }
    // The ACT Yearly reward, read from the rules the server sent rather than
    // assumed, and only once the ledger shows it for this order.
    const yearlyRule = S.coins && (S.coins.rules || []).find(r => r.key === 'act_yearly');
    const rewarded = o.sku === 'act_yearly' && S.coins && (S.coins.history || [])
      .some(h => h.reason === 'act_yearly' && h.source_id === o.id);
    return `
      <div class="bl-success">
        <span class="bl-success__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        <span class="bl-success__amount">${money(o.payable_minor)}</span>
        ${granted}
        ${rewarded && yearlyRule ? `<p class="bl-coins"><span>You earned Kal Coins</span> +${yearlyRule.coins}</p>` : ''}
      </div>
      <dl class="bl-facts">
        <div><dt>Item</dt><dd>${orderLabel(o)}</dd></div>
        ${o.coins_redeemed > 0 ? `<div><dt>Kal Coins used</dt><dd>${o.coins_redeemed.toLocaleString('en-IN')}</dd></div>` : ''}
        <div><dt>Paid</dt><dd>${money(o.payable_minor)}</dd></div>
        <div><dt>Method</dt><dd><span>${escapeHtml(orderMethodLabel(o))}</span></dd></div>
        ${o.transaction_reference ? `<div><dt>Reference</dt><dd>${escapeHtml(o.transaction_reference)}</dd></div>` : ''}
        <div><dt>Order</dt><dd>#${o.id}</dd></div>
      </dl>
      ${o.is_demo ? `<p class="bl-demo-note">${escapeHtml(DEMO_NOTE)}</p>` : ''}
      <div class="bl-modal__buttons">
        ${o.kind === 'service' ? `<button type="button" class="btn" data-bl="open-tax">Open Tax Calculator</button>` : ''}
        <button type="button" class="btn btn--primary" data-bl="done">Continue</button>
      </div>`;
  }

  /* ---------------- upgrade prompt ----------------
     Shown by any screen whose action came back 402. It explains and offers
     the way forward; it never replaces what the screen already shows. */

  function promptHtml() {
    const d = S.prompt;
    if (!d) return '';
    const key = d.error === 'purchase_required' ? d.sku : d.feature;
    const copy = PROMPTS[key] || PROMPT_FALLBACK;

    let facts = '';
    if (d.error === 'quota_exceeded') {
      facts = `
        <dl class="bl-facts">
          <div><dt>Used this month</dt><dd>${d.used} / ${d.limit}</dd></div>
          <div><dt>Free allowances reset on</dt><dd>${date(d.resets_on)}</dd></div>
        </dl>`;
    } else if (d.error === 'purchase_required' && d.subject_ref) {
      facts = `
        <dl class="bl-facts">
          <div><dt>Tax year</dt><dd>${escapeHtml(taxYear(d.subject_ref))}</dd></div>
        </dl>`;
    }

    const primary = d.error === 'purchase_required'
      ? `<button type="button" class="btn btn--primary" data-bl="prompt-buy"><span>Unlock for</span> ${money(d.price_minor)}</button>`
      : `<button type="button" class="btn btn--primary" data-bl="prompt-upgrade">See ACT plans</button>`;
    const secondary = d.error === 'purchase_required' && d.included_in_act
      ? `<button type="button" class="btn" data-bl="prompt-upgrade">See ACT plans</button>`
      : `<button type="button" class="btn" data-bl="prompt-close">Not now</button>`;

    return `
      <div class="bl-modal" role="dialog" aria-modal="true" aria-labelledby="blPromptTitle">
        <div class="bl-modal__backdrop" data-bl="prompt-close"></div>
        <div class="bl-modal__card" tabindex="-1" id="blCheckoutCard">
          <div class="bl-modal__head">
            <h3 id="blPromptTitle">${escapeHtml(copy.title)}</h3>
            <button type="button" class="bl-modal__close" data-bl="prompt-close" aria-label="Close">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor"
                stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
          </div>
          <p class="bl-muted">${escapeHtml(copy.body)}</p>
          ${facts}
          <div class="bl-modal__buttons">${secondary}${primary}</div>
        </div>
      </div>`;
  }

  /* An inline "part of ACT" card for a panel whose content is an ACT feature
     (e.g. weekly reports). Its button is handled by the document listener
     below, so a screen can drop this HTML in without wiring anything. */
  const LOCK_CARDS = {
    reports: {
      title: 'Weekly reports are part of ACT',
      body: 'Your daily brief stays free. Upgrade for weekly health and spend reports, with PDF download.'
    }
  };

  function lockCardHtml(detail) {
    const copy = LOCK_CARDS[detail && detail.feature] || PROMPT_FALLBACK;
    return `
      <div class="bl-lockcard">
        <span class="tax-lock__icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none"><rect x="4" y="9" width="12" height="8.5" rx="1.5"
            stroke="currentColor" stroke-width="1.5"/><path d="M6.8 9V6.5a3.2 3.2 0 0 1 6.4 0V9"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </span>
        <div class="bl-lockcard__text">
          <div class="bl-lockcard__title">${escapeHtml(copy.title)}</div>
          <p class="bl-muted">${escapeHtml(copy.body)}</p>
        </div>
        <button type="button" class="btn btn--primary bl-btn-sm" data-bl-upgrade>See ACT plans</button>
      </div>`;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-bl-upgrade]') && window.billingView) window.billingView.openUpgrade();
  });

  /** Show an upgrade prompt for a 402 detail. Returns false for anything that
   *  is not a billing refusal, so callers can fall back to their own error. */
  function showPrompt(detail) {
    if (!detail || !['quota_exceeded', 'upgrade_required', 'purchase_required'].includes(detail.error)) {
      return false;
    }
    if (S.checkout) return true;   // already mid-purchase; don't stack dialogs
    S.prompt = detail;
    renderCheckout();
    return true;
  }

  function closePrompt() {
    if (!S.prompt) return;
    S.prompt = null;
    renderCheckout();
  }

  /* ---------------- render ---------------- */

  function render() {
    const host = $('view-billing');
    if (!host) return;

    if (S.loadError) {
      host.innerHTML = `
        <div class="panel">
          <p class="empty-note">Could not load your plan.</p>
          <p class="bl-fine">${escapeHtml(S.loadError)}</p>
          <button type="button" class="btn" data-bl="retry">Try again</button>
        </div>`;
      renderCheckout();
      return;
    }
    if (!S.me || !S.catalog) {
      host.innerHTML = `<div class="panel"><p class="empty-note">Loading your plan…</p></div>`;
      renderCheckout();
      return;
    }

    const body = {
      plan: planTabHtml,
      upgrade: upgradeTabHtml,
      coins: coinsTabHtml,
      history: historyTabHtml
    }[S.tab]();

    host.innerHTML = `
      <div class="bl">
        ${S.me.payment_mode === 'demo' ? `
          <div class="bl-banner" role="note">
            <span class="bl-demo-tag">Demo mode</span>
            <span>Payments are simulated. No money is charged.</span>
          </div>` : ''}
        <div class="bl-tabs" role="tablist" aria-label="Plans and billing">
          ${TABS.map(t => `
            <button type="button" role="tab" aria-selected="${S.tab === t.key}"
                    class="bl-tab${S.tab === t.key ? ' is-active' : ''}" data-bl="tab" data-tab="${t.key}">${t.label}</button>`).join('')}
        </div>
        <div class="bl-body" role="tabpanel">${body}</div>
      </div>`;

    renderCheckout();
  }

  /* The dialog lives on <body>, not inside the view: .view animates with a
     transform on entry, and a transformed ancestor would pin a fixed overlay
     to the view instead of the viewport while it runs. */
  function modalHost() {
    let el = $('blCheckoutHost');
    if (!el) {
      el = document.createElement('div');
      el.id = 'blCheckoutHost';
      document.body.appendChild(el);
      el.addEventListener('click', onClick);
    }
    return el;
  }

  function renderCheckout() {
    const host = modalHost();
    host.innerHTML = S.checkout ? checkoutHtml() : promptHtml();
    const open = !!(S.checkout || S.prompt);
    document.body.classList.toggle('bl-modal-open', open);
    if (open) {
      const card = $('blCheckoutCard');
      if (card && !card.contains(document.activeElement)) card.focus();
    }
  }

  /* ---------------- data ---------------- */

  async function load() {
    S.loadError = null;
    if (!S.me) render();
    try {
      // /billing/me first: it grants any reward that has come due, so the
      // coins read after it already include that reward.
      S.me = await window.api.billing.me();
      const [catalog, orders, coins] = await Promise.all([
        window.api.billing.catalog(),
        window.api.billing.orders(),
        window.api.billing.coins()
      ]);
      S.catalog = catalog;
      S.orders = orders || [];
      S.coins = coins;
    } catch (err) {
      console.error('Billing load failed:', err);
      S.loadError = err.message || 'Please check your connection.';
    }
    render();
  }

  /* ---------------- checkout flow ---------------- */

  /* A token per checkout attempt. Every async step checks it before writing
     back, so a reply that lands after the user cancelled is dropped instead of
     reopening a dialog they closed. */
  let attempt = 0;

  function stopSim() {
    const c = S.checkout;
    if (c && c.timer) {
      clearInterval(c.timer);
      c.timer = null;
    }
  }

  function live(token) {
    return S.checkout && S.checkout.token === token;
  }

  async function buy(sku, subjectRef) {
    if (!S.me || !S.catalog) await load();
    if (!S.me) return;
    stopSim();
    const token = ++attempt;
    S.checkout = { stage: 'creating', method: DEFAULT_METHOD, token };
    render();
    let next;
    try {
      const order = await window.api.billing.createOrder(sku, subjectRef);
      next = { stage: 'review', order, method: DEFAULT_METHOD, error: null, token };
    } catch (err) {
      next = { stage: 'blocked', error: err.message || 'Could not start checkout.', token };
    }
    if (!live(token)) return;
    S.checkout = next;
    render();
  }

  /* The Pay button. An order Kal Coins cover in full moves no money, so it is
     confirmed straight away; anything payable goes to the QR first. */
  async function payNow() {
    const c = S.checkout;
    if (!c || c.stage !== 'review' || c.busy) return;
    if (c.order.payable_minor === 0) return payWithCoins();

    c.busy = true;
    c.error = null;
    render();
    const token = c.token;
    try {
      const intent = await window.api.billing.startUpiQr(c.order.id);
      if (!live(token)) return;
      c.order = intent.order || c.order;
      c.intent = intent;
      c.busy = false;
      c.stage = 'qr';
      c.phase = 'waiting';
      c.startedAt = Date.now();
      render();
      c.timer = setInterval(simTick, 80);
    } catch (err) {
      if (!live(token)) return;
      c.busy = false;
      await applyPayError(c, err);
      if (live(token)) render();
    }
  }

  async function payWithCoins() {
    const c = S.checkout;
    c.stage = 'paying';
    c.locked = true;
    c.error = null;
    render();
    const token = c.token;
    try {
      const res = await window.api.billing.payOrder(c.order.id, c.method, null);
      if (!live(token)) return;
      await settle(res, token);
    } catch (err) {
      if (!live(token)) return;
      c.locked = false;
      c.stage = 'review';
      await applyPayError(c, err);
      if (live(token)) render();
    }
  }

  /* Drives the simulated payment. The stages are presentation; the request
     fired at SIM.confirmAt is the real one, and only its success moves the
     dialog on — a failure there never shows a success screen. */
  function simTick() {
    const c = S.checkout;
    if (!c || c.stage !== 'qr') return stopSim();
    const t = Date.now() - c.startedAt;

    const bar = $('blQrBar');
    if (bar) bar.style.width = Math.min(100, (t / SIM.total) * 100).toFixed(1) + '%';

    const phase = t < SIM.received ? 'waiting' : t < SIM.verifying ? 'received' : 'verifying';
    if (phase !== c.phase) {
      c.phase = phase;
      paintSteps(phase);
    }

    if (t >= SIM.confirmAt && !c.confirmSent) {
      c.confirmSent = true;
      // No cancelling once the request is out. `locked` is what actually
      // refuses it — the buttons are greyed here rather than by re-rendering,
      // which would restart the progress bar mid-animation.
      c.locked = true;
      document.querySelectorAll('#blCheckoutCard [data-bl="close"]')
        .forEach(el => { el.disabled = true; });
      confirmPayment();
    }
    if (c.receiptPending && t >= SIM.successAt) showSuccess();
  }

  async function confirmPayment() {
    const c = S.checkout;
    const token = c.token;
    const reference = (c.intent && c.intent.transaction_reference) || null;
    try {
      const res = await window.api.billing.payOrder(c.order.id, c.method, reference);
      if (!live(token)) return;
      S.checkout.receiptPending = res;
      if (Date.now() - S.checkout.startedAt >= SIM.successAt) showSuccess();
    } catch (err) {
      if (!live(token)) return;
      stopSim();
      const cc = S.checkout;
      cc.locked = false;
      cc.confirmSent = false;
      await applyPayError(cc, err);
      if (!live(token)) return;
      // A re-priced order goes back to the summary for the user to confirm the
      // new total; anything else is a plain failure they can retry.
      S.checkout.stage = S.checkout.requoted ? 'review' : 'failed';
      S.checkout.requoted = false;
      render();
    }
  }

  async function showSuccess() {
    const c = S.checkout;
    const res = c.receiptPending;
    stopSim();
    await settle(res, c.token);
  }

  /* Shared by both payment paths: record the receipt, refresh what the rest of
     the app reads, and tell it the plan changed. */
  async function settle(res, token) {
    S.me = res.account;
    S.checkout = { stage: 'success', receipt: res.order, token };
    render();
    try {
      const [orders, coins] = await Promise.all([window.api.billing.orders(), window.api.billing.coins()]);
      S.orders = orders || [];
      S.coins = coins;
    } catch (e) { /* history refreshes on next open */ }
    document.dispatchEvent(new CustomEvent('mk:billingchange', { detail: S.me }));
    if (live(token)) render();
  }

  /* Turns a failed payment into something worth reading. Raw server messages
     are only shown for the refusals that tell the user what to do about it. */
  async function applyPayError(c, err) {
    const detail = err && err.detail;
    const code = detail && detail.error;
    c.requoted = false;
    if (code === 'coins_changed' && detail.order) {
      // Coins were spent elsewhere since this order was priced: the server
      // re-priced it, so show the new total for the user to confirm.
      c.order = detail.order;
      c.intent = null;
      c.requoted = true;
      c.error = detail.message || 'Your Kal Coins balance changed. Please check the new total.';
      try { S.me = await window.api.billing.me(); } catch (e) { /* keep the last known balance */ }
      return;
    }
    if (code === 'already_has_access' || code === 'payments_unavailable' || code === 'no_payment_needed') {
      c.error = detail.message;
      return;
    }
    c.error = PAY_FAILED;
  }

  async function toggleCoins(useCoins) {
    const c = S.checkout;
    if (!c || c.stage !== 'review' || c.busy) return;
    c.stage = 'requoting';
    c.error = null;
    render();
    const token = c.token;
    try {
      const order = await window.api.billing.setOrderCoins(c.order.id, useCoins);
      if (!live(token)) return;
      S.checkout.order = order;
      S.checkout.intent = null;     // the old QR named the old total
    } catch (err) {
      if (!live(token)) return;
      S.checkout.error = (err && err.message) || 'Could not update Kal Coins.';
    }
    S.checkout.stage = 'review';
    render();
  }

  /* Back to the summary after a failure, so the user can re-check the total
     before trying again. The order is still unpaid, and keeps its reference. */
  function retryPayment() {
    const c = S.checkout;
    if (!c || !c.order) return;
    c.stage = 'review';
    c.intent = null;
    c.confirmSent = false;
    c.receiptPending = null;
    c.locked = false;
    c.busy = false;
    c.error = null;
    render();
  }

  /* Closing mid-payment is refused rather than ignored: the order is unpaid
     until the server says otherwise, and abandoning it there would leave the
     user unsure whether they had been charged. */
  function closeCheckout() {
    const c = S.checkout;
    if (!c || c.locked || c.stage === 'paying') return;
    stopSim();
    attempt++;
    S.checkout = null;
    render();
  }

  /* ---------------- events ---------------- */

  function onClick(e) {
    const el = e.target.closest('[data-bl]');
    if (!el || el.tagName === 'SELECT') return;
    switch (el.dataset.bl) {
      case 'tab':
      case 'goto':
        S.tab = el.dataset.tab;
        render();
        break;
      case 'cycle':
        S.cycle = el.dataset.cycle;
        render();
        break;
      case 'buy':
        buy(el.dataset.sku, el.dataset.subject || null);
        break;
      case 'method':
        if (S.checkout && S.checkout.stage === 'review') { S.checkout.method = el.value; render(); }
        break;
      case 'coins':
        toggleCoins(el.checked);
        break;
      case 'pay':
        // Disabled the moment it is pressed, so a second click lands on
        // nothing rather than starting a second payment.
        el.disabled = true;
        payNow();
        break;
      case 'retry-pay':
        retryPayment();
        break;
      case 'close':
        closeCheckout();
        break;
      case 'done':
        stopSim();
        attempt++;
        S.checkout = null;
        S.tab = 'plan';
        render();
        break;
      case 'open-tax':
        stopSim();
        attempt++;
        S.checkout = null;
        render();
        if (typeof window.switchView === 'function') window.switchView('tax');
        break;
      case 'retry':
        load();
        break;
      case 'prompt-close':
        closePrompt();
        break;
      case 'prompt-upgrade':
        S.prompt = null;
        renderCheckout();
        window.billingView.openUpgrade();
        break;
      case 'prompt-buy': {
        const d = S.prompt;
        S.prompt = null;
        window.billingView.buy(d.sku, d.subject_ref, { stay: true });
        break;
      }
      default:
        break;
    }
  }

  function onChange(e) {
    if (e.target.matches('select[data-bl="tax-year"]')) {
      S.taxYear = e.target.value;
      render();
    }
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (S.checkout) closeCheckout();
    else if (S.prompt) closePrompt();
  }
  // At load rather than in wire(): a prompt can open from any screen before
  // this page has ever been visited.
  document.addEventListener('keydown', onKey);

  function wire() {
    if (wired) return;
    const host = $('view-billing');
    if (!host) return;
    wired = true;
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
  }

  /* Returning from GET /gmail/auth, which sends a user without ACT back here
     with ?status=error&detail=upgrade_required instead of starting OAuth. */
  function explainGmailReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('detail') !== 'upgrade_required') return;
    params.delete('status');
    params.delete('detail');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    showPrompt({ error: 'upgrade_required', feature: 'gmail_ingest' });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', explainGmailReturn);
  } else {
    explainGmailReturn();
  }

  window.billingView = {
    open: () => { wire(); load(); },
    openUpgrade: () => {
      S.tab = 'upgrade';
      if (typeof window.switchView === 'function') window.switchView('billing');
    },
    // { stay: true } opens checkout over the current screen instead of
    // switching to Plans & Billing, so the user lands back where they were.
    buy: (sku, subjectRef, opts) => {
      wire();
      if (!(opts && opts.stay) && typeof window.switchView === 'function') window.switchView('billing');
      buy(sku, subjectRef);
    },
    prompt: showPrompt,
    lockCardHtml,
    // Fresh plan state for a screen deciding up front (e.g. before navigating
    // away to Gmail). The server still enforces every gate regardless.
    fetchState: async () => {
      S.me = await window.api.billing.me();
      return S.me;
    },
    state: () => S.me
  };
})();
