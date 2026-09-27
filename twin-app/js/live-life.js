/* ==========================================================================
   live.life.fully — the immersive lifestyle experience

   A full-viewport overlay that lives beside the app rather than inside it: it
   mounts on #llf, owns nothing in the shell, and adds no route. switchView()
   and every existing view are untouched — opening and closing this changes one
   class on <body> and one attribute on the overlay.

   Presentation only, on the same terms as js/home.js: every rupee, percentage
   and verdict on screen is computed by backend/services/live_life_service.py
   and arrives through GET /live-life. This file never derives a financial
   number of its own; the one sum it does — combining what-if levers — applies
   the balance's own rule to deltas the server supplied (see renderLevers).
   When the backend says `insufficient_data`, the UI says so rather than
   filling the gap with something that looks plausible.

   Writes go through endpoints that already exist — an experience stash is a
   FinancialGoal, so it is created with POST /home/goals and funded with
   PUT /home/goals/{id}. After any write the Daily Home is asked to re-render,
   so the Overview and this experience can never show different numbers.

   Depends on window.api (api.js) and, optionally, escapeHtml() from app.js and
   window.dailyHome from home.js — both are referenced only inside functions
   that run well after those files have loaded.
   ========================================================================== */
(function () {

  const SCENE_MS = 11000;          // how long a scene holds before crossfading
  const COUNT_MS = 1600;           // count-up duration for the headline figure

  const state = {
    /** Individual profiles only, matching how the Daily Home is gated. */
    enabled: false,
    open: false,
    data: null,
    loading: false,
    error: null,
    sceneIndex: 0,
    sceneTimer: null,
    scenesBuilt: {},
    ambience: true,
    /** The single cinematic loop, once it has actually decoded. Until then the
     *  procedural scenes are what the user is looking at. */
    backdrop: null,
    backdropActive: false,
    accentTimer: null,
    accentIndex: 0,
    particles: null,
    rafId: null,
    sheet: null,
    /** Indexes into freedom_story.levers the user has switched on, and the
     *  figure the lever readout is currently showing (so a change tweens from
     *  what is on screen rather than jumping). */
    levers: [],
    leverShown: null,
    leverTween: 0,
    /** Moments the user has already seen today, so MoneyKal does not repeat
     *  the same celebration every time the page is opened. Stored per-day and
     *  per-moment-type; the server holds no notification state. */
    seenMoments: readSeen(),
  };

  const reduced = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  const el = id => document.getElementById(id);
  const esc = v => (typeof escapeHtml === 'function')
    ? escapeHtml(v)
    : String(v == null ? '' : v).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ======================================================================
     Utilities
     ====================================================================== */

  /** Indian grouping, matching home_service.format_money on the server. Only
   *  used for figures this file animates — every static figure uses the
   *  display string the API already formatted. */
  function money(currency, n) {
    const c = currency || '₹';
    const v = Math.round(Math.abs(n || 0));
    return (n < 0 ? '-' : '') + c + v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  /* ------------------------------------------------------------- scenery
     This experience used to run a cinematic backdrop: a looping video, a set
     of rotating procedural scenes, drifting particles and film grain. It is an
     editorial page now, so the stage stays empty. These are the seams that
     were left behind, kept as no-ops so the many callers (visibility changes,
     reduced-motion handling, keyboard shortcuts, scene dots) need no special
     cases. */
  function ensureScene() {}
  function mountBackdrop() {}
  function showScene() {}
  function startSceneCycle() {}
  function stopSceneCycle() {}
  function startParticles() {}
  function stopParticles() {}
  function startAccentCycle() {}
  function stopAccentCycle() {}
  function onPointerMove() {}

  function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }

  /** Counts a figure up from zero. Under reduced motion the final value is
   *  written immediately — the number is the point, the animation is not. */
  function countUp(node, target, currency, duration) {
    if (!node) return;
    if (reduced.matches || !target) {
      node.textContent = money(currency, target || 0);
      return;
    }
    const start = performance.now();
    const dur = duration || COUNT_MS;
    (function step(now) {
      const t = Math.min((now - start) / dur, 1);
      node.textContent = money(currency, target * easeOutExpo(t));
      if (t < 1) requestAnimationFrame(step);
    })(start);
  }

  /* --------------------------------------------------------- seen moments */

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function readSeen() {
    try {
      const raw = JSON.parse(localStorage.getItem('moneykal_llf_moments') || '{}');
      return raw.day === todayKey() ? raw : { day: todayKey(), types: [] };
    } catch (e) {
      return { day: todayKey(), types: [] };
    }
  }

  function markSeen(type) {
    if (!type || state.seenMoments.types.indexOf(type) !== -1) return;
    state.seenMoments.types.push(type);
    try {
      localStorage.setItem('moneykal_llf_moments', JSON.stringify(state.seenMoments));
    } catch (e) { /* private mode — the moment simply shows again next time */ }
  }

  /* ======================================================================
     The stage — scenes, parallax, particles
     ====================================================================== */

  /** Scenes are built on demand rather than all at once: each one carries a few
   *  hundred SVG nodes, and ten of them up front would cost a visible pause on
   *  the very frame the experience is trying to feel effortless. */
  /* -------------------------------------------------------------- backdrop
     One video behind the whole experience, when the project has been given one.

     Deliberately mounted *after* the procedural scenes are already on screen
     and never awaited: 28 MB of 1440p takes a moment even on a good line, and
     the user must never be looking at a black rectangle while it arrives. The
     scenes play, the video crossfades over them when it is ready, and if it
     never arrives — missing file, decode failure, a browser that refuses to
     autoplay — the scenes simply keep going and nothing about the page breaks.
  */
  /** With one unchanging clip behind everything, the accent is what keeps the
   *  page breathing — it drives the hero word, the glow under the balance, the
   *  progress paths and every card edge. */
  /* ------------------------------------------------------------ parallax */

  /* ----------------------------------------------------------- particles */

  /* ======================================================================
     Progress art — a road, a flight path, a wave, a mountain trail

     Each is one SVG path. The fill is drawn with stroke-dasharray and the
     marker is placed with getPointAtLength, so progress is a real position on
     a real curve rather than a bar wearing a costume.
     ====================================================================== */

  const PROG_PATHS = {
    flight: 'M 14 86 Q 200 2 386 58',
    road:   'M 16 92 C 118 92 88 26 200 26 S 296 86 386 86',
    wave:   'M 10 68 Q 57 26 104 68 T 198 68 T 292 68 T 386 68',
    trail:  'M 12 92 L 92 72 L 66 56 L 168 40 L 142 28 L 262 18 L 240 12 L 386 8'
  };

  const PROG_MARKERS = {
    flight: '<path d="M -8 0 L 8 -5 L 3.5 0 L 8 5 Z"/>',
    road:   '<rect x="-7" y="-4.5" width="14" height="9" rx="3"/>',
    wave:   '<circle r="5.2"/>',
    trail:  '<path d="M -4 6 L -4 -7 L 7 -3.5 L -4 0 Z"/>'
  };

  const PROG_CAPTIONS = {
    flight: 'Distance to your destination',
    road:   'How far down the road you are',
    wave:   'How close the wave is to shore',
    trail:  'How far up the trail you are'
  };

  let progSeq = 0;

  function progressArt(art, pct, tint) {
    const kind = PROG_PATHS[art] ? art : 'road';
    const id = 'llfProg' + (++progSeq);
    const safePct = Math.max(0, Math.min(pct == null ? 0 : pct, 100));
    return '' +
      '<div class="llf-prog" style="--llf-tint:' + esc(tint || '#00e5ff') + '">' +
        '<span class="llf-prog__pct">' + safePct.toFixed(0) + '%</span>' +
        '<svg viewBox="0 0 400 100" data-prog="' + id + '" data-pct="' + safePct + '" ' +
             'role="img" aria-label="' + safePct.toFixed(0) + ' percent funded">' +
          '<path class="llf-prog__track" d="' + PROG_PATHS[kind] + '" stroke-width="3"/>' +
          '<path class="llf-prog__fill" id="' + id + '" d="' + PROG_PATHS[kind] + '" stroke-width="4"/>' +
          '<g class="llf-prog__marker">' + PROG_MARKERS[kind] + '</g>' +
        '</svg>' +
        '<p class="llf-prog__cap">' + PROG_CAPTIONS[kind] + '</p>' +
      '</div>';
  }

  /** Draws every progress path that has been inserted but not yet animated.
   *  Two frames: one to set the dash at zero, one to let the transition run. */
  function paintProgress(root) {
    (root || document).querySelectorAll('svg[data-prog]').forEach(svg => {
      if (svg.dataset.painted === '1') return;
      svg.dataset.painted = '1';
      const fill = svg.querySelector('.llf-prog__fill');
      const marker = svg.querySelector('.llf-prog__marker');
      if (!fill || !fill.getTotalLength) return;

      let len = 0;
      try { len = fill.getTotalLength(); } catch (e) { return; }
      const pct = Math.max(0, Math.min(parseFloat(svg.dataset.pct) || 0, 100)) / 100;

      fill.style.strokeDasharray = len;
      fill.style.strokeDashoffset = len;
      const at = fill.getPointAtLength(0);
      if (marker) marker.setAttribute('transform', 'translate(' + at.x + ',' + at.y + ')');

      const settle = () => {
        fill.style.strokeDashoffset = len * (1 - pct);
        if (marker) {
          const p = fill.getPointAtLength(len * pct);
          marker.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
        }
      };
      if (reduced.matches) settle();
      else requestAnimationFrame(() => requestAnimationFrame(settle));
    });
  }

  /* ======================================================================
     Reveals
     ====================================================================== */

  let revealObserver = null;

  function observeReveals(root) {
    const nodes = (root || document).querySelectorAll('.llf-reveal:not(.is-in)');
    // Reduced motion, or a browser without IntersectionObserver: show
    // everything at once, fully drawn. Nothing is lost but the staging.
    if (reduced.matches || !('IntersectionObserver' in window)) {
      nodes.forEach(n => n.classList.add('is-in'));
      paintProgress(root);
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
          paintProgress(entry.target);
        });
      }, { root: el('llfScroll'), rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    }
    nodes.forEach(n => revealObserver.observe(n));
  }

  /* ======================================================================
     Rendering
     ====================================================================== */

  /* ======================================================================
     My Freedom Balance — the number, and the story that explains it

     Five beats, top to bottom, each answering one question a person has the
     moment they see the figure:

       opening   how much is genuinely mine to decide about, and is that good?
       flow      how does my income turn into that number?
       shapers   what is taking the rest, largest first?
       levers    what would give me more room?
       meaning   what does all of this add up to, in plain words?

     Every amount and every sentence comes from `freedom_story`, which the
     server builds from the balance's own figures. The one sum done here is
     combining what-if levers, and that re-applies the balance's rule —
     max(0, min(flow, stock)) — to deltas the server supplied, rather than
     working anything out afresh.
     ====================================================================== */

  const LEAD = {
    of_income: 'of your monthly income is truly flexible.',
    this_month: 'is truly flexible this month.'
  };

  /** Shown in place of a figure when there is none yet, so someone who has
   *  never heard of a Freedom Balance still learns what it is. */
  const DEFINITION = 'Your Freedom Balance is the part of your income that’s still yours ' +
    'to decide about, once your essentials, bills, EMIs and goals are covered.';

  const CHECK_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6.1-6.4"/></svg>';

  /** A share of income, never "0%" for something that is really there. */
  function sharePct(n) {
    if (!n) return '0%';
    return (n > 0 && n < 0.5 ? '<1' : Math.round(n)) + '%';
  }

  function barWidth(part, whole) {
    return (whole > 0 ? Math.max(0, Math.min(part / whole, 1)) * 100 : 0).toFixed(3) + '%';
  }

  /* ------------------------------------------------------------ opening */

  function renderOpening(d) {
    const s = d.freedom_story;
    const known = s.status === 'ready';

    let reading =
      '<p class="llf-fb__reading-title">' + esc(s.title) + '</p>' +
      (s.summary ? '<p class="llf-fb__reading-body">' + esc(s.summary) + '</p>' : '');
    if (!known) {
      reading +=
        '<ul class="llf-fb__missing">' +
          (s.missing || []).map(m => '<li>' + esc(m) + '</li>').join('') +
        '</ul>' +
        '<div class="llf-fb__actions">' +
          '<button type="button" class="llf-btn llf-btn--primary" data-llf-profile>' +
            'Add them to your profile</button>' +
          '<button type="button" class="llf-btn llf-btn--ghost" data-llf-hisaab>' +
            'Log spending in Hisaab</button>' +
        '</div>';
    }

    el('llfHeroCards').innerHTML =
      '<header class="llf-fb__open llf-reveal">' +
        '<div class="llf-fb__headline">' +
          '<p class="llf-fb__eyebrow">My Freedom Balance</p>' +
          '<h1 class="llf-fb__figure">' +
            (known
              ? '<span class="llf-fb__value" id="llfFreedomValue">' + money(d.user.currency, 0) + '</span>' +
                '<span class="llf-fb__lead">' + esc(LEAD[s.lead] || LEAD.this_month) + '</span>'
              : '<span class="llf-fb__lead llf-fb__lead--definition">' + DEFINITION + '</span>') +
          '</h1>' +
        '</div>' +
        '<div class="llf-fb__reading" data-state="' + esc(s.state || 'unknown') + '">' +
          reading +
        '</div>' +
      '</header>' +
      (known && s.flow ? renderFlow(s) : '');
  }

  /* --------------------------------------------------------------- flow
     One bar for the month's income, cut into what is committed, what has
     been spent, what is held back and what is left, with the same cuts
     written out underneath as a sum. The bar is for the glance; the sum is
     for anyone who wants to check it. */

  function renderFlow(s) {
    const f = s.flow;
    const inc = f.income.amount;
    const short = f.over ? f.over.amount : 0;
    // An over-committed month overflows the income, so the bar is scaled to
    // what went out and a marker shows where the income ran out.
    const scale = Math.max(inc, f.committed.amount + f.spent.amount) || 1;

    const segs = [
      ['committed', f.committed.amount],
      ['spent', f.spent.amount],
      ['held', f.held ? f.held.amount : 0],
      ['free', f.free.amount]
    ].filter(x => x[1] > 0).map(x =>
      '<span class="llf-flow__seg" data-seg="' + x[0] + '" style="--w:' + barWidth(x[1], scale) +
      '"></span>').join('');

    const marker = short > 0
      ? '<span class="llf-flow__limit" style="--at:' + barWidth(inc, scale) + '">' +
          '<span>Your income</span></span>'
      : '';

    const parts = (f.committed.parts || []).map(p => '<span>' + esc(p) + '</span>').join(', ') +
      (f.committed.more ? ' <span>and more</span>' : '');

    const step = (seg, op, label, value, note, cls) =>
      '<li class="llf-flow__step' + (cls ? ' ' + cls : '') + '" data-seg="' + seg + '">' +
        '<span class="llf-flow__op" aria-hidden="true">' + op + '</span>' +
        '<span class="llf-flow__k">' + esc(label) + '</span>' +
        '<span class="llf-flow__v">' + esc(value) + '</span>' +
        (note ? '<span class="llf-flow__n">' + note + '</span>' : '') +
      '</li>';

    const steps = [
      step('income', '', 'Monthly income', f.income.display, '<span>' + esc(f.income.note) + '</span>'),
      step('committed', '−', 'Already committed', f.committed.display,
           '<span>' + sharePct(f.committed.share) + '</span> <span>of income</span>' +
           (parts ? ' · ' + parts : ''))
    ];
    if (f.spent.amount > 0) {
      steps.push(step('spent', '−', 'Spent so far', f.spent.display, '<span>This month</span>'));
    }
    if (f.held) {
      steps.push(step('held', '−', 'Held back', f.held.display,
                      '<span>To protect your safety buffer</span>'));
    }
    if (short > 0) {
      steps.push(step('short', '=', 'Short this month', f.over.display,
                      '<span>Coming out of your savings</span>', 'is-result is-short'));
    } else {
      steps.push(step('free', '=', 'Left to decide about', f.free.display,
                      '<span>' + (s.state === 'protecting'
                        ? 'Yours once your safety buffer is rebuilt.'
                        : 'Save it, invest it, travel or spend it. Everything you’ve committed to is already accounted for.') +
                      '</span>', 'is-result is-free'));
    }

    const cols = 'repeat(' + (steps.length - 1) + ', minmax(0, 1fr)) minmax(0, 1.5fr)';
    const summary = 'Of ' + f.income.display + ' income, ' + f.committed.display + ' is committed' +
      (f.spent.amount > 0 ? ', ' + f.spent.display + ' is spent' : '') +
      (f.held ? ', ' + f.held.display + ' is held back' : '') +
      (short > 0 ? ', and ' + f.over.display + ' goes beyond it.'
                 : ', and ' + f.free.display + ' is left.');

    return '' +
      '<div class="llf-flow llf-reveal' + (short > 0 ? ' llf-flow--over' : '') + '">' +
        '<p class="llf-flow__kicker">How your income becomes your Freedom Balance</p>' +
        '<div class="llf-flow__track">' +
          '<div class="llf-flow__bar" role="img" aria-label="' + esc(summary) + '">' + segs + '</div>' +
          marker +
        '</div>' +
        '<ol class="llf-flow__steps" style="--cols:' + cols + '">' + steps.join('') + '</ol>' +
      '</div>';
  }

  /* ------------------------------------------------------------ shapers */

  function renderShapers(d) {
    const sec = el('llfShapeSec');
    const s = d.freedom_story;
    if (!s || s.status !== 'ready' || !(s.shapers || []).length) {
      sec.hidden = true; sec.innerHTML = ''; return;
    }
    const inc = s.flow.income.amount;

    const rows = s.shapers.map((r, i) =>
      '<li class="llf-break__row" data-kind="' + esc(r.kind) + '" style="--i:' + i + '">' +
        '<div class="llf-break__label"><span>' + esc(r.label) + '</span>' +
          (r.note ? '<span class="llf-break__note">' + esc(r.note) + '</span>' : '') +
        '</div>' +
        '<div class="llf-shape__track" aria-hidden="true">' +
          '<i style="--w:' + barWidth(r.amount, inc) + '"></i></div>' +
        '<div class="llf-break__amt">−' + esc(r.display) +
          '<span class="llf-shape__pct"><span>' + sharePct(r.share) + '</span> <span>of income</span></span>' +
        '</div>' +
      '</li>').join('');

    const f = s.flow;
    const last = s.shapers.length;
    const result = f.over
      ? '<li class="llf-break__row llf-shape__result" data-kind="short" style="--i:' + last + '">' +
          '<div class="llf-break__label"><span>Short this month</span>' +
            '<span class="llf-break__note">More going out than coming in</span></div>' +
          '<div class="llf-shape__track" aria-hidden="true"></div>' +
          '<div class="llf-break__amt">' + esc(f.over.display) + '</div>' +
        '</li>'
      : '<li class="llf-break__row llf-shape__result" data-kind="free" style="--i:' + last + '">' +
          '<div class="llf-break__label"><span>Left for you</span>' +
            '<span class="llf-break__note">Your Freedom Balance</span></div>' +
          '<div class="llf-shape__track" aria-hidden="true">' +
            '<i style="--w:' + barWidth(f.free.amount, inc) + '"></i></div>' +
          '<div class="llf-break__amt">' + esc(f.free.display) +
            '<span class="llf-shape__pct"><span>' + sharePct(f.free.share) + '</span> <span>of income</span></span>' +
          '</div>' +
        '</li>';

    sec.innerHTML =
      '<header class="llf-fb__head llf-reveal">' +
        '<h2 class="llf-fb__h">What’s shaping your freedom</h2>' +
        '<p class="llf-fb__sub">Everything that comes out of your income before your Freedom Balance, largest first.</p>' +
      '</header>' +
      '<ol class="llf-shape llf-reveal">' + rows + result + '</ol>';
    sec.hidden = false;
  }

  /* ------------------------------------------------------------- levers */

  function renderLevers(d) {
    const sec = el('llfLeverSec');
    const s = d.freedom_story;
    state.levers = [];
    if (!s || s.status !== 'ready' || !(s.levers || []).length) {
      sec.hidden = true; sec.innerHTML = ''; return;
    }

    const items = s.levers.map((l, i) =>
      '<li><button type="button" class="llf-lever" data-llf-lever="' + i + '" aria-pressed="false">' +
        '<span class="llf-lever__tick" aria-hidden="true">' + CHECK_SVG + '</span>' +
        '<span class="llf-lever__body">' +
          '<span class="llf-lever__title">' + esc(l.title) + '</span>' +
          '<span class="llf-lever__detail">' + esc(l.detail) + '</span>' +
        '</span>' +
        '<span class="llf-lever__effect">' +
          (l.delta >= 1
            ? '<span class="llf-lever__to">' + esc(l.new_display) + '</span>' +
              '<span class="llf-lever__gain">+' + esc(l.delta_display) + '</span>'
            : '<span class="llf-lever__to">−' + esc(l.closes_gap_display) + '</span>' +
              '<span class="llf-lever__gain">off the shortfall</span>') +
        '</span>' +
      '</button></li>').join('');

    sec.innerHTML =
      '<header class="llf-fb__head llf-reveal">' +
        '<h2 class="llf-fb__h">Want more breathing room?</h2>' +
        '<p class="llf-fb__sub">Tap a change to see what it would do to your Freedom Balance. Each one is worked out from your own numbers.</p>' +
      '</header>' +
      '<div class="llf-levers llf-reveal">' +
        '<ul class="llf-levers__list">' + items + '</ul>' +
        '<div class="llf-levers__result">' +
          '<p class="llf-levers__k" id="llfLeverLabel">Your Freedom Balance today</p>' +
          '<p class="llf-levers__v"><span id="llfLeverValue">' + esc(s.display) + '</span>' +
            '<span class="llf-levers__delta" id="llfLeverDelta"></span></p>' +
          '<div class="llf-levers__bar" aria-hidden="true">' +
            '<i class="llf-levers__now" id="llfLeverNow"></i>' +
            '<i class="llf-levers__gain" id="llfLeverGain"></i></div>' +
          '<p class="llf-levers__note" id="llfLeverNote" aria-live="polite">' +
            'Pick one or more changes to see them together.</p>' +
          '<button type="button" class="llf-btn" data-llf-simulate disabled>' +
            'Explore this in Simulate <span aria-hidden="true">→</span></button>' +
        '</div>' +
      '</div>';
    sec.hidden = false;
    state.leverShown = s.value;
    updateLevers(false);
  }

  /** The balance's own rule, applied to the story's two tests plus whichever
   *  lever deltas are switched on. */
  function combineLevers(s, picked) {
    let fd = 0, sd = 0;
    picked.forEach(i => { fd += s.levers[i].flow_delta; sd += s.levers[i].stock_delta; });
    const flow = s.base.flow + fd;
    return {
      value: Math.max(0, Math.min(flow, s.base.stock + sd)),
      short: Math.max(-flow, 0)
    };
  }

  function updateLevers(animate) {
    const d = state.data;
    const s = d && d.freedom_story;
    if (!s || !s.levers || !el('llfLeverValue')) return;
    const currency = d.user.currency;
    const picked = state.levers;
    const next = combineLevers(s, picked);
    const everything = combineLevers(s, s.levers.map((_, i) => i));
    const scale = Math.max(s.flow.income.amount, everything.value) || 1;
    const gain = Math.max(next.value - s.value, 0);

    el('llfLeverLabel').textContent = !picked.length ? 'Your Freedom Balance today'
      : picked.length === 1 ? 'With this change' : 'With these changes';
    el('llfLeverDelta').textContent = gain >= 1 ? '+' + money(currency, gain) : '';
    el('llfLeverNow').style.setProperty('--w', barWidth(s.value, scale));
    el('llfLeverGain').style.setProperty('--w', barWidth(gain, scale));

    let note;
    if (!picked.length) note = 'Pick one or more changes to see them together.';
    else if (next.short >= 1) note = 'Still ' + money(currency, next.short) + ' short of your income this month.';
    else if (gain >= 1) note = 'That’s ' + money(currency, gain) + ' more room than you have today.';
    else note = 'That wouldn’t change your Freedom Balance on its own.';
    el('llfLeverNote').textContent = note;

    const sim = el('llfLeverSec').querySelector('[data-llf-simulate]');
    if (sim) sim.disabled = !picked.length;

    const node = el('llfLeverValue');
    const from = state.leverShown == null ? s.value : state.leverShown;
    state.leverShown = next.value;
    state.leverTween = (state.leverTween || 0) + 1;
    if (!animate || reduced.matches || from === next.value) {
      node.textContent = money(currency, next.value);
      return;
    }
    const token = state.leverTween;
    const start = performance.now();
    (function step(now) {
      if (token !== state.leverTween) return;
      const t = Math.min((now - start) / 520, 1);
      node.textContent = money(currency, from + (next.value - from) * easeOutExpo(t));
      if (t < 1) requestAnimationFrame(step);
    })(start);
  }

  function toggleLever(btn) {
    const i = Number(btn.dataset.llfLever);
    const at = state.levers.indexOf(i);
    if (at === -1) state.levers.push(i); else state.levers.splice(at, 1);
    btn.setAttribute('aria-pressed', String(at === -1));
    updateLevers(true);
  }

  /** Hands the chosen changes to Simulate as a scenario, the same way Ask
   *  Twin's hand-off pre-fills it, so the what-if carries on there rather
   *  than starting again from a blank box. */
  function simulateLevers() {
    const s = state.data && state.data.freedom_story;
    if (!s || !state.levers.length) return;
    const picked = state.levers.slice().sort((a, b) => a - b).map(i => s.levers[i]);
    const scenario = picked.length === 1
      ? picked[0].scenario
      : 'What happens to my finances if I make these changes: ' +
        picked.map(l => l.title).join('; ') + '?';
    leaveTo('simulate', () => {
      const input = el('scenarioInput');
      if (input) { input.value = scenario; input.focus(); }
    });
  }

  /** Closes the overlay and moves the app to another view behind it. */
  function leaveTo(view, then) {
    close();
    setTimeout(() => {
      if (view && typeof switchView === 'function') switchView(view);
      if (then) then();
    }, 60);
  }

  /* ------------------------------------------------------------ meaning */

  function renderMeaning(d) {
    const sec = el('llfMeaningSec');
    const s = d.freedom_story;
    const f = d.freedom_balance;
    if (!s || s.status !== 'ready' || !(s.interpretation || []).length) {
      sec.hidden = true; sec.innerHTML = ''; return;
    }

    const calc = f.calculation || {};
    const why =
      '<button type="button" class="llf-why" data-llf-why>How is this worked out?</button>' +
      '<div class="llf-why__body" hidden>' +
        esc(calc.formula || '') + '\n\n' +
        Object.keys(calc.inputs || {}).map(k =>
          k.replace(/_/g, ' ') + ': ' + calc.inputs[k]).join('\n') +
        '\n\nSource: ' + esc(calc.data_source || '') +
        (f.assumptions && f.assumptions.length
          ? '\n\nAssumptions:\n· ' + f.assumptions.map(esc).join('\n· ') : '') +
      '</div>';

    sec.innerHTML =
      '<header class="llf-fb__head llf-reveal">' +
        '<h2 class="llf-fb__h">What this means</h2>' +
      '</header>' +
      '<div class="llf-meaning llf-reveal">' +
        s.interpretation.map((p, i) =>
          '<p class="llf-meaning__p' + (i === 0 ? ' is-first' : '') + '">' + esc(p) + '</p>').join('') +
        '<p class="llf-fb__provenance">' +
          '<span>' + (s.data_status === 'actual' ? 'From your own data' : 'Partly estimated') + '</span>' +
          ' · <span>' + esc('Over the ' + s.period) + '</span>' +
        '</p>' +
        (s.estimate_note ? '<p class="llf-fb__provenance">' + esc(s.estimate_note) + '</p>' : '') +
        why +
      '</div>';
    sec.hidden = false;
  }

  /** An API that predates freedom_story still gets an honest page: the
   *  figure and the balance's own sentence, with the story sections left out
   *  rather than filled with something invented here. */
  function legacyStory(f) {
    return f.status !== 'insufficient_data'
      ? { status: 'ready', lead: 'this_month', value: f.value, display: f.display,
          title: f.copy, summary: f.note || '', state: 'unknown' }
      : { status: 'insufficient_data', title: f.copy, summary: f.note || '',
          missing: f.missing || [] };
  }

  function renderStory(d) {
    const s = d.freedom_story || legacyStory(d.freedom_balance);
    const view = Object.assign({}, d, { freedom_story: s });

    renderOpening(view);
    renderShapers(view);
    renderLevers(view);
    renderMeaning(view);

    if (s.status === 'ready') {
      // Held back a beat, so the number lands as the opening arrives rather
      // than racing the text around it.
      setTimeout(() => countUp(el('llfFreedomValue'), s.value, d.user.currency),
                 reduced.matches ? 0 : 450);
    }
  }

  /* ------------------------------------------------------------- moment */

  function renderMoment(d) {
    const sec = el('llfMomentSec');
    let m = d.moment;
    const locked = d.moment_locked;

    if (m) {
      // Anti-spam. The backend has no per-user notification state by design, so
      // the client remembers which moments it has already celebrated today: a
      // fresh one is preferred, and a repeat is shown calmly rather than being
      // presented as news all over again.
      const seen = state.seenMoments.types;
      if (seen.indexOf(m.cooldown_key) !== -1) {
        const fresh = (d.moment_alternatives || [])
          .find(a => seen.indexOf(a.cooldown_key) === -1);
        if (fresh) m = fresh;
      }
      const repeat = seen.indexOf(m.cooldown_key) !== -1;
      markSeen(m.cooldown_key);
      const ev = (m.evidence || []).map(e => '<span class="llf-chip">' + esc(e) + '</span>').join('');
      const act = m.action
        ? '<button type="button" class="llf-btn llf-btn--primary" data-llf-moment-action="' +
          esc(m.action.target || '') + '">' + esc(m.action.label) + ' <span>→</span></button>'
        : '';
      sec.innerHTML =
        '<p class="llf-sec__label">A moment for you</p>' +
        '<div class="llf-moment llf-reveal' + (repeat ? ' llf-moment--quiet' : '') + '">' +
          '<span class="llf-moment__spark">' +
            (repeat ? 'Still true today' : '✨ You deserve this') + '</span>' +
          '<h2 class="llf-moment__title">' + esc(m.title) + '</h2>' +
          '<p class="llf-moment__msg">' + esc(m.message) + '</p>' +
          '<div class="llf-moment__ev">' + ev + '</div>' +
          '<div class="llf-moment__actions">' + act +
            '<button type="button" class="llf-btn llf-btn--ghost" data-llf-goto="llfCheckSec">' +
              'Check something first</button>' +
          '</div>' +
        '</div>';
      sec.hidden = false;
      return;
    }

    if (locked) {
      const needs = (locked.needs || []).map(n => '<li>' + esc(n) + '</li>').join('');
      sec.innerHTML =
        '<p class="llf-sec__label">A moment for you</p>' +
        '<div class="llf-moment llf-moment--locked llf-reveal">' +
          '<h2 class="llf-moment__title">' + esc(locked.title) + '</h2>' +
          '<p class="llf-moment__msg">' + esc(locked.message) + '</p>' +
          (needs ? '<ul class="llf-moment__needs">' + needs + '</ul>' : '') +
        '</div>';
      sec.hidden = false;
      return;
    }
    sec.hidden = true;
  }

  /* ---------------------------------------------------------- adventure */

  function renderAdventure(d) {
    const sec = el('llfAdventureSec');
    const a = d.upcoming_adventure;
    if (!a) { sec.hidden = true; return; }

    const unit = a.days_to_go === 1 ? 'day to go' : 'days to go';
    sec.innerHTML =
      '<p class="llf-sec__label">Upcoming adventure</p>' +
      '<div class="llf-adv">' +
        '<div class="llf-card llf-adv__main llf-reveal" style="--i:0;--llf-tint:' + esc(a.accent) + '">' +
          '<span class="llf-adv__emoji">' + esc(a.emoji) + '</span>' +
          '<h2 class="llf-adv__name">' + esc(a.name) + '</h2>' +
          '<p class="llf-adv__date">' + esc(a.date_display || '') + '</p>' +
          '<div class="llf-adv__count">' +
            '<span class="llf-adv__num" data-llf-count="' + a.days_to_go + '">0</span>' +
            '<span class="llf-adv__unit">' + esc(unit) + '</span>' +
          '</div>' +
          '<p class="llf-adv__ready">' + esc(a.readiness) + '</p>' +
        '</div>' +
        '<div class="llf-card llf-adv__path llf-reveal" style="--i:1;--llf-tint:' + esc(a.accent) + '">' +
          '<p class="llf-adv__pathtitle">Funding</p>' +
          '<p class="llf-adv__pathnote">' + esc(a.current_display) + ' of ' + esc(a.target_display) + '</p>' +
          progressArt(a.progress_art, a.percentage, a.accent) +
        '</div>' +
      '</div>';
    sec.hidden = false;
  }

  /* -------------------------------------------------------------- stash */

  function renderStash(d) {
    const sec = el('llfStashSec');
    const s = d.stash;

    if (!s.count) {
      sec.innerHTML =
        '<p class="llf-sec__label">Experience stash</p>' +
        '<div class="llf-card llf-empty llf-reveal">' +
          '<h3 class="llf-empty__title">Nothing set aside for an experience yet</h3>' +
          '<p class="llf-empty__body">A stash is a savings goal with a better name. Start one and ' +
            'it shows up in your Goals, on your Financial Calendar and in the countdown above ' +
            'MoneyKal keeps one set of numbers, not two.</p>' +
          '<button type="button" class="llf-btn llf-btn--primary" data-llf-new="experience_trips">' +
            'Start a stash</button>' +
        '</div>';
      sec.hidden = false;
      return;
    }

    const items = s.items.map((i, idx) =>
      '<div class="llf-card llf-stash__item llf-reveal" style="--i:' + idx + ';--llf-tint:' +
           esc(i.accent) + '">' +
        '<div>' +
          '<div class="llf-stash__head">' +
            '<span class="llf-stash__emoji">' + esc(i.emoji) + '</span>' +
            '<div>' +
              '<h3 class="llf-stash__name">' + esc(i.name) + '</h3>' +
              '<p class="llf-stash__kind">' + esc(i.experience_label) +
                (i.target_date ? ' · ' + esc(formatDate(i.target_date)) : '') + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="llf-stash__figs">' +
            '<span class="llf-stash__saved">' + esc(i.current_display) + '</span>' +
            '<span class="llf-stash__target">of ' + esc(i.target_display) + '</span>' +
          '</div>' +
          '<p class="llf-stash__meta">' +
            (i.is_funded
              ? 'Fully funded. Go and use it.'
              : esc(i.remaining_display) + ' to go' +
                (i.monthly_required_display
                  ? ' \u00b7 about ' + esc(i.monthly_required_display) + ' a month to land on time'
                  : '')) +
          '</p>' +
          (i.shared_with_profile_ids && i.shared_with_profile_ids.length > 0 
            ? '<p class="llf-stash__meta" style="color:#a8e6cf; font-weight:500;">' + 
              '<svg style="width:14px; height:14px; vertical-align:middle; margin-right:4px;" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>' +
              'Shared with ' + i.shared_with_profile_ids.length + ' partner(s)</p>' 
            : '') +
          '<div class="llf-stash__actions">' +
            '<button type="button" class="llf-btn" data-llf-fund="' + i.id + '">Add money</button>' +
            (i.remaining > 0
              ? '<button type="button" class="llf-btn llf-btn--ghost" data-llf-ask="' +
                i.remaining + '">Can I afford the rest?</button>'
              : '') +
          '</div>' +
        '</div>' +
        '<div>' + progressArt(i.progress_art, i.percentage, i.accent) + '</div>' +
      '</div>').join('');

    sec.innerHTML =
      '<p class="llf-sec__label">Experience stash · ' + esc(s.total_saved_display) +
        ' set aside</p>' +
      '<div class="llf-stash">' + items + '</div>';
    sec.hidden = false;
  }

  function formatDate(iso) {
    try {
      return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return iso; }
  }

  /* --------------------------------------------------------- categories */

  function renderCategories(d) {
    const cards = (d.categories || []).map((c, idx) => {
      const has = c.stash_count > 0;
      return '<div class="llf-cat llf-reveal" style="--i:' + idx +
                 ';--llf-tint:' + esc(c.accent) + '" ' +
                 'data-llf-cat="' + esc(c.key) + '" data-llf-lead="' + (c.lead_stash_id || '') + '">' +
        '<button type="button" class="llf-cat__main" aria-label="Open category" style="width:100%; text-align:left; background:transparent; border:none; color:inherit; padding:0; cursor:pointer;" onclick="this.parentElement.click()">' +
          '<span class="llf-cat__bg-emoji" aria-hidden="true">' + esc(c.emoji) + '</span>' +
          '<span class="llf-cat__emoji">' + esc(c.emoji) + '</span>' +
          '<h3 class="llf-cat__name">' + esc(c.label) + '</h3>' +
          '<p class="llf-cat__blurb">' + esc(c.blurb) + '</p>' +
          (has
            ? '<div class="llf-cat__stat">' +
                '<span class="llf-cat__saved">' + esc(c.saved_display) + '</span>' +
                (c.target_display ? '<span class="llf-cat__of">of ' + esc(c.target_display) + '</span>' : '') +
              '</div>' +
              '<div class="llf-cat__bar"><i data-llf-bar="' + (c.percentage || 0) + '"></i></div>' +
              '<span class="llf-cat__cta">Open it <span>→</span></span>'
            : '<span class="llf-cat__cta">Start one <span>→</span></span>') +
        '</button>' +
        (has
          ? '<button type="button" class="llf-btn" data-llf-itinerary-cat="' + esc(c.key) + '" data-llf-itinerary-name="' + esc(c.label) + '" data-llf-itinerary-budget="' + c.saved + '" style="margin-top:10px; width:100%; font-size:13px; padding:6px; background:rgba(255,255,255,0.05)">Plan Itinerary</button>'
          : '') +
      '</div>';
    }).join('');

    el('llfCatsSec').innerHTML =
      '<p class="llf-sec__label">What are you saving to live?</p>' +
      '<div class="llf-cats">' + cards + '</div>';
  }

  /* ------------------------------------------------------- check + reco */

  function renderCheck(d) {
    const r = d.recommendation;
    const currency = d.user.currency;

    const reco = r
      ? '<div class="llf-card llf-reco llf-reveal" style="--i:1">' +
          '<p class="llf-sec__label" style="margin-bottom:14px">MoneyKal suggests</p>' +
          '<div class="llf-reco__amount" data-llf-money="' + r.amount + '">' +
            money(currency, 0) + '</div>' +
          '<p class="llf-reco__head">' + esc(r.headline) + '</p>' +
          '<p class="llf-reco__basis">' + esc(r.basis) + '</p>' +
          '<div class="llf-reco__links">' +
            '<button type="button" class="llf-btn" data-llf-ask="' + r.amount + '">' +
              'Check it against my plans</button>' +
          '</div>' +
        '</div>'
      : '<div class="llf-card llf-reco llf-reveal" style="--i:1">' +
          '<p class="llf-sec__label" style="margin-bottom:14px">MoneyKal suggests</p>' +
          '<p class="llf-reco__head">Nothing to suggest yet.</p>' +
          (d.freedom_balance && d.freedom_balance.status !== 'insufficient_data'
            ? '<p class="llf-reco__basis">Your Freedom Balance currently has no headroom for extra expenses. Focus on building your savings and buffer before planning new trips or big spends.</p>'
            : '<p class="llf-reco__basis">A recommendation needs your income, your expenses and your ' +
              'current savings. Once MoneyKal can see those, it will tell you what size of trip is ' +
              'genuinely comfortable, rather than guessing at one.</p>') +
        '</div>';

    const t = d.tradeoffs;
    const tradeOffUi = (t && t.status === 'active')
      ? '<div class="llf-card llf-tradeoff llf-reco llf-reveal" style="--i:2">' +
          '<h2 class="llf-check__title">Smart Tradeoffs</h2>' +
          '<p class="llf-check__sub">Move the slider to see how skipping some daily expenses accelerates your <strong>' + esc(t.primary_goal.name) + '</strong>.</p>' +
          '<div style="margin-bottom:20px">' +
            '<label for="llfTradeoffSlider" class="llf-tradeoff__label" style="display:flex; justify-content:space-between; font-size:14px; margin-bottom:10px;">' +
              '<span style="color:var(--llf-ink-muted)">Cut monthly spending by</span>' +
              '<strong id="llfTradeoffVal" style="color:var(--llf-tint)">' + money(currency, 0) + '</strong>' +
            '</label>' +
            '<input type="range" min="0" max="10000" step="500" value="0" id="llfTradeoffSlider" class="llf-slider" style="--llf-fill:0%">' +
          '</div>' +
          '<div id="llfTradeoffResult" style="padding:15px; background:rgba(255,255,255,0.05); border-radius:12px; font-size:14px; color:var(--llf-ink-muted); line-height:1.5;">' +
            'Drag the slider to see the impact.' +
          '</div>' +
        '</div>'
      : '';
        
    const sweepUi = '<div class="llf-card llf-reco llf-reveal" style="--i:3">' +
            '<p class="llf-sec__label" style="margin-bottom:14px">Auto-Sweeps</p>' +
            '<p class="llf-reco__head" style="font-size:16px;">Automatically sweep unspent budget to your goals</p>' +
            '<p class="llf-reco__basis" style="margin-top:10px;">At the end of the month, any money you didn\'t spend will automatically accelerate your primary goal.</p>' +
            '<div class="llf-reco__links" style="margin-top:16px;">' +
              '<button type="button" class="llf-btn" data-llf-sweep="true">Run Sweep Now</button>' +
            '</div>' +
          '</div>';

    el('llfCheckSec').innerHTML =
      '<p class="llf-sec__label">Before you book it</p>' +
      '<div class="llf-check">' +
        '<div class="llf-card llf-check__panel llf-reveal" style="--i:0">' +
          '<h2 class="llf-check__title">Can I afford it?</h2>' +
          '<p class="llf-check__sub">Ask about any amount. The answer is measured against the same ' +
            'Freedom Balance above, with your bills, your goals and your buffer all included.</p>' +
          '<form class="llf-check__form" id="llfCheckForm">' +
            '<input class="llf-check__input" id="llfCheckAmount" type="number" min="1" step="100" ' +
              'inputmode="numeric" placeholder="' + esc(currency) + ' amount" ' +
              'aria-label="Amount to check">' +
            '<button type="submit" class="llf-btn llf-btn--primary" id="llfCheckBtn">Ask</button>' +
          '</form>' +
          '<div class="llf-check__quick">' +
            [2000, 10000, 25000, 60000].map(v =>
              '<button type="button" class="llf-quick" data-llf-quick="' + v + '">' +
                money(currency, v) + '</button>').join('') +
          '</div>' +
          '<div class="llf-verdict" id="llfVerdict" hidden aria-live="polite"></div>' +
        '</div>' +
        reco + tradeOffUi + sweepUi +
      '</div>';
  }

  const VERDICT_LABEL = {
    comfortable: 'Comfortable',
    stretch: 'A stretch',
    not_yet: 'Not yet',
    unknown: 'Unknown'
  };

  function renderVerdict(v) {
    const box = el('llfVerdict');
    if (!box) return;
    const impacts = (v.impacts || []).map(i =>
      '<li>' + esc(i.label) + (i.detail ? '<em>' + esc(i.detail) + '</em>' : '') + '</li>').join('');
    box.dataset.verdict = v.verdict;
    box.innerHTML =
      '<span class="llf-verdict__tag">' + esc(VERDICT_LABEL[v.verdict] || v.verdict) + '</span>' +
      '<h3 class="llf-verdict__head">' + esc(v.headline) + '</h3>' +
      (v.detail ? '<p class="llf-verdict__detail">' + esc(v.detail) + '</p>' : '') +
      (impacts ? '<ul class="llf-verdict__impacts">' + impacts + '</ul>' : '');
    box.hidden = false;
  }

  /* --------------------------------------------------------- whole page */

  function render() {
    const d = state.data;
    if (!d) return;

    el('llfSubtitle').innerHTML = (d.identity.lines || [])
      .map(l => '<span>' + esc(l) + '</span>').join('');

    renderStory(d);
    renderMoment(d);
    renderAdventure(d);
    renderStash(d);
    renderCategories(d);
    renderCheck(d);

    const scroll = el('llfScroll');
    observeReveals(scroll);
    // The opening is above the fold and must not wait on an intersection, but
    // it does wait two frames: added in the same frame it was inserted, the
    // class would skip straight to the end state and the income bar would
    // never be seen filling. Everything below is drawn by the observer as it
    // arrives — a road that finishes its journey before the user has scrolled
    // to it is a road they never saw.
    const above = scroll.querySelectorAll('.llf-hero .llf-reveal');
    requestAnimationFrame(() => requestAnimationFrame(() =>
      above.forEach(n => n.classList.add('is-in'))));

    // Secondary counters (days to go, the suggested amount).
    scroll.querySelectorAll('[data-llf-count]').forEach(n => {
      const target = Number(n.dataset.llfCount) || 0;
      if (reduced.matches) { n.textContent = target; return; }
      const start = performance.now();
      (function step(now) {
        const t = Math.min((now - start) / 1200, 1);
        n.textContent = Math.round(target * easeOutExpo(t));
        if (t < 1) requestAnimationFrame(step);
      })(start);
    });
    scroll.querySelectorAll('[data-llf-money]').forEach(n => {
      setTimeout(() => countUp(n, Number(n.dataset.llfMoney) || 0, d.user.currency, 1300),
                 reduced.matches ? 0 : 500);
    });
    setTimeout(() => {
      scroll.querySelectorAll('[data-llf-bar]').forEach(n => {
        n.style.width = Math.max(0, Math.min(Number(n.dataset.llfBar) || 0, 100)) + '%';
      });
    }, reduced.matches ? 0 : 400);
  }

  function renderError(message) {
    el('llfHeroCards').innerHTML =
      '<header class="llf-fb__open llf-reveal is-in">' +
        '<div class="llf-fb__headline">' +
          '<p class="llf-fb__eyebrow">My Freedom Balance</p>' +
          '<h1 class="llf-fb__figure"><span class="llf-fb__lead llf-fb__lead--definition">' +
            DEFINITION + '</span></h1>' +
        '</div>' +
        '<div class="llf-fb__reading" data-state="unknown">' +
          '<p class="llf-fb__reading-title">Your numbers didn’t load</p>' +
          '<p class="llf-fb__reading-body">' + esc(message) + '</p>' +
          '<div class="llf-fb__actions">' +
            '<button type="button" class="llf-btn" data-llf-retry>Try again</button>' +
          '</div>' +
        '</div>' +
      '</header>';
    ['llfShapeSec', 'llfLeverSec', 'llfMeaningSec',
     'llfMomentSec', 'llfAdventureSec', 'llfStashSec'].forEach(id => { el(id).hidden = true; });
    el('llfCatsSec').innerHTML = '';
    el('llfCheckSec').innerHTML = '';
  }

  /* ======================================================================
     Data
     ====================================================================== */

  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    try {
      state.data = await window.api.fetchLiveLife();
      render();
    } catch (err) {
      console.error('live.life.fully could not load', err);
      state.error = err;
      renderError(err && err.message ? err.message : 'Could not reach your numbers just now.');
    } finally {
      state.loading = false;
    }
  }

  /** After any write, both this experience and the Daily Home re-read. They
   *  share the same goals, so refreshing one without the other would leave the
   *  Overview showing a stale figure the moment the user closes this. */
  async function refreshEverything() {
    await load();
    if (window.dailyHome && typeof window.dailyHome.render === 'function') {
      try { await window.dailyHome.render({ force: true }); } catch (e) { /* non-fatal */ }
    }
  }

  /* ======================================================================
     Open / close
     ====================================================================== */

  function open(opts) {
    if (!state.enabled || state.open) return;
    const root = el('llf');
    if (!root) return;

    state.open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('llf-open');

    // Force a reflow so the entrance transition has a starting frame.
    void root.offsetWidth;
    root.classList.add('is-open');

    showScene(state.sceneIndex);
    startSceneCycle();
    startParticles();
    // Not awaited, and deliberately last: the page is already alive by the
    // time the clip starts downloading.
    mountBackdrop();
    if (state.backdropActive) startAccentCycle();
    el('llfScroll').scrollTop = 0;

    if (!state.data) load();
    else render();

    if (!(opts && opts.fromHistory)) {
      try { history.pushState({ llf: true }, '', '#live'); } catch (e) { /* file:// */ }
    }
    setTimeout(() => { const c = el('llfClose'); if (c) c.focus(); }, 120);
  }

  function close(opts) {
    if (!state.open) return;
    const root = el('llf');
    state.open = false;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('llf-open');
    stopSceneCycle();
    stopAccentCycle();
    stopParticles();
    if (state.backdrop) state.backdrop.pause();
    closeSheet();

    setTimeout(() => { if (!state.open) root.hidden = true; }, 600);

    if (!(opts && opts.fromHistory)) {
      // Only unwind our own history entry — never the user's.
      if (history.state && history.state.llf) history.back();
      else if (location.hash === '#live') {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      }
    }
    const portal = el('llfPortal');
    if (portal) portal.focus();
  }

  /* ======================================================================
     The sheet — create a stash, fund a stash
     ====================================================================== */

  function closeSheet() {
    const sheet = el('llfSheet');
    if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; }
    state.sheet = null;
  }

  function openItinerarySheet(catKey, catName, budget) {
    const d = state.data;
    state.sheet = { kind: 'itinerary' };
    const sheet = el('llfSheet');
    
    sheet.innerHTML =
      '<div class="llf-sheet__panel" role="dialog" aria-modal="true" aria-label="Plan Itinerary" style="max-width: 650px;">' +
        '<h2 class="llf-sheet__title">Plan ' + esc(catName) + ' Itinerary</h2>' +
        '<p class="llf-sheet__sub">Set your preferences before we curate the perfect experience.</p>' +
        '<form id="llfItineraryForm" style="margin-top: 20px;">' +
          '<label class="llf-field"><span>👥 Split with friends? (Multiplayer Budget)</span>' +
            '<input id="llfSplitCount" type="number" min="1" max="10" value="1" required></label>' +
          '<div class="llf-sheet__actions" style="margin-top: 20px;">' +
            '<button type="button" class="llf-btn llf-btn--ghost" data-llf-sheet-cancel>Cancel</button>' +
            '<button type="submit" class="llf-btn llf-btn--primary">Generate AI Itinerary</button>' +
          '</div>' +
        '</form>' +
        '<div id="llfItineraryBody" class="llf-itinerary-loading" style="margin-top: 16px;">' +
        '</div>' +
        '<div class="llf-sheet__acts" style="margin-top: 20px;">' +
          '<button type="button" class="llf-btn llf-btn--ghost" onclick="window.liveLife.closeSheet()">Close</button>' +
        '</div>' +
      '</div>';
      
    sheet.hidden = false;
    setTimeout(() => sheet.classList.add('is-open'), 10);
    
    const form = el('llfItineraryForm');
    form.onsubmit = function(e) {
      e.preventDefault();
      const splitCount = parseInt(el('llfSplitCount').value, 10) || 1;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = '✨ Curating Experience...';
      
      const body = el('llfItineraryBody');
      body.innerHTML = '<div style="text-align:center; padding: 40px; color: #a1a1aa;">Designing your perfectly balanced escape...</div>';

      window.api.generateItinerary({
          category_id: catKey,
          category_name: catName,
          budget: Number(budget),
          currency: d.user.currency,
          split_count: splitCount
      }).then(res => {
        if (!body) return;
        if (res.html) {
          form.style.display = 'none';
          el('llfSheet').querySelector('.llf-sheet__title').textContent = "Your " + esc(catName) + " Itinerary";
          el('llfSheet').querySelector('.llf-sheet__sub').textContent = "Tailored perfectly for " + splitCount + (splitCount>1?" people":" person") + ".";
          body.innerHTML = res.html;
        } else {
          body.textContent = "Could not generate itinerary.";
          btn.disabled = false;
          btn.textContent = 'Try Again';
        }
      }).catch(err => {
        if (body) body.textContent = "Error: " + err.message;
        btn.disabled = false;
        btn.textContent = 'Try Again';
      });
    };
  }

  function playItineraryAudio(url) {
    const audio = new Audio(url);
    audio.play();
  }

  function openCreateSheet(categoryKey) {
    const d = state.data;
    const cats = (d && d.categories) || [];
    const options = cats.map(c =>
      '<option value="' + esc(c.key) + '"' + (c.key === categoryKey ? ' selected' : '') + '>' +
        esc(c.emoji) + '  ' + esc(c.label) + '</option>').join('');
    const chosen = cats.find(c => c.key === categoryKey) || cats[0] || {};

    state.sheet = { kind: 'create' };
    const sheet = el('llfSheet');
    sheet.innerHTML =
      '<div class="llf-sheet__panel" role="dialog" aria-modal="true" aria-label="Start an experience stash">' +
        '<h2 class="llf-sheet__title">Start a stash</h2>' +
        '<p class="llf-sheet__sub">This creates a savings goal, so it also appears in your Goals, ' +
          'your savings progress and your Financial Calendar. One set of numbers.</p>' +
        '<p class="llf-sheet__err" id="llfSheetErr" hidden></p>' +
        '<form id="llfSheetForm">' +
          '<label class="llf-field"><span>What is it?</span>' +
            '<input id="llfNewName" type="text" maxlength="120" required ' +
              'placeholder="' + esc(chosen.label === 'Trips' ? 'Goa trip' : (chosen.label || 'Experience')) + '"></label>' +
          '<label class="llf-field"><span>Type</span>' +
            '<select id="llfNewCat">' + options + '</select></label>' +
          '<div class="llf-field--split">' +
            '<label class="llf-field"><span>Target amount</span>' +
              '<input id="llfNewTarget" type="number" min="1" step="100" required ' +
                'placeholder="' + esc((d && d.user.currency) || '₹1') + '"></label>' +
            '<label class="llf-field"><span>Already saved</span>' +
              '<input id="llfNewCurrent" type="number" min="0" step="100" value="0"></label>' +
          '</div>' +
          '<label class="llf-field"><span>When is it? (optional)</span>' +
            '<input id="llfNewDate" type="date"></label>' +
          '<div class="llf-sheet__actions">' +
            '<button type="button" class="llf-btn llf-btn--ghost" data-llf-sheet-cancel>Cancel</button>' +
            '<button type="submit" class="llf-btn llf-btn--primary" id="llfSheetSubmit">Create stash</button>' +
          '</div>' +
        '</form>' +
      '</div>';
    sheet.hidden = false;
    setTimeout(() => { const n = el('llfNewName'); if (n) n.focus(); }, 60);
  }

  function openFundSheet(goalId) {
    const d = state.data;
    const item = (d.stash.items || []).find(i => String(i.id) === String(goalId));
    if (!item) return;
    const free = d.freedom_balance.value;

    state.sheet = { kind: 'fund', item: item };
    const sheet = el('llfSheet');
    sheet.innerHTML =
      '<div class="llf-sheet__panel" role="dialog" aria-modal="true" aria-label="Add money to this stash">' +
        '<h2 class="llf-sheet__title">' + esc(item.emoji) + ' ' + esc(item.name) + '</h2>' +
        '<p class="llf-sheet__sub">' + esc(item.current_display) + ' of ' + esc(item.target_display) +
          ' so far' + (item.remaining > 0 ? ' · ' + esc(item.remaining_display) + ' to go' : '') +
          '.</p>' +
        '<p class="llf-sheet__err" id="llfSheetErr" hidden></p>' +
        '<form id="llfSheetForm">' +
          '<label class="llf-field"><span>Amount to add</span>' +
            '<input id="llfFundAmount" type="number" min="1" step="100" required ' +
              'placeholder="' + esc(d.user.currency) + '"></label>' +
          (free ? '<p class="llf-sheet__sub" style="margin:-6px 0 16px">Your Freedom Balance is ' +
                  esc(d.freedom_balance.display) + ' right now.</p>' : '') +
          '<div class="llf-sheet__actions">' +
            '<button type="button" class="llf-btn llf-btn--ghost" data-llf-sheet-cancel>Cancel</button>' +
            '<button type="submit" class="llf-btn llf-btn--primary" id="llfSheetSubmit">Add to stash</button>' +
          '</div>' +
        '</form>' +
      '</div>';
    sheet.hidden = false;
    setTimeout(() => { const n = el('llfFundAmount'); if (n) n.focus(); }, 60);
  }

  function sheetError(msg) {
    const box = el('llfSheetErr');
    if (!box) return;
    box.textContent = msg;
    box.hidden = false;
  }

  async function submitSheet(e) {
    e.preventDefault();
    const btn = el('llfSheetSubmit');
    const err = el('llfSheetErr');
    if (err) err.hidden = true;
    if (!state.sheet || !btn) return;

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      if (state.sheet.kind === 'create') {
        const target = Number(el('llfNewTarget').value);
        const current = Number(el('llfNewCurrent').value) || 0;
        if (!target || target <= 0) throw new Error('Give the stash a target amount.');
        if (current > target) throw new Error('You cannot have saved more than the target.');
        await window.api.createGoal({
          name: el('llfNewName').value.trim(),
          target_amount: target,
          current_amount: current,
          target_date: el('llfNewDate').value || null,
          category: el('llfNewCat').value,
          icon: null
        });
      } else {
        const add = Number(el('llfFundAmount').value);
        if (!add || add <= 0) throw new Error('Enter an amount to add.');
        const item = state.sheet.item;
        // The API refuses a current_amount above the target, so a generous
        // top-up lands the stash on its target rather than being rejected.
        const next = Math.min(item.current_amount + add, item.target_amount);
        await window.api.updateGoal(item.id, { current_amount: next });
      }
      closeSheet();
      await refreshEverything();
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = label;
      sheetError(ex && ex.message ? ex.message : 'That did not save. Try again.');
    }
  }

  /* ======================================================================
     Interactions
     ====================================================================== */

  function scrollToSection(id) {
    const target = el(id);
    const scroll = el('llfScroll');
    if (!target || !scroll) return;
    const top = Math.max(target.offsetTop - 80, 0);
    // Element.scrollTo with options is not universal; falling back to
    // scrollTop keeps the navigation working rather than throwing and
    // aborting whatever called this.
    if (typeof scroll.scrollTo === 'function') {
      try {
        scroll.scrollTo({ top: top, behavior: reduced.matches ? 'auto' : 'smooth' });
        return;
      } catch (e) {}
    }
    scroll.scrollTop = top;
  }

  async function askAffordability(amount) {
    const input = el('llfCheckAmount');
    if (input) input.value = amount;
    scrollToSection('llfCheckSec');

    const btn = el('llfCheckBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const verdict = await window.api.checkExperienceAffordability(Number(amount));
      renderVerdict(verdict);
    } catch (err) {
      renderVerdict({
        verdict: 'unknown',
        headline: 'That check did not go through.',
        detail: err && err.message ? err.message : 'Try again in a moment.',
        impacts: []
      });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Ask'; }
    }
  }

  function wire() {
    const portal = el('llfPortal');
    if (portal) portal.addEventListener('click', () => open());

    const closeBtn = el('llfClose');
    if (closeBtn) closeBtn.addEventListener('click', () => close());

    const ambienceBtn = el('llfAmbience');
    if (ambienceBtn) {
      ambienceBtn.addEventListener('click', () => {
        state.ambience = !state.ambience;
        ambienceBtn.setAttribute('aria-pressed', String(!state.ambience));
        ambienceBtn.title = state.ambience ? 'Pause the background' : 'Resume the background';
        if (state.ambience) {
          startSceneCycle(); startParticles(); startAccentCycle();
          if (state.backdrop) state.backdrop.play().catch(() => {});
        } else {
          stopSceneCycle(); stopParticles(); stopAccentCycle();
          if (state.backdrop) state.backdrop.pause();
        }
      });
    }

    const dots = el('llfDots');
    if (dots && window.LLF_SCENES) {
      dots.innerHTML = window.LLF_SCENES.list.map((s, i) =>
        '<button type="button" class="llf__dot" data-llf-scene="' + i + '" ' +
          'aria-label="Show ' + esc(s.label) + '"></button>').join('');
    }

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !state.open) return;
      if (el('llfSheet') && !el('llfSheet').hidden) { closeSheet(); return; }
      close();
    });

    window.addEventListener('popstate', () => {
      if (state.open) close({ fromHistory: true });
      else if (location.hash === '#live' && state.enabled) open({ fromHistory: true });
    });

    const root = el('llf');
    if (root) root.addEventListener('pointermove', onPointerMove);

    // One delegated handler for everything inside the overlay.
    if (root) root.addEventListener('click', async e => {
      const t = e.target;

      const dot = t.closest('[data-llf-scene]');
      if (dot) { showScene(Number(dot.dataset.llfScene)); startSceneCycle(); return; }

      const why = t.closest('[data-llf-why]');
      if (why) {
        const body = why.nextElementSibling;
        if (body) {
          body.hidden = !body.hidden;
          why.textContent = body.hidden ? 'How is this worked out?' : 'Hide the working';
        }
        return;
      }

      const lever = t.closest('[data-llf-lever]');
      if (lever) { toggleLever(lever); return; }

      if (t.closest('[data-llf-simulate]')) { simulateLevers(); return; }

      if (t.closest('[data-llf-profile]')) {
        leaveTo(null, () => {
          const edit = el('btnOpenEditProfile');
          if (edit) edit.click();
        });
        return;
      }

      if (t.closest('[data-llf-hisaab]')) { leaveTo('hisaab'); return; }

      const goto = t.closest('[data-llf-goto]');
      if (goto) { scrollToSection(goto.dataset.llfGoto); return; }

      const retry = t.closest('[data-llf-retry]');
      if (retry) { load(); return; }

      const it = t.closest('[data-llf-itinerary-cat]');
      if (it) { 
        openItinerarySheet(it.dataset.llfItineraryCat, it.dataset.llfItineraryName, it.dataset.llfItineraryBudget);
        return; 
      }
      
      const sweep = t.closest('[data-llf-sweep]');
      if (sweep) {
        const btn = sweep;
        btn.disabled = true;
        btn.textContent = 'Sweeping...';
        window.api.runSweep().then(res => {
          if (res.swept) {
            btn.textContent = 'Swept ' + money(state.data.user.currency, res.total_amount);
          } else {
            btn.textContent = 'No underspend to sweep';
          }
        }).catch(err => {
          if (err.status === 402 && window.billingView && window.billingView.prompt(err.detail)) {
            btn.textContent = 'Run Sweep Now';
            btn.disabled = false;
            return;
          }
          btn.textContent = 'Error sweeping';
          btn.disabled = false;
        });
        return;
      }

      const quick = t.closest('[data-llf-quick]');
      if (quick) { askAffordability(Number(quick.dataset.llfQuick)); return; }

      const ask = t.closest('[data-llf-ask]');
      if (ask) { askAffordability(Number(ask.dataset.llfAsk)); return; }

      const fund = t.closest('[data-llf-fund]');
      if (fund) { openFundSheet(fund.dataset.llfFund); return; }

      const create = t.closest('[data-llf-new]');
      if (create) { openCreateSheet(create.dataset.llfNew); return; }

      const cat = t.closest('[data-llf-cat]');
      if (cat) {
        // A category the user already has a stash in scrolls to it; an empty
        // one opens the create sheet, pre-typed.
        if (cat.dataset.llfLead) scrollToSection('llfStashSec');
        else openCreateSheet(cat.dataset.llfCat);
        return;
      }

      const momentAction = t.closest('[data-llf-moment-action]');
      if (momentAction) {
        const target = momentAction.dataset.llfMomentAction || '';
        if (target.indexOf('stash:') === 0) openFundSheet(target.split(':')[1]);
        else scrollToSection('llfCatsSec');
        return;
      }

      if (t.closest('[data-llf-sheet-cancel]')) { closeSheet(); return; }
      if (t.id === 'llfSheet') { closeSheet(); return; }
    });

    // Forms are delegated too, since both the check form and the sheet form
    // are re-created on every render.
    if (root) root.addEventListener('submit', e => {
      if (e.target.id === 'llfCheckForm') {
        e.preventDefault();
        const amount = Number(el('llfCheckAmount').value);
        if (amount > 0) askAffordability(amount);
        return;
      }
      if (e.target.id === 'llfSheetForm') submitSheet(e);
    });

    if (root) root.addEventListener('input', e => {
      if (e.target.id === 'llfTradeoffSlider') {
        const val = Number(e.target.value);
        // Paint the filled portion of the track. A range input cannot style
        // "everything left of the thumb" on its own, so the fill is a gradient
        // stop the CSS reads from this variable.
        const max = Number(e.target.max) || 1;
        e.target.style.setProperty('--llf-fill', (val / max * 100) + '%');

        const t = state.data && state.data.tradeoffs;
        if (!t || !t.primary_goal) return;
        
        el('llfTradeoffVal').textContent = money(t.currency, val);
        const res = el('llfTradeoffResult');
        
        if (val === 0) {
          res.innerHTML = 'Drag the slider to see the impact.';
          res.style.color = 'var(--llf-ink-muted)';
          return;
        }
        
        const rem = t.primary_goal.remaining;
        const rate = t.monthly_savings_rate;
        
        if (rate <= 0) {
          res.innerHTML = 'Your current savings rate is 0. Saving ' + money(t.currency, val) + ' more will fund this in <strong>' + Math.ceil(rem / val) + ' months</strong>.';
          res.style.color = 'inherit';
          return;
        }
        
        const currentMonths = rem / rate;
        const newMonths = rem / (rate + val);
        const monthsSaved = currentMonths - newMonths;
        
        if (monthsSaved < 0.1) {
          res.innerHTML = 'This accelerates your goal slightly, but not by a full week.';
          res.style.color = 'inherit';
        } else {
          const weeksSaved = Math.round(monthsSaved * 4.3);
          res.innerHTML = 'You will fund <strong>' + esc(t.primary_goal.name) + '</strong> approx <strong>' + (weeksSaved >= 4 ? Math.round(weeksSaved/4.3) + ' months' : weeksSaved + ' weeks') + ' earlier</strong>.';
          res.style.color = '#fff';
        }
      }
    });

    // Pause everything while the tab is in the background.
    document.addEventListener('visibilitychange', () => {
      if (!state.open) return;
      if (document.hidden) {
        stopSceneCycle(); stopParticles(); stopAccentCycle();
        if (state.backdrop) state.backdrop.pause();
      } else if (state.ambience) {
        startSceneCycle(); startParticles(); startAccentCycle();
        if (state.backdrop) state.backdrop.play().catch(() => {});
      }
    });

    if (reduced.addEventListener) {
      reduced.addEventListener('change', () => {
        if (!state.open) return;
        if (reduced.matches) {
          stopSceneCycle(); stopParticles(); stopAccentCycle();
          if (state.backdrop) state.backdrop.pause();
        } else {
          startSceneCycle(); startParticles(); startAccentCycle();
          if (state.backdrop) state.backdrop.play().catch(() => {});
        }
      });
    }
  }

  wire();

  /* ---------------------------------------------------------- public API
     overview.js calls in here once the profile is known, exactly as it does
     for window.dailyHome — this file never races the Overview for the DOM. */

  window.liveLife = {
    /** Individual profiles only. A Startup founder's Overview, and their
     *  sidebar, are left exactly as they were. */
    setEnabled(enabled) {
      state.enabled = !!enabled;
      const portal = el('llfPortal');
      if (portal) portal.hidden = !state.enabled;
      if (!state.enabled) {
        if (state.open) close();
        state.data = null;
        return;
      }
      // Deep link: arriving on /dashboard.html#live opens straight into it.
      if (location.hash === '#live' && !state.open) open({ fromHistory: true });
    },
    open() { open(); },
    close() { close(); },
    closeSheet() {
      const sheet = el('llfSheet');
      if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; }
      state.sheet = null;
    },
    playItineraryAudio() {
      const body = el('llfItineraryBody');
      if (!body) return;
      
      // Clean up text for TTS
      const textToRead = "Here is your curated AI itinerary. " + body.innerText.replace(/Book Session|Reserve Yacht|Book Table/g, '');
      
      if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(textToRead);
        utterance.rate = 0.95;
        utterance.pitch = 1.0;
        
        // Pick a nice English voice if available
        const voices = window.speechSynthesis.getVoices();
        const prefVoice = voices.find(v => v.name.includes('Google UK English Female') || v.name.includes('Samantha') || v.name.includes('Natural'));
        if (prefVoice) utterance.voice = prefVoice;
        
        window.speechSynthesis.cancel(); // Stop anything playing
        window.speechSynthesis.speak(utterance);
      } else {
        alert("Audio playback is not supported in this browser.");
      }
    },
    data() { return state.data; }
  };

})();
