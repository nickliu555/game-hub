/* Shared celebration confetti for every game's results screen.
 *
 *   window.Confetti.burst(['#FFC93C', '#FF4757', …]);
 *   window.Confetti.burst(colors, { amount: 0.4 });   // lighter (e.g. on a phone)
 *
 * Two cannon bursts from the bottom corners, then a staggered shower from the
 * top. Each piece is simulated up front (launch, gravity, shape-dependent air
 * drag, side-to-side flutter, 3D tumble) and played back with the Web
 * Animations API, so no two pieces fall the same way. Pieces use the
 * .hub-confetti class, which /shared/topbar.js's clearConfetti() removes.
 * Skipped entirely under prefers-reduced-motion.
 */
(function () {
  'use strict';

  var DEFAULT_COLORS = ['#FFC93C', '#FF4757', '#FFFFFF', '#3DDC84', '#3DA5FF', '#B388FF'];

  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }

  function burst(colors, opts) {
    if (reduced() || !document.body || typeof document.body.animate !== 'function') return;
    colors = colors && colors.length ? colors : DEFAULT_COLORS;
    var amount = opts && opts.amount > 0 ? Math.min(1, opts.amount) : 1;
    var W = window.innerWidth, H = window.innerHeight;
    var scale = Math.max(0.8, Math.min(1.6, H / 800));
    var pieces = [], i, side;
    for (side = 0; side < 2; side++) {
      var dir = side === 0 ? 1 : -1;
      for (i = 0; i < Math.round(70 * amount); i++) {
        var ang = (-90 + dir * (18 + Math.random() * 30)) * Math.PI / 180;
        var sp = (0.95 + Math.random() * 0.75) * H * 1.55;
        pieces.push({ x: side === 0 ? -10 : W + 10, y: H + 10, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, delay: Math.random() * 0.25 + side * 0.08 });
      }
    }
    for (i = 0; i < Math.round(80 * amount); i++) {
      pieces.push({ x: Math.random() * W, y: -20 - Math.random() * 40, vx: (Math.random() - 0.5) * 120, vy: Math.random() * 80, delay: 0.35 + Math.random() * 2.4 });
    }
    for (i = 0; i < pieces.length; i++) fly(pieces[i], colors[(Math.random() * colors.length) | 0], scale, H);
  }

  function fly(p, color, scale, H) {
    var el = document.createElement('div');
    el.className = 'hub-confetti';
    var shape = Math.random(), w, h, round = false;
    if (shape < 0.55) { w = 7 + Math.random() * 5; h = w * (1.6 + Math.random() * 0.8); }   // strip
    else if (shape < 0.85) { w = h = 7 + Math.random() * 4; }                                  // square
    else { w = h = 6 + Math.random() * 4; round = true; }                                      // dot
    var s = el.style;
    s.position = 'fixed'; s.left = '0'; s.top = '0';
    s.width = (w * scale).toFixed(1) + 'px';
    s.height = (h * scale).toFixed(1) + 'px';
    s.borderRadius = round ? '50%' : '2px';
    s.background = color;
    s.pointerEvents = 'none';
    s.zIndex = '2000';
    s.willChange = 'transform';
    s.transform = 'translate(-100px,-100px)';
    document.body.appendChild(el);

    // Light, flat pieces catch more air: lower terminal speed, more flutter.
    var drag = 1.6 + Math.random() * 1.4;
    var g = H * 1.35;
    var term = H * (0.16 + Math.random() * 0.1);
    var swayAmp = (18 + Math.random() * 34) * scale, swayHz = 0.6 + Math.random() * 0.9, swayPh = Math.random() * 6.28;
    var spin = (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 540);
    var flipHz = 1.2 + Math.random() * 2.4, flipAxis = Math.random() < 0.5 ? 'X' : 'Y';
    var rot0 = Math.random() * 360;
    var dt = 1 / 30, frames = [];
    var x = p.x, y = p.y, vx = p.vx, vy = p.vy, t = 0;
    while (t < 7) {
      var fluttering = vy > 0 ? Math.min(1, vy / term) : 0;
      var sx = Math.sin(t * swayHz * 6.283 + swayPh) * swayAmp * fluttering;
      frames.push({
        transform: 'translate(' + (x + sx).toFixed(1) + 'px,' + y.toFixed(1) + 'px) rotate(' + (rot0 + spin * t).toFixed(0) + 'deg) rotate' + flipAxis + '(' + (t * flipHz * 360).toFixed(0) + 'deg)',
      });
      vy += g * dt;
      vx -= vx * drag * dt;
      if (vy > term) vy -= (vy - term) * Math.min(1, drag * 2 * dt);
      x += vx * dt; y += vy * dt; t += dt;
      if (y > H + 40) break;
    }
    if (frames.length < 2) { el.remove(); return; }
    var anim = el.animate(frames, { duration: t * 1000, delay: p.delay * 1000, easing: 'linear', fill: 'both' });
    anim.onfinish = function () { el.remove(); };
    setTimeout(function () { el.remove(); }, (t + p.delay) * 1000 + 500);
  }

  window.Confetti = { burst: burst };
})();
