/* ==========================================================================
   TWIN — application logic
   Everything here runs client-side against the API.
   ========================================================================== */

const state = {
  /* Past simulation runs, loaded from GET /twin/simulations. This used to be an
     in-memory list that a reload cleared; runs are now stored server-side
     against the profile, so the Simulate tab opens with what this account has
     already explored — including runs made on the phone. */
  simHistory: [],
  simHistoryLoaded: false,
  openSimRunId: null,       // which stored run is currently rendered
  chatSeeded: false
};

let currentProfile = null;
let pendingScenarioPrefill = null;
/* The chat -> Simulation hand-off. Set when Ask Twin's contextual CTA is
   clicked, carrying everything the conversation established (amount, purpose,
   horizon, stated risk constraints, the computed risk position). Consumed by
   switchView('simulate') alongside pendingScenarioPrefill, and cleared the
   moment the user types a different scenario or picks a suggestion — a stale
   context silently attached to an unrelated question would be worse than none. */
let pendingDecisionContext = null;
let pendingCtaLabel = null;
/* The exact sentence that arrived with the context, so an edit can be told
   apart from a re-run of the same thing. */
let pendingHandoffScenario = null;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function profile() { return currentProfile; }
function fmt(n) { return Math.round(n).toLocaleString('en-IN'); }
function metricByIdVal(id) {
  if (!profile()) return 0;
  const m = profile().metrics.find(m => m.id === id);
  return m ? m.value : 0;
}

/* ============ Routing ============ */
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.navitem');
/* Every view that can be reached from the sidebar needs an entry. Where one was
   missing the topbar silently kept the PREVIOUS view's heading, so a user who
   clicked Alerts could be reading "Weekly Spend Report" above it. The four
   startup-only views are listed here as well as in STARTUP_TITLES so the
   fallback is never the stale-heading path. */
const titles = {
  overview: ['Overview', 'Live snapshot of the digital twin'],
  hisaab: ['Hisaab', 'Money in, money out, and net — categorized'],
  simulate: ['Simulate a decision', 'Run scenarios on the twin before anything is recommended'],
  ask: ['Tathya', 'Grounded answers from your financial data'],
  reports: ['Weekly Spend Report', 'Automated financial brief and suggestions'],
  tax: ['Tax Calculator', 'Collect every head of income, then compare regimes'],
  split: ['Money Splits', 'Shared expenses, live balances and settling up'],
  alerts: ['Risk alerts', 'Runway, burn, revenue, hiring and goal alerts'],
  fundraise: ['Fundraise readiness', 'Your metrics against stage benchmarks'],
  gst: ['GST calculator', 'Add or remove GST, split CGST/SGST/IGST, and net off input credit'],
  compliance: ['Compliance center', 'Statutory deadlines, estimated liabilities and penalty exposure'],
  billing: ['Plans & Billing', 'Your plan, usage, Kal Coins and payments']
};

navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    // Some sidebar entries are actions rather than destinations (Varta places
    // a call and stays put). They carry no data-view, and switchView would
    // throw on getElementById('view-undefined'), taking the whole handler
    // down with it.
    if (!btn.dataset.view) return;
    switchView(btn.dataset.view);
  });
});

function isStartup() {
  return !!(profile() && profile().key === 'startup');
}

function switchView(name) {
  // A view whose sidebar item applyPersonaNav() has hidden for this persona
  // cannot be reached by any other route either — the notification bell, an
  // invitation deep link or ?view= would otherwise open it regardless.
  const gatedNav = document.querySelector(`.navitem[data-view="${name}"][data-persona]`);
  if (gatedNav && gatedNav.style.display === 'none') name = 'overview';
  /* A nav button whose view container is missing used to throw here, AFTER the
     loop below had already stripped is-active from every view — blanking the
     whole content area, skipping the rest of this function and leaving a stale
     topbar with no active nav item, with no way back except clicking something
     else. Resolve the target first and bail before touching anything if it is
     not there, so a markup/nav mismatch degrades to "nothing happened". */
  const target = document.getElementById('view-' + name);
  if (!target) {
    console.warn('switchView: no container for view "' + name + '" — ignoring.');
    return;
  }
  views.forEach(v => v.classList.remove('is-active'));
  target.classList.add('is-active');
  navItems.forEach(b => b.classList.toggle('is-active', b.dataset.view === name));
  /* On a phone the sidebar is a horizontal strip. Without this, switching view
     from anywhere other than the strip itself leaves the newly-active item off
     screen, so the user cannot see which section they are in. */
  const activeNav = document.querySelector('.navitem.is-active');
  if (activeNav && typeof activeNav.scrollIntoView === 'function') {
    activeNav.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
  // Money Splits opens with its own hero, which already names the feature, so
  // the shared topbar heading would print "Money Splits" twice on one screen.
  // css/split.css hides the heading and collapses the bar under this class;
  // every other view keeps its heading exactly as it was.
  document.body.classList.toggle('is-money-splits', name === 'split');
  const titleSet = (isStartup() && typeof STARTUP_TITLES !== 'undefined' && STARTUP_TITLES[name]) ? STARTUP_TITLES[name] : titles[name];
  // The "about this feature" i follows the view: close any open panel and
  // show the i only where this persona has a description for the view.
  if (window.featureInfo) {
    window.featureInfo.close();
    window.featureInfo.sync();
  }
  if (titleSet) {
    document.getElementById('topbarTitle').textContent = titleSet[0];
    document.getElementById('topbarSub').textContent = titleSet[1];
  }
  if (name === 'ask') {
      resetChat();
      loadChatSessions();
  }
  if (name === 'simulate') {
      /* Refreshed on every visit rather than only once, so the list is right
         after a run started from Ask Twin's hand-off or made on the phone. */
      loadSimHistory();
  }
  if (name === 'simulate' && pendingScenarioPrefill) {
      scenarioInput.value = pendingScenarioPrefill;
      pendingScenarioPrefill = null;
      renderHandoffNotice();
      scenarioInput.focus();
  }
  if (name === 'overview' && isStartup()) {
      loadStartupOverviewAndRender();
  }
  if (name === 'hisaab') {
      loadHisaabAndRender();
      if (typeof loadGmailStatusAndRender === 'function') loadGmailStatusAndRender();
  }
  if (name === 'alerts' && isStartup()) {
      renderAlertsView();
  }
  if (name === 'reports') {
      renderReportsView();
  }
  if (name === 'split' && window.splitApp) {
      // Rendered on every entry rather than once: balances change whenever
      // anyone else in a shared group adds an expense, so a cached screen
      // would show a stale figure with no way for the user to tell.
      window.splitApp.open();
  }
  if (name === 'fundraise' && window.fundraiseView) {
      window.fundraiseView.render();
  }
  if (name === 'compliance' && window.complianceView) {
      window.complianceView.render();
  }
  if (name === 'gst' && window.gstView) {
      window.gstView.render();
  }
  if (name === 'billing' && window.billingView) {
      // Reloaded on every entry: a purchase, or a question asked elsewhere,
      // changes the plan and usage figures this page shows.
      window.billingView.open();
  }
}

// split.js deep-links into a group from a notification, and the invitation
// landing page hands off here after sign-in; both need to switch view from
// outside this module.
window.switchView = switchView;

// Profile switching logic removed, account type is strictly enforced by the backend

async function loadProfileAndRender() {
    try {
        currentProfile = await window.api.fetchProfile();
        if (currentProfile) {
            // /profile/me resolves the real profile.key for the logged-in user
            // (e.g. "custom_<username>" or "startup") — always trust it over
            // whatever state.profileKey happened to default to, so a page
            // refresh/relogin doesn't leave chat/simulate calls sending a
            // stale "individual" key that matches no row in the DB.
            state.profileKey = currentProfile.key;
            applyPersonaNav(currentProfile.key === 'startup' ? 'startup' : 'individual');
            // The Tax Calculator gates on the exact key, not the nav persona:
            // applyPersonaNav() folds Enterprise/CFO into "individual", which
            // would otherwise reveal it there too.
            if (window.taxCalculator) {
                window.taxCalculator.initForProfile(currentProfile.key);
            }
            if (currentProfile.key === 'startup') {
                await loadStartupOverviewAndRender();
            } else {
                renderOverview();
            }
            renderSimulateForm();
            resetSimResults();
            renderSimHistory();
            resetChat();
            // Overview command center. Guarded on purpose: a failure to draw a
            // preview must never fall through to the catch below, which treats
            // errors here as "not logged in" and clears the session.
            if (typeof window.renderOvCommandCenter === 'function') {
                try { await window.renderOvCommandCenter(); } catch (err) { console.error('Overview render failed', err); }
            }
        }
    } catch(e) {
        // Not logged in or no profile. Log first: this catch ends the session,
        // so swallowing the reason makes a genuine bug look like a logout.
        console.error('loadProfileAndRender failed, signing out:', e);
        localStorage.removeItem('twin_session');

        /* On a remembered device the PIN can mint a new access token without a
           password, so an expired session belongs on the lock screen, not at
           the password form. If the three days have also run out, unlock.html
           forwards to login.html itself — that decision is made in one place
           rather than duplicated here. */
        var remembered = false;
        try { remembered = !!localStorage.getItem('moneykal_device'); } catch (err) { /* no-op */ }
        window.location.href = remembered ? 'unlock.html' : 'login.html?expired=true';
    }
}

/* ============ Sparkline (inline SVG, no chart library) ============ */
function sparkline(data, w = 220, h = 48, color = '#0E5C4A') {
  if (!data || data.length === 0) return '';
  const min = Math.min(...data), max = Math.max(...data);
  const range = (max - min) || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * (h - 8) - 4).toFixed(1)}`).join(' ');
  const lastX = ((data.length - 1) * step).toFixed(1);
  const lastY = (h - ((data[data.length - 1] - min) / range) * (h - 8) - 4).toFixed(1);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastX}" cy="${lastY}" r="2.6" fill="${color}"/>
  </svg>`;
}

/* ============ Overview ============ */
function renderOverview() {
  const p = profile();
  if (!p) return;
  document.getElementById('personaLabel').textContent = p.persona;
  document.getElementById('goalStrip').textContent = `${p.goal.title} — ${p.goal.progress}% there`;

  const currency = p.currency || '₹';
  const grid = document.getElementById('statGrid');
  grid.innerHTML = p.metrics.map(m => {
    const trendUp = m.trend && m.trend.length > 0 ? m.trend[m.trend.length - 1] >= m.trend[0] : true;
    // Some onboarding-created metrics store the currency symbol itself as the
    // unit, which would render as "₹50,000₹" — drop the suffix in that case.
    const unit = (m.unit && m.unit !== currency) ? m.unit : '';
    const displayVal = m.isPercent ? `${m.value}%` : `${currency}${fmt(m.value)}${unit}`;
    return `
      <div class="stat-card">
        <span class="stat-card__value">${displayVal}</span>
        <span class="stat-card__label">${m.label}</span>
        <div class="stat-card__chart">${sparkline(m.trend, 220, 42, trendUp ? 'var(--ov-spark-up, #00E5FF)' : 'var(--ov-spark-down, #6E767C)')}</div>
      </div>`;
  }).join('');

  document.getElementById('historyList').innerHTML = p.history.map(h => `
    <li>
      <div>
        <p class="decision-list__title">${h.title}</p>
        <p class="decision-list__date">${h.date || h.date_str}</p>
      </div>
      <span class="tag tag--${h.tag}">${h.outcome}</span>
    </li>`).join('');

  document.getElementById('alertList').innerHTML = p.alerts.map(a => `
    <li class="alert alert--${a.level}">
      <span class="alert__dot"></span>
      <p>${a.text}</p>
    </li>`).join('');
}

/* ============ Simulate ============ */
const scenarioInput = document.getElementById('scenarioInput');
const simSuggestionsEl = document.getElementById('simSuggestions');

const SCENARIO_SUGGESTIONS = [
  'What happens if I invest ₹20,000 every month for 3 years?',
  'Can I afford a ₹50,000 EMI?',
  'What if I increase my monthly savings by ₹10,000?',
  'How quickly can I reach my savings goal?',
  'What happens if I have no income for 6 months?'
];

const STAGE_ID_MAP = { Understand: 'understand', Watch: 'watch', Simulate: 'simulate', Recommend: 'recommend', Teach: 'teach', Check: 'check' };

const IMPACT_LABELS = {
  monthly_surplus_before: 'Monthly surplus — before',
  monthly_surplus_after: 'Monthly surplus — after',
  savings_impact: 'Savings impact',
  emergency_buffer_before_months: 'Emergency buffer — before',
  emergency_buffer_after_months: 'Emergency buffer — after',
  goal_progress_before_pct: 'Goal progress — before',
  goal_progress_after_pct: 'Goal progress — after',
  investment_contribution: 'Monthly investment contribution',
  foir_pct: 'Fixed-obligation ratio (FOIR)',
  affordability_verdict: 'Affordability verdict',
  goal_months_remaining_before: 'Months to goal — before',
  goal_months_remaining_after: 'Months to goal — after',
  coverage_months: 'Emergency coverage',
  requested_months: 'Months without income',
  goal_title: 'Goal',
  goal_target: 'Goal target',
  monthly_contribution_rate: 'Monthly contribution rate',
  months_to_goal: 'Months to reach goal',
  projected_savings: 'Projected savings',
  projected_value: 'Projected value',
  invested_total: 'Total invested',
  estimated_gain: 'Estimated gain',
  savings_before: 'Savings — no change',
  savings_after: 'Savings — with change',
  extra_saved: 'Extra saved',
  remaining_savings: 'Remaining savings',
  shortfall: 'Shortfall',
  amount_saved: 'Amount saved',
  emergency_buffer_months: 'Emergency buffer',
  goal_progress_pct: 'Goal progress',
  lumpsum_invested: 'Lump sum invested',
  liquid_savings_before: 'Liquid savings — before',
  liquid_savings_after: 'Liquid savings — after',
  projected_value_at_horizon: 'Projected value at horizon',
  estimated_gain_at_horizon: 'Estimated gain at horizon',
  assumed_annual_return_pct: 'Assumed annual return',
  note: 'Note'
};

function humanizeKey(k) {
  return IMPACT_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatImpactValue(k, v, currency) {
  if (typeof v === 'string') return v;
  if (typeof v !== 'number') return String(v);
  if (k.includes('pct') || k === 'foir_pct') return `${v}%`;
  if (k.includes('months') || k.startsWith('runway')) return `${v} mo`;
  if (k.startsWith('financial_health')) return `${v}/100`;
  if (k === 'headcount_added' || k === 'headcount') return `${v}`;
  return `${currency}${fmt(v)}`;
}

function renderSimulateForm() {
  const suggestions = (isStartup() && typeof STARTUP_SCENARIO_SUGGESTIONS !== 'undefined') ? STARTUP_SCENARIO_SUGGESTIONS : SCENARIO_SUGGESTIONS;
  simSuggestionsEl.innerHTML = suggestions.map(s => `<button type="button" class="chip">${s}</button>`).join('');
  simSuggestionsEl.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      scenarioInput.value = chip.textContent;
      // A suggestion is a different decision entirely, so the conversation's
      // context no longer applies to it.
      clearHandoff();
      scenarioInput.focus();
    });
  });
}

function resetSimResults() {
  document.getElementById('simResults').innerHTML = `
    <div class="empty-state">
      <p>Describe a scenario in plain language and run the simulation to see a grounded, personalized breakdown here.</p>
    </div>`;
  document.getElementById('pipeline').innerHTML = '';
}

function timelineDetail(entry, currency) {
  return Object.entries(entry)
    .filter(([k]) => k !== 'label' && k !== 'months')
    .map(([k, v]) => `<div class="timeline-step__row"><span>${humanizeKey(k)}:</span><b>${formatImpactValue(k, v, currency)}</b></div>`)
    .join('');
}

/* Simulation's job is to show what could happen, not to ratify what the chatbot
   suggested — so where risk posture is the axis that matters, the backend
   returns three genuinely different approaches modelled on the same amount and
   horizon. `is_aligned` marks the one matching what the user said they wanted;
   it is not a recommendation, and all three are shown at equal weight.
   Every figure here is computed in financial_simulator.build_alternative_paths. */
function altPathsHtml(res, currency) {
  const paths = res.alternative_paths;
  if (!paths || !paths.length) return '';

  const cards = paths.map(p => {
    const caveats = (p.caveats || [])
      .map(c => `<p class="alt-path__caveat">${escapeHtml(c)}</p>`).join('');
    return `
      <div class="alt-path${p.is_aligned ? ' alt-path--aligned' : ''}">
        <div class="alt-path__head">
          <span class="alt-path__label">${escapeHtml(p.label)}</span>
          ${p.is_aligned ? '<span class="alt-path__badge">Matches what you said</span>' : ''}
        </div>
        <p class="alt-path__desc">${escapeHtml(p.description)}</p>
        <div class="alt-path__figures">
          <div class="alt-path__fig"><span>Projected</span><b>${currency}${fmt(p.projected_value)}</b></div>
          <div class="alt-path__fig"><span>In a bad stretch</span><b>${currency}${fmt(p.plausible_trough_value)}</b></div>
          <div class="alt-path__fig"><span>Assumed return</span><b>${p.assumed_annual_return_pct}%</b></div>
        </div>
        ${caveats}
      </div>`;
  }).join('');

  return `
    <div class="sim-section">
      <h4 class="sim-section__title">Approaches to compare</h4>
      <p class="alt-path__footnote">Same amount, same horizon, three different risk postures.
        None of these is chosen for you.</p>
      ${cards}
      <p class="alt-path__footnote">The downside figure is a plausible trough, not a floor or a
        worst case.</p>
    </div>`;
}

function renderSimulationResult(res) {
  const p = profile();
  const currency = (p && p.currency) || '₹';
  const impact = res.financial_impact || {};
  const isInformational = res.mode === 'informational';

  const impactRows = Object.entries(impact)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `<div class="impact-tile"><span class="impact-tile__label">${humanizeKey(k)}</span><span class="impact-tile__value">${formatImpactValue(k, v, currency)}</span></div>`)
    .join('');

  const traceHtml = (res.stages || []).map(s => `<li><b>${escapeHtml(s.agent)}:</b> ${escapeHtml(s.summary)}</li>`).join('');

  const sections = [];

  sections.push(`
    <div class="panel__head"><h3>Scenario</h3></div>
    <p class="sim-scenario-text">“${escapeHtml(res.scenario)}”</p>`);

  sections.push(`
    <div class="sim-section">
      <h4 class="sim-section__title">${isInformational ? 'Your current snapshot' : 'Financial impact'}</h4>
      <div class="impact-grid">${impactRows || '<p class="sim-empty">No quantitative impact could be computed from this scenario.</p>'}</div>
    </div>`);

  if (!isInformational && impact.goal_impact && impact.goal_impact.length) {
    const goalRows = impact.goal_impact.map(g => {
      const before = (g.progress_before_pct !== null && g.progress_before_pct !== undefined) ? `${g.progress_before_pct.toFixed(0)}%` : '—';
      const after = (g.progress_after_pct !== null && g.progress_after_pct !== undefined) ? `${g.progress_after_pct.toFixed(0)}%` : '—';
      return `<div class="impact-tile"><span class="impact-tile__label">${escapeHtml(g.label)}</span><span class="impact-tile__value">${before} → ${after}</span></div>`;
    }).join('');
    sections.push(`
      <div class="sim-section">
        <h4 class="sim-section__title">Goal impact</h4>
        <div class="impact-grid">${goalRows}</div>
      </div>`);
  }

  if (!isInformational) {
    const timelineHtml = (res.timeline || []).map(t => `
      <div class="timeline-step">
        <div class="timeline-step__dot"></div>
        <div class="timeline-step__label">${escapeHtml(t.label)}</div>
        <div class="timeline-step__body">${timelineDetail(t, currency)}</div>
      </div>`).join('');

    sections.push(`
      <div class="sim-section">
        <h4 class="sim-section__title">Timeline</h4>
        <div class="sim-timeline">${timelineHtml || '<p class="sim-empty">No timeline applies to this scenario.</p>'}</div>
      </div>`);
  }

  if (isInformational) {
    // Reuses Ask Twin's own markdown-formatted, grounded answer verbatim.
    const answerHtml = (typeof marked !== 'undefined') ? marked.parse(res.recommendation || '') : `<p>${escapeHtml(res.recommendation)}</p>`;
    sections.push(`
      <div class="explanation">
        <span class="explanation__label">Twin's answer</span>
        ${answerHtml}
      </div>`);
  } else {
    const alts = altPathsHtml(res, currency);
    if (alts) sections.push(alts);

    sections.push(`
      <div class="explanation">
        <span class="explanation__label">Recommend agent</span>
        <p><b>${escapeHtml(res.recommendation)}</b></p>
        <p>${escapeHtml(res.why)}</p>
      </div>`);

    if (res.risks && res.risks.length) {
      const risksHtml = res.risks.map(r => `
        <li class="alert alert--warn"><span class="alert__dot"></span><p>${escapeHtml(r)}</p></li>`).join('');
      sections.push(`
        <div class="sim-section">
          <h4 class="sim-section__title">Risks / what to watch</h4>
          <ul class="alert-list">${risksHtml}</ul>
        </div>`);
    }

    if (res.assumptions && res.assumptions.length) {
      const assumptionsHtml = res.assumptions.map(a => `
        <li class="alert alert--info"><span class="alert__dot"></span><p>${escapeHtml(a)}</p></li>`).join('');
      sections.push(`
        <div class="sim-section">
          <h4 class="sim-section__title">Assumptions</h4>
          <ul class="alert-list">${assumptionsHtml}</ul>
        </div>`);
    }

    if (res.teaching) {
      sections.push(`
        <div class="explanation">
          <span class="explanation__label">Teach agent explains</span>
          <p>${escapeHtml(res.teaching)}</p>
        </div>`);
    }
  }

  sections.push(`
    <details class="sim-trace">
      <summary>How this was computed</summary>
      <ul>${traceHtml}</ul>
    </details>
    <p class="chat-note" style="padding:0; margin-top:14px;">${escapeHtml(res.disclaimer)}</p>`);

  document.getElementById('simResults').innerHTML = sections.join('');
}

async function runSimulation() {
  const p = profile();
  if (!p) return;
  const scenario = scenarioInput.value.trim();
  if (!scenario) { scenarioInput.focus(); return; }

  const pipelineEl = document.getElementById('pipeline');
  pipelineEl.innerHTML = AGENTS.map(a => `
    <div class="pipe-step" data-agent="${a.id}">
      <span class="pipe-step__dot"></span>
      <span class="pipe-step__name">${a.name}</span>
      <span class="pipe-step__state">Queued</span>
    </div>`).join('');

  document.getElementById('runSimBtn').disabled = true;
  document.getElementById('simResults').innerHTML = '';
  // This is a fresh run, so nothing from history is on screen any more — drop
  // the highlight now rather than leaving a stale row marked open for the
  // several seconds the pipeline takes.
  if (state.openSimRunId) {
    state.openSimRunId = null;
    renderSimHistory();
  }

  // API call — Understand/Watch/Simulate/Recommend/Teach/Check all run
  // server-side, grounded in the same financial context Ask Twin uses.
  let res;
  try {
    res = await window.api.simulateScenario(scenario, pendingDecisionContext);
  } catch (e) {
    // Checked before logging: running out of free simulations is an expected
    // answer, not an error.
    if (e.status === 402 && window.billingView && window.billingView.prompt(e.detail)) {
      pipelineEl.innerHTML = '';
      document.getElementById('simResults').innerHTML = `
        <div class="empty-state"><p>You've used this month's free simulations. Your past simulations are still in the list.</p></div>`;
      document.getElementById('runSimBtn').disabled = false;
      return;
    }
    console.error(e);
    document.getElementById('simResults').innerHTML = `
      <div class="empty-state"><p>Couldn't run that simulation — ${escapeHtml(e.message || 'please try again.')}</p></div>`;
    document.getElementById('runSimBtn').disabled = false;
    return;
  }

  // Reveal the real backend stage trace one at a time so the pipeline
  // reflects what actually ran, not a fake spinner.
  for (const stage of (res.stages || [])) {
    const id = STAGE_ID_MAP[stage.agent];
    const row = id && pipelineEl.querySelector(`[data-agent="${id}"]`);
    if (row) {
      row.classList.add('is-running');
      row.querySelector('.pipe-step__state').textContent = 'Running…';
    }
    await new Promise(r => setTimeout(r, 220 + Math.random() * 140));
    if (row) {
      row.classList.remove('is-running');
      row.classList.add('is-done');
      row.querySelector('.pipe-step__state').textContent = 'Done';
      row.title = stage.summary;
    }
  }

  // Informational answers only run a subset of stages (no hypothetical to
  // calculate) — mark the rest "Skipped" rather than leaving them stuck on
  // "Queued", which would read as broken.
  pipelineEl.querySelectorAll('.pipe-step:not(.is-done)').forEach(row => {
    row.querySelector('.pipe-step__state').textContent = 'Skipped';
  });

  if (isStartup() && typeof renderStartupSimulationResult === 'function') {
    renderStartupSimulationResult(res);
  } else {
    renderSimulationResult(res);
  }

  /* The backend stored the run and sent its id back, so the row goes in from
     what we already have rather than costing a second round trip. An empty id
     means the write failed: the result is still valid and still on screen, it
     just is not in the list, and the next refresh will agree with that. */
  if (res.run_id) {
    state.openSimRunId = res.run_id;
    state.simHistory = [normalizeSimRun({
      id: res.run_id,
      scenario,
      scenario_type: res.scenario_type,
      mode: res.mode,
      headline: (res.recommendation || '').split(/\s+/).join(' ').slice(0, 160),
      created_at: new Date().toISOString()
    })].concat(state.simHistory.filter(s => s.id !== res.run_id));
    state.simHistoryLoaded = true;
  } else {
    state.openSimRunId = null;
  }
  renderSimHistory();

  document.getElementById('runSimBtn').disabled = false;
}

document.getElementById('runSimBtn').addEventListener('click', runSimulation);

/* Editing the sentence away from what the conversation handed over means the
   user is describing something else, and the discovered context no longer
   applies to it. Re-running the handed-over scenario unchanged keeps it. */
scenarioInput.addEventListener('input', () => {
  if (pendingCtaLabel && scenarioInput.value.trim() !== (pendingHandoffScenario || '').trim()) {
    clearHandoff();
  }
});

/* ============ Simulation history ============
   Runs are stored server-side against the profile (backend: simulation_runs),
   so this list survives a reload, a different browser and a move to the phone.
   Clicking a row reopens that run in full — the response as it was computed,
   not a re-simulation, because the numbers a decision was made on should not
   move when it is looked at again. */

/* When a run happened, in the reader's own timezone. The server sends UTC with
   a trailing Z, so this converts rather than guesses. Today's runs get a time,
   older ones a date — what someone scanning the list wants at each distance. */
function formatRunTime(iso) {
  const then = new Date(iso);
  if (isNaN(then.getTime())) return '';
  const now = new Date();
  const hhmm = { hour: '2-digit', minute: '2-digit' };

  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString('en-IN', hhmm);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) {
    return 'Yesterday, ' + then.toLocaleTimeString('en-IN', hhmm);
  }
  return then.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  });
}

/* The server's row, in the shape the rest of this file — and overview.js's
   "Recent runs" panel, which reads `.scenario` and `.time` — already expects. */
function normalizeSimRun(row) {
  return {
    id: row.id,
    scenario: row.scenario || '',
    scenarioType: row.scenario_type || 'general',
    mode: row.mode || 'scenario',
    headline: row.headline || '',
    createdAt: row.created_at,
    time: formatRunTime(row.created_at)
  };
}

async function loadSimHistory() {
  const el = document.getElementById('simHistory');
  if (!el) return;
  if (!state.simHistoryLoaded) {
    el.innerHTML = '<li class="empty-row">Loading your past simulations…</li>';
  }
  try {
    const rows = await window.api.getSimulations();
    state.simHistory = (rows || []).map(normalizeSimRun);
    state.simHistoryLoaded = true;
    renderSimHistory();
    /* The Overview card lists the two most recent runs off this same array. */
    if (typeof window.renderOvCommandCenter === 'function') window.renderOvCommandCenter();
  } catch (e) {
    console.error(e);
    /* A history that won't load must not look like a history that is empty —
       the difference matters when the user is hunting for a past decision. */
    el.innerHTML = '<li class="empty-row">Couldn\'t load your past simulations. ' +
      '<button type="button" class="sim-history__retry" id="simHistoryRetry">Retry</button></li>';
    const retry = document.getElementById('simHistoryRetry');
    if (retry) retry.addEventListener('click', loadSimHistory);
  }
}

function renderSimHistory() {
  const el = document.getElementById('simHistory');
  if (!el) return;
  if (!state.simHistory.length) {
    el.innerHTML = '<li class="empty-row">No simulations yet. Runs are saved to your ' +
      'account, so you can come back and open them any time.</li>';
    return;
  }
  el.innerHTML = state.simHistory.map(s => `
    <li class="sim-history__row${s.id === state.openSimRunId ? ' is-open' : ''}">
      <button type="button" class="sim-history__open" data-run="${escapeHtml(s.id)}">
        <p class="decision-list__title">${escapeHtml(s.scenario)}</p>
        ${s.headline ? `<p class="sim-history__outcome">${escapeHtml(s.headline)}</p>` : ''}
        <p class="decision-list__date">${escapeHtml(s.time)}</p>
      </button>
      <span class="tag ${s.mode === 'informational' ? 'tag--neutral' : 'tag--good'}">${escapeHtml(s.mode === 'informational' ? 'answer' : s.scenarioType.replace(/_/g, ' '))}</span>
      <button type="button" class="sim-history__delete" data-delete="${escapeHtml(s.id)}"
        title="Delete this simulation" aria-label="Delete simulation">&times;</button>
    </li>`).join('');

  el.querySelectorAll('.sim-history__open').forEach(btn => {
    btn.addEventListener('click', () => openStoredSimulation(btn.dataset.run));
  });
  el.querySelectorAll('.sim-history__delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteStoredSimulation(btn.dataset.delete);
    });
  });
}

/* Paints the pipeline from a stored stage trace, all at once.
   runSimulation() reveals stages one by one because they are being read back as
   a run completes; a stored run finished long ago, so animating it would be
   theatre rather than a trace. */
function renderPipelineTrace(stages) {
  const pipelineEl = document.getElementById('pipeline');
  if (!pipelineEl) return;
  const ran = new Set((stages || []).map(s => STAGE_ID_MAP[s.agent]).filter(Boolean));
  const summaries = {};
  for (const s of (stages || [])) summaries[STAGE_ID_MAP[s.agent]] = s.summary;

  pipelineEl.innerHTML = AGENTS.map(a => `
    <div class="pipe-step ${ran.has(a.id) ? 'is-done' : ''}" data-agent="${a.id}"
      ${summaries[a.id] ? `title="${escapeHtml(summaries[a.id])}"` : ''}>
      <span class="pipe-step__dot"></span>
      <span class="pipe-step__name">${a.name}</span>
      <span class="pipe-step__state">${ran.has(a.id) ? 'Done' : 'Skipped'}</span>
    </div>`).join('');
}

async function openStoredSimulation(runId) {
  if (!runId) return;
  const resultsEl = document.getElementById('simResults');
  resultsEl.innerHTML = '<div class="empty-state"><p>Opening…</p></div>';

  let detail;
  try {
    detail = await window.api.getSimulation(runId);
  } catch (e) {
    console.error(e);
    resultsEl.innerHTML = '<div class="empty-state"><p>' +
      escapeHtml(e.message || "Couldn't open that simulation.") + '</p></div>';
    return;
  }

  state.openSimRunId = detail.id;
  renderSimHistory();

  /* Refilling the box makes "open it, change a number, run it again" the
     natural next step. The chat hand-off is dropped: a stored run is its own
     thing, and a stale context silently attached to it would be worse than
     none. */
  scenarioInput.value = detail.scenario || '';
  if (typeof clearHandoff === 'function') clearHandoff();

  renderPipelineTrace(detail.result && detail.result.stages);

  if (isStartup() && typeof renderStartupSimulationResult === 'function') {
    renderStartupSimulationResult(detail.result);
  } else {
    renderSimulationResult(detail.result);
  }

  /* Says plainly that this is a record, not a fresh projection. */
  const banner = document.createElement('div');
  banner.className = 'sim-saved-notice';
  banner.textContent = 'Saved simulation — run ' + formatRunTime(detail.created_at) +
    ', shown as it was calculated then.';
  resultsEl.prepend(banner);
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteStoredSimulation(runId) {
  const entry = state.simHistory.find(s => s.id === runId);
  if (!entry) return;
  if (!window.confirm(window.t('Delete this simulation?') + '\n\n"' + entry.scenario + '"\n\n' + window.t('This cannot be undone.'))) return;

  /* Optimistic, with the row put back if the server refuses — a failed delete
     must never silently lose someone's record. */
  const snapshot = state.simHistory;
  state.simHistory = state.simHistory.filter(s => s.id !== runId);
  if (state.openSimRunId === runId) {
    state.openSimRunId = null;
    document.getElementById('simResults').innerHTML =
      '<div class="empty-state"><p>Describe a scenario in plain language and run the ' +
      'simulation to see a grounded, personalized breakdown here.</p></div>';
  }
  renderSimHistory();

  try {
    await window.api.deleteSimulation(runId);
  } catch (e) {
    console.error(e);
    state.simHistory = snapshot;
    renderSimHistory();
  }
}

/* ============ Ask Twin (chat) ============ */
const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatSuggestions = document.getElementById('chatSuggestions');
const chatSessionList = document.getElementById('chatSessionList');
const btnNewChat = document.getElementById('btnNewChat');

let currentSessionId = null;

const SUGGESTIONS = [
  'What\u2019s my emergency buffer?', 
  'How are my savings trending?', 
  'Am I on track for my goal?'
];

async function loadChatSessions() {
  if (!profile()) return;
  try {
    const sessions = await window.api.getChatSessions(state.profileKey);
    if(chatSessionList) {
        chatSessionList.innerHTML = sessions.map(s => `
          <li style="padding: 8px; border-radius: 4px; cursor: pointer; background: ${s.id === currentSessionId ? 'var(--bg-subtle)' : 'transparent'}; position: relative;"
              onclick="switchSession('${s.id}')">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 4px;">
              <div style="font-weight: 500; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
              <button onclick="event.stopPropagation(); toggleChatMenu('${s.id}', this)"
                style="background:none; border:none; cursor:pointer; font-size:16px; color:var(--ink-faint); padding:0 4px; line-height:1; flex-shrink:0;">⋮</button>
            </div>
            <div style="font-size: 11px; color: var(--ink-faint); margin-top: 2px;">${new Date(s.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          </li>
        `).join('');
    }
  } catch(e) {
    console.error(e);
  }
}

// Single shared dropdown appended to body so it's never clipped by sidebar overflow
let _chatMenuEl = null;
let _chatMenuSessionId = null;

function ensureChatMenuEl() {
    if (!_chatMenuEl) {
        _chatMenuEl = document.createElement('div');
        _chatMenuEl.id = 'globalChatMenu';
        _chatMenuEl.style.cssText = 'position:fixed; background:var(--surface); border:1px solid var(--line); border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,0.12); z-index:9999; min-width:120px; overflow:hidden; display:none;';
        _chatMenuEl.innerHTML = `
          <button id="chatMenuRename" style="display:block; width:100%; text-align:left; padding:9px 14px; background:none; border:none; border-bottom:1px solid var(--line); font-size:13px; cursor:pointer; color:var(--ink);">✏ Rename</button>
          <button id="chatMenuDelete" style="display:block; width:100%; text-align:left; padding:9px 14px; background:none; border:none; font-size:13px; cursor:pointer; color:var(--warn);">🗑 Delete</button>
        `;
        document.body.appendChild(_chatMenuEl);

        _chatMenuEl.querySelector('#chatMenuRename').addEventListener('click', (e) => {
            e.stopPropagation();
            _chatMenuEl.style.display = 'none';
            if (_chatMenuSessionId) window.renameSession(_chatMenuSessionId, _chatMenuEl._currentTitle || '');
        });
        _chatMenuEl.querySelector('#chatMenuDelete').addEventListener('click', (e) => {
            e.stopPropagation();
            _chatMenuEl.style.display = 'none';
            if (_chatMenuSessionId) window.deleteSession(_chatMenuSessionId);
        });

        document.addEventListener('click', (e) => {
            if (!_chatMenuEl.contains(e.target)) _chatMenuEl.style.display = 'none';
        });
    }
    return _chatMenuEl;
}

window.toggleChatMenu = function(id, btn) {
    event.stopPropagation();
    const menu = ensureChatMenuEl();

    if (_chatMenuSessionId === id && menu.style.display === 'block') {
        menu.style.display = 'none';
        _chatMenuSessionId = null;
        return;
    }

    // Find matching session title for the rename prompt
    const titleEl = btn.closest('li').querySelector('div[title]');
    menu._currentTitle = titleEl ? titleEl.getAttribute('title') : '';
    _chatMenuSessionId = id;

    // Position below the ⋮ button using fixed coords (escapes any overflow container)
    const rect = btn.getBoundingClientRect();
    menu.style.display = 'block';
    const menuW = menu.offsetWidth || 120;
    let left = rect.right - menuW;
    let top = rect.bottom + 4;
    if (left < 4) left = 4;
    if (top + 80 > window.innerHeight) top = rect.top - 80;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
};

window.renameSession = async function(id, currentTitle) {
  const newTitle = prompt(window.t("Enter new title for the chat:"), currentTitle);
  if (newTitle && newTitle.trim() !== "" && newTitle !== currentTitle) {
    try {
      await window.api.renameChatSession(id, newTitle.trim(), state.profileKey);
      loadChatSessions();
      if (currentSessionId === id) {
          // If needed, update current session's UI beyond the sidebar list
      }
    } catch(e) {
      alert(window.t("Failed to rename chat session."));
    }
  }
};

window.deleteSession = async function(id) {
  if (confirm(window.t("Are you sure you want to delete this chat session?"))) {
    try {
      await window.api.deleteChatSession(id, state.profileKey);
      if (currentSessionId === id) {
        currentSessionId = null;
        resetChat();
      }
      loadChatSessions();
    } catch(e) {
      alert(window.t("Failed to delete chat session."));
    }
  }
};

window.switchSession = async function(id) {
  currentSessionId = id;
  chatLog.innerHTML = '';
  chatSuggestions.innerHTML = '';
  loadChatSessions(); 
  
  try {
    const session = await window.api.getChatSession(id, state.profileKey);
    session.messages.forEach(m => {
      const who = m.role === 'assistant' || m.role === 'twin' ? 'twin' : 'user';
      addBubble(who, m.content);
    });
  } catch(e) {
    addBubble('twin', 'Failed to load chat history.');
  }
};

if(btnNewChat) {
    btnNewChat.addEventListener('click', () => {
      currentSessionId = null;
      resetChat();
      loadChatSessions();
    });
}

function seedChat() {
  if (!profile()) return;
  if (state.chatSeeded || currentSessionId) return;
  state.chatSeeded = true;
  
  const greetings = [
    "Ready to explore some scenarios?",
    "What financial future shall we map out today?",
    "How can I help optimize your strategy?",
    "Let's simulate your next big decision.",
    "Ask me anything about your numbers.",
    "Ready to run some financial simulations?"
  ];
  const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
  
  const greetingEl = document.querySelector('.chat-greeting h2');
  if (greetingEl) {
    greetingEl.textContent = randomGreeting;
  }
  
  const chatGreeting = document.getElementById('chatGreeting');
  if (chatGreeting) chatGreeting.classList.remove('hidden');
  
  renderSuggestions();
}

function resetChat() {
  chatLog.innerHTML = '';
  state.chatSeeded = false;
  currentSessionId = null;
  if (document.getElementById('view-ask').classList.contains('is-active')) {
      seedChat();
  }
  renderSuggestions();
}

function renderSuggestions() {
  if(currentSessionId) return; // Don't show suggestions in an active session
  const suggestions = (isStartup() && typeof STARTUP_CHAT_SUGGESTIONS !== 'undefined') ? STARTUP_CHAT_SUGGESTIONS : SUGGESTIONS;
  chatSuggestions.innerHTML = suggestions.map(s => `<button type="button" class="chip">${s}</button>`).join('');
  chatSuggestions.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => { chatInput.value = chip.textContent; chatForm.requestSubmit(); });
  });
}

/* The Financial Discovery layer decides what a turn is — an answer, one
   follow-up question, or respectful push-back — and whether the conversation
   has reached a decision worth simulating. This function renders that decision.
   It does not make one: in particular there is no client-side rule that adds a
   Simulation CTA, so `res.simulation_cta` being absent is the instruction not
   to show one. See backend/agents/discovery.py. */
function addBubble(who, text, meta = null) {
  const chatGreeting = document.getElementById('chatGreeting');
  if (chatGreeting) chatGreeting.classList.add('hidden');

  const div = document.createElement('div');
  div.className = 'bubble bubble--' + who;

  if (who === 'twin' && typeof marked !== 'undefined') {
    div.innerHTML = marked.parse(text);
  } else {
    div.textContent = text;
  }

  chatLog.appendChild(div);

  /* The old build put "Simulate this \u2192" under every question the user typed.
     That fired before the twin knew what the decision was, so it usually handed
     Simulation a vague sentence and no context. It is replaced by the two
     backend-driven affordances below, which appear only when they apply. */
  if (who === 'twin' && meta) {
    // Tappable answers to a follow-up. Shortcuts only — the composer stays
    // live, so the user can always say something else or push back.
    const suggestions = (meta.follow_up && meta.follow_up.suggestions) || [];
    if (meta.mode === 'ask' && suggestions.length) {
      const row = document.createElement('div');
      row.className = 'sim-chip-row chat-followup-row';
      row.innerHTML = suggestions
        .map(sg => `<button type="button" class="chip">${escapeHtml(sg)}</button>`)
        .join('');
      row.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
          chatInput.value = chip.textContent;
          chatForm.requestSubmit();
        });
      });
      chatLog.appendChild(row);
    }

    // The Simulation hand-off. Present only when the backend attached a CTA —
    // never during a follow-up, and never on a question about the user's
    // current position. The copy is the backend's, so it names the actual
    // decision rather than saying "simulate".
    if (meta.simulation_cta) {
      const cta = meta.simulation_cta;
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'bubble-action bubble-action--cta';
      box.innerHTML =
        `<b>${escapeHtml(cta.label)} \u2192</b>` +
        (cta.sublabel ? `<span>${escapeHtml(cta.sublabel)}</span>` : '') +
        `<span class="bubble-action__note">Optional \u2014 you can keep talking here instead</span>`;
      box.addEventListener('click', () => {
        // Everything discovered travels with it, so Simulation starts from the
        // decision rather than from a sentence.
        pendingScenarioPrefill = cta.scenario;
        pendingHandoffScenario = cta.scenario;
        pendingDecisionContext = cta.decision_context;
        pendingCtaLabel = cta.label;
        switchView('simulate');
      });
      chatLog.appendChild(box);
    }
  }

  chatLog.scrollTop = chatLog.scrollHeight;
}

/* Says out loud what came across from the conversation, and offers a way out of
   it. A hand-off the user can neither see nor undo would make Simulation feel
   like it was deciding things on their behalf. */
function renderHandoffNotice() {
  const el = document.getElementById('simHandoffNotice');
  if (!el) return;
  if (!pendingCtaLabel) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="handoff-notice">
      <b>${escapeHtml(pendingCtaLabel)}</b>
      <p>Carried over from your conversation with the Twin \u2014 the amount, purpose, horizon and
         risk preferences you already gave are included, so you don't have to repeat them.</p>
      <button type="button" class="linklike" id="clearHandoffBtn">Start fresh instead</button>
    </div>`;

  const btn = document.getElementById('clearHandoffBtn');
  if (btn) btn.addEventListener('click', clearHandoff);
}

/* Drop the conversation's context and treat this as a plain typed scenario.
   The user is never locked into what the chatbot concluded. */
function clearHandoff() {
  pendingDecisionContext = null;
  pendingCtaLabel = null;
  pendingHandoffScenario = null;
  renderHandoffNotice();
}

chatForm.addEventListener('submit', async e => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  
  addBubble('user', text);
  chatInput.value = '';
  chatSuggestions.innerHTML = ''; // Hide suggestions once chatting
  
  const thinking = document.createElement('div');
  thinking.className = 'bubble bubble--twin bubble--thinking';
  thinking.textContent = 'Thinking…';
  chatLog.appendChild(thinking);
  chatLog.scrollTop = chatLog.scrollHeight;
  
  try {
      const res = await window.api.askTwin(text, currentSessionId, state.profileKey);
      currentSessionId = res.session_id;
      thinking.remove();
      // "Show the financial insight visually first, then let Tathya explain it" —
      // a numeric/trend question gets a chart (built entirely from the Financial
      // Twin's own metrics) ahead of the text answer; simple questions get none.
      if (res.visualization && typeof suChatVizHtml === 'function') {
        const vizHtml = suChatVizHtml(res.visualization);
        if (vizHtml) {
          const vizDiv = document.createElement('div');
          vizDiv.innerHTML = vizHtml;
          chatLog.appendChild(vizDiv.firstElementChild);
        }
      }
      addBubble('twin', res.answer, res);
      loadChatSessions();
  } catch(e) {
      thinking.remove();
      // Out of free questions: say so in the conversation and offer ACT,
      // rather than reporting a connection error that did not happen.
      if (e.status === 402 && window.billingView && window.billingView.prompt(e.detail)) {
          addBubble('twin', "You've used this month's free questions. Upgrade to ACT for unlimited questions.");
          return;
      }
      addBubble('twin', "I encountered an error connecting to the backend.");
  }
});

/* ============ Edit Profile Modal Logic ============ */
async function authFetch(endpoint, data = null, method = 'POST') {
  const session = JSON.parse(localStorage.getItem('twin_session') || '{}');
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) {
    headers['Authorization'] = `Bearer ${session.token}`;
  }

  const opts = { method, headers };
  if (data) opts.body = JSON.stringify(data);

  const res = await fetch(`${window.API_BASE}${endpoint}`, opts);
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || 'Request failed');
  }
  return await res.json();
}

function setupEditProfileModal() {
  const btnOpen = document.getElementById('btnOpenEditProfile');
  const modal = document.getElementById('editProfileModal');
  const btnClose = document.getElementById('btnCloseEditProfileModal');
  const btnCancel = document.getElementById('btnCancelEditProfile');
  const form = document.getElementById('editProfileForm');
  const container = document.getElementById('editProfileFieldsContainer');
  const errDiv = document.getElementById('editProfileModalError');
  const titleEl = document.getElementById('editProfileModalTitle');

  if (!btnOpen || !modal) return;

  function closeModal() {
    modal.classList.remove('is-open');
    if (errDiv) errDiv.style.display = 'none';
  }

  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  btnOpen.addEventListener('click', async () => {
    container.innerHTML = '<p style="color:var(--ink-muted); font-size:13px;">Loading profile details...</p>';
    if (errDiv) errDiv.style.display = 'none';
    modal.classList.add('is-open');

    try {
      const res = await authFetch('/profile/me', null, 'GET');
      const personaKey = res.key || state.profileKey || 'individual';
      const details = res.details || res.raw_inputs || {};
      titleEl.textContent = `Edit Profile (${res.label || personaKey.toUpperCase()})`;

      if (personaKey === 'individual') {
        container.innerHTML = `
          <div class="field-row">
            <label class="hdfc-field"><span>Full Name</span><input type="text" id="editIndName" class="ob-input" value="${details.full_name || ''}"></label>
            <label class="hdfc-field"><span>Email</span><input type="email" id="editIndEmail" class="ob-input" value="${details.email || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Mobile Number</span><input type="text" id="editIndMobile" class="ob-input" value="${details.mobile || ''}"></label>
            <label class="hdfc-field"><span>Occupation / Role</span><input type="text" id="editIndOccupation" class="ob-input" value="${details.occupation || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Monthly Salary/Income (₹)</span><input type="number" id="editIndIncome" class="ob-input" value="${details.monthly_income || 0}"></label>
            <label class="hdfc-field"><span>Total Savings (₹)</span><input type="number" id="editIndSavings" class="ob-input" value="${details.total_savings || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Monthly Fixed Expenses (₹)</span><input type="number" id="editIndExpenses" class="ob-input" value="${details.monthly_expenses || 0}"></label>
            <label class="hdfc-field"><span>Outstanding Loans (₹)</span><input type="number" id="editIndLoans" class="ob-input" value="${details.outstanding_loans || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Existing Investments (₹)</span><input type="number" id="editIndInvestments" class="ob-input" value="${details.existing_investments || 0}"></label>
            <label class="hdfc-field"><span>Insurance Coverage (₹)</span><input type="number" id="editIndInsurance" class="ob-input" value="${details.insurance_coverage || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Dependents</span><input type="number" id="editIndDependents" class="ob-input" value="${details.dependents || 0}"></label>
            <label class="hdfc-field"><span>Goal Title</span><input type="text" id="editIndGoalTitle" class="ob-input" value="${details.goal_title || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Goal Target Amount (₹)</span><input type="number" id="editIndGoalTarget" class="ob-input" value="${details.goal_target_amount || 0}"></label>
            <label class="hdfc-field"><span>Goal Target Date</span><input type="date" id="editIndGoalDate" class="ob-input" value="${details.goal_target_date || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>AI Insights Schedule</span>
              <select id="editIndSchedule" class="ob-input">
                <option value="hourly" ${res.insights_schedule === 'hourly' ? 'selected' : ''}>Hourly</option>
                <option value="daily" ${(!res.insights_schedule || res.insights_schedule === 'daily') ? 'selected' : ''}>Daily</option>
                <option value="weekly" ${res.insights_schedule === 'weekly' ? 'selected' : ''}>Weekly</option>
              </select>
            </label>
            <label class="hdfc-field"><span>📱 WhatsApp Number</span><input type="text" id="editIndWhatsapp" class="ob-input" placeholder="91XXXXXXXXXX (country code + number)" value="${res.whatsapp_phone || ''}"></label>
          </div>
        `;
      } else if (personaKey === 'enterprise') {
        container.innerHTML = `
          <div class="field-row">
            <label class="hdfc-field"><span>CFO / Executive Name</span><input type="text" id="editEntCfoName" class="ob-input" value="${details.cfo_name || ''}"></label>
            <label class="hdfc-field"><span>Corporate Mobile</span><input type="text" id="editEntCorporateMobile" class="ob-input" value="${details.corporate_mobile || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Organization Name</span><input type="text" id="editEntOrgName" class="ob-input" value="${details.org_name || ''}"></label>
            <label class="hdfc-field"><span>Industry</span><input type="text" id="editEntIndustry" class="ob-input" value="${details.industry || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>GST Number (GSTIN)<span class="req">*</span></span><input type="text" id="editEntGstNumber" class="ob-input" required value="${details.gst_number || ''}"></label>
            <label class="hdfc-field"><span>Headcount</span><input type="number" id="editEntHeadcount" class="ob-input" value="${details.headcount || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Treasury Balance (₹ Cr)</span><input type="number" id="editEntTreasury" class="ob-input" step="0.01" value="${details.treasury_balance || 0}"></label>
            <label class="hdfc-field"><span>Annual Turnover (₹ Cr)</span><input type="number" id="editEntTurnover" class="ob-input" step="0.01" value="${details.annual_turnover || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Qtr Cash Flow (₹ Cr)</span><input type="number" id="editEntCashFlow" class="ob-input" step="0.01" value="${details.quarterly_cash_flow || 0}"></label>
            <label class="hdfc-field"><span>Operating Expenses (₹ Cr)</span><input type="number" id="editEntOperatingExpenses" class="ob-input" step="0.01" value="${details.operating_expenses || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>FX Exposure (%)</span><input type="number" id="editEntFx" class="ob-input" step="0.1" value="${details.fx_exposure_pct || 0}"></label>
            <label class="hdfc-field"><span>Debt Amount (₹ Cr)</span><input type="number" id="editEntDebt" class="ob-input" step="0.01" value="${details.debt_amount || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>AI Insights Schedule</span>
              <select id="editEntSchedule" class="ob-input">
                <option value="hourly" ${res.insights_schedule === 'hourly' ? 'selected' : ''}>Hourly</option>
                <option value="daily" ${(!res.insights_schedule || res.insights_schedule === 'daily') ? 'selected' : ''}>Daily</option>
                <option value="weekly" ${res.insights_schedule === 'weekly' ? 'selected' : ''}>Weekly</option>
              </select>
            </label>
          </div>
        `;
      } else if (personaKey === 'startup') {
        container.innerHTML = `
          <div class="field-row">
            <label class="hdfc-field"><span>Founder Name</span><input type="text" id="editSuFounderName" class="ob-input" value="${details.founder_name || ''}"></label>
            <label class="hdfc-field"><span>Founder Mobile</span><input type="text" id="editSuFounderMobile" class="ob-input" value="${details.founder_mobile || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Company Name</span><input type="text" id="editSuCompanyName" class="ob-input" value="${details.company_name || ''}"></label>
            <label class="hdfc-field"><span>Industry</span><input type="text" id="editSuIndustry" class="ob-input" value="${details.industry || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Business Model</span><input type="text" id="editSuBusinessModel" class="ob-input" value="${details.business_model || ''}"></label>
            <label class="hdfc-field"><span>Stage</span><input type="text" id="editSuStage" class="ob-input" value="${details.stage || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Headcount</span><input type="number" id="editSuHeadcount" class="ob-input" value="${details.headcount || 0}"></label>
            <label class="hdfc-field"><span>GST Number (GSTIN)</span><input type="text" id="editSuGstNumber" class="ob-input" value="${details.gst_number || ''}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Monthly Revenue (₹)</span><input type="number" id="editSuMonthlyRevenue" class="ob-input" value="${details.monthly_revenue || 0}"></label>
            <label class="hdfc-field"><span>Current Cash (₹)</span><input type="number" id="editSuCurrentCash" class="ob-input" value="${details.current_cash || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Fixed Costs (₹)</span><input type="number" id="editSuFixedCosts" class="ob-input" value="${details.fixed_costs || 0}"></label>
            <label class="hdfc-field"><span>Variable Costs (₹)</span><input type="number" id="editSuVariableCosts" class="ob-input" value="${details.variable_costs || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>Total Funding (₹)</span><input type="number" id="editSuTotalFunding" class="ob-input" value="${details.total_funding || 0}"></label>
            <label class="hdfc-field"><span>Business Loans/Debt (₹)</span><input type="number" id="editSuDebt" class="ob-input" value="${details.business_loans_debt || 0}"></label>
          </div>
          <div class="field-row">
            <label class="hdfc-field"><span>AI Insights Schedule</span>
              <select id="editSuSchedule" class="ob-input">
                <option value="hourly" ${res.insights_schedule === 'hourly' ? 'selected' : ''}>Hourly</option>
                <option value="daily" ${(!res.insights_schedule || res.insights_schedule === 'daily') ? 'selected' : ''}>Daily</option>
                <option value="weekly" ${res.insights_schedule === 'weekly' ? 'selected' : ''}>Weekly</option>
              </select>
            </label>
          </div>
        `;
      }
      form.dataset.persona = personaKey;
    } catch (err) {
      container.innerHTML = `<p style="color:var(--warn); font-size:13px;">Error loading profile data: ${err.message}</p>`;
    }
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const personaKey = form.dataset.persona || state.profileKey || 'individual';
    const btnSave = document.getElementById('btnSaveEditProfile');
    btnSave.disabled = true;
    btnSave.textContent = 'Saving...';
    if (errDiv) errDiv.style.display = 'none';

    let payload = {};
    let endpoint = `/onboard/${personaKey}/update`;

    if (personaKey === 'individual') {
      payload = {
        full_name: document.getElementById('editIndName')?.value,
        email: document.getElementById('editIndEmail')?.value,
        mobile: document.getElementById('editIndMobile')?.value,
        occupation: document.getElementById('editIndOccupation')?.value,
        monthly_income: Number(document.getElementById('editIndIncome')?.value || 0),
        total_savings: Number(document.getElementById('editIndSavings')?.value || 0),
        monthly_expenses: Number(document.getElementById('editIndExpenses')?.value || 0),
        outstanding_loans: Number(document.getElementById('editIndLoans')?.value || 0),
        existing_investments: Number(document.getElementById('editIndInvestments')?.value || 0),
        insurance_coverage: Number(document.getElementById('editIndInsurance')?.value || 0),
        dependents: Number(document.getElementById('editIndDependents')?.value || 0),
        goal_title: document.getElementById('editIndGoalTitle')?.value,
        goal_target_amount: Number(document.getElementById('editIndGoalTarget')?.value || 0),
        goal_target_date: document.getElementById('editIndGoalDate')?.value || null,
        insights_schedule: document.getElementById('editIndSchedule')?.value || 'daily',
        whatsapp_phone: document.getElementById('editIndWhatsapp')?.value?.trim() || null
      };
    } else if (personaKey === 'enterprise') {
      payload = {
        cfo_name: document.getElementById('editEntCfoName')?.value,
        corporate_mobile: document.getElementById('editEntCorporateMobile')?.value,
        org_name: document.getElementById('editEntOrgName')?.value,
        industry: document.getElementById('editEntIndustry')?.value,
        headcount: Number(document.getElementById('editEntHeadcount')?.value || 0),
        gst_number: document.getElementById('editEntGstNumber')?.value,
        treasury_balance: Number(document.getElementById('editEntTreasury')?.value || 0),
        annual_turnover: Number(document.getElementById('editEntTurnover')?.value || 0),
        quarterly_cash_flow: Number(document.getElementById('editEntCashFlow')?.value || 0),
        operating_expenses: Number(document.getElementById('editEntOperatingExpenses')?.value || 0),
        fx_exposure_pct: Number(document.getElementById('editEntFx')?.value || 0),
        debt_amount: Number(document.getElementById('editEntDebt')?.value || 0),
        insights_schedule: document.getElementById('editEntSchedule')?.value || 'daily'
      };
    } else if (personaKey === 'startup') {
      payload = {
        founder_name: document.getElementById('editSuFounderName')?.value,
        founder_mobile: document.getElementById('editSuFounderMobile')?.value,
        company_name: document.getElementById('editSuCompanyName')?.value,
        industry: document.getElementById('editSuIndustry')?.value,
        business_model: document.getElementById('editSuBusinessModel')?.value,
        stage: document.getElementById('editSuStage')?.value,
        headcount: Number(document.getElementById('editSuHeadcount')?.value || 0),
        gst_number: document.getElementById('editSuGstNumber')?.value,
        monthly_revenue: Number(document.getElementById('editSuMonthlyRevenue')?.value || 0),
        current_cash: Number(document.getElementById('editSuCurrentCash')?.value || 0),
        fixed_costs: Number(document.getElementById('editSuFixedCosts')?.value || 0),
        variable_costs: Number(document.getElementById('editSuVariableCosts')?.value || 0),
        total_funding: Number(document.getElementById('editSuTotalFunding')?.value || 0),
        business_loans_debt: Number(document.getElementById('editSuDebt')?.value || 0),
        insights_schedule: document.getElementById('editSuSchedule')?.value || 'daily'
      };
    }

    try {
      await authFetch(endpoint, payload, 'PUT');
      closeModal();
      await loadProfileAndRender();
      if (typeof renderOverview === 'function') renderOverview();
    } catch (err) {
      if (errDiv) {
        errDiv.textContent = err.message || 'Failed to update profile.';
        errDiv.style.display = 'block';
      }
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = 'Save Changes';
    }
  });
}

/* ============ Excel Handlers ============ */
function setupExcelHandlers() {
  const btnDownload = document.getElementById('btnDownloadExcelTemplate');
  const fileInput = document.getElementById('excelFileInput');

  if (btnDownload) {
    btnDownload.addEventListener('click', () => {
      const persona = state.profileKey || 'individual';
      window.open(`${window.API_BASE}/onboard/excel/template?persona=${persona}`, '_blank');
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      const session = JSON.parse(localStorage.getItem('twin_session') || '{}');
      try {
        const res = await fetch(`${window.API_BASE}/onboard/excel/upload`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.token}`
          },
          body: formData
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || 'Upload failed');
        }

        let alertMsg = data.message || 'Excel upload processed.';
        if (data.errors && data.errors.length > 0) {
          alertMsg += '\n\nSkipped fields due to errors:\n' + data.errors.map(err => `• ${err.field}: ${err.error}`).join('\n');
        }
        alert(alertMsg);

        await loadProfileAndRender();
        if (typeof renderOverview === 'function') renderOverview();
      } catch (err) {
        alert(`Excel upload error: ${err.message}`);
      } finally {
        fileInput.value = '';
      }
    });
  }
}

/* ============ Onboarding State ============ */
let obUserId = "";
/* ============ Init ============ */
const savedSession = localStorage.getItem('twin_session');

/* `__mkPinLocked` is set by js/pin-gate.js when this load is on its way to the
   lock screen. The gate removes the session deliberately, so the absence of one
   here is not a signed-out user — and scheduling a second navigation to
   login.html would race the gate's and could win, dropping someone at the
   password form when their PIN would have done. */
if (window.__mkPinLocked) {
    // Nothing to boot. The browser is already leaving this document.
} else if (savedSession) {
    const session = JSON.parse(savedSession);
    loadProfileAndRender().then(() => { 
        setupEditProfileModal();
        setupExcelHandlers();
        // Not awaited: Overview's "Recent runs" panel reads state.simHistory,
        // and nothing else on the first paint depends on it.
        loadSimHistory();
        const urlParams = new URLSearchParams(window.location.search);
        // An explicit ?view= still wins. Failing that, an invitation deep link
        // starts the user on Split — split.js captured the target at parse
        // time precisely so this decision can be made here, once, instead of
        // two files racing to set the visible view.
        const startView = urlParams.get('view')
            || ((window.splitApp && window.splitApp.hasPendingDeepLink()) ? 'split' : 'overview');
        switchView(startView); 
    });
} else {
    window.location.href = 'login.html';
}

/* ============ Logout ============ */
const btnLogout = document.getElementById("btnLogout");
if (btnLogout) {
    btnLogout.addEventListener("click", () => {
        localStorage.removeItem('twin_session');
        /* Logging out is an explicit "stop trusting this browser", so the
           remembered device goes with the session. Leaving it would send the
           next visitor to a lock screen for an account they just signed out
           of, and let a PIN reopen it without a password. The single-use pass
           goes too, so nothing is left to authorise a page load. */
        try {
            localStorage.removeItem('moneykal_device');
            localStorage.removeItem('moneykal_unlocked_tabs');
            sessionStorage.removeItem('moneykal_unlock_pass');
        } catch (e) { /* private mode */ }
        window.location.href = 'index.html';
    });
}
