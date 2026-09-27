/* ==========================================================================
   TWIN — Startup: Fundraise Readiness

   Renders GET /startup/fundraise/readiness. Every number, band and verdict
   shown here is computed by the backend; this file formats and nothing more,
   so the screen can never disagree with the engine.

   Reuses escapeHtml/svgProgressRing/suHealthColor/suStatusLabel/
   suCalcInfoHtml/attachCalcInfoToggles from app.js and startup.js, both of
   which are loaded before this file.
   ========================================================================== */

(function () {
  'use strict';

  let lastPayload = null;
  let wired = false;
  let stages = null;   // [{key, label, is_current}] from GET /startup/fundraise/benchmarks

  const $ = id => document.getElementById(id);

  const VERDICT_LABEL = {
    strong: 'Strong',
    acceptable: 'Acceptable',
    weak: 'Weak',
    blocker: 'Blocker',
    not_applicable: 'Not applicable',
    unknown: 'No data'
  };

  const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

  /* ---------- Benchmark track geometry ----------
     Places the company's value on a 0-100% track running from the critical
     threshold to a little past the target, and marks where target sits. A
     picture of "how far off am I" that the raw numbers alone do not give. */
  function trackGeometry(value, band) {
    if (value === null || value === undefined) return null;
    const { direction, target, critical } = band;
    // Extend the scale 25% past target so a company that beats it still shows
    // headroom rather than pinning at the end of the bar.
    const lo = direction === 'higher' ? critical : target * 0.5;
    const hi = direction === 'higher' ? target * 1.25 : critical;
    if (hi === lo) return null;
    const clamp = v => Math.max(0, Math.min(100, v));
    const pos = clamp(((value - lo) / (hi - lo)) * 100);
    const targetPos = clamp(((target - lo) / (hi - lo)) * 100);
    return { pos, targetPos };
  }

  function benchRowHtml(row) {
    const m = row.metric;
    const b = row.benchmark;
    const geo = trackGeometry(m.value, b);
    const fillClass = row.verdict === 'blocker' ? 'is-blocker' : (row.verdict === 'weak' ? 'is-weak' : '');

    const track = geo ? `
      <div class="fr-track">
        <div class="fr-track__fill ${fillClass}" style="width:${geo.pos.toFixed(1)}%"></div>
        <div class="fr-track__target" style="left:${geo.targetPos.toFixed(1)}%"
             title="Stage target: ${escapeHtml(b.target_display)}"></div>
      </div>` : '';

    return `
      <div class="fr-bench">
        <div class="fr-bench__head">
          <span class="fr-bench__label">${escapeHtml(m.label)}</span>
          <span class="fr-bench__value">${escapeHtml(m.display)}</span>
        </div>
        ${track}
        <div class="fr-bench__meta">
          <span class="verdict-pill verdict-pill--${row.verdict}">${VERDICT_LABEL[row.verdict] || row.verdict}</span>
          <span class="status-chip status-chip--${m.status}">${suStatusLabel(m.status)}</span>
          <span>Target ${escapeHtml(b.target_display)} &middot; warn ${escapeHtml(b.warn_display)} &middot; blocker past ${escapeHtml(b.critical_display)}</span>
          <span>&middot; ${row.verdict === 'not_applicable' ? 'not scored' : `${row.weight_pct}% of score`}</span>
        </div>
        <p class="fr-bench__note">${escapeHtml(b.note)}</p>
        ${suCalcInfoHtml(m, 'fr')}
      </div>`;
  }

  function gapCardHtml(gap) {
    const inputs = (gap.missing_inputs || []).map(i => `<li>${escapeHtml(i)}</li>`).join('');
    return `
      <div class="gap-card">
        <div class="gap-card__head">
          <span class="gap-card__label">${escapeHtml(gap.label)}</span>
          <span class="sev-pill sev-pill--${gap.severity}">${SEVERITY_LABEL[gap.severity] || gap.severity}</span>
        </div>
        <p><b>Why it matters:</b> ${escapeHtml(gap.asked_by)}</p>
        <p><b>What is missing:</b></p>
        <ul>${inputs}</ul>
        <p><b>Unlocks:</b> ${escapeHtml(gap.unlocks)}</p>
        ${gap.how_to_close ? `<div class="gap-card__close">${escapeHtml(gap.how_to_close)}</div>` : ''}
      </div>`;
  }

  function contextMetricHtml(m) {
    return `
      <div class="stat-card">
        <div class="stat-card__label-row">
          <span class="stat-card__label">${escapeHtml(m.label)}</span>
          <span class="status-chip status-chip--${m.status}">${suStatusLabel(m.status)}</span>
        </div>
        <span class="stat-card__value">${escapeHtml(m.display)}</span>
        ${suCalcInfoHtml(m, 'frctx')}
      </div>`;
  }

  function flagListHtml(items, emptyText) {
    if (!items.length) return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
    return `<ul class="alert-list">` + items.map(i => `
      <li>
        <b>${escapeHtml(i.metric)}</b> — ${escapeHtml(i.display)} against a target of ${escapeHtml(i.target)}.
        <br><span style="color:var(--ink-muted); font-size:12px;">${escapeHtml(i.note)}</span>
      </li>`).join('') + `</ul>`;
  }

  function render(data) {
    lastPayload = data;
    const r = data.readiness;

    /* ---- Hero: score ring + verdict ---- */
    const ring = svgProgressRing(r.score, { size: 108, color: suHealthColor(r.score), strokeW: 10, showLabel: false });
    $('frHero').innerHTML = `
      <div class="fr-hero">
        <div class="fr-hero__ring">${ring}</div>
        <div class="fr-hero__body">
          <p class="fr-hero__label tone-${r.tone}">${escapeHtml(r.label)} &middot; ${escapeHtml(r.display)}</p>
          <p class="fr-hero__summary">${escapeHtml(r.summary)}</p>
          <span class="fr-hero__note">${escapeHtml(r.confidence_note)}</span>
          <div class="fr-stage-row">
            <label for="frStageSelect">Judged against:</label>
            <select id="frStageSelect" class="ob-input" style="width:auto; margin-bottom:0; padding:6px 10px; font-size:12.5px;"></select>
            <span class="fr-hero__note">${data.currently_fundraising ? 'Marked as actively fundraising.' : 'Not currently marked as fundraising.'}</span>
          </div>
        </div>
      </div>`;

    // Stage selector — lets a founder see how the next stage would judge them
    // without editing their profile. The list comes from the backend's
    // benchmark table, so adding a stage in config needs no change here. The
    // label doubles as the value because the readiness endpoint accepts it.
    const sel = $('frStageSelect');
    const options = (stages && stages.length)
      ? stages
      : [{ key: data.stage.key, label: data.stage.label }];
    sel.innerHTML = options.map(s =>
      `<option value="${escapeHtml(s.label)}"${s.key === data.stage.key ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('');
    sel.addEventListener('change', () => load(sel.value));
    if (data.stage.normalized_from_default) {
      sel.insertAdjacentHTML('afterend',
        `<span class="fr-hero__note tone-warn">No recognised stage on your profile, so ${escapeHtml(data.stage.label)} benchmarks are used.</span>`);
    }

    /* ---- The ask ---- */
    const ask = data.ask;
    $('frAsk').innerHTML = `
      <div class="metric-row">
        <div class="metric-row__main">
          <span class="metric-row__label">Raise needed for ${ask.target_runway_months} months of runway</span>
          <span class="status-chip status-chip--${ask.status}">${suStatusLabel(ask.status)}</span>
        </div>
        <div class="metric-row__value">${escapeHtml(ask.display)}</div>
      </div>
      ${ask.verdict ? `<p style="color:var(--ink-muted); font-size:12.5px; line-height:1.6; margin:10px 0 0;">${escapeHtml(ask.verdict)}</p>` : ''}
      ${ask.calculation ? suCalcInfoHtml({ id: 'ask', calculation: ask.calculation }, 'frask') : ''}`;

    /* ---- Blockers and watch list ---- */
    $('frBlockers').innerHTML = flagListHtml(
      data.blockers, 'No metric is below the blocking threshold for this stage.');
    $('frWatch').innerHTML = flagListHtml(
      data.watch, 'No metric is in the warning band.');

    /* ---- Benchmarks ---- */
    $('frBenchmarks').innerHTML = data.benchmarks.map(benchRowHtml).join('');

    /* ---- Context metrics ---- */
    $('frContext').innerHTML = (data.context_metrics || []).map(contextMetricHtml).join('');

    /* ---- Diligence gaps ---- */
    const gaps = data.diligence_gaps || [];
    $('frGapCount').textContent = gaps.length ? `${gaps.length} open` : 'None';
    $('frGaps').innerHTML = gaps.length
      ? gaps.map(gapCardHtml).join('')
      : `<p class="empty-note">Nothing outstanding — every metric an investor would ask for can be computed from your data.</p>`;

    /* ---- Disclaimer ---- */
    $('frDisclaimer').innerHTML = `<div class="note-block">${escapeHtml(data.disclaimer)}</div>`;

    // Wire every "How is this calculated?" toggle in one pass.
    attachCalcInfoToggles($('view-fundraise'));
  }

  async function load(stageOverride) {
    const host = $('frHero');
    if (!host) return;
    host.innerHTML = `<p class="empty-note">Loading readiness…</p>`;
    try {
      if (!stages) {
        try {
          stages = (await window.api.fetchFundraiseBenchmarks()).stages || [];
        } catch (e) {
          console.warn('Benchmark stages unavailable; the selector shows the current stage only.', e);
          stages = [];
        }
      }
      const data = await window.api.fetchFundraiseReadiness(stageOverride);
      render(data);
    } catch (err) {
      console.error('Fundraise readiness failed:', err);
      host.innerHTML = `<p class="empty-note">Could not load fundraise readiness. ${escapeHtml(err.message || '')}</p>`;
      ['frAsk', 'frBlockers', 'frWatch', 'frBenchmarks', 'frContext', 'frGaps', 'frDisclaimer']
        .forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
    }
  }

  function wire() {
    if (wired) return;
    wired = true;
    const btn = $('btnRefreshFundraise');
    if (btn) btn.addEventListener('click', () => load());
  }

  window.fundraiseView = {
    render: () => { wire(); load(); },
    reload: load,
    last: () => lastPayload
  };
})();
