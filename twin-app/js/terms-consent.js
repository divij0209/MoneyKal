/* ==========================================================================
   MoneyKal — Terms & Conditions consent

   Two jobs, both used by login.html and register.html:

     1. Render the Terms document from js/legal-terms.js into a modal that
        opens over the auth page. Nothing here navigates away — the form
        keeps whatever the user has already typed.
     2. Gate a form submit on the acceptance checkbox, and say clearly why
        when it is not ticked.

   The modal reuses the `.mk-modal` classes the forgot-password dialog already
   uses, so it inherits the same panel, scrim and motion. Only the additions
   it needs of its own (a scrolling document body, the consent row, the error
   state) live in css/terms.css.

   Public API — window.MKTerms
     .version                     the version string sent to the backend
     .open(sectionId)             open, optionally scrolled to one section
     .close()
     .isAccepted(checkboxId)
     .validate({ checkboxId, message })   true when ticked; otherwise shows
                                          the inline error, focuses the box
                                          and returns false
     .acceptancePayload(checkboxId)       { terms_accepted, terms_version,
                                            terms_accepted_at } for the API

   No innerHTML is used anywhere in the render path: the inline markup in the
   content file (**bold** and [label](href)) is parsed into real DOM nodes.
   ========================================================================== */
(function () {
  'use strict';

  var DOC = window.MK_TERMS;
  if (!DOC) {
    // legal-terms.js failed to load. Say so once rather than throwing on every
    // click, and leave the checkbox gate working — the form must still block.
    if (window.console) console.warn('[MoneyKal] Terms content missing; the T&C dialog will not open.');
  }

  var DEFAULT_MESSAGE = 'Please accept the Terms & Conditions and Privacy Policy to continue.';

  var modal = null;        // built lazily, once
  var scrollHost = null;
  var lastFocused = null;

  /* ------------------------------------------------------------ helpers -- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * Parse the content file's inline markup into DOM nodes.
   *
   *   **bold**        -> <strong>
   *   [label](href)   -> <a href> (new tab, so the half-filled form survives)
   *
   * Anything else is a text node. Appending nodes rather than assigning
   * innerHTML means a stray angle bracket in the legal text is a character,
   * never markup.
   */
  var INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;

  function appendInline(parent, text) {
    var last = 0;
    var match;
    INLINE.lastIndex = 0;

    while ((match = INLINE.exec(text)) !== null) {
      if (match.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      if (match[1] !== undefined) {
        parent.appendChild(el('strong', null, match[1]));
      } else {
        var a = el('a', 'mk-terms__link', match[2]);
        a.href = match[3];
        a.target = '_blank';
        a.rel = 'noopener';
        parent.appendChild(a);
      }
      last = match.index + match[0].length;
    }

    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
    return parent;
  }

  /* -------------------------------------------------------- modal build -- */

  function buildDocument(host) {
    var meta = el('div', 'mk-terms__meta');
    meta.appendChild(el('span', 'mk-terms__version', 'Version ' + DOC.version));
    meta.appendChild(el('span', 'mk-terms__dot'));
    meta.appendChild(el('span', null, 'Last updated ' + DOC.updated));
    host.appendChild(meta);

    host.appendChild(appendInline(el('p', 'mk-terms__lead'), DOC.subtitle));
    host.appendChild(appendInline(el('div', 'mk-terms__callout'), DOC.callout));

    DOC.sections.forEach(function (section, i) {
      var wrap = el('section', 'mk-terms__section');
      wrap.id = 'terms-' + section.id;

      var head = el('h3', 'mk-terms__heading');
      head.appendChild(el('span', 'mk-terms__num', String(i + 1).padStart(2, '0')));
      head.appendChild(document.createTextNode(section.title));
      wrap.appendChild(head);

      section.body.forEach(function (block) {
        if (typeof block === 'string') {
          wrap.appendChild(appendInline(el('p', 'mk-terms__p'), block));
          return;
        }
        if (block && block.list) {
          var ul = el('ul', 'mk-terms__list');
          block.list.forEach(function (item) {
            ul.appendChild(appendInline(el('li'), item));
          });
          wrap.appendChild(ul);
        }
      });

      host.appendChild(wrap);
    });
  }

  function build() {
    if (modal) return modal;

    modal = el('div', 'mk-modal mk-modal--terms');
    modal.id = 'termsModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'termsModalTitle');

    var scrim = el('div', 'mk-modal__scrim');
    scrim.setAttribute('data-terms-close', '');
    modal.appendChild(scrim);

    var panel = el('div', 'mk-modal__panel mk-modal__panel--terms');

    var close = el('button', 'mk-modal__close');
    close.type = 'button';
    close.setAttribute('data-terms-close', '');
    close.setAttribute('aria-label', 'Close');
    close.appendChild(icon());
    panel.appendChild(close);

    var head = el('div', 'mk-terms__header');
    var title = el('h2', 'mk-modal__title', DOC ? DOC.title : 'Terms & Conditions');
    title.id = 'termsModalTitle';
    head.appendChild(title);
    panel.appendChild(head);

    scrollHost = el('div', 'mk-terms__body');
    scrollHost.tabIndex = 0;
    scrollHost.setAttribute('role', 'document');
    if (DOC) buildDocument(scrollHost);
    panel.appendChild(scrollHost);

    var foot = el('div', 'mk-terms__foot');
    var done = el('button', 'mk-btn--ghost', 'Close');
    done.type = 'button';
    done.setAttribute('data-terms-close', '');
    foot.appendChild(done);
    panel.appendChild(foot);

    modal.appendChild(panel);
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) {
      if (e.target.closest('[data-terms-close]')) close_();
    });

    // Tab stays inside the dialog while it is open.
    modal.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !modal.classList.contains('is-open')) return;
      var focusable = panel.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    return modal;
  }

  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    ['18,6 6,18', '6,6 18,18'].forEach(function (pair) {
      var pts = pair.split(' ');
      var line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', pts[0].split(',')[0]);
      line.setAttribute('y1', pts[0].split(',')[1]);
      line.setAttribute('x2', pts[1].split(',')[0]);
      line.setAttribute('y2', pts[1].split(',')[1]);
      svg.appendChild(line);
    });
    return svg;
  }

  /* --------------------------------------------------------- open/close -- */

  function open_(sectionId) {
    build();
    lastFocused = document.activeElement;
    modal.classList.add('is-open');
    document.body.classList.add('mk-scroll-locked');

    // Land at the top by default; jump to a named section when one was asked
    // for, so "Privacy Policy" opens on the privacy clause rather than making
    // the reader hunt for it.
    var target = sectionId ? document.getElementById('terms-' + sectionId) : null;
    if (scrollHost) scrollHost.scrollTop = 0;
    if (target && scrollHost) {
      target.classList.add('is-targeted');
      // Layout offsets, not getBoundingClientRect: the panel is still running
      // its open transform when this fires, and a measured rect is scaled by
      // it, which lands the reader some tens of pixels short. Both offsets
      // resolve against the same offsetParent, so the difference is the
      // target's position inside the scrolling content.
      var top = target.offsetTop - scrollHost.offsetTop;
      scrollHost.scrollTop = Math.max(top - 12, 0);
      setTimeout(function () { target.classList.remove('is-targeted'); }, 1800);
    }

    setTimeout(function () {
      if (scrollHost) scrollHost.focus();
    }, 60);
  }

  function close_() {
    if (!modal) return;
    modal.classList.remove('is-open');
    document.body.classList.remove('mk-scroll-locked');
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal && modal.classList.contains('is-open')) close_();
  });

  /* ------------------------------------------------------ consent gating -- */

  function consentBlock(box) {
    return box ? box.closest('.mk-consent') : null;
  }

  function clearInvalid(box) {
    var block = consentBlock(box);
    if (!block) return;
    block.classList.remove('is-invalid');
    var msg = block.querySelector('.mk-consent__error');
    if (msg) msg.textContent = '';
    box.setAttribute('aria-invalid', 'false');
  }

  function markInvalid(box, message) {
    var block = consentBlock(box);
    if (!block) return;
    block.classList.add('is-invalid');
    var msg = block.querySelector('.mk-consent__error');
    if (msg) msg.textContent = window.t ? window.t(message) : message;
    box.setAttribute('aria-invalid', 'true');
  }

  function isAccepted(checkboxId) {
    var box = document.getElementById(checkboxId);
    return !!(box && box.checked);
  }

  function validate(opts) {
    opts = opts || {};
    var box = document.getElementById(opts.checkboxId);
    // No checkbox on this form means nothing to gate. Failing open here is
    // deliberate: it keeps any form that does not carry a consent row working
    // exactly as it did.
    if (!box) return true;

    if (box.checked) {
      clearInvalid(box);
      return true;
    }

    markInvalid(box, opts.message || DEFAULT_MESSAGE);
    var block = consentBlock(box);
    if (block && block.scrollIntoView) {
      block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    box.focus();
    return false;
  }

  /** The three fields the backend records against the user row. */
  function acceptancePayload(checkboxId) {
    if (!isAccepted(checkboxId)) return null;
    return {
      terms_accepted: true,
      terms_version: DOC ? DOC.version : null,
      terms_accepted_at: new Date().toISOString(),
    };
  }

  /* --------------------------------------------------------------- wiring -- */

  function wire() {
    // Any element can open the dialog: `data-terms-open`, plus an optional
    // `data-terms-section` to land on one clause.
    document.addEventListener('click', function (e) {
      var trigger = e.target.closest('[data-terms-open]');
      if (!trigger) return;
      // The triggers sit inside the checkbox's <label>, so the click must not
      // reach it — reading the Terms is not the same as accepting them.
      e.preventDefault();
      e.stopPropagation();
      open_(trigger.getAttribute('data-terms-section') || null);
    });

    // Ticking the box clears a validation message that is no longer true.
    document.addEventListener('change', function (e) {
      var box = e.target;
      if (box && box.classList && box.classList.contains('mk-consent__input') && box.checked) {
        clearInvalid(box);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.MKTerms = {
    version: DOC ? DOC.version : null,
    open: open_,
    close: close_,
    isAccepted: isAccepted,
    validate: validate,
    acceptancePayload: acceptancePayload,
    DEFAULT_MESSAGE: DEFAULT_MESSAGE,
  };
})();
