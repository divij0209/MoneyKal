
/**
 * Map a health status to a palette colour.
 *
 * The previous code interpolated `var(--color-green|yellow|red)`, none of which
 * are defined in any stylesheet, so the value rendered in the inherited colour.
 * MoneyKal's palette is black, off-white and cyan, with red reserved for a
 * genuine problem state.
 */
function healthColorVar(statusColor) {
  if (statusColor === 'red') return 'var(--warn)';
  if (statusColor === 'yellow') return 'var(--ink-muted)';
  return 'var(--accent)';
}

/* ==========================================================================
   MoneyKal — Daily Home

   Renders the top of the Individual's Overview from a single GET /home call.
   Presentation only: every figure, percentage and phrase shown here is
   computed by backend/services/home_service.py and home_insights.py. This file
   never derives a financial number of its own, so what the user reads always
   matches what the API can defend — the one exception is the greeting, which is
   taken from the browser's own clock so it is right before the network answers.

   Depends on escapeHtml() and switchView() from app.js, and window.api from
   api.js. Both are referenced only inside functions that run after those files
   have loaded.
   ========================================================================== */
(function () {

  const state = {
    data: null,
    loading: false,
    /** Set once the user's profile is known to be Individual. The Startup
     *  Overview is deliberately untouched by this feature. */
    enabled: false,
  };

  const el = id => document.getElementById(id);

  /* ------------------------------------------------------------- icons */

  const ICONS = {
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5z"></path><path d="M3 8h18"></path><circle cx="17" cy="12.5" r="1.2" fill="currentColor" stroke="none"></circle></svg>',
    trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="15 7 21 7 21 13"></polyline></svg>',
    piggy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6h4"></path></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l2 5.5 5.5 2-5.5 2-2 5.5-2-5.5L4.5 10l5.5-2z"></path><path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"></path></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"></circle></svg>',
    health: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12.5h3.2l1.8-4 2.6 8 2.2-6 1.6 2h6.6"></path></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>',
  };

  /** Icon per insight type, so the section reads at a glance. Anything
   *  unmapped falls back to the generic spark — a new backend rule therefore
   *  renders correctly without a frontend change. */
  const INSIGHT_ICONS = {
    upcoming_pressure: ICONS.calendar,
    buffer_thin: ICONS.wallet,
    goal_behind: ICONS.target,
    goal_on_track: ICONS.target,
    goal_pace: ICONS.target,
    no_goal: ICONS.target,
    savings_improving: ICONS.piggy,
    savings_pace: ICONS.piggy,
    category_spike: ICONS.trend,
    onboarding: ICONS.spark,
    insufficient_history: ICONS.spark,
  };

  const PRIORITY_LABEL = { high: 'Needs attention', medium: 'Worth knowing', low: 'FYI' };

  /* ------------------------------------------------------------- utils */

  function esc(v) {
    return (typeof escapeHtml === 'function') ? escapeHtml(v) : String(v == null ? '' : v);
  }

  function go(view) {
    if (typeof switchView === 'function') switchView(view);
  }

  /** Clamp to 0-100 before it reaches a CSS width, so a malformed percentage
   *  can never paint a bar outside its track. */
  function barWidth(pct) {
    const n = Number(pct);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function pctText(pct) {
    if (pct === null || pct === undefined) return 'N/A';
    return (Math.abs(pct - Math.round(pct)) < 0.05 ? Math.round(pct) : pct.toFixed(1)) + '%';
  }

  /* ------------------------------------------------------- B. snapshot */

  function statMarkup(opts) {
    return `
      <div class="dh-stat">
        <p class="dh-stat__label">${opts.icon}${esc(opts.label)}</p>
        <div class="dh-stat__value${opts.empty ? ' is-empty' : ''}">${opts.value}</div>
        ${opts.bar != null ? `<div class="dh-stat__bar"><i style="width:${barWidth(opts.bar)}%"></i></div>` : ''}
        ${opts.meta ? `<p class="dh-stat__meta${opts.metaClass ? ' ' + opts.metaClass : ''}">${opts.meta}</p>` : ''}
        ${opts.cta ? `<button type="button" class="dh-stat__cta" data-dh-action="${opts.cta.action}">${esc(opts.cta.label)}</button>` : ''}
      </div>`;
  }

  function renderSnapshot(data) {
    const mount = el('dhSnapshot');
    if (!mount) return;

    const snap = data.financial_snapshot || {};
    const avail = snap.available_money || {};
    const spend = snap.monthly_spending || {};
    const savings = snap.savings_progress || {};

    /* --- Available money --- */
    const availEmpty = avail.status === 'insufficient_data';
    const availTile = statMarkup({
      icon: ICONS.wallet,
      label: avail.label || 'Available money',
      value: availEmpty ? 'Not set yet' : esc(avail.display),
      empty: availEmpty,
      meta: avail.note ? esc(avail.note) : null,
      cta: availEmpty ? { action: 'edit-profile', label: 'Add your savings' } : null,
    });

    /* --- This month's spending --- */
    const spendEmpty = spend.status === 'insufficient_data';
    let spendMeta = null, spendMetaClass = null;
    if (!spendEmpty) {
      if (spend.change_pct !== null && spend.change_pct !== undefined) {
        const up = spend.change_pct > 0;
        spendMeta = `<b>${up ? '↑' : '↓'} ${pctText(Math.abs(spend.change_pct))}</b> vs last month`;
        spendMetaClass = up ? 'is-up' : 'is-down';
      } else if (spend.top_categories && spend.top_categories.length) {
        const top = spend.top_categories[0];
        spendMeta = `Mostly <b>${esc(top.category)}</b>, ${esc(top.display)}`;
      } else {
        spendMeta = esc(spend.month || '');
      }
    }
    const spendTile = statMarkup({
      icon: ICONS.trend,
      label: spend.label || 'Spent this month',
      value: spendEmpty ? 'Nothing logged' : esc(spend.display),
      empty: spendEmpty,
      meta: spendEmpty ? esc(spend.note || '') : spendMeta,
      metaClass: spendMetaClass,
      cta: spendEmpty ? { action: 'go-hisaab', label: 'Log an expense' } : null,
    });

    /* --- Savings progress --- */
    const savingsEmpty = savings.status !== 'actual' || savings.percentage === null;
    const savingsTile = statMarkup({
      icon: ICONS.piggy,
      label: savings.label || 'Savings progress',
      value: savingsEmpty ? 'No goal yet' : pctText(savings.percentage),
      empty: savingsEmpty,
      bar: savingsEmpty ? null : savings.percentage,
      meta: savingsEmpty
        ? esc(savings.note || '')
        : `<b>${esc(savings.current_display)}</b> of ${esc(savings.target_display)}` +
          (savings.goal_count > 1 ? ` across ${savings.goal_count} goals` : ''),
      cta: savingsEmpty ? { action: 'add-goal', label: 'Set your first goal' } : null,
    });

    /* --- Health Score --- */
    const health = data.health_score;
    let healthTile = '';
    if (health) {
      healthTile = `
        <div class="dh-stat dh-health-stat" onclick="window.showHealthModal()">
          <p class="dh-stat__label">${ICONS.health}Financial Health</p>
          <div class="dh-stat__value" style="color: ${healthColorVar(health.status_color)}">
            ${health.score}/100, ${esc(health.status_text)}
          </div>
          <p class="dh-stat__meta">Tap to see breakdown</p>
        </div>`;
      
      // Store on window for the modal to use
      window._currentHealthScore = health;
    }

    mount.innerHTML = healthTile + availTile + spendTile + savingsTile;
  }

  /* -------------------------------------------------------- C. insight */

  function renderInsight(data) {
    const mount = el('dhInsight');
    if (!mount) return;

    const insight = data.insight;
    if (!insight) { mount.innerHTML = ''; return; }
    
    let insightsToRender = [insight];
    if (insight.alternatives && insight.alternatives.length) {
      insightsToRender = insightsToRender.concat(insight.alternatives).slice(0, 3);
    }

    let html = '';
    insightsToRender.forEach((ins) => {
      const priority = ins.priority || 'medium';
      const icon = INSIGHT_ICONS[ins.type] || ICONS.spark;

      const action = ins.action;

      html += `
        <div class="dh-insight dh-insight--${esc(priority)} dh-insight--stacked">
          <div class="dh-insight__icon">${icon}</div>
          <div class="dh-insight__body">
            <p class="dh-insight__eyebrow">
              <span class="dh-insight__badge">${esc(PRIORITY_LABEL[priority] || priority)}</span>
            </p>
            <h3 class="dh-insight__title">${esc(ins.title)}</h3>
            <p class="dh-insight__msg">${esc(ins.message)}</p>
            ${action ? `<button type="button" class="dh-insight__action" data-dh-insight-action="${esc(action.view)}">
                ${esc(action.label)} <span aria-hidden="true">→</span>
              </button>` : ''}
          </div>
        </div>`;
    });
    
    mount.innerHTML = `
      <div class="dh-head" style="display: flex; justify-content: space-between; align-items: center;">
        <h3 class="dh-head__title">${ICONS.spark}Daily AI Insights</h3>
        <button type="button" class="btn-outline-sm" style="font-size:12px; padding:4px 10px; cursor:pointer;" data-dh-schedule>Schedule</button>
      </div>
      <div class="dh-insights-list">
        ${html}
      </div>
    `;
  }

  /* ------------------------------------------------------- D. upcoming */

  /** The letter that stands in for a category on an upcoming-payment row.
   *  Derived rather than mapped, so a category the user invents themselves
   *  gets a mark too. */
  function categoryMark(category) {
    const c = String(category || '').trim();
    return c ? c.charAt(0).toUpperCase() : '·';
  }

  /** Where a non-manual row came from. Keyed by the backend's `source` value so
   *  a future 'sms' or 'whatsapp' detector needs only one entry here. */
  const SOURCE_LABELS = {
    gmail: 'From email',
  };

  function renderUpcoming(data) {
    const mount = el('dhUpcoming');
    if (!mount) return;

    const up = data.upcoming || {};
    const items = up.items || [];

    const head = `
      <div class="dh-head">
        <h3 class="dh-head__title">${ICONS.calendar}What's coming up</h3>
        <button type="button" class="dh-head__action" data-dh-action="add-upcoming">+ Add</button>
      </div>`;

    if (!items.length) {
      mount.innerHTML = head + `
        <div class="dh-empty">
          <p class="dh-empty__text">No upcoming payments. Add the bills, subscriptions and EMIs you know about and MoneyKal will keep them in front of you.</p>
          <button type="button" class="dh-empty__btn" data-dh-action="add-upcoming">${ICONS.plus} Add a payment</button>
        </div>`;
      return;
    }

    const rows = items.map(item => {
      const mark = esc(categoryMark(item.category));
      // Detected rows say so. A number the user did not type should be
      // visibly attributed, not silently mixed in with the ones they did.
      const detected = item.source && item.source !== 'manual';
      return `
        <li class="dh-up__item dh-up__item--${esc(item.urgency_level)}">
          <div class="dh-up__mark" aria-hidden="true">${mark}</div>
          <div class="dh-up__body">
            <div class="dh-up__name">${esc(item.name)}</div>
            <div class="dh-up__meta">
              <span class="dh-up__due">${esc(item.urgency)}</span>
              ${item.category ? `<span>·</span><span>${esc(item.category)}</span>` : ''}
              ${item.is_recurring ? `<span class="dh-up__repeat">${esc(item.recurrence)}</span>` : ''}
              ${detected ? `<span class="dh-up__src" title="Detected from ${esc(item.source_label || item.source)}">${esc(SOURCE_LABELS[item.source] || item.source)}</span>` : ''}
            </div>
          </div>
          <div class="dh-up__right">
            <span class="dh-up__amt">${item.amount_display ? esc(item.amount_display) : '—'}</span>
            ${item.payment_url ? `<a href="${esc(item.payment_url)}" target="_blank" rel="noopener noreferrer" class="btn btn--outline dh-up__pay" style="padding: 4px 8px; font-size: 13px; text-decoration: none;">Pay now</a>` : ''}
            <button type="button" class="dh-up__paid" data-dh-paid="${item.id}">Mark paid</button>
          </div>
        </li>`;
    }).join('');

    const more = up.total_count > items.length
      ? `<span>${up.total_count - items.length} more scheduled</span>`
      : `<span>Next 30 days</span>`;

    mount.innerHTML = head + `
      <p class="dh-sub">${up.next_30_days_count} due in the next 30 days.</p>
      <ul class="dh-up">${rows}</ul>
      <div class="dh-up__total">${more}<b>${esc(up.next_30_days_display)}</b></div>
      ${renderSuggestions(up)}`;
  }

  /* ---- Detected obligations awaiting confirmation ----
     Rendered below the real list and visually separated, because these are
     questions, not facts: none of them counts toward the total above until the
     user says yes. */
  function renderSuggestions(up) {
    const suggestions = (up && up.suggestions) || [];
    if (!suggestions.length) return '';

    const rows = suggestions.map(s => `
      <li class="dh-sg__item">
        <div class="dh-sg__body">
          <div class="dh-sg__name">${esc(s.name)}${s.amount_display ? ` · <b>${esc(s.amount_display)}</b>` : ''}</div>
          <div class="dh-sg__meta">
            <span>${esc(s.urgency)}</span>
            ${s.source_label ? `<span>·</span><span>from ${esc(s.source_label)}</span>` : ''}
          </div>
          ${s.source_subject ? `<div class="dh-sg__subject" title="${esc(s.source_subject)}">${esc(s.source_subject)}</div>` : ''}
        </div>
        <div class="dh-sg__actions">
          <button type="button" class="dh-sg__yes" data-dh-confirm="${s.id}">Add</button>
          <button type="button" class="dh-sg__no" data-dh-dismiss="${s.id}" aria-label="Dismiss ${esc(s.name)}">Not mine</button>
        </div>
      </li>`).join('');

    return `
      <section class="dh-sg" aria-label="Detected payments awaiting review">
        <p class="dh-sg__head">
          ${ICONS.spark}
          Found in your email: ${suggestions.length} to check
        </p>
        <p class="dh-sg__note">Not counted above until you add ${suggestions.length === 1 ? 'it' : 'them'}.</p>
        <ul class="dh-sg__list">${rows}</ul>
      </section>`;
  }

  /* ----------------------------------------------------------- E. goal */

  function renderGoal(data) {
    const mount = el('dhGoal');
    if (!mount) return;

    const goal = data.primary_goal;
    const others = (data.goals || []).filter(g => !goal || g.id !== goal.id);

    const head = `
      <div class="dh-head">
        <h3 class="dh-head__title">${ICONS.target}Goal progress</h3>
        ${goal ? '<button type="button" class="dh-head__action" data-dh-action="add-goal">+ Add</button>' : ''}
      </div>`;

    if (!goal) {
      mount.innerHTML = head + `
        <div class="dh-empty">
          <p class="dh-empty__text">Set your first financial goal, whether an emergency fund, a trip or a purchase, and every number on this page starts pointing somewhere.</p>
          <button type="button" class="dh-empty__btn" data-dh-action="add-goal">${ICONS.plus} Set your first goal</button>
        </div>`;
      return;
    }

    // Only the notes the data actually supports. A goal with no deadline gets
    // the remaining amount; one with a deadline gets the monthly pace it needs.
    let note = '';
    if (goal.monthly_required_display && goal.days_left != null && goal.days_left > 0) {
      note = `<b>${esc(goal.monthly_required_display)}</b> a month gets you there by ${esc(formatDate(goal.target_date))}.`;
    } else if (goal.days_left != null && goal.days_left <= 0) {
      note = `The ${esc(formatDate(goal.target_date))} deadline has passed. Worth resetting the target.`;
    } else if (goal.remaining_display && goal.remaining > 0) {
      note = `<b>${esc(goal.remaining_display)}</b> to go.`;
    } else if (goal.remaining === 0) {
      note = 'Goal reached. Nice work.';
    }

    mount.innerHTML = head + `
      <div class="dh-goal__top">
        <div class="dh-goal__icon" aria-hidden="true">${esc(goal.icon)}</div>
        <div class="dh-goal__name">${esc(goal.name)}</div>
      </div>
      <div class="dh-goal__figures">
        <span class="dh-goal__current">${esc(goal.current_display)}</span>
        <span class="dh-goal__target">/ ${esc(goal.target_display)}</span>
      </div>
      <div class="dh-goal__bar"><i style="width:${barWidth(goal.percentage)}%"></i></div>
      <div class="dh-goal__pct">
        <span><b>${pctText(goal.percentage)}</b> complete</span>
        ${others.length ? `<span>+${others.length} other goal${others.length === 1 ? '' : 's'}</span>` : ''}
      </div>
      ${note ? `<p class="dh-goal__note">${note}</p>` : ''}`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y) return iso;
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ------------------------------------------------ spending overview ----
     This month's outflow by the user's own Hisaab categories. Every figure
     comes from GET /home — the same rows the headline "Spent this month"
     totals — so the two can never disagree. */

  function renderSpending(data) {
    const mount = el('dhSpending');
    if (!mount) return;

    const s = data.spending_overview || {};
    const head = `
      <div class="dh-head">
        <h3 class="dh-head__title">${ICONS.trend}Spending overview</h3>
        <button type="button" class="dh-head__action" data-dh-action="go-hisaab">View Hisaab →</button>
      </div>`;

    if (s.status !== 'actual' || !(s.categories || []).length) {
      mount.innerHTML = head + `
        <div class="dh-empty">
          <p class="dh-empty__text">${esc(s.note || 'No expenses logged this month yet.')}</p>
          <button type="button" class="dh-empty__btn" data-dh-action="go-hisaab">
            ${ICONS.plus} Log an expense
          </button>
        </div>`;
      return;
    }

    // Bars are scaled against the largest category, not against the total, so
    // the shape of the month is legible even when one category dominates.
    const max = s.categories[0].amount || 1;

    const rows = s.categories.map((c, i) => {
      const lead = i === 0;
      const width = Math.max(2, Math.round((c.amount / max) * 100));
      let change = '';
      if (c.is_new) {
        change = '<span class="dh-cat__change">new this month</span>';
      } else if (c.change_pct !== null && c.change_pct !== undefined && Math.abs(c.change_pct) >= 1) {
        const up = c.change_pct > 0;
        change = `<span class="dh-cat__change ${up ? 'is-up' : 'is-down'}">`
          + `${up ? '↑' : '↓'} ${Math.abs(Math.round(c.change_pct))}% vs last month</span>`;
      }
      return `
        <li class="dh-cat${lead ? ' dh-cat--lead' : ''}">
          <span class="dh-cat__icon" aria-hidden="true">${esc(c.icon)}</span>
          <span class="dh-cat__name">${esc(c.category)}</span>
          <span class="dh-cat__amt">${esc(c.display)}</span>
          <span class="dh-cat__track"><i style="width:${width}%;--d:${i * 60}ms"></i></span>
          <span class="dh-cat__meta">
            <span>${c.share_pct}% of spend</span>
            ${change}
          </span>
        </li>`;
    }).join('');

    let delta = '';
    if (s.previous_total !== null && s.previous_total !== undefined && s.previous_total > 0) {
      const diff = s.total - s.previous_total;
      const up = diff > 0;
      delta = `<span class="dh-spend__delta ${up ? 'is-up' : 'is-down'}">`
        + `${up ? '↑' : '↓'} vs ${esc(s.previous_total_display)} last month</span>`;
    }

    mount.innerHTML = head + `
      <div class="dh-spend__head">
        <span class="dh-spend__total">
          <span class="dh-spend__amount">${esc(s.total_display)}</span>
          <span class="dh-spend__period">${esc(s.period)}</span>
        </span>
        ${delta}
      </div>
      <ul class="dh-cats">${rows}</ul>
      ${s.insight ? `<p class="dh-spend__insight">${esc(s.insight)}</p>` : ''}`;
  }

  /* ----------------------------------------------- financial calendar ----
     One dated view of everything the money is about to do. The month grid and
     the list are two readings of the same event set — GET /home ships the
     current month, and paging fetches just the month asked for rather than the
     whole dashboard again. */

  const calState = {
    month: null,        // { year, month } currently displayed
    data: null,         // the month payload
    selected: null,     // 'YYYY-MM-DD' the user clicked, or null for the timeline
    range: 30,          // timeline window in days
    loading: false,
  };

  const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  function localDateKey(d) {
    // Local, not toISOString() — that converts to UTC and can land a day early.
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }

  function prettyDate(key) {
    const [y, m, d] = (key || '').split('-').map(Number);
    if (!y) return key || '';
    return new Date(y, m - 1, d).toLocaleDateString('en-IN',
      { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /** "Today" / "Tomorrow" / "in 5 days" / "12 Sep" — the same vocabulary the
   *  upcoming list already uses, so one event reads the same in both places. */
  function relativeWhen(ev) {
    const n = ev.days_until;
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    if (n > 1 && n <= 13) return 'In ' + n + ' days';
    if (n < -1 && n >= -13) return Math.abs(n) + ' days ago';
    return prettyDate(ev.date);
  }

  function eventRow(ev) {
    const classes = ['dh-event'];
    if (ev.direction === 'in') classes.push('dh-event--in');
    if (ev.direction === 'none') classes.push('dh-event--plan');
    if (ev.tentative) classes.push('dh-event--tentative');
    if (!ev.is_past && ev.days_until <= 3) classes.push('dh-event--soon');

    const tags = [];
    if (ev.tentative) tags.push('<span class="dh-tag dh-tag--review">Needs review</span>');
    else if (ev.origin === 'gmail') tags.push('<span class="dh-tag">From email</span>');
    else if (ev.origin === 'detected') tags.push('<span class="dh-tag">Detected</span>');
    if (ev.meta && ev.meta.recurrence && ev.meta.recurrence !== 'none') {
      tags.push(`<span class="dh-tag">${esc(ev.meta.recurrence)}</span>`);
    }

    const sign = ev.direction === 'in' ? '+' : (ev.direction === 'out' ? '−' : '');
    return `
      <li class="${classes.join(' ')}" data-dh-event='${esc(JSON.stringify(ev))}'>
        <span class="dh-event__icon" aria-hidden="true">${esc(ev.icon)}</span>
        <span class="dh-event__name">${esc(ev.title)}</span>
        <span class="dh-event__amt">${ev.amount_display ? sign + esc(ev.amount_display) : ''}</span>
        <span class="dh-event__meta">
          <span class="dh-event__when">${esc(relativeWhen(ev))}</span>
          <span>·</span><span>${esc(ev.type_label)}</span>
          ${tags.join('')}
        </span>
      </li>`;
  }

  function dayCell(dayNum, key, events, todayKey) {
    if (!dayNum) return '<span class="dh-day is-blank" aria-hidden="true"></span>';

    const list = events || [];
    // Activity is the "what happened" layer; it should not make an empty
    // future day look busy, but it should still be openable on a past day.
    const classes = ['dh-day'];
    if (list.length) classes.push('has-events');
    if (key === todayKey) classes.push('is-today');
    if (key === calState.selected) classes.push('is-selected');

    const dots = list.slice(0, 3).map(ev => {
      let cls = 'dh-day__dot';
      if (ev.tentative) cls += ' dh-day__dot--tentative';
      else if (ev.direction === 'in') cls += ' dh-day__dot--in';
      else if (ev.direction === 'none') cls += ' dh-day__dot--goal';
      else cls += ' dh-day__dot--out';
      return `<span class="${cls}"></span>`;
    }).join('');

    const label = list.length
      ? `${key}, ${list.length} event${list.length === 1 ? '' : 's'}`
      : key;

    return `
      <button type="button" class="${classes.join(' ')}" data-dh-day="${key}"
        aria-label="${esc(label)}"${list.length ? '' : ' tabindex="-1"'}>
        ${dayNum}
        <span class="dh-day__dots">${dots}${list.length > 3
          ? '<span class="dh-day__more">+</span>' : ''}</span>
      </button>`;
  }

  function renderCalendar(data) {
    const mount = el('dhCalendar');
    if (!mount) return;

    const cal = calState.data || data.calendar || {};
    const timeline = data.timeline || {};
    if (!cal.days) { mount.innerHTML = ''; return; }

    calState.month = { year: cal.year, month: cal.month };

    const head = `
      <div class="dh-head">
        <h3 class="dh-head__title">${ICONS.calendar}Financial calendar</h3>
        <button type="button" class="dh-head__action" data-dh-action="add-upcoming">+ Add event</button>
      </div>`;

    const nav = `
      <div class="dh-cal__top">
        <div class="dh-cal__nav">
          <button type="button" class="dh-cal__navbtn" data-dh-cal="prev" aria-label="Previous month">‹</button>
          <span class="dh-cal__month">${esc(cal.label)}</span>
          <button type="button" class="dh-cal__navbtn" data-dh-cal="next" aria-label="Next month">›</button>
        </div>
        <button type="button" class="dh-cal__today" data-dh-cal="today">Today</button>
      </div>`;

    const t = cal.totals || {};
    const totals = `
      <p class="dh-cal__totals">
        <span>Out this month <b>${esc(t.money_out_display || 'N/A')}</b></span>
        ${t.money_in ? `<span class="is-in">In <b>${esc(t.money_in_display)}</b></span>` : ''}
        <span>${t.event_count || 0} event${t.event_count === 1 ? '' : 's'}</span>
        ${t.tentative_count ? `<span>${t.tentative_count} awaiting review</span>` : ''}
      </p>`;

    // Grid. `first_weekday` is 0 = Sunday, matching the DOW row.
    const cells = [];
    for (let i = 0; i < cal.first_weekday; i++) cells.push(dayCell(null));
    for (let d = 1; d <= cal.days_in_month; d++) {
      const key = cal.year + '-' + String(cal.month).padStart(2, '0')
        + '-' + String(d).padStart(2, '0');
      cells.push(dayCell(d, key, cal.days[key], cal.today));
    }

    const grid = `
      <div class="dh-cal__month-wrap">
        <div class="dh-cal__dow" aria-hidden="true">${DOW.map(d => `<span>${d}</span>`).join('')}</div>
        <div class="dh-cal__grid" role="grid">${cells.join('')}</div>
      </div>`;

    /* The panel below the grid is either the selected day, or the rolling
       window — one place, two modes, so the section never shows two lists. */
    let panel;
    if (calState.selected) {
      const evs = cal.days[calState.selected] || [];
      panel = `
        <div class="dh-cal__panel">
          <div class="dh-cal__panelhead">
            <span class="dh-cal__panellabel">${esc(prettyDate(calState.selected))}</span>
            <button type="button" class="dh-cal__today" data-dh-cal="clear">Show upcoming →</button>
          </div>
          ${evs.length
            ? `<ul class="dh-events">${evs.map(eventRow).join('')}</ul>`
            : '<p class="dh-cal__empty">Nothing scheduled on this day.</p>'}
        </div>`;
    } else {
      const items = (timeline.items || []).filter(
        i => calState.range === 30 || i.days_until <= 7);
      const label = calState.range === 7 ? 'Next 7 days' : 'Next 30 days';
      const sum = calState.range === 7
        ? timeline.next_7_days_out_display : timeline.money_out_display;
      panel = `
        <div class="dh-cal__panel">
          <div class="dh-cal__panelhead">
            <span class="dh-cal__panellabel">${label} · ${esc(sum || 'N/A')} out</span>
            <span class="dh-cal__range">
              <button type="button" class="dh-cal__rangebtn${calState.range === 7 ? ' is-active' : ''}"
                data-dh-range="7">7d</button>
              <button type="button" class="dh-cal__rangebtn${calState.range === 30 ? ' is-active' : ''}"
                data-dh-range="30">30d</button>
            </span>
          </div>
          ${items.length
            ? `<ul class="dh-events">${items.map(eventRow).join('')}</ul>`
            : '<p class="dh-cal__empty">Nothing scheduled in this window.</p>'}
        </div>`;
    }

    mount.innerHTML = head + nav + totals
      + `<div class="dh-cal__body">${grid}<div class="dh-cal__side">${panel}</div></div>`;
  }

  /** Detail for one event, opened from the grid or either list. Rendered
   *  inline under the panel rather than in a modal — it is a few facts, and a
   *  dialog for that would be heavier than the content. */
  function showEventDetail(ev) {
    const panel = document.querySelector('#dhCalendar .dh-cal__panel');
    if (!panel) return;
    const existing = panel.querySelector('.dh-detail');
    if (existing) existing.remove();

    const rows = [];
    if (ev.amount_display) {
      rows.push(['Amount', (ev.direction === 'in' ? '+' : ev.direction === 'out' ? '−' : '') + ev.amount_display]);
    }
    rows.push(['Date', prettyDate(ev.date)]);
    rows.push(['Type', ev.type_label]);
    if (ev.detail) rows.push(['Detail', ev.detail]);
    if (ev.meta && ev.meta.recurrence && ev.meta.recurrence !== 'none') {
      rows.push(['Repeats', ev.meta.recurrence]);
    }
    if (ev.meta && ev.meta.sender_domain) rows.push(['Source', ev.meta.sender_domain]);
    else if (ev.origin && ev.origin !== 'manual') rows.push(['Source', ev.origin]);
    if (ev.tentative) rows.push(['Status', 'Awaiting your confirmation']);

    const html = `
      <div class="dh-detail">
        <div class="dh-detail__top">
          <span class="dh-detail__title">${esc(ev.icon)} ${esc(ev.title)}</span>
          <button type="button" class="dh-detail__close" data-dh-cal="close-detail"
            aria-label="Close details">×</button>
        </div>
        <div class="dh-detail__rows">
          ${rows.map(r => `<p class="dh-detail__row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></p>`).join('')}
        </div>
      </div>`;
    panel.insertAdjacentHTML('beforeend', html);
  }

  /** Fetches one month. Only the month changes, so the rest of the dashboard
   *  is left alone rather than re-fetched on every arrow press. */
  async function loadMonth(year, month) {
    if (calState.loading) return;
    calState.loading = true;
    try {
      const cal = await window.api.fetchHomeCalendar(year, month);
      calState.data = cal;
      calState.selected = null;
      if (state.data) renderCalendar(state.data);
    } catch (err) {
      console.error('Could not load that month', err);
    } finally {
      calState.loading = false;
    }
  }

  function shiftMonth(delta) {
    if (!calState.month) return;
    const d = new Date(calState.month.year, calState.month.month - 1 + delta, 1);
    loadMonth(d.getFullYear(), d.getMonth() + 1);
  }

  /* -------------------------------------------------------- top states */

  /** A brand-new account: no stated figures, no transactions, nothing to show.
   *  Showing a grid of dashes here would look broken, and showing zeroes would
   *  be a lie, so the whole section becomes one honest call to action. */
  function renderOnboarding(data) {
    const root = el('ovDailyHome');
    if (!root) return;
    const insight = data.insight || {};
    root.innerHTML = `
      <div class="dh-onboard">
        <h3 class="dh-onboard__title">${esc(insight.title || "Let's get your financial brain started")}</h3>
        <p class="dh-onboard__text">${esc(insight.message || 'Add your income, savings and expenses and MoneyKal will start reading your money for you.')}</p>
        <div class="dh-onboard__actions">
          <button type="button" class="dh-empty__btn" data-dh-action="edit-profile">${ICONS.plus} Add your financial details</button>
          <button type="button" class="dh-empty__btn" data-dh-action="go-hisaab" style="background:none;color:var(--ink);box-shadow:none;border:1px solid var(--line-strong)">Log a transaction</button>
        </div>
      </div>`;
  }

  function renderSkeleton() {
    const root = el('ovDailyHome');
    if (!root) return;
    const tile = `
      <div class="dh-stat">
        <div class="dh-skel dh-skel--label"></div>
        <div class="dh-skel dh-skel--value"></div>
        <div class="dh-skel dh-skel--meta"></div>
      </div>`;
    root.innerHTML = `
      <div class="dh-snap">${tile + tile + tile}</div>
      <div class="dh-skel dh-skel--insight"></div>
      <div class="dh-block">
        <div class="dh-skel dh-skel--label"></div>
        <div class="dh-skel dh-skel--row"></div>
        <div class="dh-skel dh-skel--row"></div>
      </div>
      <div class="dh-block">
        <div class="dh-skel dh-skel--label"></div>
        <div class="dh-skel dh-skel--insight"></div>
      </div>
      <div class="dh-split">
        <div class="dh-block">
          <div class="dh-skel dh-skel--label"></div>
          <div class="dh-skel dh-skel--row"></div>
          <div class="dh-skel dh-skel--row"></div>
          <div class="dh-skel dh-skel--row"></div>
        </div>
        <div class="dh-block">
          <div class="dh-skel dh-skel--label"></div>
          <div class="dh-skel dh-skel--row"></div>
          <div class="dh-skel dh-skel--row"></div>
        </div>
      </div>`;
  }

  function renderError(message) {
    const root = el('ovDailyHome');
    if (!root) return;
    root.innerHTML = `
      <div class="dh-error">
        <p class="dh-error__text">${esc(message || "Couldn't load your dashboard just now.")}</p>
        <button type="button" class="dh-error__retry" data-dh-action="retry">Try again</button>
      </div>`;
  }

  /** Rebuilds the section's own skeleton after an onboarding/error state has
   *  replaced it, so a later successful load has its mount points back. */
  function ensureLayout() {
    const root = el('ovDailyHome');
    if (!root) return;
    if (el('dhSnapshot') && el('dhInsight') && el('dhSpending')
        && el('dhCalendar') && el('dhUpcoming') && el('dhGoal')) return;
    root.innerHTML = `
      <h2 class="sr-only">Your money today</h2>
      <div class="dh-snap" id="dhSnapshot"></div>
      <div class="dh-insight-slot" id="dhInsight"></div>
      <section class="dh-block dh-spend-slot" id="dhSpending" aria-label="Spending overview"></section>
      <section class="dh-block dh-cal-slot" id="dhCalendar" aria-label="Financial calendar"></section>
      <div class="dh-split">
        <section class="dh-block" id="dhUpcoming" aria-label="Upcoming payments"></section>
        <section class="dh-block" id="dhGoal" aria-label="Goal progress"></section>
      </div>`;
  }

  /* -------------------------------------------------------------- load */

  /** The greeting is written from the browser clock rather than the API's,
   *  because it must be right the instant the page paints — the backend sends
   *  the same wording for non-browser consumers, from the hour we pass it. */
  function applyGreeting(data) {
    const heading = document.querySelector('.ov-top__greeting');
    if (!heading || !data.user) return;
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : (hour < 17 ? 'Good afternoon' : 'Good evening');
    heading.innerHTML = `${esc(greeting)}, <span id="ovName">${esc(data.user.name)}</span>`;

    if (data.user.name) {
      const initial = data.user.name.charAt(0).toUpperCase();
      document.querySelectorAll('.ov-avatar').forEach(a => { a.textContent = initial; });
    }
  }

  async function load(opts) {
    const root = el('ovDailyHome');
    if (!root || !state.enabled) return;
    if (state.loading) return;

    state.loading = true;
    root.hidden = false;
    // Only show skeletons on a cold load — a refresh after switching views
    // should not blank content the user is already reading.
    if (!state.data || (opts && opts.force)) renderSkeleton();

    try {
      const data = await window.api.fetchHome();
      state.data = data;

      applyGreeting(data);

      if (!data.has_financial_data) {
        renderOnboarding(data);
        return;
      }

      ensureLayout();
      renderSnapshot(data);
      renderInsight(data);
      // A fresh payload supersedes any month the user had paged to, so the
      // calendar follows the data rather than getting stuck on a stale month.
      calState.data = null;
      calState.selected = null;
      renderSpending(data);
      renderCalendar(data);
      renderUpcoming(data);
      renderGoal(data);
      if (typeof window.loadBudgets === 'function') window.loadBudgets();
    } catch (err) {
      console.error('Daily Home failed to load', err);
      // Keep whatever was already on screen rather than replacing good data
      // with an error box on a transient refresh failure.
      if (!state.data) renderError(err && err.message);
    } finally {
      state.loading = false;
    }
  }

  /* ------------------------------------------------------------ modals */

  function openModal(id) {
    const m = el(id);
    if (m) m.classList.add('is-open');
  }

  function closeModal(id) {
    const m = el(id);
    if (!m) return;
    m.classList.remove('is-open');
    const err = m.querySelector('.dh-modal__err');
    if (err) err.hidden = true;
  }

  function showModalError(id, message) {
    const err = el(id);
    if (!err) return;
    err.textContent = message;
    err.hidden = false;
  }

  const UPCOMING_CATEGORIES = [
    'Utilities & Bills', 'Subscriptions', 'Rent / Housing', 'Travel & Transport',
    'Health & Medical', 'Shopping', 'Groceries', 'Food & Dining', 'Entertainment',
    'Taxes', 'Professional fees', 'Software/Tools', 'Other expense',
  ];

  function setupModals() {
    /* --- Goal --- */
    const goalForm = el('dhGoalForm');
    if (goalForm) {
      goalForm.addEventListener('submit', async e => {
        e.preventDefault();
        const submit = el('dhGoalSubmit');
        const target = parseFloat(el('dhGoalTarget').value);
        const current = parseFloat(el('dhGoalCurrent').value || '0');

        if (!(target > 0)) return showModalError('dhGoalModalError', 'Enter a target amount greater than zero.');
        if (current > target) return showModalError('dhGoalModalError', "What you've saved can't be more than the target.");

        submit.disabled = true;
        try {
          await window.api.createGoal({
            name: el('dhGoalName').value.trim(),
            target_amount: target,
            current_amount: current,
            target_date: el('dhGoalDate').value || null,
            category: el('dhGoalCategory').value,
          });
          closeModal('dhGoalModal');
          goalForm.reset();
          el('dhGoalCurrent').value = '0';
          await load({ force: true });
          // The goal is mirrored into the legacy profile blob server-side, so
          // pull the profile again to keep the rest of the page consistent.
          if (typeof loadProfileAndRender === 'function') loadProfileAndRender();
        } catch (err) {
          showModalError('dhGoalModalError', err.message || 'Could not save that goal.');
        } finally {
          submit.disabled = false;
        }
      });
    }

    /* --- Upcoming --- */
    const upSelect = el('dhUpCategory');
    if (upSelect) {
      upSelect.innerHTML = UPCOMING_CATEGORIES
        .map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    }

    const upForm = el('dhUpcomingForm');
    if (upForm) {
      upForm.addEventListener('submit', async e => {
        e.preventDefault();
        const submit = el('dhUpcomingSubmit');
        const amount = parseFloat(el('dhUpAmount').value);
        const due = el('dhUpDate').value;

        if (!(amount > 0)) return showModalError('dhUpcomingModalError', 'Enter an amount greater than zero.');
        if (!due) return showModalError('dhUpcomingModalError', 'Pick a due date.');

        submit.disabled = true;

        const recurrence = el('dhUpRecurrence').value || 'none';
        
        const urlInput = el('dhUpUrl');
        const urlVal = urlInput ? urlInput.value.trim() : '';

        try {
          await window.api.createUpcoming({
            name: el('dhUpName').value.trim(),
            amount: amount,
            due_date: due,
            category: el('dhUpCategory').value,
            recurrence: recurrence,
            payment_url: urlVal ? urlVal : undefined
          });
          closeModal('dhUpcomingModal');
          upForm.reset();
          el('dhUpRecurrence').value = 'monthly';
          await load({ force: true });
        } catch (err) {
          showModalError('dhUpcomingModalError', err.message || 'Could not add that payment.');
        } finally {
          submit.disabled = false;
        }
      });
    }

    [['dhGoalModalClose', 'dhGoalModal'], ['dhGoalCancel', 'dhGoalModal'],
     ['dhUpcomingModalClose', 'dhUpcomingModal'], ['dhUpcomingCancel', 'dhUpcomingModal']]
      .forEach(([btnId, modalId]) => {
        const b = el(btnId);
        if (b) b.addEventListener('click', () => closeModal(modalId));
      });

    ['dhGoalModal', 'dhUpcomingModal'].forEach(modalId => {
      const m = el(modalId);
      if (m) m.addEventListener('click', e => { if (e.target === m) closeModal(modalId); });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeModal('dhGoalModal'); closeModal('dhUpcomingModal'); }
    });
  }

  /* ------------------------------------------------------------ wiring */

  const ACTIONS = {
    'add-goal': () => openModal('dhGoalModal'),
    'add-upcoming': () => {
      // Default the due date to a week out — the common case, and it saves the
      // user a date-picker trip for a bill they already know about.
      const input = el('dhUpDate');
      if (input && !input.value) {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        input.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      openModal('dhUpcomingModal');
    },
    'go-hisaab': () => go('hisaab'),
    'edit-profile': () => { const b = el('btnOpenEditProfile'); if (b) b.click(); },
    'retry': () => load({ force: true }),
  };

  document.addEventListener('click', async e => {
    const root = el('ovDailyHome');
    if (!root) return;

    const actionBtn = e.target.closest('[data-dh-action]');
    if (actionBtn && (root.contains(actionBtn) || actionBtn.dataset.dhAction === 'retry')) {
      e.preventDefault();
      e.stopPropagation();
      const fn = ACTIONS[actionBtn.dataset.dhAction];
      if (fn) fn();
      return;
    }

    const insightBtn = e.target.closest('[data-dh-insight-action]');
    if (insightBtn && root.contains(insightBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const view = insightBtn.dataset.dhInsightAction;
      // An insight pointing at Overview means "look just below" — scroll to the
      // relevant section rather than navigating to the page you are on.
      if (view === 'overview') {
        const anchor = el('dhUpcoming') || root;
        anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        go(view);
      }
      return;
    }

    /* --- calendar: month nav, day selection, window, event detail --- */
    const calBtn = e.target.closest('[data-dh-cal]');
    if (calBtn && root.contains(calBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const action = calBtn.dataset.dhCal;
      if (action === 'prev') shiftMonth(-1);
      else if (action === 'next') shiftMonth(1);
      else if (action === 'today') {
        const now = new Date();
        loadMonth(now.getFullYear(), now.getMonth() + 1);
      } else if (action === 'clear') {
        calState.selected = null;
        if (state.data) renderCalendar(state.data);
      } else if (action === 'close-detail') {
        const d = document.querySelector('#dhCalendar .dh-detail');
        if (d) d.remove();
      }
      return;
    }

    const dayBtn = e.target.closest('[data-dh-day]');
    if (dayBtn && root.contains(dayBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const key = dayBtn.dataset.dhDay;
      // Clicking the selected day again returns to the rolling window.
      calState.selected = (calState.selected === key) ? null : key;
      if (state.data) renderCalendar(state.data);
      return;
    }

    const rangeBtn = e.target.closest('[data-dh-range]');
    if (rangeBtn && root.contains(rangeBtn)) {
      e.preventDefault();
      e.stopPropagation();
      calState.range = parseInt(rangeBtn.dataset.dhRange, 10) || 30;
      if (state.data) renderCalendar(state.data);
      return;
    }

    const eventRowEl = e.target.closest('[data-dh-event]');
    if (eventRowEl && root.contains(eventRowEl)) {
      e.preventDefault();
      e.stopPropagation();
      try {
        showEventDetail(JSON.parse(eventRowEl.dataset.dhEvent));
      } catch (err) { /* malformed payload — nothing to show */ }
      return;
    }

    const paidBtn = e.target.closest('[data-dh-paid]');
    if (paidBtn && root.contains(paidBtn)) {
      e.preventDefault();
      e.stopPropagation();
      paidBtn.disabled = true;
      paidBtn.textContent = 'Saving…';
      try {
        await window.api.markUpcomingPaid(paidBtn.dataset.dhPaid);
        await load({ force: true });
      } catch (err) {
        paidBtn.disabled = false;
        paidBtn.textContent = 'Mark paid';
        console.error('Could not mark payment as paid', err);
      }
      return;
    }

    /* --- Accept or reject a detected obligation --- */
    const confirmBtn = e.target.closest('[data-dh-confirm]');
    if (confirmBtn && root.contains(confirmBtn)) {
      e.preventDefault();
      e.stopPropagation();
      await resolveSuggestion(confirmBtn, () =>
        window.api.confirmUpcoming(confirmBtn.dataset.dhConfirm), 'Add');
      return;
    }

    const dismissBtn = e.target.closest('[data-dh-dismiss]');
    if (dismissBtn && root.contains(dismissBtn)) {
      e.preventDefault();
      e.stopPropagation();
      await resolveSuggestion(dismissBtn, () =>
        window.api.dismissUpcoming(dismissBtn.dataset.dhDismiss), 'Not mine');
    }
  });

  /** Shared button-state handling for the two suggestion actions, so a failed
   *  call restores the button instead of leaving it stuck on "Saving…". */
  async function resolveSuggestion(button, action, label) {
    const row = button.closest('.dh-sg__item');
    if (row) row.querySelectorAll('button').forEach(b => { b.disabled = true; });
    button.textContent = '…';
    try {
      await action();
      await load({ force: true });
    } catch (err) {
      console.error('Could not update the suggestion', err);
      if (row) row.querySelectorAll('button').forEach(b => { b.disabled = false; });
      button.textContent = label;
    }
  }

  setupModals();

  /* --------------------------------------------------------- public API
     overview.js owns the Overview's render cycle, so it calls in here rather
     than this file racing it for the same DOM. */

  window.dailyHome = {
    /** Called by overview.js once the profile is known. Startup profiles pass
     *  false, which leaves their Overview exactly as it was. */
    setEnabled(enabled) {
      state.enabled = !!enabled;
      const root = el('ovDailyHome');
      if (root) root.hidden = !state.enabled;
      if (!state.enabled) state.data = null;
    },
    render(opts) { return load(opts || {}); },
    /** The last payload, so other views can reuse it without a second call. */
    data() { return state.data; },
  };
  /* ==========================================================================
     Health Score Modal
     ========================================================================== */
  window.showHealthModal = function() {
    const health = window._currentHealthScore;
    if (!health) return;
    
    // Create modal if it doesn't exist
    let modal = document.getElementById('healthScoreModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'healthScoreModal';
      modal.className = 'health-modal-overlay';
      modal.onclick = (e) => {
        if (e.target === modal) modal.style.display = 'none';
      };
      document.body.appendChild(modal);
    }
    
    const impList = health.improvements.map(i => `<li>${esc(i)}</li>`).join('');
    const hurtList = health.hurting.map(i => `<li>${esc(i)}</li>`).join('');
    
    modal.innerHTML = `
      <div class="health-modal-content">
        <button class="health-modal-close" onclick="document.getElementById('healthScoreModal').style.display='none'">×</button>
        <h2>Financial Health Score</h2>
        <div class="health-modal-score" style="color: ${healthColorVar(health.status_color)}">
          ${health.score}/100, ${esc(health.status_text)}
        </div>
        
        ${health.improvements.length ? `
        <div class="health-section">
          <h3>What improved your score</h3>
          <ul class="health-list health-list-good">${impList}</ul>
        </div>` : ''}
        
        ${health.hurting.length ? `
        <div class="health-section">
          <h3>What is hurting your score</h3>
          <ul class="health-list health-list-bad">${hurtList}</ul>
        </div>` : ''}
      </div>
    `;
    
    modal.style.display = 'flex';
  };

  // ==========================================================================
  // BUDGET GOALS
  // ==========================================================================

  const STATUS_COLOR = { ok: '#22c55e', warning: '#f59e0b', over: '#ef4444' };
  const STATUS_LABEL = { ok: 'On Track', warning: 'Warning', over: 'Over Budget' };

  function renderBudgets(statuses) {
    const section = el('dhBudgets');
    const list = el('dhBudgetList');
    if (!statuses || statuses.length === 0) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    list.innerHTML = statuses.map(b => {
      const clr = STATUS_COLOR[b.status] || '#6b7280';
      const pct = Math.min(b.pct_used, 100);
      const lbl = STATUS_LABEL[b.status] || '';
      const remain = b.remaining >= 0 ? `${b.currency}${b.remaining.toLocaleString('en-IN', {maximumFractionDigits:0})} left` : `${b.currency}${Math.abs(b.remaining).toLocaleString('en-IN', {maximumFractionDigits:0})} over`;
      return `
        <li class="dh-budget-item" data-budget-id="${b.id}">
          <div class="dh-budget-row">
            <span class="dh-budget-cat">${esc(b.category)}</span>
            <span class="dh-budget-remain" style="color:${clr}">${remain}</span>
          </div>
          <div class="dh-budget-bar-bg">
            <div class="dh-budget-bar-fill" style="width:${pct}%;background:${clr};"></div>
          </div>
          <div class="dh-budget-meta">
            <span>${b.currency}${b.spent.toLocaleString('en-IN', {maximumFractionDigits:0})} of ${b.currency}${b.monthly_limit.toLocaleString('en-IN', {maximumFractionDigits:0})}</span>
            <span style="color:${clr};font-weight:600">${lbl} · ${b.pct_used}%</span>
          </div>
        </li>`;
    }).join('');
  }

  async function loadBudgets() {
    try {
      const statuses = await window.api('/budgets/status');
      renderBudgets(statuses);
    } catch (e) {
      // Budget section stays hidden if not configured
    }
  }

  // Budget modal
  function openBudgetModal() {
    el('budgetModal').style.display = 'flex';
    el('budgetModalError').hidden = true;
    el('budgetLimit').value = '';
    el('budgetNotes').value = '';
  }
  function closeBudgetModal() { el('budgetModal').style.display = 'none'; }

  document.addEventListener('DOMContentLoaded', () => {
    const addBtn = el('btnAddBudget');
    if (addBtn) addBtn.addEventListener('click', openBudgetModal);
    const closeBtn = el('btnCloseBudgetModal');
    if (closeBtn) closeBtn.addEventListener('click', closeBudgetModal);
    const cancelBtn = el('btnCancelBudget');
    if (cancelBtn) cancelBtn.addEventListener('click', closeBudgetModal);

    const budgetForm = el('budgetForm');
    if (budgetForm) {
      budgetForm.addEventListener('submit', async e => {
        e.preventDefault();
        const errEl = el('budgetModalError');
        errEl.hidden = true;
        const submitBtn = el('btnSubmitBudget');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        try {
          await window.api('/budgets', {
            method: 'POST',
            body: JSON.stringify({
              category: el('budgetCategory').value,
              monthly_limit: parseFloat(el('budgetLimit').value),
              notes: el('budgetNotes').value || null,
            }),
          });
          closeBudgetModal();
          loadBudgets();
        } catch (err) {
          errEl.textContent = err.message || 'Failed to save budget.';
          errEl.hidden = false;
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Save Budget';
        }
      });
    }
  });

  // ==========================================================================
  // PDF STATEMENT IMPORT
  // ==========================================================================

  let _pdfFile = null;

  function openPdfModal() {
    el('pdfImportModal').style.display = 'flex';
    el('pdfModalError').hidden = true;
    el('pdfResult').style.display = 'none';
    el('btnUploadPdf').disabled = true;
    el('pdfDropText').textContent = 'Click or drag & drop your PDF here';
    _pdfFile = null;
  }
  function closePdfModal() { el('pdfImportModal').style.display = 'none'; }

  document.addEventListener('DOMContentLoaded', () => {
    const importBtn = el('btnImportStatement');
    if (importBtn) importBtn.addEventListener('click', openPdfModal);
    el('btnClosePdfModal')?.addEventListener('click', closePdfModal);
    el('btnCancelPdf')?.addEventListener('click', closePdfModal);

    const dropZone = el('pdfDropZone');
    const fileInput = el('pdfFileInput');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
      dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--accent)';
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = 'var(--line-strong)';
      });
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--line-strong)';
        const f = e.dataTransfer.files[0];
        if (f && f.type === 'application/pdf') {
          _pdfFile = f;
          el('pdfDropText').textContent = f.name;
          el('btnUploadPdf').disabled = false;
        }
      });
      fileInput.addEventListener('change', () => {
        const f = fileInput.files[0];
        if (f) {
          _pdfFile = f;
          el('pdfDropText').textContent = f.name;
          el('btnUploadPdf').disabled = false;
        }
      });
    }

    el('btnUploadPdf')?.addEventListener('click', async () => {
      if (!_pdfFile) return;
      const btn = el('btnUploadPdf');
      btn.disabled = true;
      btn.textContent = 'Parsing…';
      el('pdfModalError').hidden = true;
      el('pdfResult').style.display = 'none';
      try {
        const sess = JSON.parse(localStorage.getItem('twin_session') || '{}');
        const formData = new FormData();
        formData.append('file', _pdfFile);
        const resp = await fetch(`${window.API_BASE}/upload/statement`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${sess.token}` },
          body: formData,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || 'Upload failed');

        const resultEl = el('pdfResultText');
        const iconColor = data.added > 0 ? '#22c55e' : '#f59e0b';
        resultEl.innerHTML = `
          <div style="font-weight:600;font-size:15px;margin-bottom:8px;color:${iconColor}">
            ${data.message}
          </div>
          <div style="color:var(--ink-faint);font-size:12px">
            Found ${data.parsed} transactions · Added ${data.added} · Skipped ${data.skipped_duplicates} duplicates
            ${data.errors?.length ? `<br>${data.errors[0]}` : ''}
          </div>
        `;
        el('pdfResult').style.display = 'block';
        // Refresh Hisaab if transactions were added
        if (data.added > 0 && typeof window.refreshHisaab === 'function') {
          window.refreshHisaab();
        }
      } catch (err) {
        const errEl = el('pdfModalError');
        errEl.textContent = err.message || 'Upload failed. Please try again.';
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Upload & Parse';
      }
    });
  });

  /* ------------------------------------------- Daily AI Insights: schedule

     The Schedule button used to click #btnOpenEditProfile, which opened the
     whole profile form — the frequency select happened to live there because
     `profiles.insights_schedule` is a profile column. That is a storage detail,
     not a reason to make someone open Edit Profile to change when they read
     their insight, and the form had no time field or off switch at all.

     This opens a dialog with exactly the three settings the scheduler reads,
     saved through PUT /home/insight-schedule. The section itself is untouched:
     same markup, same insight, same place on the page. */

  const FREQ_LABELS = {
    hourly:   'Every hour',
    daily:    'Every day',
    weekdays: 'Weekdays (Mon-Fri)',
    weekly:   'Every week (Monday)',
  };

  const schedState = { loaded: false, saving: false };

  function schedEls() {
    return {
      modal:   el('ovSchedModal'),
      time:    el('ovSchedTime'),
      freq:    el('ovSchedFreq'),
      enabled: el('ovSchedEnabled'),
      summary: el('ovSchedSummary'),
      note:    el('ovSchedNote'),
      save:    el('ovSchedSave'),
    };
  }

  /** "Every day at 08:00", in the 12-hour form the button's example used. */
  function schedSummaryText(freq, time, enabled) {
    if (!enabled) return 'Insights will not be generated on a schedule';
    const label = FREQ_LABELS[freq] || FREQ_LABELS.daily;
    if (freq === 'hourly') return `${label}`;
    const [h, m] = String(time || '09:00').split(':');
    const hour = Number(h);
    const suffix = hour < 12 ? 'AM' : 'PM';
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${label} at ${h12}:${m} ${suffix}`;
  }

  function schedRefreshSummary() {
    const e = schedEls();
    if (!e.summary) return;
    e.summary.textContent = schedSummaryText(
      e.freq && e.freq.value, e.time && e.time.value, e.enabled && e.enabled.checked
    );
  }

  function schedNote(message, isError) {
    const e = schedEls();
    if (!e.note) return;
    if (!message) { e.note.hidden = true; return; }
    e.note.textContent = message;
    e.note.classList.toggle('is-error', !!isError);
    e.note.hidden = false;
  }

  function schedClose() {
    const e = schedEls();
    if (e.modal) e.modal.hidden = true;
  }

  async function schedOpen() {
    const e = schedEls();
    if (!e.modal) return;
    e.modal.hidden = false;
    schedNote('');

    try {
      const s = await window.api.insightSchedule.get();

      // Options come from the server's own list, so the dialog cannot offer a
      // frequency the scheduler has no branch for.
      if (e.freq) {
        const options = (s.frequencies && s.frequencies.length)
          ? s.frequencies : Object.keys(FREQ_LABELS);
        e.freq.innerHTML = options.map(f =>
          `<option value="${esc(f)}"${f === s.frequency ? ' selected' : ''}>${esc(FREQ_LABELS[f] || f)}</option>`
        ).join('');
      }
      if (e.time) e.time.value = s.time || '09:00';
      if (e.enabled) e.enabled.checked = s.enabled !== false;
      schedState.loaded = true;
      schedRefreshSummary();
    } catch (err) {
      schedNote('Could not load your schedule. Close and try again.', true);
    }
  }

  async function schedSave() {
    const e = schedEls();
    if (schedState.saving) return;
    schedState.saving = true;
    if (e.save) { e.save.disabled = true; e.save.textContent = 'Saving…'; }

    try {
      await window.api.insightSchedule.save({
        enabled:   e.enabled ? e.enabled.checked : true,
        frequency: e.freq ? e.freq.value : 'daily',
        time:      e.time ? e.time.value : '09:00',
      });

      // Generate once now, so saving a schedule has something to show for
      // itself immediately rather than only at the next matching time. Best
      // effort: the preference is already saved, and a failure here should not
      // read as "your schedule did not save".
      let refreshed = false;
      if (e.enabled && e.enabled.checked) {
        try {
          const r = await window.api.insightSchedule.runNow();
          refreshed = !!(r && r.generated);
        } catch (err) { /* the scheduled run will still happen */ }
      }

      schedNote(refreshed
        ? 'Saved. Your insight for today has been refreshed.'
        : 'Saved.', false);

      // Pull the section down again so the new insight is on screen without a
      // reload. load() is this module's own refresh, so nothing else re-renders.
      if (refreshed) { try { await load(); } catch (err) { /* keep the dialog honest */ } }

      setTimeout(schedClose, 900);
    } catch (err) {
      schedNote('Could not save your schedule. Please try again.', true);
    } finally {
      schedState.saving = false;
      if (e.save) { e.save.disabled = false; e.save.textContent = 'Save schedule'; }
    }
  }

  function wireSchedule() {
    const e = schedEls();
    if (!e.modal) return;

    e.modal.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-sched-close]')) schedClose();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.modal.hidden) schedClose();
    });

    ['change', 'input'].forEach(evt => {
      if (e.freq) e.freq.addEventListener(evt, schedRefreshSummary);
      if (e.time) e.time.addEventListener(evt, schedRefreshSummary);
      if (e.enabled) e.enabled.addEventListener(evt, schedRefreshSummary);
    });

    if (e.save) e.save.addEventListener('click', schedSave);

    // Delegated: the Daily AI Insights header is re-rendered on every load(),
    // so a handler bound to the button itself would not survive a refresh.
    document.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-dh-schedule]')) {
        ev.preventDefault();
        schedOpen();
      }
    });
  }

  wireSchedule();

  // Expose budget loader so init() can call it
  window.loadBudgets = loadBudgets;

})();
