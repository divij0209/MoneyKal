/* ==========================================================================
   MoneyKal — public homepage behaviour

   No animation framework. The entrance sequence and every hover live in CSS;
   this file only supplies the four things CSS cannot do on its own:

     1. tell an element it has entered the viewport (IntersectionObserver),
     2. count a number toward a target (requestAnimationFrame),
     3. move the Ask/Simulate demos between states,
     4. the nav's stuck state, the mobile sheet and the progress hairline.

   That keeps the page at zero third-party JS — the previous build pulled in
   Lenis, GSAP + ScrollTrigger and Three.js for the same result.

   Reduced motion is honoured by skipping the work entirely rather than by
   running it faster: counters jump to their target, demos render their first
   state and stop, and nothing loops.
   ========================================================================== */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /** Escapes anything interpolated into innerHTML. The demo copy is authored
   *  here rather than user-supplied, but the helper keeps that guarantee local
   *  instead of implicit. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------------------------------------------------------- nav */

  function initNav() {
    var nav = $('#mkNav');
    var burger = $('#mkBurger');
    var sheet = $('#mkMobileMenu');
    var bar = $('#mkProgressBar');
    if (!nav) return;

    // One scroll listener drives both the nav state and the progress bar, read
    // inside a rAF so we never measure layout on the scroll event itself.
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY || window.pageYOffset;
        nav.classList.toggle('is-stuck', y > 24);
        if (bar) {
          var max = document.documentElement.scrollHeight - window.innerHeight;
          bar.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + '%';
        }
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (!burger || !sheet) return;

    function setMenu(open) {
      burger.setAttribute('aria-expanded', String(open));
      sheet.hidden = !open;
      // Lock the page behind the sheet so scrolling does not bleed through.
      document.body.style.overflow = open ? 'hidden' : '';
    }
    burger.addEventListener('click', function () {
      setMenu(burger.getAttribute('aria-expanded') !== 'true');
    });
    // Any navigation closes it — including the anchor links inside.
    sheet.addEventListener('click', function (e) {
      if (e.target.closest('a')) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setMenu(false);
    });
    // A resize past the breakpoint must not leave the page scroll-locked.
    window.addEventListener('resize', function () {
      if (window.innerWidth > 1080 && burger.getAttribute('aria-expanded') === 'true') setMenu(false);
    });
  }

  /* ------------------------------------------------------------- reveal */

  function initReveal() {
    var targets = $$('[data-reveal]');
    if (!targets.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('is-in'); });
      startCounters(document);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        // Counters belong to the section that just arrived, so they start in
        // sync with its reveal rather than on a timer of their own.
        startCounters(entry.target);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

    targets.forEach(function (el) { io.observe(el); });
  }

  /* ------------------------------------------------------------ counters */

  function formatIndian(n) {
    // ₹1,23,456 grouping, matching how the product renders money.
    var whole = String(Math.round(n));
    if (whole.length <= 3) return whole;
    var head = whole.slice(0, -3), tail = whole.slice(-3), parts = [];
    while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2); }
    if (head) parts.unshift(head);
    return parts.join(',') + ',' + tail;
  }

  function renderCount(el, value) {
    el.textContent = (el.dataset.prefix || '') + formatIndian(value) + (el.dataset.suffix || '');
  }

  function countTo(el, to, duration) {
    var from = parseFloat(el.dataset.current || '0');
    if (reduceMotion) {
      el.dataset.current = to;
      renderCount(el, to);
      return;
    }
    if (el._raf) cancelAnimationFrame(el._raf);
    var start = null;
    var span = to - from;
    var ms = duration || 1400;

    function frame(now) {
      if (start === null) start = now;
      var t = Math.min((now - start) / ms, 1);
      // Matches the CSS easing so counters feel part of the same system.
      var eased = 1 - Math.pow(1 - t, 3);
      var value = from + span * eased;
      renderCount(el, value);
      if (t < 1) {
        el._raf = requestAnimationFrame(frame);
      } else {
        el.dataset.current = to;
        el._raf = null;
      }
    }
    el._raf = requestAnimationFrame(frame);
  }

  function startCounters(scope) {
    $$('[data-count]', scope).forEach(function (el) {
      if (el.dataset.done === '1') return;
      el.dataset.done = '1';
      countTo(el, parseFloat(el.dataset.count), 1600);
    });
  }
  /* ======================================================================
     PRODUCT SHOWCASES

     Six demos that explain a feature by performing it. They share three rules:

       1. Each runs only while on screen (`whenVisible`), so nothing loops in a
          background tab and a long page costs no idle CPU.
       2. Each has a `still()` that paints its finished state. That is what
          reduced motion gets — a complete, readable result, not a faster one.
       3. All copy and all figures live in the markup or in one data table per
          demo. Nothing user-visible is buried in control flow.
     ====================================================================== */

  /** Runs `start` when the element is meaningfully on screen, and `stop` when
   *  it leaves. Under reduced motion (or without IO) it calls `still` once.
   *
   *  The stop is deliberately delayed. A demo should not be torn down by a
   *  momentary scroll — anchor jumps, a browser scrolling an element into view,
   *  or a flick past the section all fire a non-intersecting entry that is
   *  immediately followed by an intersecting one. Without the grace period the
   *  visitor sees the demo restart from nothing at exactly the moment they
   *  arrive at it. */
  var VISIBILITY_GRACE_MS = 450;

  function whenVisible(el, start, stop, still) {
    if (!el) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      if (still) still();
      return;
    }
    var running = false;
    var pending = null;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          if (pending) { clearTimeout(pending); pending = null; }
          if (!running) { running = true; start(); }
        } else if (running && !pending) {
          pending = setTimeout(function () {
            pending = null;
            running = false;
            if (stop) stop();
          }, VISIBILITY_GRACE_MS);
        }
      });
    }, { threshold: 0.25 });
    io.observe(el);
  }

  /** A cancellable sequence of steps. Every demo drives itself through one of
   *  these, so stopping a demo is always a single `.cancel()`. */
  function Timeline() {
    this._t = null;
    this._dead = false;
  }
  Timeline.prototype.after = function (ms, fn) {
    var self = this;
    this._t = setTimeout(function () { if (!self._dead) fn(); }, ms);
    return this;
  };
  Timeline.prototype.cancel = function () {
    this._dead = true;
    if (this._t) clearTimeout(this._t);
    this._t = null;
  };

  var money = function (n) { return '₹' + formatIndian(Math.abs(n)); };

  /* ------------------------------------------------------- 1. HISAAB ---- */

  // An illustrative month, ordered as it would actually arrive. Kept here in
  // one table so the ledger, the totals and the category bars can never
  // disagree — every figure on screen is derived from these rows.
  var HISAAB_ENTRIES = [
    { icon: '💼', name: 'August salary',      cat: 'Salary',            amt:  118000, type: 'in'  },
    { icon: '🏠', name: 'Rent',                 cat: 'Rent / Housing',    amt:  -26000, type: 'out' },
    { icon: '🛒', name: 'Big Basket',           cat: 'Groceries',         amt:   -4200, type: 'out' },
    { icon: '📺', name: 'Netflix',              cat: 'Subscriptions',     amt:    -649, type: 'out' },
    { icon: '🍽️', name: 'Dinner at Koramangala', cat: 'Food & Dining',     amt:   -1850, type: 'out' },
    { icon: '⚡', name: 'Electricity bill',     cat: 'Utilities & Bills', amt:   -2400, type: 'out' },
    { icon: '🛍️', name: 'Laptop stand + desk',  cat: 'Shopping',          amt:  -14000, type: 'out' },
    { icon: '🛒', name: 'Weekly groceries',     cat: 'Groceries',         amt:   -3100, type: 'out' },
    { icon: '🚕', name: 'Cabs',                 cat: 'Travel & Transport',amt:   -1420, type: 'out' },
    { icon: '💻', name: 'Freelance invoice',    cat: 'Freelance',         amt:   18000, type: 'in'  }
  ];

  function initHisaab() {
    var root = $('[data-demo="hisaab"]');
    var list = $('#mkHisaabList');
    if (!root || !list) return;

    var countEl = $('#mkHisaabCount');
    var inEl = $('#mkHisaabIn'), outEl = $('#mkHisaabOut'), netEl = $('#mkHisaabNet');
    var catsEl = $('#mkHisaabCats');

    function rowHtml(e) {
      var sign = e.type === 'in' ? '+' : '−';
      return '<li class="mk-hisaab__row is-' + e.type + '" data-cat="' + esc(e.cat) + '">'
        + '<span class="mk-hisaab__icon" aria-hidden="true">' + e.icon + '</span>'
        + '<span><span class="mk-hisaab__name">' + esc(e.name) + '</span>'
        + '<span class="mk-hisaab__cat">' + esc(e.cat) + '</span></span>'
        + '<span class="mk-hisaab__amt">' + sign + money(e.amt) + '</span>'
        + '</li>';
    }

    // Category totals are recomputed from whatever has landed so far, never
    // accumulated separately — the bars are a view of the ledger, not a copy.
    function paintCats(upto) {
      var totals = {};
      for (var i = 0; i < upto; i++) {
        var e = HISAAB_ENTRIES[i];
        if (e.type !== 'out') continue;
        totals[e.cat] = (totals[e.cat] || 0) + Math.abs(e.amt);
      }
      var rows = Object.keys(totals).map(function (k) { return { cat: k, amt: totals[k] }; })
        .sort(function (a, b) { return b.amt - a.amt; })
        .slice(0, 5);
      var max = rows.length ? rows[0].amt : 1;

      // Reuse existing nodes so the bars transition rather than restart.
      rows.forEach(function (r, i) {
        var node = catsEl.children[i];
        if (!node) {
          node = document.createElement('li');
          node.className = 'mk-cat';
          node.innerHTML = '<span class="mk-cat__name"></span><span class="mk-cat__amt"></span>'
            + '<span class="mk-cat__track"><i></i></span>';
          catsEl.appendChild(node);
        }
        node.dataset.cat = r.cat;
        node.querySelector('.mk-cat__name').textContent = r.cat;
        node.querySelector('.mk-cat__amt').textContent = money(r.amt);
        node.querySelector('.mk-cat__track i').style.width = Math.round(r.amt / max * 100) + '%';
      });
      while (catsEl.children.length > rows.length) catsEl.removeChild(catsEl.lastChild);
    }

    function totalsUpTo(n) {
      var moneyIn = 0, moneyOut = 0;
      for (var i = 0; i < n; i++) {
        var e = HISAAB_ENTRIES[i];
        if (e.type === 'in') moneyIn += e.amt; else moneyOut += Math.abs(e.amt);
      }
      return { moneyIn: moneyIn, moneyOut: moneyOut };
    }

    function setTotals(n, animate) {
      var t = totalsUpTo(n);
      [[inEl, t.moneyIn], [outEl, t.moneyOut], [netEl, t.moneyIn - t.moneyOut]].forEach(function (pair) {
        if (!pair[0]) return;
        if (animate) countTo(pair[0], pair[1], 620);
        else { pair[0].dataset.current = pair[1]; renderCount(pair[0], pair[1]); }
      });
      if (countEl) countEl.textContent = n;
    }

    var tl = null, index = 0;

    function reset() {
      if (tl) tl.cancel();
      list.innerHTML = '';
      catsEl.innerHTML = '';
      index = 0;
      [inEl, outEl, netEl].forEach(function (el) { if (el) { el.dataset.current = 0; renderCount(el, 0); } });
      if (countEl) countEl.textContent = '0';
    }

    function step() {
      if (index >= HISAAB_ENTRIES.length) {
        // Hold the finished month, then rebuild it so a returning visitor sees
        // the story rather than a static list.
        tl = new Timeline().after(5200, function () { reset(); run(); });
        return;
      }
      list.insertAdjacentHTML('afterbegin', rowHtml(HISAAB_ENTRIES[index]));
      index++;
      setTotals(index, true);
      paintCats(index);
      tl = new Timeline().after(index === 1 ? 900 : 620, step);
    }

    /** Continues from wherever the ledger got to. Only a completed month is
     *  cleared and replayed — coming back to a half-built month should pick it
     *  up, not start the story over. */
    function run() {
      if (index >= HISAAB_ENTRIES.length) reset();
      tl = new Timeline().after(index === 0 ? 260 : 500, step);
    }

    function still() {
      list.innerHTML = HISAAB_ENTRIES.slice().reverse().map(rowHtml).join('');
      setTotals(HISAAB_ENTRIES.length, false);
      paintCats(HISAAB_ENTRIES.length);
    }

    // Hovering a category dims the entries that do not belong to it, which is
    // the fastest possible answer to "what is in this bar?".
    catsEl.addEventListener('mouseover', function (e) {
      var cat = e.target.closest('.mk-cat');
      if (!cat) return;
      $$('.mk-hisaab__row', list).forEach(function (r) {
        r.classList.toggle('is-dim', r.dataset.cat !== cat.dataset.cat);
      });
    });
    catsEl.addEventListener('mouseleave', function () {
      $$('.mk-hisaab__row', list).forEach(function (r) { r.classList.remove('is-dim'); });
    });

    whenVisible(root, run, function () { if (tl) tl.cancel(); }, still);
  }

  /* ------------------------------------------------------- 2. TATHYA ---- */

  var TATHYA_CHIPS = [
    'Groceries <b>₹7,300</b>', 'Rent <b>₹26,000</b>', 'Shopping <b>₹14,000</b>',
    'Dining <b>₹1,850</b>', 'Subscriptions <b>₹649</b>', 'Utilities <b>₹2,400</b>',
    'Transport <b>₹1,420</b>', 'Salary <b>₹1,18,000</b>', 'Freelance <b>₹18,000</b>',
    'Goal · Emergency Fund', 'Due in 3 days · ₹2,400'
  ];
  // Long enough to actually read each state. Analysis and Patterns carry the
  // argument, so they get the most time; Action is the payoff and holds longest.
  var TATHYA_TIMING = [2400, 3200, 3600, 4600, 5200];
  var TATHYA_STAGE_COUNT = 5;

  // The shortlist the rules produce before one is chosen. Showing it is what
  // makes the Insight state read as a decision rather than a headline, and it
  // is how the real engine works: several candidates, ranked, highest wins.
  var TATHYA_PATTERNS = [
    { name: 'Shopping vs your usual week', val: '+204%', w: 100, top: true },
    { name: 'Dining vs your usual pattern', val: '+24%', w: 34 },
    { name: 'Groceries', val: 'steady', w: 12 },
    { name: 'Emergency Fund pace', val: 'on track', w: 20 }
  ];

  function initTathya() {
    var root = $('[data-demo="tathya"]');
    if (!root) return;
    var stages = $$('#mkTathyaStages li');
    var panels = $$('.mk-tathya__panel', root);
    var chipsEl = $('#mkTathyaChips');
    var patternsEl = $('#mkTathyaPatterns');
    var insightCount = $('.mk-insight__body [data-count]', root);
    if (!panels.length) return;

    function paintChips() {
      chipsEl.innerHTML = TATHYA_CHIPS.map(function (c, i) {
        return '<li class="mk-chip" style="animation-delay:' + (i * 70) + 'ms">' + c + '</li>';
      }).join('');
    }

    function paintPatterns(animate) {
      if (!patternsEl) return;
      patternsEl.innerHTML = TATHYA_PATTERNS.map(function (p, i) {
        return '<li class="' + (p.top ? 'is-top' : '') + '" style="--w:' + p.w + '%;animation-delay:'
          + (animate ? i * 130 : 0) + 'ms">'
          + '<span class="mk-pattern__name">' + esc(p.name) + '</span>'
          + '<span class="mk-pattern__val">' + esc(p.val) + '</span>'
          + '<span class="mk-pattern__track"><i></i></span></li>';
      }).join('');
      // Next frame so the bars have a zero width to grow from.
      requestAnimationFrame(function () {
        $$('.mk-pattern__track i', patternsEl).forEach(function (bar, i) {
          bar.style.width = TATHYA_PATTERNS[i].w + '%';
        });
      });
    }

    function setStage(i) {
      stages.forEach(function (s, k) {
        s.classList.toggle('is-active', k === i);
        s.classList.toggle('is-done', k < i);
      });
      panels.forEach(function (p, k) { p.classList.toggle('is-on', k === i); });
      if (i === 0) paintChips();
      if (i === 2) paintPatterns(true);
      if (i === 3 && insightCount) {
        insightCount.dataset.done = '';
        insightCount.dataset.current = 0;
        countTo(insightCount, parseFloat(insightCount.dataset.count), 1100);
      }
    }

    var tl = null, stage = 0;

    function advance() {
      setStage(stage);
      var hold = TATHYA_TIMING[stage];
      stage = (stage + 1) % TATHYA_STAGE_COUNT;
      tl = new Timeline().after(hold, advance);
    }

    function still() {
      paintChips();
      paintPatterns(false);
      stages.forEach(function (s) { s.classList.remove('is-active'); s.classList.add('is-done'); });
      panels.forEach(function (p) { p.classList.add('is-on'); });
      if (insightCount) { insightCount.dataset.current = insightCount.dataset.count; renderCount(insightCount, parseFloat(insightCount.dataset.count)); }
    }

    whenVisible(root, function () { stage = 0; advance(); },
      function () { if (tl) tl.cancel(); }, still);
  }

  /* -------------------------------------------------------- 3. VARTA ---- */

  function initVarta() {
    var root = $('[data-demo="varta"]');
    if (!root) return;
    var typed = $('.mk-varta__typed', root);
    var wave = $('#mkVartaWave');
    var thinking = $('#mkVartaThinking');
    var sources = $$('.mk-varta__sources li', root);
    var answer = $('#mkVartaAnswer');
    var text = $('.mk-varta__text', root);
    var figuresEl = $('.mk-varta__figures', root);
    var basis = $('.mk-varta__basis', root);
    var dotsWrap = $('#mkVartaDots');
    if (!typed || !answer) return;

    var items = $$('.mk-varta__source li').map(function (li) {
      return {
        q: li.dataset.q, a: li.dataset.a, b: li.dataset.b,
        f: (li.dataset.f || '').split('|').filter(Boolean)
      };
    });
    if (!items.length) return;

    var dots = items.map(function (_, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', 'Example question ' + (i + 1));
      b.addEventListener('click', function () { manual(i); });
      if (dotsWrap) dotsWrap.appendChild(b);
      return b;
    });

    var tl = null, index = 0, auto = true;

    function markDots() {
      dots.forEach(function (d, i) {
        d.classList.toggle('is-active', i === index);
        d.setAttribute('aria-selected', String(i === index));
      });
    }

    function paintAnswer(item) {
      text.textContent = item.a;
      figuresEl.innerHTML = item.f.map(function (f, i) {
        return '<li style="animation-delay:' + (140 + i * 110) + 'ms">' + esc(f) + '</li>';
      }).join('');
      basis.textContent = item.b;
      answer.classList.add('is-shown');
    }

    function clearThinking() {
      if (thinking) thinking.classList.remove('is-shown');
      sources.forEach(function (s) { s.classList.remove('is-read'); });
    }

    /** Lights each source in turn, then calls `done`. The pause between the
     *  question and the answer is the twin reading the position it will answer
     *  from — showing which parts it consults is more honest than a spinner,
     *  and it names the same four things the product actually reads. */
    function think(done) {
      if (!thinking || !sources.length) { done(); return; }
      thinking.classList.add('is-shown');
      var i = 0;
      (function nextSource() {
        if (i >= sources.length) {
          tl = new Timeline().after(340, function () { clearThinking(); done(); });
          return;
        }
        sources[i].classList.add('is-read');
        i++;
        tl = new Timeline().after(230, nextSource);
      })();
    }

    function show(i) {
      if (tl) tl.cancel();
      index = ((i % items.length) + items.length) % items.length;
      markDots();
      var item = items[index];

      answer.classList.remove('is-shown');
      clearThinking();
      typed.textContent = '';
      if (wave) wave.classList.add('is-live');

      var pos = 0;
      (function type() {
        if (pos <= item.q.length) {
          typed.textContent = item.q.slice(0, pos);
          pos++;
          tl = new Timeline().after(26 + Math.random() * 26, type);
          return;
        }
        // The waveform stops the moment the question ends — the pause before
        // the answer is the twin reading, and it should look like silence.
        if (wave) wave.classList.remove('is-live');
        tl = new Timeline().after(280, function () {
          think(function () {
            paintAnswer(item);
            if (auto) tl = new Timeline().after(4600, function () { show(index + 1); });
          });
        });
      })();
    }

    function manual(i) {
      auto = false;
      show(i);
      // Resume the carousel once the visitor has had time with their choice.
      tl = new Timeline().after(9000, function () { auto = true; show(index + 1); });
    }

    function still() {
      var item = items[0];
      typed.textContent = item.q;
      var caret = $('.mk-ask__caret', root);
      if (caret) caret.style.display = 'none';
      if (wave) wave.classList.remove('is-live');
      clearThinking();
      paintAnswer(item);
      markDots();
    }

    whenVisible(root, function () { auto = true; show(0); },
      function () { if (tl) tl.cancel(); if (wave) wave.classList.remove('is-live'); clearThinking(); }, still);
  }

  /* ---------------------------------------------------------- 5. HUB ---- */

  function initHub() {
    var hub = $('[data-demo="hub"]');
    if (!hub) return;
    var stat = $('#mkHubStat');
    var tl = null;
    // Cycles what the core is currently doing, so the label carries the same
    // "always running" claim the pulses make visually.
    var STATES = ['reading', 'modelling', 'in sync', 'simulating'];
    var si = 0;

    function tick() {
      if (stat) {
        stat.textContent = STATES[si % STATES.length];
        stat.classList.toggle('is-live', STATES[si % STATES.length] === 'in sync');
      }
      si++;
      tl = new Timeline().after(2600, tick);
    }

    whenVisible(hub,
      function () { hub.classList.add('is-flowing'); si = 0; tick(); },
      function () { hub.classList.remove('is-flowing'); if (tl) tl.cancel(); },
      function () { if (stat) { stat.textContent = 'in sync'; stat.classList.add('is-live'); } });
  }

  /* ---------------------------------------------------------- 6. CFO ---- */

  // Four quarters of an illustrative company. Revenue climbing, burn falling,
  // runway extending — with the observation a CFO would actually write.
  var CFO = [
    {
      q: 'Q1', revenue: 1450000, burn: 2200000, runway: 9.4, health: 46,
      revenueD: 'baseline', burnD: 'baseline', runwayD: 'baseline',
      insight: 'Burn is running 52% ahead of revenue. At this rate the runway ends before the next raise window.'
    },
    {
      q: 'Q2', revenue: 1810000, burn: 2090000, runway: 10.8, health: 57,
      revenueD: '+24.8% QoQ', burnD: '−5.0% QoQ', runwayD: '+1.4 mo',
      insight: 'The gap narrowed without cutting headcount. Revenue growth, not cost cutting, did the work.'
    },
    {
      q: 'Q3', revenue: 2240000, burn: 1980000, runway: 13.1, health: 68,
      revenueD: '+23.8% QoQ', burnD: '−5.3% QoQ', runwayD: '+2.3 mo',
      insight: 'Revenue crossed net burn this quarter. The company is default-alive at current spend.'
    },
    {
      q: 'Q4', revenue: 2760000, burn: 1900000, runway: 17.6, health: 79,
      revenueD: '+23.2% QoQ', burnD: '−4.0% QoQ', runwayD: '+4.5 mo',
      insight: 'Four straight quarters of widening margin. Raising now would be a choice, not a necessity.'
    }
  ];

  function initCfo() {
    var root = $('[data-demo="cfo"]');
    if (!root) return;
    var tabs = $$('.mk-cfo__q', root);
    var progress = $('#mkCfoProgress');
    var barsEl = $('#mkCfoBars');
    var insight = $('#mkCfoInsight');
    var insightText = $('.mk-cfo__insighttext', root);
    if (!tabs.length || !barsEl) return;

    var maxVal = Math.max.apply(null, CFO.map(function (c) { return Math.max(c.revenue, c.burn); }));

    barsEl.innerHTML = CFO.map(function (c) {
      return '<div class="mk-cfo__col" data-col="' + c.q + '">'
        + '<span class="mk-cfo__pair">'
        + '<i class="mk-cfo__bar mk-cfo__bar--rev"></i>'
        + '<i class="mk-cfo__bar mk-cfo__bar--burn"></i>'
        + '</span><span>' + c.q + '</span></div>';
    }).join('');
    var cols = $$('.mk-cfo__col', barsEl);

    var els = {
      revenue: $('#mkCfoRevenue'), revenueD: $('#mkCfoRevenueD'),
      burn: $('#mkCfoBurn'), burnD: $('#mkCfoBurnD'),
      runway: $('#mkCfoRunway'), runwayD: $('#mkCfoRunwayD'),
      health: $('#mkCfoHealth'), healthBar: $('#mkCfoHealthBar')
    };

    function setDelta(el, txt, dir) {
      if (!el) return;
      el.textContent = txt;
      el.classList.toggle('is-up', dir === 'up');
      el.classList.toggle('is-down', dir === 'down');
    }

    function apply(i, animate) {
      var c = CFO[i];

      tabs.forEach(function (t, k) {
        t.classList.toggle('is-active', k === i);
        t.classList.toggle('is-past', k < i);
        t.setAttribute('aria-selected', String(k === i));
      });
      if (progress) progress.style.transform = 'translateX(' + (i * 100) + '%)';

      // Bars grow only up to the current quarter, so the chart fills as the
      // timeline advances rather than showing the answer in advance.
      cols.forEach(function (col, k) {
        var reached = k <= i;
        col.classList.toggle('is-reached', reached);
        col.classList.toggle('is-active', k === i);
        var rev = col.querySelector('.mk-cfo__bar--rev');
        var burn = col.querySelector('.mk-cfo__bar--burn');
        rev.style.height = reached ? (CFO[k].revenue / maxVal * 100) + '%' : '0%';
        burn.style.height = reached ? (CFO[k].burn / maxVal * 100) + '%' : '0%';
      });

      if (els.revenue) {
        els.revenue.dataset.prefix = '₹';
        if (animate) countTo(els.revenue, c.revenue, 780);
        else { els.revenue.dataset.current = c.revenue; renderCount(els.revenue, c.revenue); }
      }
      if (els.burn) {
        els.burn.dataset.prefix = '₹';
        if (animate) countTo(els.burn, c.burn, 780);
        else { els.burn.dataset.current = c.burn; renderCount(els.burn, c.burn); }
      }
      if (els.runway) els.runway.textContent = c.runway.toFixed(1) + ' mo';
      if (els.health) els.health.textContent = c.health + '/100';
      if (els.healthBar) els.healthBar.style.width = c.health + '%';

      setDelta(els.revenueD, c.revenueD, i === 0 ? null : 'up');
      setDelta(els.burnD, c.burnD, i === 0 ? null : 'up');
      setDelta(els.runwayD, c.runwayD, i === 0 ? null : 'up');

      // The insight is the payoff, so it lands after the numbers have moved.
      if (insight && insightText) {
        insight.classList.remove('is-shown');
        var reveal = function () {
          insightText.textContent = c.insight;
          insight.classList.add('is-shown');
        };
        if (animate) new Timeline().after(620, reveal);
        else reveal();
      }
    }

    var tl = null, index = 0, auto = true;

    function advance() {
      apply(index, true);
      index = (index + 1) % CFO.length;
      tl = new Timeline().after(index === 0 ? 5200 : 3800, advance);
    }

    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () {
        auto = false;
        if (tl) tl.cancel();
        index = i;
        apply(i, true);
        tl = new Timeline().after(9000, function () {
          auto = true;
          index = (i + 1) % CFO.length;
          advance();
        });
      });
    });

    whenVisible(root,
      function () { if (tl) tl.cancel(); index = 0; auto = true; advance(); },
      function () { if (tl) tl.cancel(); },
      function () { apply(CFO.length - 1, false); });
  }

  /* ------------------------------------------------------ 4. SIMULATE ---- */

  // Illustrative only — the section says so on the page. Each scenario carries
  // its full consequence, not just the headline figure, so no option can look
  // like a free win. Whether a delta is an improvement is decided per figure,
  // because it is not always the number going up: months-to-goal falling is good.
  var SIM_BASE = { months: 14, flow: 18500, health: 72 };

  var SCENARIOS = {
    car: {
      label: 'After buying a car', value: 268000,
      note: 'A real setback, but the buffer holds above three months.',
      buffer: 42, goal: 34, months: 19, flow: 12400, health: 54
    },
    loan: {
      label: 'After taking a loan', value: 331000,
      note: 'Cash today, at the cost of every month that follows.',
      buffer: 55, goal: 46, months: 16, flow: 9800, health: 61
    },
    save: {
      label: 'After increasing savings', value: 496000,
      note: 'The slowest change, and by far the largest one.',
      buffer: 92, goal: 88, months: 7, flow: 27600, health: 88
    },
    spend: {
      label: 'After cutting spending', value: 447000,
      note: 'Same income, more of it kept. Compounds quietly.',
      buffer: 78, goal: 71, months: 10, flow: 24100, health: 79
    }
  };

  function initSim() {
    var choices = $$('.mk-sim__choice');
    var figure = $('#mkSimFigure');
    var label = $('#mkSimLabel');
    var note = $('#mkSimNote');
    var baseEl = $('[data-sim-base]');
    var bufBar = $('#mkMeterBuffer');
    var bufVal = $('#mkMeterBufferVal');
    var goalBar = $('#mkMeterGoal');
    var goalVal = $('#mkMeterGoalVal');
    var monthsEl = $('#mkSimMonths'), monthsD = $('#mkSimMonthsDelta');
    var flowEl = $('#mkSimFlow'), flowD = $('#mkSimFlowDelta');
    var healthEl = $('#mkSimHealth'), healthBar = $('#mkSimHealthBar');
    if (!choices.length || !figure) return;

    if (baseEl) baseEl.setAttribute('data-count', baseEl.dataset.simBase);

    function setDelta(el, value, base, good, unit) {
      if (!el) return;
      var diff = value - base;
      var sign = diff > 0 ? '+' : (diff < 0 ? '\u2212' : '');
      var body = unit === 'mo'
        ? sign + Math.abs(diff) + ' mo'
        : sign + '\u20B9' + formatIndian(Math.abs(diff));
      el.textContent = diff === 0 ? 'no change' : body + ' vs current path';
      el.classList.toggle('is-up', diff !== 0 && good);
      el.classList.toggle('is-down', diff !== 0 && !good);
    }

    function apply(key, animate) {
      var s = SCENARIOS[key];
      if (!s) return;

      if (label) label.textContent = s.label;
      if (note) note.textContent = s.note;

      if (animate === false || reduceMotion) {
        figure.dataset.current = s.value;
        renderCount(figure, s.value);
      } else {
        countTo(figure, s.value, 900);
      }

      if (bufBar) { bufBar.style.width = s.buffer + '%'; bufBar.classList.toggle('is-low', s.buffer < 50); }
      if (goalBar) { goalBar.style.width = s.goal + '%'; goalBar.classList.toggle('is-low', s.goal < 50); }
      if (bufVal) bufVal.textContent = s.buffer + '%';
      if (goalVal) goalVal.textContent = s.goal + '%';

      if (monthsEl) monthsEl.textContent = s.months + ' mo';
      // Fewer months to the goal is the improvement, so the direction here is
      // inverted relative to every other figure in this panel.
      setDelta(monthsD, s.months, SIM_BASE.months, s.months < SIM_BASE.months, 'mo');

      if (flowEl) {
        flowEl.dataset.prefix = '\u20B9';
        if (animate === false || reduceMotion) { flowEl.dataset.current = s.flow; renderCount(flowEl, s.flow); }
        else countTo(flowEl, s.flow, 780);
      }
      setDelta(flowD, s.flow, SIM_BASE.flow, s.flow > SIM_BASE.flow, 'money');

      if (healthEl) healthEl.textContent = s.health + '/100';
      if (healthBar) healthBar.style.width = s.health + '%';
    }

    choices.forEach(function (btn) {
      btn.addEventListener('click', function () {
        choices.forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        apply(btn.dataset.sim, true);
      });
    });

    var first = choices[0].dataset.sim;
    var s = SCENARIOS[first];
    if (label) label.textContent = s.label;
    if (note) note.textContent = s.note;

    var panel = $('.mk-sim');

    function reveal() {
      apply(first, false);
      // Both headline figures are held at zero until the section arrives, so
      // they count up with it rather than before it.
      figure.dataset.current = 0;
      figure.setAttribute('data-count', s.value);
      if (flowEl) { flowEl.dataset.current = 0; flowEl.setAttribute('data-count', s.flow); }
      startCounters(panel || document);
    }

    if (reduceMotion || !('IntersectionObserver' in window)) {
      apply(first, false);
      if (baseEl) { baseEl.dataset.current = baseEl.dataset.simBase; renderCount(baseEl, parseFloat(baseEl.dataset.simBase)); }
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        reveal();
        io.disconnect();
      });
    }, { threshold: 0.3 });
    if (panel) io.observe(panel);
  }

  /* ---------------------------------------------------------- marquee */

  function initMarquee() {
    var track = $('.mk-marquee__track');
    if (!track) return;
    if (reduceMotion) return;   // leave one static, readable set

    // Duplicate the set so the -50% keyframe loops seamlessly. Clones are
    // hidden from assistive tech and keyboard order — the originals are the
    // real links.
    var originals = Array.prototype.slice.call(track.children);
    originals.forEach(function (node) {
      var clone = node.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      clone.setAttribute('tabindex', '-1');
      track.appendChild(clone);
    });
  }

  /* ======================================================================
     ADDITIONS — journeys, tax, market pulse, WhatsApp alerts, devices.

     Same three rules as the showcases above: run only while visible, expose a
     `still()` that paints the finished state for reduced motion, and keep all
     copy in one data table per demo.
     ====================================================================== */

  /* ----------------------------------------------------- 7. JOURNEYS ---- */

  // `soon: true` marks anything not in the product yet. The chip renders it
  // explicitly rather than letting a roadmap item read as shipped.
  var JOURNEYS = {
    individual: {
      cta: 'register.html?v=2&type=individual',
      flow: ['Track', 'Understand', 'Ask', 'Plan', 'Simulate', 'Act'],
      detail: [
        'Every rupee in and out, categorised as it lands.',
        'What the pattern in your own spending actually says.',
        'Plain questions, answered from your position.',
        'Goals and obligations on one honest timeline.',
        'Run the decision before you commit to it.',
        'Move on a number you can defend.'
      ],
      feats: [
        { t: 'Hisaab tracking' }, { t: 'Tathya insights' }, { t: 'Varta voice AI' },
        { t: 'Financial Brain' }, { t: 'What-If simulations' }, { t: 'Goals' },
        { t: 'Upcoming payments' }, { t: 'Gmail context' }, { t: 'Market Pulse' },
        { t: 'Tax assistance', soon: true }, { t: 'WhatsApp alerts', soon: true },
        { t: 'Mobile app', soon: true }
      ]
    },
    business: {
      cta: 'register.html?v=2&type=startup',
      flow: ['Financial data', 'Revenue analysis', 'Expense & burn', 'Cash flow',
             'Runway', 'Financial health', 'Period over period', 'Forecasting', 'Reports'],
      detail: [
        'Your ledger, your onboarding figures, your history.',
        'Growth quarter over quarter, from real movement.',
        'Gross and net burn, split by where it goes.',
        'What actually enters and leaves each month.',
        'Cash divided by the burn that is really happening.',
        'One composite score, computed from all of it.',
        'This period against the last, like for like.',
        'Scenario analysis on the same model.',
        'The observation a CFO would have written.'
      ],
      feats: [
        { t: 'Runway & burn' }, { t: 'Revenue analysis' }, { t: 'Expense breakdown' },
        { t: 'Cash projection' }, { t: 'Financial health score' }, { t: 'Break-even estimate' },
        { t: 'Funding dependency' }, { t: 'Hiring capacity' }, { t: 'Weekly reports' },
        { t: 'Scenario simulation' }, { t: 'Quarterly reports', soon: true }
      ]
    }
  };

  function initJourneys() {
    var root = $('[data-demo="journeys"]');
    if (!root) return;
    var tabs = $$('.mk-journey__tab', root);
    var flowEl = $('#mkJourneyFlow');
    var featsEl = $('#mkJourneyFeats');
    var cta = $('#mkJourneyCta');
    if (!tabs.length || !flowEl) return;

    var current = null;

    function paint(key, animate) {
      var j = JOURNEYS[key];
      if (!j) return;
      current = key;

      tabs.forEach(function (t) {
        var on = t.dataset.journey === key;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
      });

      flowEl.classList.remove('is-filled');
      flowEl.innerHTML = '<span class="mk-flow__fill" aria-hidden="true"></span>'
        + j.flow.map(function (step, i) {
          var delay = animate ? (i * 90) : 0;
          return '<li class="mk-flow__step" style="animation-delay:' + delay + 'ms">'
            + '<b>' + esc(step) + '</b>: ' + esc(j.detail[i] || '') + '</li>';
        }).join('');
      // Next frame, so the fill transition has a 0 height to start from.
      requestAnimationFrame(function () { flowEl.classList.add('is-filled'); });

      featsEl.innerHTML = j.feats.map(function (f, i) {
        return '<li class="' + (f.soon ? 'is-soon' : '') + '" style="animation-delay:'
          + (animate ? 120 + i * 45 : 0) + 'ms">' + esc(f.t) + '</li>';
      }).join('');

      if (cta) cta.setAttribute('href', j.cta);
    }

    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        if (t.dataset.journey !== current) paint(t.dataset.journey, true);
      });
    });

    whenVisible(root,
      function () { paint('individual', true); },
      null,
      function () { paint('individual', false); });
  }

  /* ---------------------------------------------------------- 8. TAX ---- */

  var TAX_DOCS = [
    'Salary & income', 'Rent paid', 'Investments & SIPs',
    'Insurance premiums', 'Medical spend', 'Interest paid'
  ];
  var TAX_FOUND = [
    { name: 'Investments', sec: 'Section 80C', amt: 150000 },
    { name: 'Health insurance', sec: 'Section 80D', amt: 25000 },
    { name: 'House rent allowance', sec: 'HRA', amt: 96000 },
    { name: 'Home loan interest', sec: 'Section 24(b)', amt: 78000 }
  ];
  var TAX_STATES = ['Reading', 'Matching', 'Checking', 'Done'];

  function initTax() {
    var root = $('[data-demo="tax"]');
    if (!root) return;
    var docsEl = $('#mkTaxDocs');
    var foundEl = $('#mkTaxFound');
    var totalEl = $('#mkTaxTotal');
    var statusEl = $('#mkTaxStatus');
    if (!docsEl || !foundEl) return;

    var tl = null;

    function paintDocs(animate) {
      docsEl.innerHTML = TAX_DOCS.map(function (d, i) {
        return '<li style="animation-delay:' + (animate ? i * 110 : 0) + 'ms">'
          + '<span aria-hidden="true"></span>' + esc(d) + '</li>';
      }).join('');
    }

    function paintFound(upto, animate) {
      foundEl.innerHTML = TAX_FOUND.slice(0, upto).map(function (f, i) {
        return '<li style="animation-delay:' + (animate ? i * 60 : 0) + 'ms">'
          + '<span class="mk-tax__name">' + esc(f.name) + '</span>'
          + '<span class="mk-tax__sec">' + esc(f.sec) + '</span>'
          + '<span class="mk-tax__amt">' + money(f.amt) + '</span></li>';
      }).join('');
      var total = TAX_FOUND.slice(0, upto).reduce(function (s, f) { return s + f.amt; }, 0);
      if (totalEl) {
        if (animate) countTo(totalEl, total, 640);
        else { totalEl.dataset.current = total; renderCount(totalEl, total); }
      }
    }

    function run() {
      if (tl) tl.cancel();
      paintDocs(true);
      paintFound(0, false);
      var step = 0;

      function next() {
        if (statusEl) statusEl.textContent = TAX_STATES[Math.min(step, TAX_STATES.length - 1)];
        if (step > 0) paintFound(Math.min(step, TAX_FOUND.length), true);
        step++;
        if (step <= TAX_FOUND.length) {
          tl = new Timeline().after(step === 1 ? 1100 : 780, next);
        } else {
          if (statusEl) statusEl.textContent = 'Done';
          // Hold the result, then replay so a returning visitor sees the read.
          tl = new Timeline().after(6000, run);
        }
      }
      tl = new Timeline().after(700, next);
    }

    function still() {
      paintDocs(false);
      paintFound(TAX_FOUND.length, false);
      if (statusEl) statusEl.textContent = 'Done';
    }

    whenVisible(root, run, function () { if (tl) tl.cancel(); }, still);
  }

  /* -------------------------------------------------- 9. MARKET PULSE ---- */

  // Mirrors the real /market-pulse response: a headline, a relevance grade and
  // a why-it-matters line tied to the holding that made it relevant.
  var NEWS_CONTEXT = ['Mutual funds', 'Monthly SIP', 'IT sector', 'Emergency Fund', 'Home loan'];
  var NEWS_SIGNALS = [
    {
      cat: 'Markets', rel: 'high', hit: 0,
      head: 'Mid-cap funds see sharpest weekly inflow of the quarter',
      why: 'Two of your mutual funds sit in this category, so a move here changes your position, not just the index.'
    },
    {
      cat: 'Rates', rel: 'high', hit: 4,
      head: 'Repo rate held steady for the third consecutive review',
      why: 'Your home loan EMI stays where it is. No change to the monthly surplus your goal depends on.'
    },
    {
      cat: 'Sector', rel: 'medium', hit: 2,
      head: 'IT services guidance revised upward for the coming quarter',
      why: 'You hold IT exposure through your SIP. Worth watching, not acting on yet.'
    },
    {
      cat: 'Savings', rel: 'medium', hit: 3,
      head: 'Small savings instrument rates unchanged for the quarter',
      why: 'Relevant to where your Emergency Fund is parked.'
    }
  ];

  function initNews() {
    var root = $('[data-demo="news"]');
    if (!root) return;
    var chipsEl = $('#mkNewsChips');
    var listEl = $('#mkNewsList');
    var countEl = $('#mkNewsCount');
    if (!chipsEl || !listEl) return;

    chipsEl.innerHTML = NEWS_CONTEXT.map(function (c, i) {
      return '<li data-chip="' + i + '">' + esc(c) + '</li>';
    }).join('');
    var chips = $$('li', chipsEl);

    function itemHtml(s, animate, i) {
      return '<li class="mk-news__item" style="animation-delay:' + (animate ? i * 90 : 0) + 'ms">'
        + '<p class="mk-news__meta">' + esc(s.cat)
        + '<span class="mk-news__rel' + (s.rel === 'medium' ? ' is-medium' : '') + '">'
        + esc(s.rel) + ' relevance</span></p>'
        + '<h3 class="mk-news__head">' + esc(s.head) + '</h3>'
        + '<p class="mk-news__why">' + esc(s.why) + '</p></li>';
    }

    var tl = null, shown = 0;

    function light(index) {
      chips.forEach(function (c, i) { c.classList.toggle('is-hit', i === index); });
    }

    function run() {
      if (tl) tl.cancel();
      listEl.innerHTML = '';
      shown = 0;
      light(-1);

      function next() {
        if (shown >= NEWS_SIGNALS.length) {
          light(-1);
          tl = new Timeline().after(5600, run);
          return;
        }
        var s = NEWS_SIGNALS[shown];
        // The matching holding lights first, then the signal it produced —
        // the order is the argument the section is making.
        light(s.hit);
        listEl.insertAdjacentHTML('beforeend', itemHtml(s, true, 0));
        shown++;
        if (countEl) countEl.textContent = shown;
        tl = new Timeline().after(1500, next);
      }
      tl = new Timeline().after(500, next);
    }

    function still() {
      listEl.innerHTML = NEWS_SIGNALS.map(function (s, i) { return itemHtml(s, false, i); }).join('');
      if (countEl) countEl.textContent = NEWS_SIGNALS.length;
      light(-1);
    }

    whenVisible(root, run, function () { if (tl) tl.cancel(); light(-1); }, still);
  }

  /* ------------------------------------------- 10. WHATSAPP ALERTS ---- */

  var ALERT_TRIGGERS = [
    { k: '\uD83D\uDCAC', t: 'Ask in a message', d: 'Plain questions, answered from your own figures.' },
    { k: '\uD83C\uDFA4', t: 'Send a voice note', d: 'Transcribed first, then answered.' },
    { k: '\uD83D\uDCF7', t: 'Photograph a receipt', d: 'Read and turned into a Hisaab entry.' },
    { k: '\u26A1', t: 'It reaches you first', d: 'Due dates and unusual spending, without being asked.' }
  ];

  // dir 'in' is the person, 'out' is MoneyKal. `voice` renders the WhatsApp
  // voice bubble. The outbound alerts are the originals.
  var ALERT_MESSAGES = [
    { dir: 'in', trigger: 1, voice: true, dur: '0:07', time: '09:12' },
    { dir: 'out', trigger: 1, title: 'Voice note transcribed',
      body: '\u201cHow much can I spend this month?\u201d<br>You have <b>\u20b922,600</b> spare after bills and goals.',
      time: '09:12' },
    { dir: 'in', trigger: 0, body: 'and if I book the Goa trip now?', time: '09:13' },
    { dir: 'out', trigger: 0, title: 'Answer',
      body: 'It fits. Your buffer stays above <b>3 months</b> and the trip stays on date.',
      time: '09:13' },
    { dir: 'out', trigger: 3, title: 'Upcoming bill',
      body: 'Your electricity bill of <b>\u20b92,840</b> is due in 3 days.', time: '09:14' }
  ];

  function initAlerts() {
    var root = $('[data-demo="alerts"]');
    if (!root) return;
    var triggersEl = $('#mkAlertTriggers');
    var thread = $('#mkPhoneThread');
    var status = $('#mkPhoneStatus');
    if (!triggersEl || !thread) return;

    triggersEl.innerHTML = ALERT_TRIGGERS.map(function (a, i) {
      return '<li data-trigger="' + i + '">'
        + '<span class="mk-alerts__k" aria-hidden="true">' + a.k + '</span>'
        + '<span class="mk-alerts__t">' + esc(a.t) + '</span>'
        + '<span class="mk-alerts__d">' + esc(a.d) + '</span></li>';
    }).join('');
    var triggerEls = $$('li', triggersEl);

    function fire(index) {
      triggerEls.forEach(function (el, i) { el.classList.toggle('is-firing', i === index); });
    }

    function msgHtml(m) {
      var cls = 'mk-msg' + (m.dir === 'in' ? ' mk-msg--in' : '');

      if (m.voice) {
        // WhatsApp's voice bubble: play control, waveform, duration.
        var bars = '';
        for (var i = 0; i < 22; i++) {
          bars += '<i style="height:'
               + (22 + Math.round(Math.abs(Math.sin(i * 1.7)) * 60))
               + '%;animation-delay:' + (i * 45) + 'ms"></i>';
        }
        return '<div class="' + cls + ' mk-msg--voice">'
          + '<span class="mk-msg__play" aria-hidden="true">'
          + '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">'
          + '<path d="M8 5v14l11-7z"/></svg></span>'
          + '<span class="mk-msg__wave">' + bars + '</span>'
          + '<span class="mk-msg__dur">' + esc(m.dur || '0:06') + '</span>'
          + '<span class="mk-msg__time">' + esc(m.time) + '</span></div>';
      }

      return '<div class="' + cls + '">'
        + (m.title ? '<span class="mk-msg__title">' + esc(m.title) + '</span>' : '')
        + '<span class="mk-msg__body">' + m.body + '</span>'
        + '<span class="mk-msg__time">' + esc(m.time) + '</span></div>';
    }

    var tl = null, index = 0;

    function run() {
      if (tl) tl.cancel();
      thread.innerHTML = '';
      index = 0;
      step();
    }

    function step() {
      if (index >= ALERT_MESSAGES.length) {
        fire(-1);
        if (status) status.textContent = 'online';
        tl = new Timeline().after(5200, run);
        return;
      }
      var m = ALERT_MESSAGES[index];

      // Detection first — the trigger lights, then the bubble is typed, then
      // the message lands. Skipping the typing state would make the alert look
      // scheduled rather than caused.
      fire(m.trigger);

      // An inbound message is the person, so MoneyKal does not type first:
      // the bubble simply arrives.
      if (m.dir === 'in') {
        if (status) status.textContent = 'online';
        thread.insertAdjacentHTML('beforeend', msgHtml(m));
        trimThread();
        index++;
        tl = new Timeline().after(1250, step);
        return;
      }

      if (status) status.textContent = 'typing…';
      thread.insertAdjacentHTML('beforeend',
        '<div class="mk-msg mk-msg--typing" data-typing="1"><i></i><i></i><i></i></div>');
      trimThread();

      tl = new Timeline().after(1150, function () {
        var typing = thread.querySelector('[data-typing]');
        if (typing) typing.remove();
        if (status) status.textContent = 'online';
        thread.insertAdjacentHTML('beforeend', msgHtml(m));
        trimThread();
        index++;
        tl = new Timeline().after(2100, step);
      });
    }

    // The thread is a fixed window; keep only what fits so it never overflows
    // the phone frame.
    function trimThread() {
      // Three fits the frame now that the thread carries taller inbound and
      // voice bubbles as well as MoneyKal's own messages.
      while (thread.children.length > 3) thread.removeChild(thread.firstChild);
    }

    function still() {
      thread.innerHTML = ALERT_MESSAGES.slice(-3).map(msgHtml).join('');
      if (status) status.textContent = 'online';
      fire(-1);
    }

    whenVisible(root, run, function () { if (tl) tl.cancel(); fire(-1); }, still);
  }

  /* ------------------------------------------------------ 11. DEVICES ---- */

  function initDevices() {
    var root = $('[data-demo="devices"]');
    if (!root) return;
    // The mini figures share the page's counter mechanism; the spark and the
    // goal bar are pure CSS, keyed off the same `is-in` class the reveal
    // observer already sets on this element.
    whenVisible(root,
      function () { root.classList.add('is-in'); startCounters(root); },
      null,
      function () { root.classList.add('is-in'); startCounters(root); });
  }

  /* ------------------------------------------------- 12. SECURITY FAQ ----
     A plain disclosure list: each question is a button that owns its own
     panel. Height is animated in CSS (grid-template-rows 0fr -> 1fr), so
     nothing here measures or sets a pixel height, and an answer of any length
     opens correctly. Items toggle independently — opening one does not shut
     another, because these are reference answers people compare. */

  function initFaq() {
    var items = $$('.mk-faq__item');
    if (!items.length) return;

    items.forEach(function (item) {
      var btn = item.querySelector('.mk-faq__btn');
      if (!btn) return;

      btn.addEventListener('click', function () {
        var open = item.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
  }

  /* ------------------------------------------------------------- boot */

  /* --------------------------------------------------------- hero counters
     The hero animates via CSS delays, not the reveal observer, so its counters
     have no [data-reveal] ancestor to start them. They are kicked off here,
     timed to land just after the readout panel has finished entering. */
  function initHeroCounters() {
    var readout = $('.mk-hero__readout');
    if (!readout) return;
    if (reduceMotion) {
      startCounters(readout);
      return;
    }
    // Matches the panel's 2600ms entrance delay in home.css.
    setTimeout(function () { startCounters(readout); }, 2750);
  }

  function boot() {
    initNav();
    initReveal();
    initHeroCounters();

    // Product showcases. Each is self-guarding: a missing section is a no-op,
    // so the page still boots if one is ever removed from the markup.
    initHisaab();
    initTathya();
    initVarta();
    initSim();
    initHub();
    initCfo();

    initJourneys();
    initTax();
    initNews();
    initAlerts();
    initDevices();

    initMarquee();
    initFaq();

    // The final CTA reuses the hero's masked-line reveal, driven by the same
    // is-in class the reveal observer already sets on its parent.
    var finalInner = $('.mk-final__inner');
    if (finalInner && (reduceMotion || !('IntersectionObserver' in window))) {
      finalInner.classList.add('is-in');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
