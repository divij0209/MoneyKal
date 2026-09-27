/* ==========================================================================
   live.life.fully — scenes

   The background of this experience is a rotating set of cinematic scenes.
   Each scene is described once, here, and can be rendered two ways:

     1. A video, if a file exists at `scene.video`. Drop an .mp4 into
        assets/live-life/ with the filename below and it is picked up on the
        next load — no code change. See assets/live-life/README.md.
     2. A procedural fallback: layered SVG silhouettes over a gradient, drawn
        from a seeded random so a given scene looks identical on every load.

   The fallback is not a placeholder waiting to be replaced. No video files
   ship with the project, so it is what actually renders today, and it is
   built to stand on its own — parallax layers, light leaks and drifting
   particles rather than a flat image. If a video is added later it simply
   layers on top and the same gradient/veil keeps the text readable.

   Nothing here touches financial data. This file is scenery.
   ========================================================================== */
(function () {

  /* ------------------------------------------------------- seeded random
     Deterministic so a scene does not re-scramble its mountains every time
     the user opens the experience — it should feel like a place, not noise. */
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const W = 1440, H = 900;

  /* --------------------------------------------------------- art helpers */

  /** A jagged ridge line across the frame, closed to the bottom edge. */
  function ridge(rand, baseY, amp, n) {
    const step = (W + 80) / n;
    let d = 'M -40 ' + H + ' L -40 ' + baseY.toFixed(0);
    for (let i = 0; i <= n; i++) {
      const x = -40 + i * step;
      const peak = baseY - rand() * amp - (i % 2 ? amp * 0.22 : 0);
      d += ' L ' + x.toFixed(0) + ' ' + peak.toFixed(0);
    }
    return d + ' L ' + (W + 40) + ' ' + H + ' Z';
  }

  /** A soft rolling band — sea, cloud deck, dunes. */
  function band(rand, baseY, amp, n) {
    const step = (W + 80) / n;
    let d = 'M -40 ' + H + ' L -40 ' + baseY.toFixed(0);
    for (let i = 1; i <= n; i++) {
      const x = -40 + i * step;
      const cx = x - step / 2;
      const cy = baseY - amp + rand() * amp * 2;
      d += ' Q ' + cx.toFixed(0) + ' ' + cy.toFixed(0) + ' ' + x.toFixed(0) + ' ' + baseY.toFixed(0);
    }
    return d + ' L ' + (W + 40) + ' ' + H + ' Z';
  }

  function stars(rand, count, maxY) {
    let out = '';
    for (let i = 0; i < count; i++) {
      const x = rand() * W, y = rand() * maxY, r = 0.6 + rand() * 1.5;
      out += '<circle cx="' + x.toFixed(0) + '" cy="' + y.toFixed(0) + '" r="' + r.toFixed(1) +
             '" fill="#fff" opacity="' + (0.25 + rand() * 0.55).toFixed(2) + '"/>';
    }
    return out;
  }

  function disc(cx, cy, r, color, opacity) {
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + color +
           '" opacity="' + opacity + '"/>';
  }

  /* ------------------------------------------------------------ scene art
     Each generator returns layers, painted back to front. `depth` drives the
     parallax multiplier in live-life.js — higher moves more. */

  const ART = {

    peaks(rand) {
      return [
        { depth: 0.2, html: stars(rand, 60, 420) + disc(1080, 250, 78, '#ffffff', 0.10) },
        { depth: 0.5, html: '<path d="' + ridge(rand, 560, 150, 9) + '" fill="rgba(255,255,255,0.09)"/>' },
        { depth: 1.0, html: '<path d="' + ridge(rand, 660, 190, 7) + '" fill="rgba(6,10,20,0.55)"/>' },
        { depth: 1.7, html: '<path d="' + ridge(rand, 780, 170, 5) + '" fill="rgba(2,4,10,0.85)"/>' }
      ];
    },

    waves(rand) {
      const sun = disc(720, 430, 120, '#ffd9a0', 0.55) + disc(720, 430, 190, '#ff9a55', 0.18);
      return [
        { depth: 0.2, html: sun },
        { depth: 0.7, html: '<path d="' + band(rand, 520, 14, 6) + '" fill="rgba(255,150,90,0.16)"/>' },
        { depth: 1.2, html: '<path d="' + band(rand, 640, 26, 5) + '" fill="rgba(10,20,40,0.55)"/>' },
        { depth: 2.0, html: '<path d="' + band(rand, 770, 34, 4) + '" fill="rgba(3,8,18,0.85)"/>' }
      ];
    },

    flight(rand) {
      let clouds = '';
      for (let i = 0; i < 7; i++) {
        const x = rand() * W, y = 380 + rand() * 380, rx = 150 + rand() * 190;
        clouds += '<ellipse cx="' + x.toFixed(0) + '" cy="' + y.toFixed(0) + '" rx="' + rx.toFixed(0) +
                  '" ry="' + (rx * 0.28).toFixed(0) + '" fill="rgba(255,255,255,0.10)"/>';
      }
      return [
        { depth: 0.2, html: stars(rand, 40, 300) },
        { depth: 0.8, html: clouds },
        { depth: 1.6, html: '<path d="M -60 700 Q 500 520 1500 640" stroke="rgba(255,255,255,0.28)" ' +
                            'stroke-width="2" stroke-dasharray="10 14" fill="none"/>' +
                            '<path d="M 980 596 l 34 12 -34 12 6 -12 z" fill="rgba(255,255,255,0.85)"/>' },
        { depth: 2.4, html: '<path d="' + band(rand, 820, 20, 4) + '" fill="rgba(4,6,16,0.8)"/>' }
      ];
    },

    crowd(rand) {
      let beams = '';
      for (let i = 0; i < 5; i++) {
        const x = 180 + i * 280 + rand() * 60;
        beams += '<path d="M ' + x.toFixed(0) + ' -40 L ' + (x - 150).toFixed(0) + ' ' + H +
                 ' L ' + (x + 150).toFixed(0) + ' ' + H + ' Z" fill="url(#llfBeam)" opacity="' +
                 (0.16 + rand() * 0.2).toFixed(2) + '"/>';
      }
      let people = '';
      for (let i = 0; i < 46; i++) {
        const x = rand() * W, y = 720 + rand() * 150, r = 16 + rand() * 12;
        people += '<circle cx="' + x.toFixed(0) + '" cy="' + y.toFixed(0) + '" r="' + r.toFixed(0) +
                  '" fill="rgba(0,0,0,0.82)"/>' +
                  '<rect x="' + (x - r * 1.5).toFixed(0) + '" y="' + (y + r * 0.7).toFixed(0) +
                  '" width="' + (r * 3).toFixed(0) + '" height="200" rx="' + r.toFixed(0) +
                  '" fill="rgba(0,0,0,0.82)"/>';
      }
      return [
        { depth: 0.3, html: beams },
        { depth: 0.9, html: disc(720, 300, 220, '#ffffff', 0.07) },
        { depth: 1.8, html: people }
      ];
    },

    beams(rand) {
      let cones = '';
      for (let i = 0; i < 6; i++) {
        const x = rand() * W;
        cones += '<path d="M ' + x.toFixed(0) + ' -60 L ' + (x - 220).toFixed(0) + ' ' + H +
                 ' L ' + (x + 90).toFixed(0) + ' ' + H + ' Z" fill="url(#llfBeam)" opacity="' +
                 (0.12 + rand() * 0.22).toFixed(2) + '"/>';
      }
      let orbs = '';
      for (let i = 0; i < 22; i++) {
        orbs += disc((rand() * W).toFixed(0), (rand() * H * 0.8).toFixed(0),
                     (3 + rand() * 8).toFixed(1), '#ffffff', (0.15 + rand() * 0.4).toFixed(2));
      }
      return [
        { depth: 0.4, html: cones },
        { depth: 1.3, html: orbs },
        { depth: 2.2, html: '<path d="' + band(rand, 830, 16, 3) + '" fill="rgba(2,2,8,0.85)"/>' }
      ];
    },

    skyline(rand) {
      let towers = '', windows = '';
      let x = -60;
      while (x < W + 60) {
        const w = 60 + rand() * 90;
        const h = 220 + rand() * 400;
        const y = H - h;
        towers += '<rect x="' + x.toFixed(0) + '" y="' + y.toFixed(0) + '" width="' + w.toFixed(0) +
                  '" height="' + h.toFixed(0) + '" fill="rgba(2,5,14,0.9)"/>';
        for (let wy = y + 22; wy < H - 30; wy += 30) {
          for (let wx = x + 12; wx < x + w - 14; wx += 24) {
            if (rand() > 0.55) {
              windows += '<rect x="' + wx.toFixed(0) + '" y="' + wy.toFixed(0) +
                         '" width="8" height="12" fill="#ffd9a0" opacity="' +
                         (0.25 + rand() * 0.6).toFixed(2) + '"/>';
            }
          }
        }
        x += w + 10 + rand() * 26;
      }
      return [
        { depth: 0.2, html: stars(rand, 50, 380) },
        { depth: 0.8, html: '<path d="' + ridge(rand, 640, 90, 8) + '" fill="rgba(255,255,255,0.05)"/>' },
        { depth: 1.6, html: towers + windows }
      ];
    },

    fire(rand) {
      let flames = '';
      for (let i = 0; i < 5; i++) {
        const x = 700 + (i - 2) * 34 + rand() * 20;
        const h = 150 + rand() * 130;
        flames += '<path d="M ' + x + ' 780 C ' + (x - 40) + ' ' + (780 - h * 0.5) + ', ' +
                  (x + 34) + ' ' + (780 - h * 0.7) + ', ' + x + ' ' + (780 - h) + ' C ' +
                  (x - 30) + ' ' + (780 - h * 0.6) + ', ' + (x + 40) + ' ' + (780 - h * 0.45) +
                  ', ' + x + ' 780 Z" fill="url(#llfFire)" opacity="' +
                  (0.4 + rand() * 0.45).toFixed(2) + '"/>';
      }
      let sparks = '';
      for (let i = 0; i < 34; i++) {
        sparks += disc((620 + rand() * 200).toFixed(0), (280 + rand() * 480).toFixed(0),
                       (1 + rand() * 2.4).toFixed(1), '#ffb469', (0.3 + rand() * 0.6).toFixed(2));
      }
      return [
        { depth: 0.2, html: stars(rand, 70, 460) },
        { depth: 0.7, html: '<path d="' + ridge(rand, 700, 120, 6) + '" fill="rgba(4,6,14,0.8)"/>' },
        { depth: 1.4, html: disc(720, 740, 210, '#ff7a2f', 0.16) + flames },
        { depth: 2.2, html: sparks }
      ];
    },

    road(rand) {
      let dashes = '';
      for (let i = 0; i < 9; i++) {
        const t = i / 9;
        const y = 560 + t * t * 340;
        const w = 4 + t * 26;
        const h = 12 + t * 46;
        dashes += '<rect x="' + (720 - w / 2).toFixed(0) + '" y="' + y.toFixed(0) + '" width="' +
                  w.toFixed(0) + '" height="' + h.toFixed(0) + '" rx="' + (w / 2).toFixed(0) +
                  '" fill="rgba(255,255,255,0.5)"/>';
      }
      return [
        { depth: 0.2, html: stars(rand, 30, 320) + disc(720, 470, 96, '#ffcf9a', 0.35) },
        { depth: 0.7, html: '<path d="' + ridge(rand, 600, 110, 7) + '" fill="rgba(8,10,22,0.7)"/>' },
        { depth: 1.5, html: '<path d="M 660 540 L 780 540 L 1180 ' + H + ' L 260 ' + H +
                            ' Z" fill="rgba(3,4,10,0.88)"/>' + dashes }
      ];
    },

    palms(rand) {
      function palm(x, base, scale, lean) {
        let s = '<path d="M ' + x + ' ' + base + ' Q ' + (x + lean * 0.4) + ' ' +
                (base - 150 * scale) + ' ' + (x + lean) + ' ' + (base - 300 * scale) +
                '" stroke="rgba(2,4,10,0.92)" stroke-width="' + (12 * scale).toFixed(1) +
                '" fill="none" stroke-linecap="round"/>';
        for (let i = 0; i < 6; i++) {
          const a = -150 + i * 48 + rand() * 16;
          const rad = a * Math.PI / 180;
          const tx = x + lean, ty = base - 300 * scale;
          s += '<path d="M ' + tx.toFixed(0) + ' ' + ty.toFixed(0) + ' Q ' +
               (tx + Math.cos(rad) * 90 * scale).toFixed(0) + ' ' +
               (ty + Math.sin(rad) * 60 * scale).toFixed(0) + ' ' +
               (tx + Math.cos(rad) * 165 * scale).toFixed(0) + ' ' +
               (ty + Math.sin(rad) * 130 * scale + 30).toFixed(0) +
               '" stroke="rgba(2,4,10,0.92)" stroke-width="' + (9 * scale).toFixed(1) +
               '" fill="none" stroke-linecap="round"/>';
        }
        return s;
      }
      return [
        { depth: 0.2, html: disc(600, 400, 130, '#ffd2a0', 0.5) + disc(600, 400, 220, '#ff8a5c', 0.16) },
        { depth: 0.9, html: '<path d="' + band(rand, 690, 18, 5) + '" fill="rgba(8,16,34,0.6)"/>' },
        { depth: 1.8, html: palm(210, 900, 1.1, 70) + palm(1240, 900, 0.95, -60) },
        { depth: 2.4, html: '<path d="' + band(rand, 850, 14, 4) + '" fill="rgba(2,4,10,0.85)"/>' }
      ];
    },

    trail(rand) {
      return [
        { depth: 0.2, html: stars(rand, 55, 400) },
        { depth: 0.7, html: '<path d="' + ridge(rand, 520, 170, 6) + '" fill="rgba(255,255,255,0.08)"/>' },
        { depth: 1.3, html: '<path d="' + ridge(rand, 700, 190, 4) + '" fill="rgba(5,9,20,0.78)"/>' +
                            '<path d="M 240 900 L 470 700 L 380 620 L 640 470 L 560 400 L 760 300" ' +
                            'stroke="rgba(255,255,255,0.35)" stroke-width="3" stroke-dasharray="9 12" ' +
                            'fill="none" stroke-linecap="round"/>' },
        { depth: 2.1, html: '<path d="' + ridge(rand, 840, 90, 4) + '" fill="rgba(1,3,8,0.9)"/>' }
      ];
    }
  };

  /* --------------------------------------------------------------- scenes
     `video` is the filename this scene would use if one is dropped into
     assets/live-life/. Nothing breaks when the file is absent — the loader
     never sees a 404 because it only attempts a fetch when `useVideo` is on
     and it falls back silently on error. */

  const SCENES = [
    { id: 'mountains', label: 'Mountains', art: 'peaks', video: 'assets/live-life/mountains.mp4',
      accent: '#39d0ff', sky: ['#0b1a2e', '#123a56', '#2a6b83'] },
    { id: 'beach', label: 'Beaches & sunsets', art: 'waves', video: 'assets/live-life/beach.mp4',
      accent: '#ff8a3d', sky: ['#1a1030', '#7c2f4a', '#e0713f'] },
    { id: 'travel', label: 'Travel', art: 'flight', video: 'assets/live-life/travel.mp4',
      accent: '#7cc7ff', sky: ['#0a1430', '#1d3a6b', '#5f7fb8'] },
    { id: 'concerts', label: 'Concerts & festivals', art: 'crowd', video: 'assets/live-life/concert.mp4',
      accent: '#ff5f9e', sky: ['#12061f', '#3d0f42', '#7a1f5c'] },
    { id: 'party', label: 'Parties & nightlife', art: 'beams', video: 'assets/live-life/party.mp4',
      accent: '#b06bff', sky: ['#0d0620', '#2c0f4d', '#5b1f7a'] },
    { id: 'city', label: 'City lights', art: 'skyline', video: 'assets/live-life/city.mp4',
      accent: '#00e5ff', sky: ['#04070f', '#0d1c33', '#1c3552'] },
    { id: 'bonfire', label: 'Bonfires & friends', art: 'fire', video: 'assets/live-life/bonfire.mp4',
      accent: '#ffb469', sky: ['#0a0710', '#26121a', '#4a2318'] },
    { id: 'roadtrip', label: 'Road trips', art: 'road', video: 'assets/live-life/roadtrip.mp4',
      accent: '#ffd166', sky: ['#131024', '#4a2a4a', '#b0654a'] },
    { id: 'weekend', label: 'Weekend escapes', art: 'palms', video: 'assets/live-life/weekend.mp4',
      accent: '#37e0b0', sky: ['#0a1826', '#134a4a', '#3f8a72'] },
    { id: 'adventure', label: 'Adventure', art: 'trail', video: 'assets/live-life/adventure.mp4',
      accent: '#9be36d', sky: ['#0c1420', '#1c3a34', '#3d6b4a'] }
  ];

  /** Shared gradient defs every scene's SVG can reference. */
  const DEFS =
    '<defs>' +
    '<linearGradient id="llfBeam" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#fff" stop-opacity="0.85"/>' +
    '<stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="llfFire" x1="0" y1="1" x2="0" y2="0">' +
    '<stop offset="0%" stop-color="#ffcf6b"/><stop offset="60%" stop-color="#ff7a2f"/>' +
    '<stop offset="100%" stop-color="#ff3d2e" stop-opacity="0.5"/></linearGradient>' +
    '</defs>';

  /** Builds the DOM for one scene. Called once per scene on first open. */
  function buildScene(scene, index) {
    const rand = rng(index * 7919 + 104729);
    const layers = (ART[scene.art] || ART.peaks)(rand);
    const el = document.createElement('div');
    el.className = 'llf-scene';
    el.dataset.scene = scene.id;
    el.style.setProperty('--llf-sky-a', scene.sky[0]);
    el.style.setProperty('--llf-sky-b', scene.sky[1]);
    el.style.setProperty('--llf-sky-c', scene.sky[2]);

    let html = '<div class="llf-scene__sky"></div>';
    layers.forEach(function (layer, i) {
      html += '<svg class="llf-scene__layer" viewBox="0 0 ' + W + ' ' + H + '" ' +
              'preserveAspectRatio="xMidYMid slice" aria-hidden="true" ' +
              'style="--d:' + layer.depth + ';--i:' + i + '">' + DEFS + layer.html + '</svg>';
    });
    html += '<div class="llf-scene__leak llf-scene__leak--a"></div>' +
            '<div class="llf-scene__leak llf-scene__leak--b"></div>';
    el.innerHTML = html;
    return el;
  }

  /* ------------------------------------------------------------- backdrop
     One cinematic loop behind the whole experience.

     This takes priority over the rotating scenes above: when the file loads,
     it crossfades in over them and the rotation stops, because a single piece
     of footage under ten alternating silhouette sets would read as a glitch
     rather than as weather. The scenes stay mounted underneath as the fallback
     — if the file is missing, fails to decode, or the viewer prefers reduced
     motion, the rotation simply carries on and nothing is lost.

     Set `src` to null to go back to the rotating scenes. */
  const BACKDROP = {
    id: 'backdrop',
    label: 'live.life.fully',
    /* null = no backdrop. The 29 MB clip this pointed at was removed:
       mountBackdrop() in live-life.js has been an empty function since
       live.life.fully became an editorial page, so the file was shipped
       to every visitor's cache and never decoded. Put a path back here
       to re-enable it. */
    src: null,
    /* The footage does not change, so the accent does: the hero word, the
       glow behind the balance, the progress paths and the category cards all
       read --llf-accent, and cycling it keeps the page breathing colour
       without a second video. */
    accents: ['#39d0ff', '#ff8a3d', '#b06bff', '#ff5f9e', '#37e0b0', '#ffd166']
  };

  window.LLF_SCENES = {
    list: SCENES,
    build: buildScene,
    backdrop: BACKDROP,
    /** Exposed so the loader can decide whether to even try a per-scene video.
     *  Flipped to true once files matching each scene's `video` path are added
     *  to assets/live-life/. Independent of BACKDROP above. */
    videosAvailable: false
  };

})();
