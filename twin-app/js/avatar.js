/* ==========================================================================
   MoneyKal — profile picture

   Upload, preview, save, replace and remove, plus the initials fallback that
   every avatar on the page falls back to when there is no picture.

   WHERE THE PICTURE COMES FROM
   ----------------------------
   GET /profile/me returns `avatar` (a data URI, or null) and `initials`. Both
   are painted onto every `.ov-avatar` on the page, so the topbar avatar and
   the one inside the account menu can never disagree.

   WHY PREVIEW AND SAVE ARE SEPARATE
   ---------------------------------
   Choosing a file shows it immediately from a local object URL and nothing is
   sent. The upload only happens on Save. Picking the wrong photo is the most
   likely mistake here, and it should cost a click to undo rather than a
   round trip and a second upload.

   Validation is duplicated on purpose. The server is the authority — it
   decodes every image and rejects anything that is not one — but checking
   type and size in the browser turns "wait four seconds, then an error" into
   an instant, specific message, and saves uploading 20 MB to be told no.
   ========================================================================== */
(function () {
  'use strict';

  var MAX_BYTES = 4 * 1024 * 1024;
  var ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

  var state = { file: null, objectUrl: null, current: null, initials: 'M' };

  function $(id) { return document.getElementById(id); }

  /** Paint every avatar on the page: the topbar, the menu, the preview. */
  function paintAll() {
    var url = state.current;
    document.querySelectorAll('.ov-avatar').forEach(function (el) {
      if (url) {
        el.textContent = '';
        el.style.backgroundImage = 'url("' + url + '")';
        el.classList.add('has-photo');
      } else {
        el.style.backgroundImage = '';
        el.classList.remove('has-photo');
        el.textContent = state.initials;
      }
    });
    var prev = $('ovPicPreview');
    if (prev) {
      var shown = state.objectUrl || url;
      if (shown) {
        prev.textContent = '';
        prev.style.backgroundImage = 'url("' + shown + '")';
        prev.classList.add('has-photo');
      } else {
        prev.style.backgroundImage = '';
        prev.classList.remove('has-photo');
        prev.textContent = state.initials;
      }
    }
    syncButtons();
  }

  function syncButtons() {
    var staged = !!state.file;
    var has = !!state.current;
    if ($('ovPicSave')) $('ovPicSave').hidden = !staged;
    if ($('ovPicCancel')) $('ovPicCancel').hidden = !staged;
    if ($('ovPicRemove')) $('ovPicRemove').hidden = staged || !has;
    if ($('ovPicChoose')) {
      $('ovPicChoose').textContent = window.t
        ? window.t(has ? 'Replace' : 'Upload')
        : (has ? 'Replace' : 'Upload');
    }
  }

  function say(text, kind) {
    var el = $('ovPicMsg');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = window.t ? window.t(text) : text;
    el.className = 'ov-pic__msg' + (kind ? ' is-' + kind : '');
  }

  function clearStaged() {
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    state.file = null;
    var input = $('ovPicInput');
    if (input) input.value = '';     // so re-picking the same file still fires change
  }

  /* ------------------------------------------------------------- selection */

  function onPick(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    if (ALLOWED.indexOf(file.type) < 0) {
      say('Use a PNG, JPG or WebP image.', 'bad');
      clearStaged();
      paintAll();
      return;
    }
    if (file.size > MAX_BYTES) {
      say('That image is over 4 MB. Please choose a smaller one.', 'bad');
      clearStaged();
      paintAll();
      return;
    }

    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.file = file;
    state.objectUrl = URL.createObjectURL(file);
    say('Preview only — press Save to keep it.', 'info');
    paintAll();
  }

  /* ----------------------------------------------------------------- save */

  async function onSave() {
    if (!state.file || !window.api || !window.api.uploadAvatar) return;
    var btn = $('ovPicSave');
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '…'; }
    say('Uploading…', 'info');
    try {
      var out = await window.api.uploadAvatar(state.file);
      state.current = out.avatar || null;
      if (out.initials) state.initials = out.initials;
      clearStaged();
      say('Profile picture updated.', 'good');
      paintAll();
    } catch (err) {
      // The server's message is written for the user, so show it rather than
      // a generic failure.
      say(err && err.message ? err.message : 'Could not upload that picture.', 'bad');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Save'; }
    }
  }

  function onCancel() {
    clearStaged();
    say('');
    paintAll();
  }

  async function onRemove() {
    if (!window.api || !window.api.removeAvatar) return;
    var btn = $('ovPicRemove');
    if (btn) btn.disabled = true;
    say('Removing…', 'info');
    try {
      var out = await window.api.removeAvatar();
      state.current = null;
      if (out.initials) state.initials = out.initials;
      say('Back to your initials.', 'good');
      paintAll();
    } catch (err) {
      say(err && err.message ? err.message : 'Could not remove the picture.', 'bad');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ----------------------------------------------------------------- boot */

  /** Called by the profile renderers once /profile/me has landed. */
  function hydrate(profile) {
    if (!profile) return;
    state.current = profile.avatar || null;
    if (profile.initials) state.initials = profile.initials;
    paintAll();
  }

  function boot() {
    var input = $('ovPicInput');
    if (input) input.addEventListener('change', onPick);
    if ($('ovPicChoose')) $('ovPicChoose').addEventListener('click', function () { input && input.click(); });
    if ($('ovPicSave')) $('ovPicSave').addEventListener('click', onSave);
    if ($('ovPicCancel')) $('ovPicCancel').addEventListener('click', onCancel);
    if ($('ovPicRemove')) $('ovPicRemove').addEventListener('click', onRemove);
    paintAll();
  }

  window.mkAvatar = { hydrate: hydrate, repaint: paintAll };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
