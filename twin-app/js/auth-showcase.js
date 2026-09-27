/* ==========================================================================
   MoneyKal - auth product showcase

   Drives the panel on the right of login.html and register.html: a loop over
   four MoneyKal surfaces (Hisaab, Taxes, Ask MoneyKal, Intelligence), each one
   holding for a beat while its own rows, bars and figures fill in.

   Everything visual lives in css/login.css. This file only:
     1. advances the scene, the rail and the copy together,
     2. types the Ask MoneyKal question,
     3. counts the headline figures up when their scene arrives,
     4. stops the whole thing while the tab is hidden.

   It touches nothing in the authentication path. If the markup is absent -
   below 1024px the panel is not rendered at all - every function returns
   early and the page behaves as though this script were not loaded.
   ========================================================================== */
(function () {
  'use strict';

  /* How long one scene holds, and so how long the rail's progress bar takes to
     fill — the bar is a CSS animation reading this as a custom property rather
     than a duplicated constant, so the two can never drift apart.

     Every in-card beat in css/login.css is timed to resolve inside this
     window: the slowest chain (Ask MoneyKal's question, sources and answer)
     settles at about 1.75s, which leaves the finished card a moment to read as
     finished before it hands over. Shortening this alone would leave the cards
     still filling in as they left. */
  var SCENE_MS = 4000;

  /* Long enough for the outgoing cards to clear (0.5s transform plus the
     per-card stagger), short enough that the class is gone well before the
     scene is next due. */
  var EXIT_MS = 600;

  var reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* very old browser */ }

  function boot() {
    var deck = document.getElementById('authDeck');
    if (!deck) return;

    var scenes = [].slice.call(deck.querySelectorAll('.ashow'));
    var tabs   = [].slice.call(document.querySelectorAll('.astage-tab'));
    var copies = [].slice.call(document.querySelectorAll('.astage-copy'));
    if (!scenes.length) return;

    document.documentElement.style.setProperty('--mk-scene', SCENE_MS + 'ms');

    var index = 0;
    var timer = null;
    var typing = [];

    /* ---------------------------------------------------------- typing ----
       The Ask MoneyKal question is typed rather than faded in, because the
       point of that scene is a question being asked. Any pending timeouts are
       cleared when the scene leaves, so a fast cycle cannot stack two
       typewriters onto the same element. */
    function clearTyping() {
      for (var i = 0; i < typing.length; i++) clearTimeout(typing[i]);
      typing = [];
    }

    function typeQuestion(scene) {
      var el = scene.querySelector('[data-typewriter]');
      if (!el) return;
      var full = el.getAttribute('data-typewriter');

      if (reduced) { el.textContent = full; return; }

      el.textContent = '';
      var i = 0;
      (function step() {
        el.textContent = full.slice(0, i);
        if (i++ <= full.length) typing.push(setTimeout(step, 26));
      })();
    }

    /* ---------------------------------------------------------- counting --
       Figures count up to their final value so the card reads as something
       being computed. The target is carried in `data-count`; the prefix and
       any grouping are rebuilt here in the Indian numbering system, which is
       what the rest of MoneyKal shows. */
    function groupIndian(n) {
      var s = String(n);
      if (s.length <= 3) return s;
      var last3 = s.slice(-3);
      var rest = s.slice(0, -3);
      return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
    }

    function countUp(scene) {
      var nodes = [].slice.call(scene.querySelectorAll('[data-count]'));
      nodes.forEach(function (el) {
        var target = parseInt(el.getAttribute('data-count'), 10);
        if (isNaN(target)) return;
        var prefix = el.getAttribute('data-prefix') || '';
        var suffix = el.getAttribute('data-suffix') || '';

        if (reduced) {
          el.textContent = prefix + groupIndian(target) + suffix;
          return;
        }

        var started = null;
        var dur = 850;
        function frame(now) {
          if (started === null) started = now;
          var t = Math.min(1, (now - started) / dur);
          var eased = 1 - Math.pow(1 - t, 3);         // ease-out cubic
          el.textContent = prefix + groupIndian(Math.round(target * eased)) + suffix;
          if (t < 1) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
    }

    /* ------------------------------------------------------------ scenes --
       `is-exit` is held only for the length of the outgoing transition. The
       class is what restarts every in-card animation: dropping `is-active`
       removes them, adding it back plays them from zero, which is why the
       loop looks the same on its fifth pass as on its first. */
    function show(next) {
      var current = scenes[index];

      if (current && current !== scenes[next]) {
        current.classList.remove('is-active');
        current.classList.add('is-exit');
        setTimeout(function () { current.classList.remove('is-exit'); }, EXIT_MS);
      }

      index = next;
      clearTyping();

      var scene = scenes[index];
      scene.classList.remove('is-exit', 'is-active');
      // Force a reflow so the class removal above and the addition below are
      // two separate styles rather than one coalesced no-op. Dropping and
      // re-adding `is-active` is what replays the in-card animations, which
      // also matters when the same scene is re-shown after a hidden tab.
      void scene.offsetWidth;
      scene.classList.add('is-active');

      tabs.forEach(function (t, i) {
        t.classList.remove('is-on');
        if (i === index) { void t.offsetWidth; t.classList.add('is-on'); }
      });
      copies.forEach(function (c, i) { c.classList.toggle('is-on', i === index); });

      typeQuestion(scene);
      countUp(scene);
    }

    function advance() { show((index + 1) % scenes.length); }

    function start() {
      stop();
      timer = setInterval(advance, SCENE_MS);
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    /* A background tab gets no animation frames, so the loop would otherwise
       queue up scene changes and burn through them on return. */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stop(); clearTyping(); }
      else { show(index); start(); }
    });

    show(0);
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
