/* Voice mode — Vapi real-time voice-to-voice layer.
 *
 * Vapi replaces the old browser SpeechRecognition + Edge-TTS round trip. It is
 * the transport only: microphone -> Vapi (STT, turn-taking, barge-in, TTS) ->
 * our backend tools -> the existing Financial Twin brain -> back out as speech.
 *
 * This file never talks to the Financial Twin directly and never sends a
 * user_id. It asks the authenticated backend for a call configuration
 * (/voice/session) and hands that straight to the SDK.
 *
 * Flow:
 *   click -> mic permission -> POST /voice/session -> vapi.start(config)
 *         -> live conversation (interruptible) -> vapi.stop()
 */
(function () {
  'use strict';

  // Loaded lazily from the CDN so the static app needs no build step. In a
  // bundled app this is `import Vapi from '@vapi-ai/web'`.
  var SDK_SOURCES = [
    'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2/+esm',
    'https://cdn.jsdelivr.net/npm/@vapi-ai/web/+esm'
  ];

  function initVoice() {
    var btnVoiceMode = document.getElementById('btnVoiceMode');
    var btnVoiceClose = document.getElementById('btnVoiceClose');
    var voiceOverlay = document.getElementById('voiceOverlay');
    var voiceStatus = document.getElementById('voiceStatus');
    var voiceHint = document.getElementById('voiceHint');
    var voiceTranscript = document.getElementById('voiceTranscript');
    var voiceOrbContainer = document.querySelector('.voice-orb-container');
    var voiceOrb = document.getElementById('voiceOrb');
    var btnVoiceAction = document.getElementById('btnVoiceAction');
    var btnVoiceMute = document.getElementById('btnVoiceMute');
    var iconVoiceMic = document.getElementById('iconVoiceMic');
    var iconVoiceStop = document.getElementById('iconVoiceStop');

    if (!btnVoiceMode || !voiceOverlay) return;

    var vapi = null;          // SDK instance, created once per page
    var VapiCtor = null;      // resolved constructor
    var state = 'idle';
    var starting = false;
    var callActive = false;   // true only between call-start and call-end
    var muted = false;
    var connectTimer = null;
    var endedReason = '';
    var CONNECT_TIMEOUT_MS = 25000;

    // ---------------------------------------------------------------- states
    // idle | connecting | listening | thinking | speaking | error | disconnected
    var COPY = {
      idle: ['Speak. Ask. Understand.', 'Tap the mic to start a live conversation'],
      connecting: ['Connecting…', 'Setting up your secure voice session'],
      listening: ['Listening…', 'Just talk, you can interrupt any time'],
      thinking: ['Thinking…', 'Checking your financial brain'],
      speaking: ['Speaking…', 'Start talking to interrupt'],
      error: ['Something went wrong', ''],
      disconnected: ['Call ended', 'Tap the mic to talk again']
    };

    function setState(next, detail) {
      state = next;
      voiceOrbContainer.className = 'voice-orb-container';
      if (next === 'listening') voiceOrbContainer.classList.add('state-listening');
      else if (next === 'thinking' || next === 'connecting') voiceOrbContainer.classList.add('state-processing');
      else if (next === 'speaking') voiceOrbContainer.classList.add('state-speaking');
      else if (next === 'error') voiceOrbContainer.classList.add('state-error');

      var copy = COPY[next] || COPY.idle;
      voiceStatus.textContent = copy[0];
      if (voiceHint) voiceHint.textContent = detail || copy[1];

      var live = next === 'listening' || next === 'thinking' || next === 'speaking';
      iconVoiceMic.classList.toggle('hidden', live);
      iconVoiceStop.classList.toggle('hidden', !live);
      btnVoiceAction.disabled = next === 'connecting';
      btnVoiceAction.title = live ? 'End conversation' : 'Start conversation';
      if (btnVoiceMute) btnVoiceMute.classList.toggle('hidden', !live);
      if (!live) voiceOrb.style.transform = 'scale(1)';
    }

    function showError(message) {
      setState('error', message);
    }

    // Turns Vapi's endedReason into something worth reading.
    function endedHint() {
      if (/silence/i.test(endedReason)) return 'Ended after a long pause. Tap the mic to talk again.';
      if (/max-duration/i.test(endedReason)) return 'Reached the call length limit. Tap the mic to start again.';
      return '';
    }

    // ------------------------------------------------------------ transcript
    // Shown live for the duration of the call only. Voice transcripts are not
    // written to chat history or the database — the backend stays the source
    // of truth for Financial Twin memory.
    function clearTranscript() {
      if (voiceTranscript) voiceTranscript.innerHTML = '';
    }

    var partialEl = null;
    function renderTranscript(role, text, isFinal) {
      return; // Disabled live transcripts as requested
      if (!voiceTranscript || !text) return;
      if (!isFinal) {
        if (!partialEl || partialEl.dataset.role !== role) {
          partialEl = document.createElement('p');
          partialEl.className = 'voice-line voice-line--' + role + ' is-partial';
          partialEl.dataset.role = role;
          voiceTranscript.appendChild(partialEl);
        }
        partialEl.textContent = text;
      } else {
        if (partialEl && partialEl.dataset.role === role) {
          partialEl.classList.remove('is-partial');
          partialEl.textContent = text;
          partialEl = null;
        } else {
          var el = document.createElement('p');
          el.className = 'voice-line voice-line--' + role;
          el.textContent = text;
          voiceTranscript.appendChild(el);
        }
        while (voiceTranscript.children.length > 8) {
          voiceTranscript.removeChild(voiceTranscript.firstChild);
        }
      }
      voiceTranscript.scrollTop = voiceTranscript.scrollHeight;
    }

    // ------------------------------------------------------------- SDK setup
    // The package is CommonJS, so the CDN ESM build wraps the constructor in
    // one or two `default` layers depending on the bundler. Unwrap until we
    // reach the actual class.
    function resolveCtor(mod) {
      var candidate = mod;
      for (var depth = 0; depth < 4 && candidate; depth++) {
        if (typeof candidate === 'function') return candidate;
        candidate = candidate.default || candidate.Vapi;
      }
      return null;
    }

    async function loadSdk() {
      if (VapiCtor) return VapiCtor;
      var lastErr = null;
      for (var i = 0; i < SDK_SOURCES.length; i++) {
        try {
          var mod = await import(/* webpackIgnore: true */ SDK_SOURCES[i]);
          VapiCtor = resolveCtor(mod);
          if (VapiCtor) return VapiCtor;
          lastErr = new Error('Unexpected SDK module shape');
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('SDK unavailable');
    }

    function bindEvents(instance) {
      instance.on('call-start', function () {
        clearConnectTimer();
        starting = false;
        callActive = true;
        setState('listening');
      });

      instance.on('call-end', function () {
        clearConnectTimer();
        starting = false;
        callActive = false;
        partialEl = null;
        setState(state === 'error' ? 'error' : 'disconnected', endedHint());
      });

      // Assistant speech boundaries drive Speaking vs Listening.
      instance.on('speech-start', function () {
        if (callActive) setState('speaking');
      });
      instance.on('speech-end', function () {
        // A speech-end can land after the call is already over; it must not
        // put the UI back into a live state.
        if (callActive && state !== 'error') setState('listening');
      });

      // Real microphone/assistant energy replaces the old simulated pulse.
      instance.on('volume-level', function (level) {
        if (!callActive) return;
        var v = Math.max(0, Math.min(1, Number(level) || 0));
        voiceOrb.style.transform = 'scale(' + (1 + v * 0.35).toFixed(3) + ')';
      });

      instance.on('message', function (msg) {
        if (!msg) return;
        // Vapi reports why a call ended; keep it even if this lands after the
        // call is already torn down, so we can explain the ending.
        if (msg.type === 'status-update' && msg.status === 'ended') {
          endedReason = msg.endedReason || '';
          if (callActive) {
            callActive = false;
            setState('disconnected', endedHint());
          }
          return;
        }
        if (!callActive) return;
        if (msg.type === 'transcript' && msg.transcript) {
          var role = msg.role === 'assistant' ? 'twin' : 'user';
          renderTranscript(role, msg.transcript, msg.transcriptType === 'final');
          if (role === 'user' && msg.transcriptType === 'final' && state === 'listening') {
            setState('thinking');
          }
        } else if (msg.type === 'tool-calls' || msg.type === 'function-call') {
          setState('thinking', 'Checking your financial data');
        }
      });

      instance.on('error', function (err) {
        console.error('[voice] Vapi error', err);
        clearConnectTimer();
        starting = false;
        var wasConnected = callActive;
        callActive = false;

        var msg = (err && (err.errorMsg || err.error || err.message)) || '';
        if (typeof msg !== 'string') msg = '';

        // Once a call is live, the SDK also surfaces an ordinary hang-up
        // (silence timeout, assistant ended it, tab lost the room) as an
        // ejection error. That is a disconnect, not a failure to show.
        if (wasConnected && /eject|meeting/i.test(msg)) {
          setState('disconnected', endedHint());
          return;
        }
        if (/network|connection|websocket/i.test(msg)) {
          showError('The connection dropped. Check your network and try again.');
        } else if (wasConnected) {
          showError('The call ended unexpectedly. Please try again.');
        } else {
          showError('Voice service is unavailable right now. Please try again.');
        }
      });
    }

    // --------------------------------------------------------------- control
    function clearConnectTimer() {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    }

    // A start() that neither resolves nor errors would otherwise leave the UI
    // in Connecting forever, so give it a deadline.
    function armConnectTimer() {
      clearConnectTimer();
      connectTimer = setTimeout(function () {
        connectTimer = null;
        if (callActive) return;
        starting = false;
        try { if (vapi) vapi.stop(); } catch (e) { /* nothing to stop */ }
        showError('Connecting is taking too long. Check your connection and try again.');
      }, CONNECT_TIMEOUT_MS);
    }

    async function requestMic() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw { kind: 'unsupported' };
      }
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Vapi opens its own track; release this probe immediately.
        stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) {
        throw { kind: 'permission', name: e && e.name };
      }
    }

    async function startCall() {
      if (starting || state === 'listening' || state === 'thinking' || state === 'speaking') return;
      starting = true;
      endedReason = '';
      clearTranscript();
      setState('connecting');
      armConnectTimer();

      try {
        await requestMic();
      } catch (e) {
        starting = false;
        clearConnectTimer();
        if (e && e.kind === 'unsupported') {
          showError('This browser cannot access the microphone. Try Chrome or Edge.');
        } else {
          showError('Microphone access is blocked. Allow it in your browser settings, then try again.');
        }
        return;
      }

      var config;
      try {
        config = await window.api.startVoiceSession();
      } catch (e) {
        starting = false;
        clearConnectTimer();
        console.error('[voice] session error', e);
        if (e && e.status === 402 && window.billingView && window.billingView.prompt(e.detail)) {
          showError("You've used this month's free questions.");
        } else if (e && e.status === 401) {
          showError('Your session expired. Please sign in again.');
        } else if (e && e.status === 503) {
          showError('Voice mode is not available right now. Please try again later.');
        } else if (e && e.status === 404) {
          showError('Finish your profile setup first, then voice will have your numbers.');
        } else {
          showError('Could not start the call. Please try again.');
        }
        return;
      }

      try {
        var Ctor = await loadSdk();
        if (!vapi) {
          vapi = new Ctor(config.public_key);
          bindEvents(vapi);
          // Debug handle: lets you inspect or drive the live call from the
          // browser console when diagnosing a voice issue.
          window.__vapi = vapi;
        }
        muted = false;
        if (btnVoiceMute) btnVoiceMute.classList.remove('is-muted');

        if (config.assistant_id) {
          await vapi.start(config.assistant_id, config.assistant_overrides || {});
        } else {
          await vapi.start(config.assistant);
        }
      } catch (e) {
        starting = false;
        clearConnectTimer();
        console.error('[voice] start failed', e);
        showError('Could not connect the call. Please try again.');
      }
    }

    function endCall() {
      clearConnectTimer();
      callActive = false;
      try {
        if (vapi) vapi.stop();
      } catch (e) {
        console.error('[voice] stop failed', e);
      }
      starting = false;
      partialEl = null;
      if (state !== 'error') setState('disconnected');
    }

    function toggleMute() {
      if (!vapi) return;
      muted = !muted;
      try {
        vapi.setMuted(muted);
        btnVoiceMute.classList.toggle('is-muted', muted);
        btnVoiceMute.title = muted ? 'Unmute microphone' : 'Mute microphone';
      } catch (e) {
        muted = !muted;
      }
    }

    // ---- Outbound phone call (Varta over the telephone, via Omnidim) ----
    //
    // Two entry points drive this: the floating button and the sidebar item.
    // They have different markup, so the label is resolved generically rather
    // than assuming .floating-call-btn__label.

    var callState = { busy: false, configured: null, hasPhone: null };

    function labelOf(btn) {
      if (!btn) return null;
      return btn.querySelector('.floating-call-btn__label, .navitem__label');
    }

    function setCallLabel(btn, text) {
      var el = labelOf(btn);
      if (el) el.textContent = text;
    }

    function flashCallLabel(btn, text, revertTo, ms) {
      setCallLabel(btn, text);
      setTimeout(function () { setCallLabel(btn, revertTo); }, ms || 3500);
    }

    /** Mark every call entry point as unavailable, with the reason on hover. */
    function disableCallEntryPoints(reason) {
      document.querySelectorAll('.floating-call-btn, [data-varta-call]').forEach(function (el) {
        el.disabled = true;
        el.classList.add('is-unavailable');
        el.title = reason;
      });
      var hint = document.getElementById('navVartaHint');
      if (hint) { hint.textContent = 'Unavailable'; hint.hidden = false; }
    }

    /** Ask the backend what is actually available before the user clicks.
     *  getVoiceStatus existed and was never called, so the entry point used to
     *  look live on deployments with no voice provider at all. */
    async function refreshVoiceAvailability() {
      if (!window.api || !window.api.getVoiceStatus) return;
      try {
        var st = await window.api.getVoiceStatus();
        callState.configured = !!(st && st.calling_enabled);
        callState.hasPhone = !!(st && st.has_phone);
        if (!callState.configured) {
          disableCallEntryPoints('Phone calling is not switched on for this deployment yet.');
        }
      } catch (e) {
        // A status check that fails is not a reason to hide the feature; the
        // call itself reports the real problem.
        console.warn('[voice] could not read voice status', e);
      }
    }

    async function triggerPhoneCall(targetBtn) {
      if (callState.busy) return;

      var btn = targetBtn || btnVoiceMode || document.querySelector('.floating-call-btn');
      var labelEl = labelOf(btn);
      var prevText = labelEl ? labelEl.textContent : 'Call Varta';

      if (callState.configured === false) {
        alert('Phone calling is not switched on for this deployment yet.');
        return;
      }

      callState.busy = true;
      if (btn) btn.setAttribute('aria-busy', 'true');
      setCallLabel(btn, 'Calling…');

      try {
        var res = await window.api.triggerOmnidimCall(null, 'Live user requested call');
        if (res && res.success) {
          flashCallLabel(btn, 'Calling your phone', prevText);
        } else {
          // A provider-level refusal comes back 200 with success:false.
          setCallLabel(btn, prevText);
          alert((res && (res.error || res.reason)) ||
                'Could not place the call. Check the phone number saved on your profile.');
        }
      } catch (e) {
        console.error('[voice] phone call error', e);
        setCallLabel(btn, prevText);
        // e.message is the backend's own wording: no number on profile (400),
        // monthly allowance spent (402), or not configured (503). Anything we
        // substituted here would point the user at the wrong fix.
        alert(e && e.message ? e.message
                             : 'Could not trigger the call to your phone.');
      } finally {
        callState.busy = false;
        if (btn) btn.removeAttribute('aria-busy');
      }
    }

    if (btnVoiceMode) {
      btnVoiceMode.addEventListener('click', function (e) {
        e.preventDefault();
        triggerPhoneCall(btnVoiceMode);
      });
    }

    // Sidebar entry point plus any other floating button on the page.
    document.querySelectorAll('.floating-call-btn, [data-varta-call]').forEach(function (el) {
      if (el === btnVoiceMode) return;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        triggerPhoneCall(el);
      });
    });

    refreshVoiceAvailability();

    document.querySelectorAll('.btn-voice-chat-input').forEach(function (el) {
      el.addEventListener('click', function() {
        voiceOverlay.classList.remove('hidden');
        clearTranscript();
        setState('idle');
        startCall();
      });
    });

    btnVoiceClose.addEventListener('click', function () {
      endCall();
      voiceOverlay.classList.add('hidden');
      setState('idle');
    });

    btnVoiceAction.addEventListener('click', function () {
      if (state === 'listening' || state === 'thinking' || state === 'speaking') endCall();
      else startCall();
    });

    if (btnVoiceMute) btnVoiceMute.addEventListener('click', toggleMute);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !voiceOverlay.classList.contains('hidden')) {
        endCall();
        voiceOverlay.classList.add('hidden');
        setState('idle');
      }
    });

    // Never leave a call running on navigation.
    window.addEventListener('beforeunload', function () {
      if (vapi && (state === 'listening' || state === 'thinking' || state === 'speaking')) {
        try { vapi.stop(); } catch (err) { /* page is going away */ }
      }
    });

    setState('idle');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVoice);
  } else {
    initVoice();
  }
})();
