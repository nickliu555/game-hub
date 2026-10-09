/* Round-end banner for the arcade host screens (Snake Party, Maze Chomp).
 *
 * Turns a plain `.reason-overlay > .reason-text` into a short sequence:
 * the banner slams in on a ribbon (with a shine sweep and a shockwave ring),
 * the board shakes once on impact (the banner itself stays still), the board
 * dims behind it, plus a flourish per ending:
 *   win  — ribbon in the winner's colour, a spotlight + 👑 + confetti on them
 *   time — the board drains of colour and the clock flashes (lighter shake)
 *   down — strongest shake + a red flash at the edges
 *   over — solo game over: a medium shake
 * Respects prefers-reduced-motion (no slam / shake / confetti).
 *
 *   EndBanner.show({ overlay, board, clock, text, kind, color, spot, sound })
 *     spot: { x, y } in px relative to the overlay (win only)
 *   EndBanner.reset(overlay, board, clock)
 */
(function (global) {
  'use strict';

  const SHAKE = { win: 'eb-shake-md', time: 'eb-shake-sm', down: 'eb-shake-lg', over: 'eb-shake-md' };
  const RIBBON = { time: '#FBBF24', down: '#EF4444', over: '#F87171' };

  function reduced() {
    try { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  // Build the extra layers inside the overlay once, keeping the game's own
  // .reason-text element (its id is used elsewhere).
  function parts(overlay) {
    if (overlay._eb) return overlay._eb;
    const text = overlay.querySelector('.reason-text');
    const vignette = document.createElement('div'); vignette.className = 'eb-vignette';
    const ribbon = document.createElement('div'); ribbon.className = 'eb-ribbon';
    const ring = document.createElement('div'); ring.className = 'eb-ring';
    const shine = document.createElement('div'); shine.className = 'eb-shine';
    const crown = document.createElement('div'); crown.className = 'eb-crown'; crown.textContent = '👑';
    const burst = document.createElement('div'); burst.className = 'eb-burst';
    overlay.insertBefore(vignette, overlay.firstChild);
    overlay.appendChild(ring);
    ribbon.appendChild(text);
    ribbon.appendChild(shine);
    overlay.appendChild(ribbon);
    overlay.appendChild(crown);
    overlay.appendChild(burst);
    overlay.classList.add('eb');
    overlay._eb = { text: text, vignette: vignette, ribbon: ribbon, ring: ring, crown: crown, burst: burst, timers: [] };
    return overlay._eb;
  }

  function restart(el) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }

  function reset(overlay, board, clock) {
    if (overlay && overlay._eb) {
      const e = overlay._eb;
      e.timers.forEach(clearTimeout); e.timers = [];
      e.burst.textContent = '';
      overlay.classList.remove('eb-win', 'eb-time', 'eb-down', 'eb-over', 'eb-spot');
    }
    if (board) board.classList.remove('eb-freeze', 'eb-shake-sm', 'eb-shake-md', 'eb-shake-lg');
    if (clock) clock.classList.remove('eb-clock-flash');
  }

  function confetti(e, x, y, color) {
    const colors = [color, '#FFFFFF', '#FFE58A', color];
    for (let i = 0; i < 26; i++) {
      const d = document.createElement('i');
      const a = Math.random() * Math.PI * 2, v = 70 + Math.random() * 130;
      d.style.left = x + 'px'; d.style.top = y + 'px';
      d.style.background = colors[i % colors.length];
      d.style.setProperty('--dx', Math.cos(a) * v + 'px');
      d.style.setProperty('--dy', (Math.sin(a) * v - 60) + 'px');
      d.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      d.style.animationDelay = (Math.random() * 0.08) + 's';
      e.burst.appendChild(d);
    }
  }

  function show(o) {
    const overlay = o.overlay;
    if (!overlay) return;
    const e = parts(overlay);
    const kind = o.kind || 'time';
    reset(overlay, o.board, o.clock);
    e.text.textContent = o.text || '';
    const col = kind === 'win' ? (o.color || '#A3E635') : RIBBON[kind];
    overlay.style.setProperty('--eb-color', col || '#FFFFFF');
    overlay.classList.add('eb-' + kind);
    // Spotlight on the winner (the vignette opens up around them).
    if (kind === 'win' && o.spot) {
      overlay.style.setProperty('--eb-x', o.spot.x + 'px');
      overlay.style.setProperty('--eb-y', o.spot.y + 'px');
      overlay.classList.add('eb-spot');
      e.crown.style.left = o.spot.x + 'px';
      e.crown.style.top = o.spot.y + 'px';
    }
    overlay.hidden = false;
    [e.vignette, e.ribbon, e.text, e.ring, e.crown].forEach(restart);
    e.ribbon.querySelector('.eb-shine') && restart(e.ribbon.querySelector('.eb-shine'));
    if (kind === 'time') {
      if (o.board) o.board.classList.add('eb-freeze');
      if (o.clock) { o.clock.classList.add('eb-clock-flash'); }
    }
    const calm = reduced();
    // Impact: shake the board (never the banner), sound, confetti.
    e.timers.push(setTimeout(function () {
      if (o.sound) { try { o.sound(kind); } catch (_) {} }
      if (calm) return;
      if (o.board) {
        const cls = SHAKE[kind] || 'eb-shake-sm';
        o.board.classList.remove(cls); void o.board.offsetWidth; o.board.classList.add(cls);
      }
      if (kind === 'win' && o.spot) confetti(e, o.spot.x, o.spot.y, col);
    }, calm ? 0 : 280));
    e.timers.push(setTimeout(function () { e.burst.textContent = ''; }, 2200));
  }

  global.EndBanner = { show: show, reset: reset };
})(window);
