/* ==========================================================================
   TWIN — Startup: GST Calculator

   Posts to /startup/gst/calculate on every change and renders what comes
   back. No rate, threshold or formula is hardcoded here — the slab list, the
   supply types and the scheme rules all arrive from /startup/gst/config, the
   same contract tax.js holds with /tax/config.

   Reuses escapeHtml from app.js.
   ========================================================================== */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  let config = null;
  let lines = [];
  let nextLineId = 1;
  let wired = false;
  let debounceTimer = null;
  let lastResult = null;
  // Once the founder picks a rate structure by hand, that choice is sent as-is
  // and the invoice date only produces a warning if they disagree. Until then
  // the backend chooses the structure from the invoice date.
  let structureTouched = false;

  /* ---------- Formatting ---------- */
  function inr(v) {
    if (v === null || v === undefined) return '—';
    return '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function inr0(v) {
    if (v === null || v === undefined) return '—';
    return '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };


  /* ---------- Inline field help ----------
     Mirrors renderFieldHelp() in tax.js: a small "?" beside a control that
     toggles a tooltip. Text comes from config.field_guidance, so adding a
     field means adding a config entry and nothing here. */
  function helpButtonHtml(key) {
    const text = (config && config.field_guidance && config.field_guidance[key]) || '';
    if (!text) return '';
    // Same "i" as the invoice-table column headings, so every help control on
    // the page looks and reads the same.
    return `<button type="button" class="gst-help gst-help--info" data-help="${escapeHtml(key)}"
              aria-label="What is this?" title="What is this?">i</button>`;
  }

  function closeHelp() {
    document.querySelectorAll('#view-gst .gst-help-tip').forEach(el => el.remove());
    document.querySelectorAll('#view-gst [data-line-help].is-open').forEach(el => el.classList.remove('is-open'));
    const box = $('gstLineHelp');
    if (box) box.dataset.key = '';
  }

  /* ---------- Column help on the invoice table ----------
     An "i" beside each column heading. The explanation opens in a panel under
     the table rather than inside the header cell, because the table sits in a
     horizontally scrolling wrapper that would clip a tooltip. Text comes from
     config.field_guidance, keyed by each <th data-help-key>. */
  function decorateLineHeaders() {
    document.querySelectorAll('#view-gst th[data-help-key]').forEach(th => {
      if (th.dataset.helped) return;
      const text = (config.field_guidance || {})[th.dataset.helpKey];
      if (!text) return;
      th.dataset.helped = '1';
      const label = th.textContent.trim();
      th.insertAdjacentHTML('beforeend',
        `<button type="button" class="gst-help gst-help--info" data-line-help="${escapeHtml(th.dataset.helpKey)}"
           data-label="${escapeHtml(label)}" aria-label="About ${escapeHtml(label)}" title="About ${escapeHtml(label)}">i</button>`);
    });
  }

  function toggleLineHelp(btn) {
    const box = $('gstLineHelp');
    if (!box) return;
    const key = btn.dataset.lineHelp;
    const wasOpen = box.dataset.key === key;
    closeHelp();
    if (wasOpen) return;
    box.dataset.key = key;
    btn.classList.add('is-open');
    const tip = document.createElement('div');
    tip.className = 'gst-help-tip gst-line-help';
    const title = document.createElement('b');
    title.textContent = btn.dataset.label;
    tip.append(title, document.createTextNode(' — ' + ((config.field_guidance || {})[key] || '')));
    box.appendChild(tip);
  }

  function attachHelp(root) {
    root.querySelectorAll('.gst-help').forEach(btn => {
      // Column-heading buttons open the panel under the table instead.
      if (btn.dataset.wired || btn.dataset.lineHelp) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const open = btn.nextElementSibling && btn.nextElementSibling.classList.contains('gst-help-tip');
        closeHelp();
        if (open) return;
        const text = (config.field_guidance || {})[btn.dataset.help] || '';
        const tip = document.createElement('div');
        tip.className = 'gst-help-tip';
        tip.textContent = text;
        btn.insertAdjacentElement('afterend', tip);
      });
    });
  }

  /* Label a control that already exists in the markup, adding its help button
     once. Keeps the HTML free of per-field copy. */
  function decorateControl(id, key) {
    const el = $(id);
    if (!el || el.dataset.helped) return;
    el.dataset.helped = '1';
    const btn = helpButtonHtml(key || id);
    if (btn) el.insertAdjacentHTML('afterend', btn);
  }

  /* ---------- Line model ---------- */
  function blankLine() {
    return {
      id: nextLineId++,
      description: '',
      hsn_sac: '',
      amount: '',
      quantity: 1,
      rate: config ? config.default_rate : 18,
      cess_rate: 0,
      discount: 0,
      reverse_charge: false
    };
  }

  function rateOptions(selected) {
    const structure = $('gstStructure') ? $('gstStructure').value : config.default_rate_structure;
    const slabs = (config.rate_structures[structure] || {}).slabs || [];
    const known = slabs.map(s =>
      `<option value="${s.rate}"${Number(selected) === s.rate ? ' selected' : ''}>${s.rate}%</option>`).join('');
    // Preserve a hand-typed rate that is not a slab, so switching structures
    // never silently rewrites the user's number.
    const isKnown = slabs.some(s => s.rate === Number(selected));
    const custom = isKnown ? '' : `<option value="${selected}" selected>${selected}% (custom)</option>`;
    return known + custom;
  }

  function lineRowHtml(l) {
    return `
      <tr data-line="${l.id}">
        <td><input class="gst-in" data-f="description" type="text" placeholder="Item or service"
              value="${escapeHtml(l.description)}"></td>
        <td><input class="gst-in gst-in--sm" data-f="hsn_sac" type="text" placeholder="HSN/SAC"
              value="${escapeHtml(l.hsn_sac)}"></td>
        <td><input class="gst-in gst-in--num" data-f="quantity" type="number" min="0" step="any"
              value="${l.quantity}"></td>
        <td><input class="gst-in gst-in--num" data-f="amount" type="number" min="0" step="any"
              placeholder="0" value="${l.amount}"></td>
        <td><select class="gst-in gst-in--sm" data-f="rate">${rateOptions(l.rate)}</select></td>
        <td><input class="gst-in gst-in--num" data-f="cess_rate" type="number" min="0" step="any"
              value="${l.cess_rate}"></td>
        <td><input class="gst-in gst-in--num" data-f="discount" type="number" min="0" step="any"
              value="${l.discount}"></td>
        <td style="text-align:center;"><input data-f="reverse_charge" type="checkbox"
              ${l.reverse_charge ? 'checked' : ''} title="${escapeHtml(rcmTitle())}"></td>
        <td style="text-align:right;">
          <button class="gst-del" data-del="${l.id}" title="Remove line" type="button">&times;</button>
        </td>
      </tr>`;
  }

  /* Who owes reverse-charge tax depends on the supply type: your customer for
     a line on your own invoice, you for an import of services. The wording
     comes from config.rcm_payer_notes. */
  function rcmTitle() {
    if (!config || !config.rcm_payer_notes) return 'Reverse charge';
    const supply = $('gstSupply') ? (config.supply_types[$('gstSupply').value] || {}) : {};
    const payer = supply.force_rcm ? 'you' : 'recipient';
    return (config.rcm_payer_notes[payer] || {}).line || 'Reverse charge';
  }

  function renderLines() {
    $('gstLines').innerHTML = lines.map(lineRowHtml).join('');
    const head = $('gstRcmHead');
    if (head) head.title = rcmTitle();
  }

  /* ---------- Read the form ---------- */
  function buildRequest() {
    const invoiceDate = ($('gstInvoiceDate') || {}).value || null;
    return {
      mode: $('gstMode').value,
      supply_type: $('gstSupply').value,
      // With an invoice date and no hand-picked structure, let the backend
      // choose the structure that was in force on that date.
      rate_structure: (invoiceDate && !structureTouched) ? null : $('gstStructure').value,
      invoice_date: invoiceDate,
      lines: lines.map(l => ({
        description: l.description || null,
        hsn_sac: l.hsn_sac || null,
        amount: num(l.amount),
        quantity: num(l.quantity) || 1,
        rate: num(l.rate),
        cess_rate: num(l.cess_rate),
        discount: num(l.discount),
        reverse_charge: !!l.reverse_charge
      })),
      input_tax_credit: num($('gstItc').value),
      composition_category: $('gstComposition').value || null,
      annual_turnover: $('gstTurnover').value === '' ? null : num($('gstTurnover').value),
      business_type: $('gstBusinessType').value,
      special_category_state: $('gstSpecialState').checked,
      gstin: (($('gstGstinInput') || {}).value || '').trim().toUpperCase() || null
    };
  }

  /* ---------- Render results ---------- */
  function totalsHtml(res) {
    const t = res.totals;
    const isInter = res.supply_type === 'inter_state';
    const rows = [
      ['Gross value', t.gross],
      t.discount ? ['Less discount', -t.discount] : null,
      ['Taxable value', t.taxable_value],
      isInter ? ['IGST', t.igst] : ['CGST', t.cgst],
      isInter ? null : ['SGST / UTGST', t.sgst],
      t.cess ? ['Compensation cess', t.cess] : null,
      ['Total tax', t.total_tax]
    ].filter(Boolean);

    return `
      <div class="cmp-scroll">
        <table class="cmp-table">
          <tbody>
            ${rows.map(([label, v]) =>
              `<tr><td>${escapeHtml(label)}</td><td class="num">${inr(v)}</td></tr>`).join('')}
            <tr class="is-total"><td>Invoice total</td><td class="num">${inr(t.total)}</td></tr>
            ${t.rounding_adjustment !== 0 ? `
              <tr><td>Rounding (S.170)</td><td class="num">${inr(t.rounding_adjustment)}</td></tr>
              <tr class="is-total"><td>Rounded total</td><td class="num">${inr0(t.rounded_total)}</td></tr>` : ''}
            ${t.reverse_charge_taxable ? `
              <tr><td colspan="2" style="padding-top:14px; color:var(--ink-faint);">${escapeHtml(t.reverse_charge_label || 'Reverse charge')}</td></tr>
              <tr><td>Taxable value under RCM (included in the invoice total, no tax collected)</td><td class="num">${inr(t.reverse_charge_taxable)}</td></tr>
              <tr><td>Tax under RCM</td><td class="num">${inr(t.reverse_charge_tax)}</td></tr>` : ''}
          </tbody>
        </table>
      </div>
      <p style="font-size:11.5px; color:var(--ink-faint); margin:10px 0 0; font-family:var(--font-mono);">
        ${escapeHtml(res.formula)}
      </p>`;
  }

  function rateSummaryHtml(res) {
    if (!res.rate_summary.length) {
      return `<p class="empty-note">Add a line to see the rate-wise breakup.</p>`;
    }
    const isInter = res.supply_type === 'inter_state';
    return `
      <div class="cmp-scroll">
        <table class="cmp-table">
          <thead><tr>
            <th>Rate</th><th class="num">Taxable value</th>
            ${isInter ? '<th class="num">IGST</th>' : '<th class="num">CGST</th><th class="num">SGST</th>'}
            <th class="num">Cess</th><th class="num">Total tax</th>
          </tr></thead>
          <tbody>
            ${res.rate_summary.map(s => `
              <tr>
                <td>${s.rate}%</td>
                <td class="num">${inr(s.taxable_value)}</td>
                ${isInter ? `<td class="num">${inr(s.igst)}</td>`
                          : `<td class="num">${inr(s.cgst)}</td><td class="num">${inr(s.sgst)}</td>`}
                <td class="num">${inr(s.cess)}</td>
                <td class="num">${inr(s.total_tax)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function netHtml(res) {
    const n = res.net_position;
    return `
      <div class="cmp-scroll">
        <table class="cmp-table">
          <tbody>
            <tr><td>Output tax on outward supplies</td><td class="num">${inr(n.output_tax)}</td></tr>
            <tr><td>Less input tax credit</td><td class="num">-${inr(n.input_tax_credit)}</td></tr>
            ${n.reverse_charge_payable ? `<tr><td>Add reverse-charge tax (payable in cash)</td><td class="num">${inr(n.reverse_charge_payable)}</td></tr>` : ''}
            <tr class="is-total"><td>Net GST payable</td><td class="num">${inr(n.net_payable)}</td></tr>
            ${n.credit_carried_forward ? `<tr><td>Credit carried forward</td><td class="num">${inr(n.credit_carried_forward)}</td></tr>` : ''}
          </tbody>
        </table>
      </div>
      <p style="font-size:12.5px; color:var(--ink-muted); line-height:1.6; margin:10px 0 0;">${escapeHtml(n.note)}</p>`;
  }

  function compositionHtml(res) {
    const c = res.composition;
    if (!c) {
      return `<p class="empty-note">Pick a composition category above to compare it against regular GST.</p>`;
    }
    return `
      <div class="cmp-scroll">
        <table class="cmp-table">
          <tbody>
            <tr><td>Category</td><td class="num">${escapeHtml(c.label)}</td></tr>
            <tr><td>Composition rate</td><td class="num">${c.rate}% (${escapeHtml(c.split)})</td></tr>
            <tr><td>Turnover limit</td><td class="num">${inr0(c.turnover_limit)}</td></tr>
            <tr><td>Turnover used</td><td class="num">${inr0(c.turnover_used)}</td></tr>
            <tr><td>Tax under composition</td><td class="num">${inr(c.composition_tax)}</td></tr>
            <tr><td>Tax under regular GST</td><td class="num">${inr(c.regular_tax)}</td></tr>
            <tr class="is-total"><td>Difference</td><td class="num">${inr(c.difference)}</td></tr>
          </tbody>
        </table>
      </div>
      <p style="font-size:12.5px; color:var(--ink-muted); line-height:1.6; margin:12px 0 0;">
        <span class="${c.eligible ? 'tone-good' : 'tone-critical'}">${c.eligible ? 'Eligible' : 'Not eligible'}</span>
        — ${escapeHtml(c.note)}
      </p>
      <p style="font-size:11.5px; color:var(--ink-faint); line-height:1.6; margin:8px 0 0;">${escapeHtml(c.basis)}</p>
      <div class="note-block" style="margin-top:12px;">
        <b>What you give up under composition</b>
        <ul>${c.restrictions.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      </div>`;
  }


  function supplyNoteHtml(res) {
    const d = res.supply_detail;
    if (!d) return '';
    const chips = [
      `<span class="cmp-chip cmp-chip--cat">${escapeHtml(d.group)}</span>`,
      d.zero_rated ? `<span class="cmp-chip cmp-chip--upcoming">Zero-rated</span>` : '',
      d.credit_allowed
        ? `<span class="cmp-chip cmp-chip--upcoming">Input credit allowed</span>`
        : `<span class="cmp-chip cmp-chip--overdue">No input credit</span>`
    ].filter(Boolean).join(' ');
    return `
      <div class="note-block">
        <div style="margin-bottom:6px;">${chips}</div>
        ${escapeHtml(d.description)}
        ${d.note ? `<div style="margin-top:8px; color:var(--ink);">${escapeHtml(d.note)}</div>` : ''}
      </div>`;
  }

  function applicabilityHtml(res) {
    const a = res.applicability;
    if (!a) return '';
    if (a.status === 'insufficient_data') {
      return `<p class="empty-note">${escapeHtml(a.note)}</p>`;
    }
    const rows = a.rules.map(r => `
      <div class="fr-bench">
        <div class="fr-bench__head">
          <span class="fr-bench__label">${escapeHtml(r.label)}</span>
          <span class="cmp-chip cmp-chip--${r.applies ? 'overdue' : 'upcoming'}">
            ${r.applies ? 'Applies' : 'Does not apply'}
          </span>
        </div>
        <p class="fr-bench__note">${escapeHtml(r.message)}</p>
        <p class="fr-bench__note" style="color:var(--ink-faint);">
          Threshold ${inr0(r.threshold)}${r.sticky ? ' · once crossed, stays applicable' : ''}.
          ${escapeHtml(r.detail)}
        </p>
      </div>`).join('');
    return rows + `
      <div class="note-block" style="margin-top:14px;">
        <b>E-way bill</b> — ${escapeHtml(a.eway_bill.note || '')}
      </div>
      <p style="font-size:11.5px; color:var(--ink-faint); margin:10px 0 0;">${escapeHtml(a.note)}</p>`;
  }

  function gstinResultHtml(g) {
    if (!g) return '';
    if (!g.valid) {
      return `<div class="note-block tone-critical">
          ${(g.errors || []).map(e => `<div style="margin:3px 0;">${escapeHtml(e)}</div>`).join('')}
        </div>`;
    }
    const rows = [
      ['State', `${escapeHtml(g.state)} (${escapeHtml(g.state_code)})${g.special_category_state ? ' · special category' : ''}`],
      ['PAN', escapeHtml(g.pan)],
      ['Entity type', escapeHtml(g.entity_type || '—')],
      ['Registration number in state', escapeHtml(g.registration_number)],
      ['Check digit', `${escapeHtml(g.check_digit)} · verified`]
    ];
    return `
      <div class="note-block tone-good" style="margin-bottom:12px;">Well-formed GSTIN.</div>
      <div class="cmp-scroll"><table class="cmp-table"><tbody>
        ${rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')}
      </tbody></table></div>
      ${(g.warnings || []).length ? `<div class="note-block" style="margin-top:12px;">
        ${g.warnings.map(w => `<div style="margin:3px 0;">${escapeHtml(w)}</div>`).join('')}</div>` : ''}
      <p style="font-size:11.5px; color:var(--ink-faint); margin:10px 0 0;">${escapeHtml(g.note)}</p>`;
  }

  function hsnResultHtml(data) {
    if (!data || !data.results.length) {
      return `<p class="empty-note">Nothing matched. Try a broader word such as "software" or "consulting".</p>`;
    }
    return `
      <div class="cmp-scroll"><table class="cmp-table">
        <thead><tr><th>Code</th><th>Kind</th><th class="num">Rate</th><th>Description</th></tr></thead>
        <tbody>${data.results.map(r => `
          <tr>
            <td style="font-family:var(--font-mono);">${escapeHtml(r.code)}</td>
            <td>${escapeHtml(r.kind)}</td>
            <td class="num">${r.rate}%</td>
            <td>${escapeHtml(r.label)}${r.note ? `<br><span style="color:var(--ink-faint);">${escapeHtml(r.note)}</span>` : ''}</td>
          </tr>`).join('')}
        </tbody></table></div>
      <div class="note-block" style="margin-top:12px;">${escapeHtml(data.disclaimer)}</div>`;
  }

  function filingGuidesHtml() {
    const guides = (config && config.filing_guides) || [];
    if (!guides.length) return '';
    return guides.map(g => `
      <div style="margin-bottom:20px;">
        <h4 style="margin:0 0 4px; font-size:13.5px;">${escapeHtml(g.title)}</h4>
        <p style="font-size:12.5px; color:var(--ink-muted); line-height:1.6; margin:0 0 10px;">${escapeHtml(g.intro)}</p>
        <ol style="margin:0 0 0 18px; padding:0; font-size:12.5px; color:var(--ink-muted);">
          ${g.steps.map(st => `<li style="margin:7px 0;">
            <b style="color:var(--ink);">${escapeHtml(st.title)}</b><br>${escapeHtml(st.body)}
          </li>`).join('')}
        </ol>
      </div>`).join('');
  }

  function render(res) {
    lastResult = res;

    // The backend may have picked the structure from the invoice date. Mirror
    // it in the selector so the slab dropdowns match what was computed.
    const structSel = $('gstStructure');
    if (structSel && res.rate_structure && structSel.value !== res.rate_structure) {
      structSel.value = res.rate_structure;
      renderLines();
    }
    $('gstTotals').innerHTML = totalsHtml(res);
    $('gstRateSummary').innerHTML = rateSummaryHtml(res);
    $('gstNet').innerHTML = netHtml(res);
    $('gstCompositionOut').innerHTML = compositionHtml(res);

    const reg = res.registration;
    $('gstRegistration').innerHTML = reg
      ? `<div class="note-block ${reg.required ? 'tone-warn' : ''}">${escapeHtml(reg.message)}</div>`
      : '';

    $('gstSupplyNote').innerHTML = supplyNoteHtml(res);
    $('gstApplicability').innerHTML = applicabilityHtml(res);
    if (res.gstin_check) $('gstGstinResult').innerHTML = gstinResultHtml(res.gstin_check);

    $('gstWarnings').innerHTML = res.warnings.length
      ? `<div class="note-block">${res.warnings.map(w => `<div style="margin:4px 0;">${escapeHtml(w)}</div>`).join('')}</div>`
      : '';

    $('gstHeadline').innerHTML = `
      <div class="gst-headline">
        <div>
          <span class="gst-headline__label">${escapeHtml(res.mode_label)} · ${escapeHtml(res.supply_type_label)}</span>
          <span class="gst-headline__value">${inr(res.totals.total_tax)}</span>
          <span class="gst-headline__sub">total tax on ${inr(res.totals.taxable_value)} taxable value</span>
        </div>
        <div>
          <span class="gst-headline__label">Net payable after credit</span>
          <span class="gst-headline__value">${inr(res.net_position.net_payable)}</span>
          <span class="gst-headline__sub">${escapeHtml(res.rate_structure_label)}${
            res.rate_structure_basis === 'invoice_date' ? ` · chosen from the invoice date ${escapeHtml(res.invoice_date || '')}` : ''}</span>
        </div>
      </div>`;
  }

  /* ---------- Recalculate ---------- */
  async function recalc() {
    if (!config) return;
    try {
      const res = await window.api.calculateGst(buildRequest());
      render(res);
    } catch (err) {
      console.error('GST calculate failed:', err);
      $('gstWarnings').innerHTML =
        `<div class="note-block tone-critical">Could not calculate. ${escapeHtml(err.message || '')}</div>`;
    }
  }

  function scheduleRecalc() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recalc, 220);
  }

  /* ---------- Wiring ---------- */
  function wire() {
    if (wired) return;
    wired = true;

    const thead = document.querySelector('#view-gst .gst-table thead');
    if (thead) thead.addEventListener('click', e => {
      const btn = e.target.closest('[data-line-help]');
      if (!btn) return;
      e.stopPropagation();   // the document-level click would close it again
      toggleLineHelp(btn);
    });

    // Delegated: the line table is re-rendered wholesale, so listeners live on
    // the container rather than on individual inputs.
    $('gstLines').addEventListener('input', e => {
      const tr = e.target.closest('tr[data-line]');
      if (!tr) return;
      const line = lines.find(l => l.id === Number(tr.dataset.line));
      const field = e.target.dataset.f;
      if (!line || !field) return;
      line[field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      scheduleRecalc();
    });
    $('gstLines').addEventListener('change', e => {
      const tr = e.target.closest('tr[data-line]');
      if (!tr) return;
      const line = lines.find(l => l.id === Number(tr.dataset.line));
      const field = e.target.dataset.f;
      if (!line || !field) return;
      line[field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      scheduleRecalc();
    });
    $('gstLines').addEventListener('click', e => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      lines = lines.filter(l => l.id !== Number(btn.dataset.del));
      if (!lines.length) lines.push(blankLine());
      renderLines();
      recalc();
    });

    $('gstAddLine').addEventListener('click', () => {
      lines.push(blankLine());
      renderLines();
      recalc();
    });
    $('gstClear').addEventListener('click', () => {
      lines = [blankLine()];
      $('gstItc').value = '';
      if ($('gstInvoiceDate')) $('gstInvoiceDate').value = '';
      structureTouched = false;
      renderLines();
      recalc();
    });

    // Changing the rate structure by hand rebuilds each line's slab dropdown
    // and makes that choice stick over the invoice date.
    $('gstStructure').addEventListener('change', () => { structureTouched = true; renderLines(); recalc(); });

    // The supply type changes who owes reverse-charge tax, so the RCM hints change too.
    $('gstSupply').addEventListener('change', renderLines);

    const invoiceDate = $('gstInvoiceDate');
    if (invoiceDate) invoiceDate.addEventListener('change', recalc);


    // GSTIN checker
    const gstinBtn = $('gstGstinCheck');
    if (gstinBtn) gstinBtn.addEventListener('click', async () => {
      const v = ($('gstGstinInput').value || '').trim().toUpperCase();
      try {
        const g = await window.api.checkGstin(v);
        $('gstGstinResult').innerHTML = gstinResultHtml(g);
      } catch (err) {
        $('gstGstinResult').innerHTML =
          `<div class="note-block tone-critical">${escapeHtml(err.message || 'Check failed')}</div>`;
      }
    });
    const gstinInput = $('gstGstinInput');
    if (gstinInput) gstinInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); gstinBtn.click(); }
    });

    // HSN / SAC finder
    const hsnBtn = $('gstHsnSearch');
    async function runHsn() {
      try {
        const data = await window.api.searchHsn($('gstHsnQuery').value);
        $('gstHsnResult').innerHTML = hsnResultHtml(data);
      } catch (err) {
        $('gstHsnResult').innerHTML =
          `<div class="note-block tone-critical">${escapeHtml(err.message || 'Search failed')}</div>`;
      }
    }
    if (hsnBtn) hsnBtn.addEventListener('click', runHsn);
    const hsnInput = $('gstHsnQuery');
    if (hsnInput) hsnInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runHsn(); }
    });

    // Save the working set
    const saveBtn = $('gstSave');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      $('gstSaveState').textContent = 'Saving…';
      try {
        await window.api.saveGstProfile(null, buildRequest());
        $('gstSaveState').textContent = 'Saved';
        setTimeout(() => { $('gstSaveState').textContent = ''; }, 2500);
      } catch (err) {
        $('gstSaveState').textContent = 'Could not save';
        console.error('GST save failed:', err);
      }
    });

    // A click anywhere else dismisses an open help tooltip.
    document.addEventListener('click', closeHelp);

    ['gstMode', 'gstSupply', 'gstItc', 'gstComposition', 'gstTurnover',
     'gstBusinessType', 'gstSpecialState'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('change', scheduleRecalc);
      if (el && el.tagName === 'INPUT') el.addEventListener('input', scheduleRecalc);
    });
  }

  /* ---------- Boot ---------- */
  async function init() {
    if (config) { recalc(); return; }
    try {
      config = await window.api.fetchGstConfig();
    } catch (err) {
      console.error('GST config failed:', err);
      $('gstHeadline').innerHTML =
        `<p class="empty-note">Could not load the GST calculator. ${escapeHtml(err.message || '')}</p>`;
      return;
    }

    // Structure selector
    $('gstStructure').innerHTML = Object.entries(config.rate_structures).map(([k, v]) =>
      `<option value="${k}"${k === config.default_rate_structure ? ' selected' : ''}>${escapeHtml(v.label)}</option>`).join('');

    // Mode and supply selectors
    $('gstMode').innerHTML = Object.entries(config.calc_modes).map(([k, v]) =>
      `<option value="${k}"${k === config.default_calc_mode ? ' selected' : ''}>${escapeHtml(v.label)}</option>`).join('');
    // Grouped by Domestic / Zero-rated / No tax / Reverse charge so the
    // taxonomy reads as a taxonomy rather than a flat list of ten.
    const groups = {};
    Object.entries(config.supply_types).forEach(([k, v]) => {
      (groups[v.group || 'Other'] = groups[v.group || 'Other'] || []).push([k, v]);
    });
    $('gstSupply').innerHTML = Object.entries(groups).map(([g, entries]) =>
      `<optgroup label="${escapeHtml(g)}">` + entries.map(([k, v]) =>
        `<option value="${k}"${k === config.default_supply_type ? ' selected' : ''}>${escapeHtml(v.label)}</option>`
      ).join('') + `</optgroup>`).join('');

    // Composition + business type
    $('gstComposition').innerHTML = `<option value="">Do not compare</option>` +
      config.composition_categories.map(c =>
        `<option value="${c.key}">${escapeHtml(c.label)} — ${c.rate}%</option>`).join('');
    $('gstBusinessType').innerHTML = Object.entries(config.registration_thresholds).map(([k, v]) =>
      `<option value="${k}">${escapeHtml(v.label)}</option>`).join('');

    // Slab reference + RCM reference, straight from config
    const structure = config.rate_structures[config.default_rate_structure];
    $('gstSlabRef').innerHTML = `
      <p style="font-size:12.5px; color:var(--ink-muted); margin:0 0 10px;">${escapeHtml(structure.note)}</p>
      <div class="cmp-scroll"><table class="cmp-table">
        <thead><tr><th>Slab</th><th>Typical items</th></tr></thead>
        <tbody>${structure.slabs.map(s =>
          `<tr><td style="white-space:nowrap;">${escapeHtml(s.label)}</td><td>${escapeHtml(s.examples)}</td></tr>`).join('')}
        </tbody></table></div>`;

    $('gstRcmRef').innerHTML = `
      <p style="font-size:12.5px; color:var(--ink-muted); line-height:1.6; margin:0 0 10px;">${escapeHtml(config.rcm_note)}</p>
      <ul style="margin:0 0 0 18px; padding:0; font-size:12.5px; color:var(--ink-muted);">
        ${config.rcm_common_cases.map(c => `<li style="margin:3px 0;">${escapeHtml(c)}</li>`).join('')}
      </ul>`;

    $('gstDisclaimer').innerHTML =
      `<div class="note-block">${escapeHtml(config.disclaimer)}<br><br>${escapeHtml(config.rounding_note)}</div>`;

    if (config.company && config.company.gstin) {
      $('gstGstin').textContent = 'GSTIN ' + config.company.gstin;
    } else {
      $('gstGstin').textContent = 'No GSTIN on file';
    }

    $('gstFilingGuides').innerHTML = filingGuidesHtml();

    // Inline help on every control that has copy for it.
    ['gstMode', 'gstSupply', 'gstStructure', 'gstItc', 'gstComposition',
     'gstTurnover', 'gstBusinessType', 'gstGstinInput'].forEach(id => decorateControl(id));
    attachHelp($('view-gst'));
    decorateLineHeaders();

    // Restore the saved working set for this year, if there is one.
    lines = [blankLine()];
    try {
      const saved = await window.api.fetchGstProfile(null);
      if (saved.exists && saved.inputs && (saved.inputs.lines || []).length) {
        const i = saved.inputs;
        if (i.mode) $('gstMode').value = i.mode;
        if (i.supply_type) $('gstSupply').value = i.supply_type;
        if (i.rate_structure) { $('gstStructure').value = i.rate_structure; structureTouched = true; }
        if (i.invoice_date && $('gstInvoiceDate')) $('gstInvoiceDate').value = i.invoice_date;
        if (i.input_tax_credit) $('gstItc').value = i.input_tax_credit;
        if (i.composition_category) $('gstComposition').value = i.composition_category;
        if (i.annual_turnover !== null && i.annual_turnover !== undefined) $('gstTurnover').value = i.annual_turnover;
        if (i.business_type) $('gstBusinessType').value = i.business_type;
        $('gstSpecialState').checked = !!i.special_category_state;
        if (i.gstin) $('gstGstinInput').value = i.gstin;
        lines = i.lines.map(l => Object.assign(blankLine(), l));
        $('gstSaveState').textContent = `Restored from ${saved.fy}`;
      }
    } catch (err) {
      // A missing saved set is normal, not an error worth surfacing.
      console.debug('No saved GST working set:', err && err.message);
    }

    renderLines();
    wire();
    recalc();
  }

  window.gstView = { render: init, reload: recalc, last: () => lastResult };
})();
