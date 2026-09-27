/* ==========================================================================
   MoneyKal — Overview command center

   Presentation + routing only. Every number rendered here comes from data the
   app already fetches (profile metrics, /startup/hisaab, /twin/chats,
   /startup/reports/*, the in-memory AGENTS list). Nothing new is invented and
   no endpoint is called that the app did not already call; each preview is a
   read-only summary whose click hands off to the existing view via
   switchView(), so there is exactly one implementation of every feature.
   ========================================================================== */
(function () {

  const ovState = { range: '6M', series: null, loaded: false };

  /* ---------------------------------------------------------------- utils */

  function money(v, currency) {
    const c = currency || '₹';
    if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    if (abs >= 1e7) return sign + c + (abs / 1e7).toFixed(2) + ' Cr';
    if (abs >= 1e5) return sign + c + (abs / 1e5).toFixed(2) + ' L';
    return sign + c + Math.round(abs).toLocaleString('en-IN');
  }

  function displayName() {
    const sess = JSON.parse(localStorage.getItem('twin_session') || '{}');
    let n = sess.username || '';
    if (n.includes('@')) n = n.split('@')[0];          // usernames are often emails
    n = n.replace(/[._-]+/g, ' ').trim();
    if (!n) return 'there';
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function metric(p, ids) {
    if (!p || !p.metrics) return null;
    for (const id of ids) {
      const m = p.metrics.find(x => x.id === id);
      if (m) return m;
    }
    return null;
  }

  function go(view) {
    if (typeof switchView === 'function') switchView(view);
  }

  /* ------------------------------------------------------- smooth chart */

  /** Catmull-Rom → cubic bezier, so the line reads as one smooth curve
   *  rather than the angular polyline used elsewhere in the app. */
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  function renderChart(points, currency) {
    const mount = document.getElementById('ovChart');
    if (!mount) return;
    if (!points || points.length < 2) {
      mount.innerHTML = '<p class="ovc__empty">Not enough history yet to chart a trend. Add transactions in Hisaab to build one.</p>';
      return;
    }

    const W = 720, H = 230;
    const pad = { top: 16, right: 14, bottom: 26, left: 58 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const vals = points.map(p => p.value);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max === min) { max = min + Math.abs(min || 1) * 0.1 + 1; }
    const span = max - min;
    min -= span * 0.12;
    max += span * 0.12;

    const x = i => pad.left + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
    const y = v => pad.top + plotH - ((v - min) / (max - min)) * plotH;

    const coords = points.map((p, i) => [x(i), y(p.value)]);
    const line = smoothPath(coords);
    const area = line + `L${coords[coords.length - 1][0].toFixed(1)},${(pad.top + plotH).toFixed(1)} L${coords[0][0].toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

    let grid = '', yLabels = '';
    for (let g = 0; g <= 3; g++) {
      const val = min + (max - min) * (g / 3);
      const gy = y(val);
      grid += `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${W - pad.right}" y2="${gy.toFixed(1)}" stroke="var(--chart-grid)" stroke-width="1"/>`;
      yLabels += `<text class="ov-chart__axis" x="${pad.left - 10}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end">${money(val, currency)}</text>`;
    }

    const step = Math.max(1, Math.ceil(points.length / 6));
    let xLabels = '';
    for (let i = 0; i < points.length; i += step) {
      // The SVG scales horizontally but the text does not, so the end labels
      // are anchored inward to keep them from clipping at the plot edges.
      const anchor = i === 0 ? 'start' : (i >= points.length - step ? 'end' : 'middle');
      xLabels += `<text class="ov-chart__axis" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${escapeHtml(points[i].label)}</text>`;
    }

    const last = coords[coords.length - 1];
    // stdDeviation is an SVG attribute, not a CSS property, so it can't take a
    // var() — read the token instead. Light mode uses a much softer halo.
    const glow = (getComputedStyle(document.body).getPropertyValue('--ov-chart-glow').trim() || '2.6');

    mount.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cash position trend">
        <defs>
          <linearGradient id="ovFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--ov-chart-fill-1)"/>
            <stop offset="60%" stop-color="var(--ov-chart-fill-2)"/>
            <stop offset="100%" stop-color="var(--ov-chart-fill-3)"/>
          </linearGradient>
          <filter id="ovGlow" x="-20%" y="-40%" width="140%" height="180%">
            <feGaussianBlur stdDeviation="${glow}" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#ovFill)"/>
        <path d="${line}" fill="none" stroke="var(--ov-chart-line)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#ovGlow)"/>
        <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="var(--ov-chart-line)" filter="url(#ovGlow)"/>
        <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="9" fill="none" stroke="var(--ov-chart-line)" stroke-opacity="0.3" stroke-width="1.5"/>
        ${yLabels}${xLabels}
      </svg>`;
  }

  /* ------------------------------------------------- hero cash position */

  /** Build the best *real* series available, in order of fidelity:
   *  1. Startup cash history from /startup/overview
   *  2. A running balance from real Hisaab transactions
   *  3. The stored trend array on the cash/savings metric  */
  function buildSeries(p, hisaab) {
    const su = (window.startupState || {}).overview;
    if (su && Array.isArray(su.history) && su.history.length >= 2 && su.history.some(h => h.cash != null)) {
      return {
        dated: true,
        caption: 'Cash balance by month',
        points: su.history.filter(h => h.cash != null).map(h => ({
          date: new Date(h.date), label: h.date.slice(5), value: h.cash
        }))
      };
    }

    const txns = (hisaab && hisaab.transactions) || [];
    if (txns.length >= 2) {
      const asc = [...txns].sort((a, b) => new Date(a.txn_date) - new Date(b.txn_date));
      let bal = 0;
      const byDay = new Map();
      asc.forEach(t => {
        bal += (t.type === 'in' ? t.amount : -t.amount);
        byDay.set(t.txn_date, bal);
      });
      const pts = [...byDay.entries()].map(([d, v]) => ({
        date: new Date(d),
        label: new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        value: v
      }));
      if (pts.length >= 2) return { dated: true, caption: 'Running balance from Hisaab', points: pts };
    }

    const cash = metric(p, ['m_savings', 'savings', 'cash', 'treasury']);
    if (cash && Array.isArray(cash.trend) && cash.trend.length >= 2) {
      return {
        dated: false,
        caption: cash.label + ' trend',
        points: cash.trend.map((v, i) => ({ date: null, label: 'T' + (i + 1), value: v }))
      };
    }
    return { dated: false, caption: '', points: [] };
  }

  function filterByRange(series, range) {
    if (!series.dated) return series.points;
    const now = new Date();
    let from;
    if (range === '1M') from = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    else if (range === '6M') from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    else if (range === '1Y') from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    else from = new Date(now.getFullYear(), 0, 1); // YTD
    const kept = series.points.filter(pt => pt.date >= from);
    // Never render an empty chart just because the window is narrow.
    return kept.length >= 2 ? kept : series.points.slice(-2);
  }

  function renderHero(p) {
    const currency = (p && p.currency) || '₹';
    const series = ovState.series || { points: [], dated: false, caption: '' };
    const points = filterByRange(series, ovState.range);

    const cash = metric(p, ['m_savings', 'savings', 'cash', 'treasury']);
    const su = (window.startupState || {}).overview;
    const suCash = su && su.metrics && su.metrics.cash_position;

    const valueEl = document.getElementById('ovHeroValue');
    if (valueEl) {
      if (suCash && suCash.display) valueEl.textContent = suCash.display;
      else if (cash) valueEl.textContent = money(cash.value, currency);
      else if (points.length) valueEl.textContent = money(points[points.length - 1].value, currency);
      else valueEl.textContent = 'N/A';
    }

    const labelEl = document.getElementById('ovHeroLabel');
    if (labelEl) labelEl.textContent = suCash ? 'Total Cash Position' : (cash ? cash.label : 'Total Cash Position');

    const deltaEl = document.getElementById('ovHeroDelta');
    if (deltaEl) {
      if (points.length >= 2) {
        const first = points[0].value, last = points[points.length - 1].value;
        const diff = last - first;
        const pct = first ? (diff / Math.abs(first)) * 100 : 0;
        const up = diff >= 0;
        deltaEl.className = 'ov-hero__delta ' + (up ? 'is-up' : 'is-down');
        deltaEl.textContent = `${up ? '↑' : '↓'} ${money(Math.abs(diff), currency)}${first ? ` (${Math.abs(pct).toFixed(1)}%)` : ''}`;
      } else {
        deltaEl.textContent = '';
      }
    }

    const capEl = document.getElementById('ovHeroCaption');
    if (capEl) capEl.textContent = series.caption || '';

    const rangeWrap = document.getElementById('ovRange');
    if (rangeWrap) rangeWrap.style.display = series.dated ? '' : 'none';

    renderChart(points, currency);
  }

  /* ------------------------------------------------------ insight cards */

  function ring(pct) {
    const size = 62, sw = 6, r = (size - sw) / 2, c = size / 2;
    const circ = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, pct || 0));
    const dash = circ * clamped / 100;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--ov-ring-track)" stroke-width="${sw}"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${sw}" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${c} ${c})"/>
      <text x="${c}" y="${c + 5}" text-anchor="middle" fill="var(--ink)" font-size="16" font-family="'Poppins',sans-serif">${Math.round(clamped)}</text>
    </svg>`;
  }

  /** "₹-1,600,000/mo" -> the figure plus a smaller unit. Set as one unbroken
   *  string at display size, the unit ran across the column divider; split, the
   *  unit is sized like the "months" beside the runway figure and can drop to
   *  its own line when the column is narrow. */
  function figureWithUnit(text) {
    const s = String(text == null ? '' : text);
    const m = s.match(/^(.*?)\s*(\/\s*mo)$/);
    return m
      ? `<span class="ov-pos__num">${escapeHtml(m[1])}</span><wbr><em>${escapeHtml(m[2].replace(/\s+/g, ''))}</em>`
      : `<span class="ov-pos__num">${escapeHtml(s)}</span>`;
  }

  function renderInsights(p) {
    const el = document.getElementById('ovInsights');
    if (!el || !p) return;
    // The Daily Home's Financial Snapshot now leads the page with the same
    // three figures for Individuals, so this block would be a duplicate. It
    // still renders for Startup, whose Overview has no Daily Home.
    if (p.key !== 'startup') { el.innerHTML = ''; el.style.display = 'none'; return; }
    const currency = p.currency || '₹';
    const su = (window.startupState || {}).overview;
    const suM = (su && su.metrics) || {};
    const items = [];

    // --- Lead figure: cash flow (income − expenses), or net burn for startups ---
    const income = metric(p, ['m_income', 'income', 'revenue']);
    const expenses = metric(p, ['m_expenses', 'expenses', 'burn']);
    if (suM.net_burn) {
      const burn = suM.net_burn.value;
      items.push({
        lead: true,
        value: figureWithUnit(suM.net_burn.display || money(burn, currency)),
        label: 'Net burn',
        sub: burn > 0 ? 'Burning cash monthly' : 'Cash-flow positive',
        subClass: burn > 0 ? 'is-bad' : 'is-good'
      });
    } else if (income && expenses) {
      const flow = income.value - expenses.value;
      items.push({
        lead: true,
        value: money(flow, currency),
        label: 'Monthly cash flow',
        sub: `${flow >= 0 ? 'Surplus' : 'Deficit'} vs ${money(income.value, currency)} in`,
        subClass: flow >= 0 ? 'is-good' : 'is-bad'
      });
    }

    // --- Financial health (startup score) or goal progress, with a thin bar ---
    let healthPct = null, healthLabel = 'Financial health', healthSub = '';
    if (suM.financial_health && suM.financial_health.value != null) {
      healthPct = suM.financial_health.value;
      healthSub = 'Composite score / 100';
    } else if (p.goal && typeof p.goal.progress === 'number') {
      healthPct = p.goal.progress;
      healthLabel = 'Goal progress';
      healthSub = p.goal.title || '';
    }
    if (healthPct !== null) {
      items.push({
        value: Math.round(healthPct) + '%',
        bar: Math.max(0, Math.min(100, healthPct)),
        label: healthLabel,
        sub: healthSub
      });
    }

    // --- Runway: explicit metric, else savings / monthly expenses ---
    let runway = null;
    if (suM.runway && suM.runway.value != null) runway = suM.runway.value;
    else {
      const savings = metric(p, ['m_savings', 'savings', 'cash']);
      if (savings && expenses && expenses.value > 0) runway = savings.value / expenses.value;
    }
    if (runway !== null) {
      items.push({
        value: `<span class="ov-pos__num">${runway.toFixed(1)}</span> <em>months</em>`,
        label: 'Runway',
        sub: runway >= 6 ? 'Healthy buffer' : 'Below the 6-month target',
        subClass: runway >= 6 ? 'is-good' : 'is-bad'
      });
    }

    if (!items.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = `
      <p class="ov-sec__label">Monthly position</p>
      <div class="ov-pos">
        ${items.map(it => `
          <div class="ov-pos__item${it.lead ? ' ov-pos__item--lead' : ''}">
            <div class="ov-pos__value">${it.value}</div>
            ${it.bar != null ? `<div class="ov-pos__bar"><i style="width:${it.bar}%"></i></div>` : ''}
            <div class="ov-pos__label">${escapeHtml(it.label)}</div>
            ${it.sub ? `<div class="ov-pos__sub${it.subClass ? ' ' + it.subClass : ''}">${escapeHtml(it.sub)}</div>` : ''}
          </div>`).join('')}
      </div>`;
  }


  /* ------------------------------------------------------------ risk DNA */

  /* Three separate things, deliberately not collapsed into one number:
       capacity  — what the figures say this person can absorb
       tolerance — what they have actually said, usually nothing yet
       unknowns  — what is missing, named rather than quietly assumed
     A single "risk score" that blends a measured reserve with an unstated
     preference is the kind of fake precision this panel exists to avoid. */

  const RISK_BAND_CLASS = {
    strong: 'is-good', high: 'is-good', stable: 'is-good', none: 'is-good',
    moderate: 'is-warn', adequate: 'is-warn', thin: 'is-warn', variable: 'is-warn',
    low: 'is-bad', heavy: 'is-bad', weak: 'is-bad', unstable: 'is-bad',
    unknown: 'is-muted'
  };

  function riskBandClass(band) {
    return RISK_BAND_CLASS[String(band || 'unknown').toLowerCase()] || 'is-muted';
  }

  function riskRow(label, value, band, note) {
    return `
      <div class="ov-risk__row">
        <span class="ov-risk__k">${escapeHtml(label)}</span>
        <span class="ov-risk__v">${escapeHtml(value)}</span>
        ${band ? `<span class="ov-risk__band ${riskBandClass(band)}">${escapeHtml(band)}</span>` : ''}
        ${note ? `<span class="ov-risk__note">${escapeHtml(note)}</span>` : ''}
      </div>`;
  }

  async function loadRiskProfile(p) {
    const card = document.getElementById('ovRisk');
    const body = document.getElementById('ovRiskBody');
    if (!card || !body) return;

    /* The startup twin models risk with its own engine and its own language
       (runway, burn, funding dependency), so this personal-finance read would
       be the wrong frame there. */
    if (p && p.key === 'startup') { card.hidden = true; return; }

    let r;
    try {
      r = await window.api.fetchRiskProfile();
    } catch (e) {
      card.hidden = true;
      return;
    }
    if (!r || !r.capacity) { card.hidden = true; return; }

    const cap = r.capacity || {};
    const score = Number(cap.score || 0);

    const rows = [];
    if (r.reserve && r.reserve.months != null) {
      rows.push(riskRow('Emergency reserve', r.reserve.months.toFixed(1) + ' months', r.reserve.band));
    }
    if (r.debt && r.debt.pct_of_annual_income != null) {
      rows.push(riskRow('Debt load', r.debt.pct_of_annual_income.toFixed(0) + '% of annual income', r.debt.band));
    }
    if (r.protection && r.protection.cover_years_of_income != null) {
      rows.push(riskRow('Life cover', r.protection.cover_years_of_income.toFixed(1) + '× annual income', r.protection.band));
    }
    if (r.income && r.income.savings_rate_pct != null) {
      rows.push(riskRow('Savings rate', r.income.savings_rate_pct.toFixed(0) + '% of income', r.income.stability));
    }

    const priorities = (r.blocking_priorities || []).slice(0, 3);
    const drivers = (cap.drivers || []).slice(0, 4);
    const stated = (r.tolerance || {}).stated;

    body.innerHTML = `
      <div class="ov-risk__score">
        <div class="ov-risk__num">${score}<small>/100</small></div>
        <div class="ov-risk__meta">
          <span class="ov-risk__band ${riskBandClass(cap.band)}">${escapeHtml(cap.band || 'unknown')} capacity</span>
          <p class="ov-risk__cap">What your figures say you can absorb — not how much risk you want.</p>
        </div>
      </div>

      <div class="ov-risk__meter" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, score))}%"></i></div>

      <div class="ov-risk__rows">${rows.join('')}</div>

      ${priorities.length ? `
        <p class="ov-risk__label">Before taking more risk</p>
        <ul class="ov-risk__list">
          ${priorities.map(pr => `<li><b>${escapeHtml(pr.label || '')}</b> ${escapeHtml(pr.reason || '')}</li>`).join('')}
        </ul>` : ''}

      <div class="ov-risk__tol">
        <span class="ov-risk__k">Your stated tolerance</span>
        ${stated
          ? `<span class="ov-risk__v">${escapeHtml(stated)}</span>`
          : `<span class="ov-risk__v ov-risk__v--unknown">Not stated yet</span>
             <p class="ov-risk__cap">How much risk you are willing to take cannot be read off a balance
             sheet, so we do not guess it. Tell Tathya and it will be used from then on.</p>`}
      </div>

      <div class="ov-risk__how" id="ovRiskHow" hidden>
        <p class="ov-risk__label">How this is measured</p>
        <p class="ov-risk__cap">${escapeHtml((r.calculation || {}).method || '')}</p>
        <p class="ov-risk__cap">Source: ${escapeHtml((r.calculation || {}).data_source || '')}
          Nothing here is written by a language model.</p>
        ${drivers.length ? `<ul class="ov-risk__list">${drivers.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}
        ${(r.unknowns || []).length ? `
          <p class="ov-risk__label">Not known yet</p>
          <ul class="ov-risk__list">${r.unknowns.slice(0, 4).map(u => `<li>${escapeHtml(String(u))}</li>`).join('')}</ul>` : ''}
      </div>`;

    card.hidden = false;

    const toggle = document.getElementById('ovRiskToggle');
    const how = document.getElementById('ovRiskHow');
    if (toggle && how && !toggle.dataset.bound) {
      toggle.dataset.bound = '1';
      toggle.addEventListener('click', () => {
        const open = how.hidden;
        how.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Hide the method ←' : 'How is this measured? →';
      });
    }
  }

  /* --------------------------------------------------------- accounts */

  /* Balances belong here; the per-month flow figures (income, expenses,
     revenue, burn) are already shown in the insight cards and metric grid, so
     listing them again would just duplicate the same numbers. */
  const FLOW_IDS = ['m_income', 'm_expenses', 'income', 'expenses', 'revenue', 'burn', 'cashflow'];

  function renderAccounts(p) {
    const el = document.getElementById('ovAccountsBody');
    if (!el || !p || !p.metrics) return;
    const currency = p.currency || '₹';

    // Not every metric is money — runway is months, headcount/dependents are
    // plain counts. Formatting those with a ₹ prefix ("₹9 mo") is just wrong.
    const NON_MONEY = ['runway', 'headcount', 'm_dependents', 'fxExposure'];
    const isMoney = m => !m.isPercent && !NON_MONEY.includes(m.id) && !/mo|%/.test(m.unit || '');

    const row = m => {
      const suffix = (m.unit && m.unit !== currency) ? m.unit : '';
      const val = isMoney(m)
        ? money(m.value, currency)
        : (Math.round(m.value * 10) / 10).toLocaleString('en-IN');
      return `<div class="ov-account">
          <span class="ov-account__name">${escapeHtml(m.label)}</span>
          <span class="ov-account__value">${val}${escapeHtml(suffix)}</span>
        </div>`;
    };

    let pool = p.metrics.filter(m => !m.isPercent && !FLOW_IDS.includes(m.id) && m.id !== 'm_dependents');
    if (pool.length < 2) pool = p.metrics.filter(m => !m.isPercent);

    // Lead with the startup engine's cash position when we have it.
    const su = (window.startupState || {}).overview;
    const suCash = su && su.metrics && su.metrics.cash_position;
    const lead = suCash
      ? `<div class="ov-account">
           <span class="ov-account__name">${escapeHtml(suCash.label)}</span>
           <span class="ov-account__value">${escapeHtml(suCash.display || money(suCash.value, currency))}</span>
         </div>`
      : '';

    const rows = lead + pool.map(row).join('');
    el.innerHTML = rows || '<p class="ovc__empty">No account data yet.</p>';
  }

  /* ------------------------------------------------------- hisaab data ----
     The Overview no longer previews Hisaab - it has its own page - but these
     transactions are still what the cash-position chart, the activity calendar
     and the briefing are built from, so the fetch stays and only the card that
     rendered them is gone. */

  async function loadHisaab() {
    try {
      return await window.api.fetchStartupHisaab();
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------- market pulse ----
     Reads /market-pulse, which ranks the existing news service against this
     user's profile. Fetched once per page load and never awaited by the rest
     of the Overview, so slow or failing news cannot hold up the dashboard. */

  let mpLoaded = false;

  function renderMarketPulse(data) {
    const body = document.getElementById('ovMpBody');
    const live = document.getElementById('ovMpLive');
    if (!body) return;

    const signals = (data && data.signals) || [];
    if (!signals.length) {
      if (live) live.style.display = 'none';
      body.innerHTML = `<p class="ov-mp__empty">${escapeHtml((data && data.message) || 'Market intelligence is temporarily unavailable.')}</p>`;
      return;
    }
    if (live) live.style.display = '';

    const arrow = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"></path></svg>';

    // The two most relevant stories only. /market-pulse returns them already
    // ranked against this profile, so the first two ARE the top two. The cap
    // is applied here rather than in the service because the mobile app reads
    // the same endpoint and shows the longer list.
    const MP_VISIBLE = 2;

    body.innerHTML = signals.slice(0, MP_VISIBLE).map(s => {
      // Only render a link when the news service actually returned one, and
      // show the source name rather than the raw URL.
      const link = s.url
        ? `<a class="ov-mp__more" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">Read more ${arrow}</a>`
        : '';
      return `
        <article class="ov-mp__item">
          <span class="ov-mp__cat">${escapeHtml(s.category || 'Markets')}</span>
          <h4 class="ov-mp__headline">${escapeHtml(s.headline || '')}</h4>
          ${s.summary ? `<p class="ov-mp__summary">${escapeHtml(s.summary)}</p>` : ''}
          ${s.why_it_matters ? `
            <div class="ov-mp__why">
              <span class="ov-mp__why-label">Why this matters to you</span>
              <p class="ov-mp__why-text">${escapeHtml(s.why_it_matters)}</p>
            </div>` : ''}
          ${(s.source || link) ? `
            <div class="ov-mp__foot">
              <span class="ov-mp__source">${escapeHtml(s.source || '')}</span>
              ${link}
            </div>` : ''}
        </article>`;
    }).join('');
  }

  async function loadMarketPulse() {
    if (mpLoaded) return;
    mpLoaded = true;
    try {
      renderMarketPulse(await window.api.fetchMarketPulse());
    } catch (e) {
      renderMarketPulse(null);
    }
  }

  /* ------------------------------------------- Hisaab activity calendar ----
     A compact month grid over the Hisaab transactions already fetched for the
     preview above — no extra request, no new endpoint. Clicking a day hands the
     date to the existing Hisaab view via setHisaabDateFilter(). */

  const ovCal = { year: null, month: null };   // month is 0-indexed

  /** Local YYYY-MM-DD. Deliberately not toISOString(), which converts to UTC
   *  and can land on the previous day for users east of Greenwich. */
  function ymd(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  /** date key -> { count, in, out } from the transactions we already hold. */
  function buildActivityIndex() {
    const index = new Map();
    const txns = (ovState.hisaab && ovState.hisaab.transactions) || [];
    txns.forEach(t => {
      if (!t.txn_date) return;
      const e = index.get(t.txn_date) || { count: 0, in: 0, out: 0 };
      e.count += 1;
      if (t.type === 'in') e.in += t.amount; else e.out += t.amount;
      index.set(t.txn_date, e);
    });
    return index;
  }

  function activityLevel(count) {
    if (!count) return 0;
    if (count === 1) return 1;
    if (count <= 3) return 2;
    return 3;
  }

  function renderCalendar() {
    const grid = document.getElementById('ovCalGrid');
    const label = document.getElementById('ovCalLabel');
    if (!grid || !label) return;

    const today = new Date();
    if (ovCal.year === null) { ovCal.year = today.getFullYear(); ovCal.month = today.getMonth(); }

    const { year, month } = ovCal;
    label.textContent = new Date(year, month, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // new Date(y, m+1, 0) gives the last day of month m — correct for 30/31-day
    // months and for February in leap years.
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstWeekday = new Date(year, month, 1).getDay();   // 0 = Sunday
    const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());
    const selected = (window.startupState && window.startupState.hisaabDateFilter) || null;
    const index = buildActivityIndex();
    const currency = (ovState.hisaab && ovState.hisaab.currency) || '₹';

    const cells = [];
    for (let i = 0; i < firstWeekday; i++) {
      cells.push('<span class="ov-cal__day is-blank" aria-hidden="true"></span>');
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const key = ymd(year, month, d);
      const act = index.get(key);
      const lvl = activityLevel(act ? act.count : 0);
      const classes = ['ov-cal__day', 'lvl-' + lvl];
      if (key === todayKey) classes.push('is-today');
      if (key === selected) classes.push('is-selected');
      if (!act) classes.push('is-empty');

      const title = act
        ? `${act.count} transaction${act.count === 1 ? '' : 's'} · in ${currency}${fmt(act.in)} · out ${currency}${fmt(act.out)}`
        : 'No transactions';
      cells.push(
        `<button type="button" class="${classes.join(' ')}" data-date="${key}" ` +
        `title="${escapeHtml(key + ': ' + title)}" aria-label="${escapeHtml(key + ', ' + title)}">${d}</button>`
      );
    }
    grid.innerHTML = cells.join('');

    grid.querySelectorAll('.ov-cal__day[data-date]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openHisaabForDate(btn.dataset.date);
      });
    });
  }

  /** Hand the date to the Hisaab view. setHisaabDateFilter (startup.js) owns
   *  the filter state, the ?date= query param and the re-render. */
  function openHisaabForDate(dateKey) {
    if (typeof window.setHisaabDateFilter === 'function') {
      window.setHisaabDateFilter(dateKey, { navigate: true });
    } else if (typeof switchView === 'function') {
      switchView('hisaab');
    }
  }

  function shiftMonth(delta) {
    const d = new Date(ovCal.year, ovCal.month + delta, 1);
    ovCal.year = d.getFullYear();
    ovCal.month = d.getMonth();
    renderCalendar();
  }

  const calPrev = document.getElementById('ovCalPrev');
  const calNext = document.getElementById('ovCalNext');
  if (calPrev) calPrev.addEventListener('click', e => { e.stopPropagation(); shiftMonth(-1); });
  if (calNext) calNext.addEventListener('click', e => { e.stopPropagation(); shiftMonth(1); });


  /* ------------------------------------------------------------ render */

  /** A preview may only advertise a feature the current persona can actually
   *  open. applyPersonaNav() hides the sidebar items that don't apply, so
   *  mirror that here rather than keeping a second persona list in sync.
   *  `data-nav-gate` gates a card on a view without making the whole card a
   *  navigation target (the calendar has its own per-day click targets). */
  function syncPreviewsToNav() {
    document.querySelectorAll(
      '#view-overview .ovc[data-goto], #view-overview .ovc[data-nav-gate], #view-overview .ov-gm[data-nav-gate]'
    ).forEach(card => {
      const view = card.dataset.goto || card.dataset.navGate;
      const nav = document.querySelector(`.navitem[data-view="${view}"]`);
      if (nav) card.style.display = (nav.style.display === 'none') ? 'none' : '';
    });
  }
  window.syncPreviewsToNav = syncPreviewsToNav;

  /** Support dashboard.html?date=YYYY-MM-DD as a deep link into a single day.
   *
   *  app.js's init calls switchView("overview") *after* loadProfileAndRender()
   *  resolves, so navigating during the first render would just be overridden.
   *  Instead the date is held pending and consumed the next time something
   *  lands on Overview — which is that init call — with a timer as a fallback
   *  in case a future code path skips it. */
  let pendingDeepLinkDate = null;
  try {
    const raw = new URLSearchParams(window.location.search).get('date');
    if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) pendingDeepLinkDate = raw;
  } catch (e) { /* no URL access */ }

  function consumeDeepLink() {
    if (!pendingDeepLinkDate || !ovState.loaded) return;
    const nav = document.querySelector('.navitem[data-view="hisaab"]');
    if (nav && nav.style.display === 'none') { pendingDeepLinkDate = null; return; }
    const dateKey = pendingDeepLinkDate;
    pendingDeepLinkDate = null;
    openHisaabForDate(dateKey);
  }

  async function renderAll() {
    const p = (typeof profile === 'function') ? profile() : null;
    if (!p) return;

    const dateEl = document.getElementById('ovDate');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });

    const name = displayName();
    const nameEl = document.getElementById('ovName');
    if (nameEl) nameEl.textContent = name;
    const greetEl = document.querySelector('.ov-top__greeting');
    if (greetEl) greetEl.innerHTML = `${greeting()}, <span id="ovName">${escapeHtml(name)}</span>`;
    const initial = name.charAt(0).toUpperCase();
    document.querySelectorAll('.ov-avatar').forEach(a => { a.textContent = initial; });

    /* Hand the profile to js/avatar.js, which repaints every .ov-avatar with
       the uploaded picture when there is one. It runs AFTER the line above on
       purpose: that line is the initials fallback, and this either keeps it or
       covers it. Guarded so the page still works if avatar.js failed to load. */
    if (window.mkAvatar) window.mkAvatar.hydrate(p);

    /* ---- Daily Home ----
       The Individual's day-to-day layer, drawn from GET /home. It is rendered
       before the rest of the page so the answer to "what's happening with my
       money today?" paints first; the command center below it stays the
       analytical layer. Startup profiles skip it entirely — their Overview is
       unchanged — and it re-reads the *real* name from the profile, which the
       username-derived displayName() above can only approximate.
       Deliberately not awaited: a slow /home must not hold up the rest. */
    const isIndividual = p.key !== 'startup';
    if (window.dailyHome) {
      window.dailyHome.setEnabled(isIndividual);
      if (isIndividual) window.dailyHome.render();
    }

    /* ---- live.life.fully ----
       The sidebar portal into the lifestyle experience. Gated the same way the
       Daily Home is: Individual profiles only, so a Startup founder's sidebar
       is unchanged. It loads nothing until the user actually opens it. */
    if (window.liveLife) window.liveLife.setEnabled(isIndividual);

    syncPreviewsToNav();
    // The snapshot label belongs to #statGrid, which app.js/startup.js fill —
    // hide the whole section when that renderer produced nothing.
    const snapshot = document.getElementById('ovSnapshot');
    const statGrid = document.getElementById('statGrid');
    if (snapshot && statGrid) snapshot.style.display = statGrid.children.length ? '' : 'none';
    renderInsights(p);
    renderAccounts(p);

    const hisaab = await loadHisaab();
    ovState.hisaab = hisaab;
    ovState.series = buildSeries(p, hisaab);
    renderHero(p);
    renderCalendar();
    loadMarketPulse();          // deliberately not awaited
    loadRiskProfile(p);         // same — the card reveals itself when it lands
    ovState.loaded = true;
    // Fallback: if nothing navigates to Overview after this, honour the link anyway.
    if (pendingDeepLinkDate) setTimeout(consumeDeepLink, 900);
  }
  window.renderOvCommandCenter = renderAll;

  /* ------------------------------------------------------------- wiring */

  function setActive(on) { document.body.classList.toggle('ov-active', on); }

  // Apply immediately so the dark canvas paints on first frame rather than
  // flashing the app's light theme while app.js finishes loading.
  const ovSection = document.getElementById('view-overview');
  if (ovSection) setActive(ovSection.classList.contains('is-active'));

  function hookSwitchView() {
    if (typeof switchView === 'function') {
      const _orig = switchView;
      window.switchView = function (name) {
        _orig(name);
        setActive(name === 'overview');
        if (name === 'overview' && ovState.loaded) {
          // Refresh the previews so returning from Hisaab/Simulate shows new data.
          renderAll();
          // A ?date= deep link is honoured here rather than during the first
          // render, because app.js's init navigates to Overview afterwards.
          consumeDeepLink();
        }
      };
      setActive(document.getElementById('view-overview').classList.contains('is-active'));
    } else {
      setTimeout(hookSwitchView, 80);
    }
  }
  hookSwitchView();

  // Any element carrying data-goto routes to that existing view.
  document.addEventListener('click', e => {
    const target = e.target.closest('[data-goto]');
    if (!target || !document.getElementById('view-overview').contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
    go(target.dataset.goto);
  });

  // Range switcher
  const rangeWrap = document.getElementById('ovRange');
  if (rangeWrap) {
    rangeWrap.addEventListener('click', e => {
      const btn = e.target.closest('button[data-range]');
      if (!btn) return;
      ovState.range = btn.dataset.range;
      rangeWrap.querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b === btn));
      renderHero(typeof profile === 'function' ? profile() : null);
    });
  }

  // Import Data → the existing Excel upload input
  const importBtn = document.getElementById('ovImportBtn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const f = document.getElementById('excelFileInput');
      if (f) f.click();
    });
  }

  // Accounts "Edit" → the existing Edit Profile modal
  const accountsLink = document.getElementById('ovAccountsLink');
  if (accountsLink) {
    accountsLink.addEventListener('click', () => {
      const b = document.getElementById('btnOpenEditProfile');
      if (b) b.click();
    });
  }

  /* ------------------------------------------------------- theme toggle ----
     Overview-only theme, persisted under its own key so switching here cannot
     restyle the other views. The initial value is applied by an inline script
     in dashboard.html's <head> to avoid a flash of the wrong palette. */
  const OV_THEME_KEY = 'moneykal_ov_theme';

  function currentOvTheme() {
    return document.documentElement.getAttribute('data-ov-theme') === 'light' ? 'light' : 'dark';
  }

  function applyOvTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-ov-theme', t);
    try { localStorage.setItem(OV_THEME_KEY, t); } catch (e) { /* private mode */ }
    const btn = document.getElementById('ovThemeBtn');
    if (btn) btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    // The chart and ring bake their colours into SVG attributes at build time,
    // so redraw them against the new tokens.
    if (ovState.loaded) {
      const p = (typeof profile === 'function') ? profile() : null;
      renderHero(p);
      renderInsights(p);
    }
  }

  const themeBtn = document.getElementById('ovThemeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      applyOvTheme(currentOvTheme() === 'dark' ? 'light' : 'dark');
    });
  }
  applyOvTheme(currentOvTheme());

  /* ---- Account ----
     The avatar used to open one of two different dropdowns depending on which
     view you were in. Both are gone: every avatar now carries
     data-account-open and opens the single account centre declared in
     dashboard.html, owned by js/account.js. Nothing is wired here any more.

     Note for anyone searching: `.ov-account` and `.ov-account__name` still
     exist and are still used — by the Accounts balances card rendered above
     in renderAccounts(). They are unrelated to the old menu. */


  /* ---- Notification inbox ----
     The bell in the Overview header. Reads the inbox that already existed
     (GET /notifications, POST /notifications/read); this adds no storage of
     its own and no second source of truth for read state.

     Daily AI Insights are deliberately absent. They render in this view's own
     Daily AI Insights section, and notification_service refuses to write an
     inbox row for an insight kind, so nothing has to be filtered out here —
     the guarantee is upstream, where it cannot be forgotten. */

  /** Icon per notification kind, grouped by what the row is about: money,
   *  a connected integration, or the account itself. An unmapped kind falls
   *  back to the bell, so a new backend producer renders correctly without a
   *  frontend change. */
  const NOTE_ICONS = {
    budget_threshold:       'money',
    payment_due:            'money',
    split_expense_added:    'money',
    split_expense_updated:  'money',
    split_expense_deleted:  'money',
    split_settlement_received: 'money',
    split_settlement_recorded: 'money',
    split_you_are_owed:     'money',
    split_you_owe:          'money',
    gmail_sync:             'plug',
    gmail_connection_error: 'plug',
    split_group_invite:     'people',
    split_group_member_added: 'people',
    split_friend_added:     'people',
    split_friend_request:   'people',
  };

  const NOTE_SVG = {
    money:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5z"></path><path d="M3 8h18"></path></svg>',
    plug:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6"></path><path d="M6 8h12v3a6 6 0 0 1-12 0z"></path><path d="M12 17v5"></path></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"></path><circle cx="9" cy="7" r="3.2"></circle><path d="M22 20v-1.5a4 4 0 0 0-3-3.87"></path></svg>',
    bell:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>',
  };

  /** Where a notification's link_type points inside the app. Only kinds whose
   *  destination actually exists as a view are listed; anything else simply
   *  marks read and closes, which is better than navigating somewhere wrong. */
  const NOTE_VIEWS = {
    budgets:       'overview',
    upcoming:      'overview',
    hisaab:        'hisaab',
    split_group:   'split',
    split_expense: 'split',
    split_friend:  'split',
    split_settlement: 'split',
  };

  function noteEsc(v) {
    return (typeof escapeHtml === 'function')
      ? escapeHtml(v)
      : String(v == null ? '' : v).replace(/[&<>"']/g, c => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
  }

  function noteTimeAgo(iso) {
    if (!iso) return '';
    // The API serializes naive UTC timestamps, so the trailing Z is added
    // before parsing — without it the browser reads them as local time and
    // everything looks hours old the moment it arrives.
    const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z');
    if (isNaN(t)) return '';
    const secs = Math.max(0, (Date.now() - t) / 1000);
    if (secs < 60) return 'Just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function wireNotifications() {
    const root   = document.getElementById('ovNotif');
    const btn    = document.getElementById('ovBellBtn');
    const panel  = document.getElementById('ovNotifPanel');
    const list   = document.getElementById('ovNotifList');
    const badge  = document.getElementById('ovBellBadge');
    const readAll = document.getElementById('ovNotifReadAll');
    if (!root || !btn || !panel || !list || !badge) return;

    const inbox = () => (window.api && window.api.notifications) || null;

    function setBadge(count) {
      const n = Number(count) || 0;
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = false;
        btn.setAttribute('aria-label', `Notifications, ${n} unread`);
      } else {
        badge.hidden = true;
        btn.setAttribute('aria-label', 'Notifications');
      }
      if (readAll) readAll.hidden = n === 0;
    }

    async function refreshBadge() {
      const api = inbox();
      if (!api) return;
      try {
        const r = await api.unreadCount();
        setBadge(r && r.unread_count);
      } catch (e) {
        // The bell is ambient. A failed poll — no session yet, backend down —
        // should leave the header alone rather than surface an error here.
      }
    }

    function render(data) {
      const notes = (data && data.notifications) || [];
      if (!notes.length) {
        list.innerHTML = `
          <div class="ov-notif__empty">
            <b>You're all caught up</b>
            Alerts about your money, your integrations and your account will
            appear here.
          </div>`;
        return;
      }
      list.innerHTML = notes.map(n => `
        <button type="button" class="ov-note ${n.is_read ? 'is-read' : 'is-unread'}"
                data-note-id="${noteEsc(n.id)}"
                data-note-link="${noteEsc(n.link_type || '')}"
                data-note-lid="${noteEsc(n.link_id || '')}">
          <span class="ov-note__dot" aria-hidden="true"></span>
          <span class="ov-note__icon" aria-hidden="true">${NOTE_SVG[NOTE_ICONS[n.kind]] || NOTE_SVG.bell}</span>
          <span class="ov-note__body">
            <span class="ov-note__title">${noteEsc(n.title)}</span>
            ${n.body ? `<span class="ov-note__text">${noteEsc(n.body)}</span>` : ''}
            <span class="ov-note__time">${noteEsc(noteTimeAgo(n.created_at))}</span>
          </span>
        </button>`).join('');
    }

    async function load() {
      const api = inbox();
      if (!api) return;
      list.innerHTML = '<div class="ov-notif__empty">Loading…</div>';
      try {
        const data = await api.list({ limit: 40 });
        render(data);
        setBadge(data && data.unread_count);
      } catch (e) {
        list.innerHTML = `
          <div class="ov-notif__empty">
            <b>Could not load notifications</b>
            Check your connection and try again.
          </div>`;
      }
    }

    function close() {
      panel.hidden = true;
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    }

    function open() {
      panel.hidden = false;
      btn.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      load();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.hidden) open(); else close();
    });

    if (readAll) {
      readAll.addEventListener('click', async (e) => {
        e.stopPropagation();
        const api = inbox();
        if (!api) return;
        try {
          await api.markRead(null);
          await load();
        } catch (err) { /* leave the panel as it is rather than emptying it */ }
      });
    }

    // Delegated so rows re-rendered by load() stay live.
    list.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-note-id]');
      if (!row) return;
      const api = inbox();
      const id = Number(row.dataset.noteId);

      row.classList.remove('is-unread');
      row.classList.add('is-read');
      if (api && id) {
        try { await api.markRead([id]); } catch (err) { /* navigate anyway */ }
      }
      await refreshBadge();
      close();

      const view = NOTE_VIEWS[row.dataset.noteLink];
      if (view && typeof window.switchView === 'function') window.switchView(view);
    });

    document.addEventListener('click', (e) => {
      if (!panel.hidden && !root.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { close(); btn.focus(); }
    });

    refreshBadge();
    // Polled rather than pushed, matching how the rest of this dashboard
    // stays current. Sixty seconds is frequent enough for an alert produced by
    // a background job and cheap enough that it is a COUNT against one index.
    setInterval(() => { if (!document.hidden) refreshBadge(); }, 60000);
    // A tab left open overnight should not need a reload to catch up.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshBadge();
    });
  }

  wireNotifications();

  /* ------------------------------------------------------ column balance ----
     The Overview is two columns: the cash chart and snapshot on the left, a
     rail of panels on the right (Market Pulse, Accounts, Risk DNA, alerts,
     activity). How tall the rail is depends entirely on data — news length,
     whether a risk profile exists, how many alerts there are — and it used to
     run far past the end of the left column, leaving the middle of the page
     blank for a screen or more.

     So on a wide screen the rail keeps its panels, in order, only while they
     fit beside the left column; the rest continue in a row underneath both
     columns (#ovBand), in the same order and at the same width. Nothing is
     hidden, nothing scrolls inside anything, and the two columns end
     together. Below 1241px the Overview is already one column, so every panel
     simply stays where the markup put it.

     Heights are identical in either place because the band's columns are set
     to the rail's exact width and its panels carry the same hairline and
     spacing, which is what makes the decision stable: re-running it on any
     resize reaches the same answer, and moves nothing when nothing changed. */
  function wireColumnBalance() {
    const grid = document.querySelector('#view-overview .ov-grid');
    const band = document.getElementById('ovBand');
    if (!grid || !band || typeof ResizeObserver === 'undefined') return;
    const main = grid.querySelector(':scope > .ov-col:not(.ov-side)');
    const side = grid.querySelector(':scope > .ov-side');
    if (!main || !side) return;

    const panels = Array.from(side.children);              // authored order, kept wherever they sit
    const wide = window.matchMedia('(min-width: 1241px)'); // overview.css goes single-column at 1240
    let queued = false;

    const isShown = (el) => !el.hidden && getComputedStyle(el).display !== 'none';

    function place(cut, railWidth, gap) {
      const moved = panels.some((p, i) => p.parentNode !== (i < cut ? side : band));
      if (moved) panels.forEach((p, i) => (i < cut ? side : band).appendChild(p));
      const below = panels.slice(cut).filter(isShown).length;
      band.hidden = !below;
      if (!below || !railWidth) {
        band.style.columnCount = '';
        band.style.width = '';
        return;
      }
      // As many rail-width columns as fit across both columns, but never more
      // than there are panels to put in them.
      const colGap = 44;
      const fit = Math.max(1, Math.floor((grid.clientWidth + colGap) / (railWidth + colGap)));
      const count = Math.min(fit, below);
      band.style.columnCount = String(count);
      band.style.width = (count * railWidth + (count - 1) * colGap) + 'px';
    }

    function balance() {
      queued = false;
      if (!wide.matches) { place(panels.length); return; }
      // Overview not on screen (another view is open): nothing to measure.
      if (!main.offsetParent) return;
      const mainH = main.getBoundingClientRect().height;
      if (!mainH) return;

      const cs = getComputedStyle(side);
      const railWidth = Math.round(side.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      const gap = parseFloat(cs.rowGap) || 30;

      let used = 0, kept = 0, cut = panels.length;
      for (let i = 0; i < panels.length; i++) {
        const p = panels[i];
        if (!isShown(p)) continue;
        const next = used + (kept ? gap : 0) + p.getBoundingClientRect().height;
        // Keep a panel in the rail only if that brings the rail's end closer to
        // the left column's end than leaving it out would — so a short rail is
        // allowed to overshoot a little rather than stop far short, and a long
        // one stops before running away. The first panel always stays: an
        // empty rail beside the chart would be its own kind of blank.
        if (kept && Math.abs(next - mainH) >= Math.abs(used - mainH)) { cut = i; break; }
        used = next;
        kept++;
      }
      place(cut, railWidth, gap);
    }

    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(balance);
    }

    // Panels resize as their data arrives (Market Pulse lands seconds after
    // the rest); the left column resizes with the chart range and insights.
    const observer = new ResizeObserver(schedule);
    observer.observe(main);
    panels.forEach((p) => observer.observe(p));
    if (wide.addEventListener) wide.addEventListener('change', schedule);
    else if (wide.addListener) wide.addListener(schedule);
    schedule();
  }

  wireColumnBalance();

})();
