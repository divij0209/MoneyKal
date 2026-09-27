/**
 * varta-orb.js
 *
 * Drives the Varta orb on the public Varta page.
 *
 * This is not a new animation. The orb, its pulse rings, the breathing, the
 * spin and the state colours all come from the original implementation in
 * css/styles.css and css/app-theme.css, copied into css/pages.css unchanged.
 * This file only walks it through the same states js/voice.js sets during a
 * real call, so a visitor sees the actual thing rather than a mock-up:
 *
 *   idle -> connecting -> listening -> thinking -> speaking -> listening ...
 *
 * The state class names, the status copy and the amplitude technique (scaling
 * the orb by 1 + level * 0.35) are taken from js/voice.js so the two stay in
 * step. During a real call the level comes from Vapi's volume-level event;
 * here there is no microphone, so the speaking state is driven by a synthetic
 * envelope of the same shape.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-varta-orb]');
  if (!root) return;

  var container = root.querySelector('.voice-orb-container');
  var orb = root.querySelector('.voice-orb');
  var statusEl = root.querySelector('[data-orb-status]');
  var hintEl = root.querySelector('[data-orb-hint]');
  if (!container || !orb) return;

  // Same copy js/voice.js shows for each state.
  var COPY = {
    idle: ['Talk to Your Financial Brain', 'Tap the mic to start a live conversation'],
    connecting: ['Connecting…', 'Setting up your secure voice session'],
    listening: ['Listening…', 'Just talk, you can interrupt any time'],
    thinking: ['Thinking…', 'Checking your financial brain'],
    speaking: ['Speaking…', 'Start talking to interrupt']
  };

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var timers = [];
  var raf = null;
  var running = false;

  /** Mirrors setState() in js/voice.js: one state class on the container. */
  function setState(next) {
    container.className = 'voice-orb-container';
    if (next === 'listening') container.classList.add('state-listening');
    else if (next === 'thinking' || next === 'connecting') container.classList.add('state-processing');
    else if (next === 'speaking') container.classList.add('state-speaking');

    var copy = COPY[next] || COPY.idle;
    if (statusEl) statusEl.textContent = copy[0];
    if (hintEl) hintEl.textContent = copy[1];

    if (next !== 'speaking') {
      stopAmplitude();
      orb.style.transform = 'scale(1)';
    }
  }

  /* ---- speaking amplitude ----
     js/voice.js does: orb.style.transform = 'scale(' + (1 + v * 0.35) + ')'
     on every volume-level event. The same expression is used here, fed by a
     synthetic envelope so the motion reads as speech rather than a loop. */
  function startAmplitude() {
    var t0 = performance.now();
    function frame(now) {
      var t = (now - t0) / 1000;
      var v = Math.abs(Math.sin(t * 5.1)) * 0.55 +
              Math.abs(Math.sin(t * 2.3 + 1.1)) * 0.35;
      v = Math.min(1, v);
      orb.style.transform = 'scale(' + (1 + v * 0.35).toFixed(3) + ')';
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  function stopAmplitude() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function at(ms, fn) { timers.push(setTimeout(fn, ms)); }

  /** One pass of a call, then it loops. */
  function cycle() {
    if (!running) return;
    clearTimers();
    setState('connecting');
    at(1100, function () { setState('listening'); });
    at(4200, function () { setState('thinking'); });
    at(6400, function () { setState('speaking'); startAmplitude(); });
    at(11500, function () { setState('listening'); });
    at(15000, cycle);
  }

  function start() {
    if (running) return;
    running = true;
    cycle();
  }

  function stop() {
    running = false;
    clearTimers();
    stopAmplitude();
    setState('idle');
  }

  // Reduced motion gets the finished state, not a faster one: the orb sits in
  // its listening colour without breathing or rippling.
  if (reduce) {
    setState('listening');
    return;
  }

  // Only animate while the orb is actually on screen, so a background tab or a
  // scrolled-past section costs nothing.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) start();
        else stop();
      });
    }, { threshold: 0.25 }).observe(root);
  } else {
    start();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimers(); stopAmplitude(); }
    else if (running) cycle();
  });
})();
