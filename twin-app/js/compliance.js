/* ==========================================================================
   TWIN — Startup: Compliance Center

   Renders GET /startup/compliance. Due dates, penalties and liability
   estimates all come from the backend; this file formats, filters, and
   records what the founder tells it about each deadline (filed, not
   applicable, the amount due) through PUT/DELETE /startup/compliance/filings.

   Reuses escapeHtml from app.js, loaded before this file.
   ========================================================================== */

(function () {
  'use strict';

  let lastPayload = null;
  let wired = false;
  let filterCategory = 'all';
  let filterStatus = 'actionable';   // actionable = overdue + due_soon + upcoming
  let openForm = null;               // { entryId, kind: 'filed' | 'amount' }
  let busy = false;

  const $ = id => document.getElementById(id);

  const STATUS_LABEL = {
    overdue: 'Overdue',
    due_soon: 'Due soon',
    upcoming: 'Upcoming',
    before_tracking: 'Before tracking',
    filed: 'Filed',
    filed_late: 'Filed late',
    not_applicable: 'Not applicable'
  };
  const ACTIONABLE = ['overdue', 'due_soon', 'upcoming'];
  const RECORDED = ['filed', 'filed_late', 'not_applicable'];

  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  function rupees(v) {
    if (v === null || v === undefined) return '—';
    // The rupee sign, matching every other money surface in the product.
    return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function findEntry(id) {
    return lastPayload ? lastPayload.calendar.entries.find(e => e.id === id) : null;
  }

  function dueLabel(entry) {
    const d = entry.days_until;
    if (entry.status === 'filed' || entry.status === 'filed_late') {
      return entry.filing && entry.filing.filed_on ? `Filed on ${entry.filing.filed_on}` : 'Filed';
    }
    if (entry.status === 'not_applicable') return 'Marked not applicable';
    if (entry.status === 'before_tracking') return 'Predates your tracking start';
    if (d === 0) return 'Due today';
    if (d > 0) return `In ${plural(d, 'day')}`;
    return `${plural(Math.abs(d), 'day')} ago`;
  }

  function amountMeta(entry) {
    if (entry.amount === null || entry.amount === undefined) return '';
    return entry.amount_source === 'entered'
      ? ` &middot; amount ${rupees(entry.amount)} (entered)`
      : ` &middot; est. ${rupees(entry.amount)}`;
  }

  function penaltyHtml(p, entry) {
    if (!p) return '';
    const filedLate = entry.status === 'filed_late';
    const parts = (p.components || []).map(c =>
      `<li>${escapeHtml(c.label)}: <b>${rupees(c.amount)}</b> <span style="color:var(--ink-faint);">(${escapeHtml(c.basis)})</span></li>`
    ).join('');

    let head;
    if (!p.computable) {
      head = `A penalty applies, but it cannot be computed without the figure below.`;
    } else if (filedLate) {
      head = `Incurred by filing ${plural(p.days_late, 'day')} late: <b>${rupees(p.total)}</b>.`;
    } else {
      head = `Accrued exposure: <b>${rupees(p.total)}</b> after ${plural(p.days_late, 'day')}` +
        (p.complete ? '.' : ' — at least, as part of it cannot be computed yet.');
    }

    const missing = (p.missing_inputs || []).length
      ? `<div style="margin-top:6px;">Needs: ${p.missing_inputs.map(escapeHtml).join('; ')}.</div>`
      : '';
    const estimateNote = p.uses_estimate
      ? `<div style="margin-top:4px; color:var(--ink-faint);">Interest uses the amount estimated from your transactions. Enter the actual amount for an exact figure.</div>`
      : '';

    return `
      <div class="cmp-penalty">
        ${head}
        ${parts ? `<ul style="margin:6px 0 0 18px; padding:0;">${parts}</ul>` : ''}
        ${missing}
        ${estimateNote}
        <div style="margin-top:6px; color:var(--ink-faint);">${escapeHtml(p.note)}</div>
        ${p.uncapped ? `<div style="margin-top:4px; color:var(--warn);">This fee has no upper cap — it keeps growing until filed.</div>` : ''}
      </div>`;
  }

  function actionsHtml(entry) {
    const id = escapeHtml(entry.id);
    if (RECORDED.includes(entry.status)) {
      return `
        <div class="cmp-actions">
          ${entry.amount_label ? `<button type="button" class="cmp-act" data-act="amount" data-id="${id}">${entry.amount_source === 'entered' ? 'Edit amount' : 'Enter amount'}</button>` : ''}
          <button type="button" class="cmp-act" data-act="undo" data-id="${id}">Undo</button>
        </div>`;
    }
    return `
      <div class="cmp-actions">
        <button type="button" class="cmp-act cmp-act--primary" data-act="filed" data-id="${id}">Mark filed</button>
        <button type="button" class="cmp-act" data-act="na" data-id="${id}">Not applicable</button>
        ${entry.amount_label ? `<button type="button" class="cmp-act" data-act="amount" data-id="${id}">${entry.amount_source === 'entered' ? 'Edit amount' : 'Enter amount'}</button>` : ''}
        ${entry.filing ? `<button type="button" class="cmp-act" data-act="undo" data-id="${id}">Clear</button>` : ''}
      </div>`;
  }

  function formHtml(entry) {
    if (!openForm || openForm.entryId !== entry.id) return '';
    const id = escapeHtml(entry.id);
    const currentAmount = entry.amount_source === 'entered' ? entry.amount : '';
    const amountField = entry.amount_label ? `
      <label class="cmp-form__field">
        <span>${escapeHtml(entry.amount_label)} (optional)</span>
        <input type="number" min="0" step="any" class="ob-input" data-field="amount" value="${currentAmount}">
      </label>` : '';

    if (openForm.kind === 'filed') {
      const due = entry.due_date;
      const today = todayIso();
      const defaultDate = due < today ? due : today;
      return `
        <div class="cmp-form" data-form-for="${id}">
          <label class="cmp-form__field">
            <span>Filed on</span>
            <input type="date" class="ob-input" data-field="filed_on" value="${defaultDate}" max="${today}">
          </label>
          ${amountField}
          <div class="cmp-form__buttons">
            <button type="button" class="cmp-act cmp-act--primary" data-act="save-filed" data-id="${id}">Save</button>
            <button type="button" class="cmp-act" data-act="cancel" data-id="${id}">Cancel</button>
          </div>
          <p class="cmp-form__hint">A date after ${escapeHtml(due)} records it as filed late, with the fee that incurred.</p>
        </div>`;
    }
    return `
      <div class="cmp-form" data-form-for="${id}">
        ${amountField.replace(' (optional)', '')}
        <div class="cmp-form__buttons">
          <button type="button" class="cmp-act cmp-act--primary" data-act="save-amount" data-id="${id}">Save</button>
          <button type="button" class="cmp-act" data-act="cancel" data-id="${id}">Cancel</button>
        </div>
        <p class="cmp-form__hint">Used as the base for interest in place of the estimate. Enter 0 for a nil return.</p>
      </div>`;
  }

  function rowHtml(entry) {
    const d = new Date(entry.due_date + 'T00:00:00');
    return `
      <div class="cmp-row" data-entry="${escapeHtml(entry.id)}">
        <div class="cmp-row__date">
          <div class="cmp-row__day">${d.getDate()}</div>
          <div class="cmp-row__mon">${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}</div>
        </div>
        <div class="cmp-row__body">
          <div class="cmp-row__title">
            <span>${escapeHtml(entry.label)}</span>
            <span class="cmp-chip cmp-chip--cat">${escapeHtml(entry.category)}</span>
            <span class="cmp-chip cmp-chip--${entry.status}">${STATUS_LABEL[entry.status] || entry.status}</span>
          </div>
          <div class="cmp-row__desc">${escapeHtml(entry.description)}</div>
          <div class="cmp-row__meta">
            ${escapeHtml(entry.period)} &middot; ${escapeHtml(entry.authority)} &middot; ${dueLabel(entry)}${amountMeta(entry)}
          </div>
          ${penaltyHtml(entry.penalty, entry)}
          ${actionsHtml(entry)}
          ${formHtml(entry)}
        </div>
      </div>`;
  }

  function applyFilters(entries) {
    return entries.filter(e => {
      if (filterCategory !== 'all' && e.category !== filterCategory) return false;
      if (filterStatus === 'actionable') return ACTIONABLE.includes(e.status);
      if (filterStatus === 'all') return true;
      return e.status === filterStatus;
    });
  }

  function renderList() {
    if (!lastPayload) return;
    const rows = applyFilters(lastPayload.calendar.entries);
    $('cmpList').innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : `<p class="empty-note">Nothing matches this filter.</p>`;
    $('cmpListCount').textContent = `${rows.length} shown`;

    const bulk = $('btnCmpMarkAllFiled');
    if (bulk) {
      const n = lastPayload.calendar.counts.overdue;
      bulk.hidden = !n;
      bulk.textContent = `Mark ${plural(n, 'overdue filing')} as filed on time`;
    }
  }

  function renderNext() {
    const c = lastPayload.calendar;
    $('cmpNext').innerHTML = c.next_up.length
      ? c.next_up.map(rowHtml).join('')
      : `<p class="empty-note">Nothing due in the rest of this financial year.</p>`;
  }

  function gstTableHtml(gst) {
    if (gst.status === 'insufficient_data') {
      return `<p class="empty-note">No transactions are recorded for this year, so there is nothing to estimate.</p>`;
    }
    const excluded = (gst.excluded_income || []).map(x =>
      `<tr><td>${escapeHtml(x.category)}</td><td class="num">${rupees(x.amount)}</td><td>${escapeHtml(x.reason)}</td></tr>`).join('');
    const blocked = (gst.blocked_credit || []).map(x =>
      `<tr><td>${escapeHtml(x.category)}</td><td class="num">${rupees(x.amount)}</td><td>${escapeHtml(x.reason)}</td></tr>`).join('');

    return `
      <div class="cmp-scroll">
        <table class="cmp-table">
          <tbody>
            <tr><td>Taxable turnover</td><td class="num">${rupees(gst.taxable_turnover)}</td></tr>
            <tr><td>Output GST @ ${gst.rate_pct}% (amounts read as ${escapeHtml(gst.amounts_are)})</td><td class="num">${rupees(gst.output_gst)}</td></tr>
            <tr><td>Eligible inward supplies</td><td class="num">${rupees(gst.itc_base)}</td></tr>
            <tr><td>Input tax credit</td><td class="num">-${rupees(gst.input_credit)}</td></tr>
            <tr class="is-total"><td>Estimated net payable for the year</td><td class="num">${rupees(gst.net_payable)}</td></tr>
            <tr class="is-total"><td>Monthly average (over ${plural(gst.months_of_data, 'month')} of data)</td><td class="num">${rupees(gst.monthly_average)}</td></tr>
          </tbody>
        </table>
      </div>
      ${excluded ? `<h4 style="margin:18px 0 6px; font-size:13px;">Income excluded from turnover</h4>
        <div class="cmp-scroll"><table class="cmp-table">
          <thead><tr><th>Category</th><th class="num">Amount</th><th>Why excluded</th></tr></thead>
          <tbody>${excluded}</tbody></table></div>` : ''}
      ${blocked ? `<h4 style="margin:18px 0 6px; font-size:13px;">Spend with no input tax credit</h4>
        <div class="cmp-scroll"><table class="cmp-table">
          <thead><tr><th>Category</th><th class="num">Amount</th><th>Why blocked</th></tr></thead>
          <tbody>${blocked}</tbody></table></div>` : ''}
      <div class="note-block" style="margin-top:16px;">
        <b>Assumptions behind this estimate</b>
        <ul>${(gst.assumptions || []).map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
      </div>`;
  }

  function tdsTableHtml(tds) {
    if (tds.status === 'insufficient_data') {
      return `<p class="empty-note">No spend is recorded for this year yet, so there is nothing to estimate.</p>`;
    }
    const lines = (tds.lines || []).map(l => `
      <tr>
        <td>${escapeHtml(l.category)}</td>
        <td>${escapeHtml(l.section)}</td>
        <td class="num">${l.rate_pct}%</td>
        <td class="num">${rupees(l.spend)}</td>
        <td class="num">${rupees(l.tds)}</td>
        <td>${escapeHtml(l.note)}</td>
      </tr>`).join('');

    const notEstimated = (tds.not_estimated || []).map(n => `
      <div class="note-block" style="margin-top:12px;">
        <b>${escapeHtml(n.label)} — not estimated</b>
        <p style="margin:6px 0;">${escapeHtml(n.reason)}</p>
        <p style="margin:6px 0 0;">Payroll recorded this year: <b>${rupees(n.payroll_spend)}</b></p>
        <ul>${(n.missing_inputs || []).map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
      </div>`).join('');

    return `
      <div class="cmp-scroll">
        <table class="cmp-table">
          <thead><tr>
            <th>Category</th><th>Section</th><th class="num">Rate</th>
            <th class="num">Spend</th><th class="num">TDS</th><th>Status</th>
          </tr></thead>
          <tbody>
            ${lines}
            <tr class="is-total"><td colspan="4">Estimated TDS for the year</td><td class="num">${rupees(tds.total)}</td><td></td></tr>
          </tbody>
        </table>
      </div>
      ${notEstimated}
      <div class="note-block" style="margin-top:16px;">
        <b>Assumptions</b>
        <ul>${(tds.assumptions || []).map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
      </div>`;
  }

  function render(data) {
    lastPayload = data;
    const c = data.calendar;
    const k = c.counts;

    /* ---- Summary tiles ---- */
    const exposureSub = [];
    if (c.penalty_incomplete_count) {
      exposureSub.push(`${plural(c.penalty_incomplete_count, 'overdue item')} need an amount to compute in full`);
    } else {
      exposureSub.push('Accruing on unfiled deadlines');
    }
    if (c.penalty_incurred_total > 0) {
      exposureSub.push(`${rupees(c.penalty_incurred_total)} incurred on late filings`);
    }
    $('cmpSummary').innerHTML = `
      <div class="cmp-tile">
        <span class="cmp-tile__label">Overdue</span>
        <span class="cmp-tile__value ${k.overdue ? 'tone-critical' : 'tone-good'}">${k.overdue}</span>
        <span class="cmp-tile__sub">${k.filed + k.filed_late} filed &middot; ${k.before_tracking} predate tracking</span>
      </div>
      <div class="cmp-tile">
        <span class="cmp-tile__label">Due in 15 days</span>
        <span class="cmp-tile__value ${k.due_soon ? 'tone-warn' : 'tone-good'}">${k.due_soon}</span>
        <span class="cmp-tile__sub">${k.upcoming} later this year</span>
      </div>
      <div class="cmp-tile">
        <span class="cmp-tile__label">Penalty exposure</span>
        <span class="cmp-tile__value ${c.penalty_exposure_total > 0 ? 'tone-critical' : 'tone-good'}">${rupees(c.penalty_exposure_total)}</span>
        <span class="cmp-tile__sub">${exposureSub.map(escapeHtml).join(' &middot; ')}</span>
      </div>
      <div class="cmp-tile">
        <span class="cmp-tile__label">Est. GST this year</span>
        <span class="cmp-tile__value">${rupees(data.liabilities.gst.net_payable)}</span>
        <span class="cmp-tile__sub">${data.gstin ? escapeHtml(data.gstin) : 'No GSTIN on file'}</span>
      </div>`;

    renderNext();

    /* ---- Category filter options, driven by what actually exists ---- */
    const cats = Object.keys(k.by_category || {});
    const catSel = $('cmpCategory');
    if (catSel) {
      catSel.innerHTML = `<option value="all">All categories</option>` +
        cats.map(key => `<option value="${escapeHtml(key)}">${escapeHtml(key)} (${k.by_category[key]})</option>`).join('');
      catSel.value = cats.includes(filterCategory) ? filterCategory : 'all';
      filterCategory = catSel.value;
    }

    renderList();

    /* ---- Liabilities ---- */
    $('cmpGst').innerHTML = gstTableHtml(data.liabilities.gst);
    $('cmpTds').innerHTML = tdsTableHtml(data.liabilities.tds);

    /* ---- Registration check ---- */
    const reg = data.registration;
    $('cmpRegistration').innerHTML = `
      <div class="note-block ${reg.required === true ? 'tone-warn' : ''}">
        ${escapeHtml(reg.message)}
      </div>`;

    /* ---- What does not apply, and why ---- */
    const na = c.not_applicable || [];
    $('cmpNotApplicable').innerHTML = na.length
      ? `<ul class="alert-list">` + na.map(s =>
          `<li><b>${escapeHtml(s.label)}</b> (${escapeHtml(s.category)}) — ${escapeHtml(s.reason)}</li>`).join('') + `</ul>`
      : `<p class="empty-note">Every obligation in the register applies to you.</p>`;

    /* ---- Disclaimer ---- */
    $('cmpDisclaimer').innerHTML = `<div class="note-block">${escapeHtml(data.disclaimer)}</div>`;

    /* ---- Year selector ---- */
    const ySel = $('cmpYear');
    if (ySel && !ySel.options.length) {
      ySel.innerHTML = (data.available_years || [data.fy]).map(y =>
        `<option value="${y}"${y === data.fy ? ' selected' : ''}>${y}</option>`).join('');
    }
    $('cmpTrackingNote').textContent =
      `Tracking this company from ${c.tracking_start}. Deadlines before that date are shown for context only. ` +
      `Mark each filing as filed when it is done, so overdue means genuinely unfiled.`;
  }

  async function load() {
    const host = $('cmpSummary');
    if (!host) return;
    if (!lastPayload) host.innerHTML = `<p class="empty-note">Loading compliance calendar…</p>`;
    try {
      const fy = ($('cmpYear') || {}).value || null;
      const amountsAre = ($('cmpAmountsAre') || {}).value || 'inclusive';
      const data = await window.api.fetchCompliance(fy, amountsAre);
      render(data);
    } catch (err) {
      console.error('Compliance load failed:', err);
      host.innerHTML = `<p class="empty-note">Could not load the compliance calendar. ${escapeHtml(err.message || '')}</p>`;
      ['cmpNext', 'cmpList', 'cmpGst', 'cmpTds', 'cmpRegistration', 'cmpNotApplicable', 'cmpDisclaimer']
        .forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
    }
  }

  /* ---------- Recording filings ---------- */

  async function save(filings, button) {
    if (busy) return;
    busy = true;
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    try {
      await window.api.saveComplianceFilings(filings);
      openForm = null;
      await load();
    } catch (err) {
      alert(err.message || 'Could not save.');
      if (button) { button.disabled = false; button.textContent = 'Save'; }
    } finally {
      busy = false;
    }
  }

  // Read the form the Save button belongs to. An entry can appear both under
  // "Next up" and in the full calendar, so looking it up by id alone could read
  // the other, untouched copy.
  function readForm(btn) {
    const form = btn.closest('.cmp-form');
    const get = f => { const el = form && form.querySelector(`[data-field="${f}"]`); return el ? el.value : ''; };
    const amountRaw = get('amount');
    return {
      filed_on: get('filed_on') || null,
      amount: amountRaw === '' ? null : Number(amountRaw)
    };
  }

  async function onAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const entry = findEntry(btn.dataset.id);
    if (!entry) return;
    const base = { obligation_id: entry.obligation_id, due_date: entry.due_date };

    switch (btn.dataset.act) {
      case 'filed':
      case 'amount':
        openForm = { entryId: entry.id, kind: btn.dataset.act };
        renderNext();
        renderList();
        break;
      case 'cancel':
        openForm = null;
        renderNext();
        renderList();
        break;
      case 'na':
        await save([Object.assign(base, { status: 'not_applicable' })], btn);
        break;
      case 'save-filed': {
        const f = readForm(btn);
        if (f.amount !== null && (isNaN(f.amount) || f.amount < 0)) { alert('Enter a non-negative amount.'); return; }
        await save([Object.assign(base, { status: 'filed', filed_on: f.filed_on, amount: f.amount })], btn);
        break;
      }
      case 'save-amount': {
        const f = readForm(btn);
        if (f.amount === null || isNaN(f.amount) || f.amount < 0) { alert('Enter a non-negative amount.'); return; }
        const existing = entry.filing || {};
        await save([Object.assign(base, {
          status: existing.status || 'pending',
          filed_on: existing.filed_on || null,
          amount: f.amount
        })], btn);
        break;
      }
      case 'undo':
        if (busy) return;
        busy = true;
        btn.disabled = true;
        try {
          await window.api.deleteComplianceFiling(entry.obligation_id, entry.due_date);
          openForm = null;
          await load();
        } catch (err) {
          alert(err.message || 'Could not undo.');
          btn.disabled = false;
        } finally {
          busy = false;
        }
        break;
    }
  }

  async function markAllOverdueFiled(e) {
    if (!lastPayload) return;
    const overdue = lastPayload.calendar.overdue || [];
    if (!overdue.length) return;
    const ok = confirm(
      `Mark ${plural(overdue.length, 'overdue filing')} as filed on their due dates?\n\n` +
      `Only do this if they were genuinely filed on time. You can undo each one individually.`);
    if (!ok) return;
    await save(overdue.map(entry => ({
      obligation_id: entry.obligation_id,
      due_date: entry.due_date,
      status: 'filed',
      filed_on: entry.due_date
    })), e.currentTarget);
  }

  function wire() {
    if (wired) return;
    wired = true;
    const cat = $('cmpCategory');
    const stat = $('cmpStatus');
    const year = $('cmpYear');
    const amounts = $('cmpAmountsAre');
    if (cat) cat.addEventListener('change', () => { filterCategory = cat.value; renderList(); });
    if (stat) stat.addEventListener('change', () => { filterStatus = stat.value; renderList(); });
    if (year) year.addEventListener('change', () => { openForm = null; load(); });
    if (amounts) amounts.addEventListener('change', load);
    const btn = $('btnRefreshCompliance');
    if (btn) btn.addEventListener('click', load);
    const bulk = $('btnCmpMarkAllFiled');
    if (bulk) bulk.addEventListener('click', markAllOverdueFiled);
    const view = $('view-compliance');
    if (view) view.addEventListener('click', onAction);
  }

  window.complianceView = {
    render: () => { wire(); load(); },
    reload: load,
    last: () => lastPayload
  };
})();
