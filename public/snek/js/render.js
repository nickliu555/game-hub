/* Snek — host canvas renderer. Draws the board, obstacles, apples, the
 * rare golden apple, snakes (smoothly interpolated between ticks), the deadly
 * board edge, name tags, and the effects: eat bursts, the death animation
 * (flash → the body breaks apart head-to-tail), screen shake, flash and a
 * brief hit-stop.
 * Purely presentational — never mutates the world.
 */
(function (global) {
  'use strict';

  const BG = '#0a1f14';
  const CELL_A = '#10291b';
  const CELL_B = '#0d2417';
  const WALL = '#3b5a4a';
  const WALL_EDGE = '#6f9c84';
  const APPLE = '#EF4444';
  const SPECIAL = '#FFD54A';
  const HITSTOP_SEC = 0.07;
  const FLASH_SEC = 0.32;         // death: body flashes before breaking up
  const BREAK_SEC = 0.9;          // death: max time for the head→tail break-up
  const POP_SEC = 0.28;

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.t = 0;
    this.alpha = 1;
    this.hitStop = 0;
    this.shake = 0;
    this.flash = 0;
    this.particles = [];
    this.rings = [];
    this.pops = [];               // floating "+5" when a special apple is eaten
    this.dying = [];
    this.seenFood = new WeakMap(); // food item -> time first drawn (pop-in)
    this.foodAnim = new WeakMap(); // food item -> glide state when a Magnet pulls it
    this.trailT = 0;
    this.showHeadings = false;    // countdown: chevrons in front of each head (also shown on waiting snakes)
    this.reduced = false;
    try { this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    this.resize();
  }

  Renderer.prototype.resize = function () {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    c.width = Math.floor(w * this.dpr);
    c.height = Math.floor(h * this.dpr);
    this.cssW = w; this.cssH = h;
  };

  Renderer.prototype._metrics = function () {
    const b = this.world.board;
    const ts = Math.max(4, Math.floor(Math.min(this.cssW / b.w, this.cssH / b.h)));
    const gw = ts * b.w, gh = ts * b.h;
    return { ts: ts, ox: Math.floor((this.cssW - gw) / 2), oy: Math.floor((this.cssH - gh) / 2), gw: gw, gh: gh };
  };

  // ---------------- Events ----------------
  Renderer.prototype.onEvent = function (ev) {
    if (!ev) return;
    if (ev.type === 'eat') {
      const special = ev.kind === 'special';
      const n = special ? 26 : 10;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = (special ? 2 : 1.5) + Math.random() * (special ? 4.5 : 3);
        this.particles.push({ x: ev.x + 0.5, y: ev.y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, max: 0.35 + Math.random() * (special ? 0.4 : 0.2), size: special ? 0.15 : 0.12, color: special && i % 3 === 0 ? '#ffffff' : ev.color });
      }
      if (special) {
        this.rings.push({ x: ev.x + 0.5, y: ev.y + 0.5, t: 0, max: 0.5, r0: 0.4, r1: 2.6, color: 'rgba(255,213,74,0.9)' });
        this.pops.push({ x: ev.x + 0.5, y: ev.y + 0.5, t: 0, max: 0.9, text: '+' + (ev.value || 3) });
      } else {
        this.rings.push({ x: ev.x + 0.5, y: ev.y + 0.5, t: 0, max: 0.35, r0: 0.3, r1: 1.3, color: 'rgba(255,120,120,0.8)' });
      }
    } else if (ev.type === 'death') {
      const cells = ev.cells || [];
      const step = cells.length > 1 ? Math.min(0.05, BREAK_SEC / cells.length) : 0;
      const t0 = this.t;
      const anim = { color: ev.color, cells: cells, t0: t0, step: step, popped: 0 };
      this.dying.push(anim);
      if (!this.reduced) {
        this.hitStop = HITSTOP_SEC;
        this.shake = Math.max(this.shake, 0.45);
        this.flash = Math.max(this.flash, 0.28);
      }
      this.rings.push({ x: ev.x + 0.5, y: ev.y + 0.5, t: 0, max: 0.6, r0: 0.3, r1: 3.2, color: ev.color });
      this.rings.push({ x: ev.x + 0.5, y: ev.y + 0.5, t: 0, max: 0.45, r0: 0.2, r1: 2.0, color: 'rgba(255,255,255,0.9)' });
    }
  };

  /** Still animating a death (the host waits for it before the round card). */
  Renderer.prototype.busy = function () { return this.dying.length > 0; };

  // ---------------- Frame ----------------
  Renderer.prototype.render = function (dt, alpha) {
    const ctx = this.ctx, b = this.world.board;
    if (!b) return;
    dt = dt || 0;
    this.t += dt;
    if (alpha != null) this.alpha = Math.max(0, Math.min(1, alpha));
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.flash = Math.max(0, this.flash - dt);

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const m = this._metrics();
    const ts = m.ts;
    let sx = 0, sy = 0;
    if (this.shake > 0) { sx = (Math.random() - 0.5) * this.shake * ts; sy = (Math.random() - 0.5) * this.shake * ts; }
    ctx.translate(m.ox + sx, m.oy + sy);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, m.gw, m.gh); ctx.clip();
    this._drawBoard(ctx, b, ts);
    this._drawFood(ctx, b, ts);
    this._drawDying(ctx, b, ts);
    this._drawSnakes(ctx, b, ts);
    this._drawFx(ctx, ts, dt);
    ctx.restore();

    // The board edge is a deadly wall (no wrapping), so it reads like one: a
    // solid, glowing frame straddling the outer cells' outer rim.
    const rim = Math.max(3, ts * 0.2);
    ctx.save();
    ctx.strokeStyle = WALL_EDGE;
    ctx.lineWidth = rim;
    ctx.shadowColor = WALL_EDGE;
    ctx.shadowBlur = rim * 1.5;
    ctx.strokeRect(0, 0, m.gw, m.gh);
    ctx.restore();

    this._drawTags(ctx, b, ts, m);

    if (this.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (this.flash * 0.55).toFixed(3) + ')';
      ctx.fillRect(0, 0, m.gw, m.gh);
    }
    ctx.restore();
  };

  Renderer.prototype._drawBoard = function (ctx, b, ts) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, b.w * ts, b.h * ts);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        ctx.fillStyle = ((x + y) & 1) ? CELL_A : CELL_B;
        ctx.fillRect(x * ts, y * ts, ts, ts);
      }
    }
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        if (!b.wall[y * b.w + x]) continue;
        ctx.fillStyle = WALL;
        roundRect(ctx, x * ts + ts * 0.04, y * ts + ts * 0.04, ts * 0.92, ts * 0.92, ts * 0.2);
        ctx.fill();
        ctx.strokeStyle = WALL_EDGE;
        ctx.lineWidth = Math.max(1, ts * 0.06);
        ctx.stroke();
      }
    }
  };

  Renderer.prototype._drawFood = function (ctx, b, ts) {
    const t = this.t;
    this.world.food.forEach(function (f, key) {
      if (!this.seenFood.has(f)) this.seenFood.set(f, t);
      const age = t - this.seenFood.get(f);
      const pop = Math.min(1, age / 0.22);
      const s = pop < 1 ? (0.4 + 0.9 * pop - 0.3 * pop * pop) : 1;
      // Glide (rather than jump) one cell when a Magnet pulls it.
      let st = this.foodAnim.get(f);
      if (!st) { st = { x: f.x, y: f.y, fx: f.x, fy: f.y, t0: -1, dx: f.x, dy: f.y }; this.foodAnim.set(f, st); }
      if (st.x !== f.x || st.y !== f.y) { st.fx = st.dx; st.fy = st.dy; st.t0 = t; st.x = f.x; st.y = f.y; }
      const gk = st.t0 < 0 ? 1 : Math.min(1, (t - st.t0) / 0.14);
      st.dx = st.fx + (f.x - st.fx) * gk; st.dy = st.fy + (f.y - st.fy) * gk;
      const cx = st.dx * ts + ts / 2, cy = st.dy * ts + ts / 2;
      if (st.t0 >= 0 && t - st.t0 < 0.35) {
        const fade = 1 - (t - st.t0) / 0.35;
        ctx.save();
        ctx.globalAlpha = 0.55 * fade;
        ctx.strokeStyle = '#FB7185';
        ctx.lineCap = 'round';
        ctx.lineWidth = ts * 0.22;
        ctx.beginPath(); ctx.moveTo(st.fx * ts + ts / 2, st.fy * ts + ts / 2); ctx.lineTo(cx, cy); ctx.stroke();
        ctx.restore();
      }
      if (f.kind === 'power') {
        drawPowerItem(ctx, cx, cy, ts, s, f.power, t);
      } else if (f.kind === 'apple') {
        const bob = Math.sin(t * 4 + f.x + f.y) * ts * 0.03;
        drawApple(ctx, cx, cy + bob, ts * 0.36 * s, APPLE, 'rgba(239,68,68,0.25)', ts);
      } else {
        // Special apple: gold, larger, pulsing glow + sparkle, tagged "+5" so it
        // can't be mistaken for a yellow snake.
        const bob = Math.sin(t * 5 + f.x) * ts * 0.05;
        const r = ts * 0.44 * s;
        const pulse = 0.5 + 0.5 * Math.sin(t * 6);
        ctx.fillStyle = 'rgba(255,213,74,' + (0.18 + 0.22 * pulse).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(cx, cy + bob, r * (1.7 + 0.25 * pulse), 0, Math.PI * 2); ctx.fill();
        drawApple(ctx, cx, cy + bob, r, SPECIAL, null, ts);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = Math.max(1, ts * 0.05);
        ctx.beginPath(); ctx.arc(cx, cy + bob, r, 0, Math.PI * 2); ctx.stroke();
        const sa = t * 2.5, sr = r * 1.15;
        drawSparkle(ctx, cx + Math.cos(sa) * sr, cy + bob + Math.sin(sa) * sr, ts * 0.13 * (0.6 + 0.4 * pulse));
        if (s >= 1) {
          ctx.font = '900 ' + Math.max(13, Math.round(ts * 0.72)) + 'px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = Math.max(3, ts * 0.18);
          ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          const label = '+' + (f.value || 5);
          // On the top row the tag sits below the apple so the board edge can't clip it.
          const ly = cy + bob + (f.y === 0 ? r * 2.1 : -r * 2.1);
          ctx.strokeText(label, cx, ly);
          ctx.fillStyle = '#FFE58A';
          ctx.fillText(label, cx, ly);
        }
      }
    }, this);
  };

  // Points along a snake (cell units, cell centres). The body follows the real
  // grid path: only the head slides forward into its new cell and the tail
  // slides in after it, so corners stay fixed at cell centres instead of every
  // segment cutting diagonally across the bend.
  Renderer.prototype._points = function (p, b) {
    // Each snake moves at its own pace (Phantom is faster), so its progress
    // through the current move comes from the world.
    const a = this.world.moveAlpha ? this.world.moveAlpha(p, this.alpha) : this.alpha;
    const body = p.body, prev = p.prevBody;
    const n = body.length;
    function c(cell) { return { x: cell.x + 0.5, y: cell.y + 0.5 }; }
    function lerp(from, to) {
      return { x: from.x + (to.x - from.x) * a + 0.5, y: from.y + (to.y - from.y) * a + 0.5 };
    }
    const moved = prev.length && n > 1 && (prev[0].x !== body[0].x || prev[0].y !== body[0].y);
    if (!moved || a >= 1) return body.map(c);
    const pts = [lerp(body[1], body[0])];
    for (let i = 1; i < n; i++) pts.push(c(body[i]));
    // Tail moved this step: it is still sliding out of the old tail cell.
    const oldTail = prev[prev.length - 1], newTail = body[n - 1];
    if (prev.length === n && (oldTail.x !== newTail.x || oldTail.y !== newTail.y)) {
      pts.push(lerp(oldTail, newTail));
    }
    return pts;
  };

  function drawApple(ctx, cx, cy, r, body, glow, ts) {
    if (glow) {
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.45, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#6b3b1f'; ctx.lineWidth = Math.max(1, ts * 0.07);
    ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.85); ctx.lineTo(cx + r * 0.15, cy - r * 1.3); ctx.stroke();
    ctx.fillStyle = '#4ADE80';
    ctx.beginPath(); ctx.ellipse(cx + r * 0.42, cy - r * 1.12, r * 0.32, r * 0.16, -0.5, 0, Math.PI * 2); ctx.fill();
  }

  function drawSparkle(ctx, x, y, s) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x, y - s * 2); ctx.lineTo(x + s * 0.45, y - s * 0.45); ctx.lineTo(x + s * 2, y);
    ctx.lineTo(x + s * 0.45, y + s * 0.45); ctx.lineTo(x, y + s * 2); ctx.lineTo(x - s * 0.45, y + s * 0.45);
    ctx.lineTo(x - s * 2, y); ctx.lineTo(x - s * 0.45, y - s * 0.45); ctx.closePath(); ctx.fill();
  }

  const POWER_STYLE = {
    magnet: { icon: '🧲', glow: '244,63,94' },
    phantom: { icon: '👻', glow: '196,181,253' },
  };
  function drawPowerItem(ctx, cx, cy, ts, s, power, t) {
    const st = POWER_STYLE[power] || POWER_STYLE.magnet;
    const bob = Math.sin(t * 4) * ts * 0.06;
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    const r = ts * 0.5 * s;
    ctx.fillStyle = 'rgba(' + st.glow + ',' + (0.18 + 0.2 * pulse).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(cx, cy + bob, r * (1.55 + 0.25 * pulse), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(12,30,20,0.92)';
    roundRect(ctx, cx - r, cy + bob - r, r * 2, r * 2, r * 0.45); ctx.fill();
    ctx.strokeStyle = 'rgb(' + st.glow + ')';
    ctx.lineWidth = Math.max(1.5, ts * 0.08);
    ctx.stroke();
    ctx.font = Math.round(ts * 0.72 * s) + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(st.icon, cx, cy + bob + ts * 0.03);
  }

  // Cells where a snake's body overlaps a wall or another snake (left behind by
  // Phantom). Drawn see-through so nobody reads them as solid walls of snake.
  Renderer.prototype._phasedCells = function (p, b) {
    const out = new Array(p.body.length);
    for (let i = 0; i < p.body.length; i++) {
      const c = p.body[i];
      let ph = !!b.wall[c.y * b.w + c.x];
      if (!ph) {
        for (const q of this.world.players) {
          if (q === p || !q.alive) continue;
          for (const d of q.body) if (d.x === c.x && d.y === c.y) { ph = true; break; }
          if (ph) break;
        }
      }
      out[i] = ph;
    }
    return out;
  };

  function strokeBody(ctx, pts, color, ts) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = ts * 0.86;
    strokePath(ctx, pts, ts);
    ctx.strokeStyle = color;
    ctx.lineWidth = ts * 0.74;
    strokePath(ctx, pts, ts);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = ts * 0.26;
    strokePath(ctx, pts, ts);
  }

  // Blink when an effect is about to run out (a ghost waiting to clear blinks too).
  function fading(left, t) { return left > 0 && left < 1.5 && Math.floor(t * 8) % 2 === 0; }

  function strokePath(ctx, pts, ts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x * ts, pts[0].y * ts);
    if (pts.length === 1) ctx.lineTo(pts[0].x * ts + 0.01, pts[0].y * ts);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * ts, pts[i].y * ts);
    ctx.stroke();
  }

  Renderer.prototype._drawSnakes = function (ctx, b, ts) {
    const t = this.t;
    for (const p of this.world.players) {
      if (!p.alive || !p.body.length) continue;
      const pts = this._points(p, b);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (p.magnet) this._drawMagnetField(ctx, p, pts[0], ts);
      if (p.phantom) {
        // Ghost: see-through with a soft glow, shedding a faint trail.
        const blink = p.phantom === 'ending' || fading(p.fxPhantomLeft, t);
        ctx.save();
        ctx.globalAlpha = blink && Math.floor(t * 8) % 2 === 0 ? 0.22 : 0.5;
        ctx.shadowColor = 'rgba(224,231,255,0.9)';
        ctx.shadowBlur = ts * 0.7;
        strokeBody(ctx, pts, p.color, ts);
        this._drawHead(ctx, p, pts[0], b, ts);
        ctx.restore();
        if (this.t - this.trailT > 0.035) {
          const tail = pts[pts.length - 1];
          this.particles.push({ x: tail.x + (Math.random() - 0.5) * 0.4, y: tail.y + (Math.random() - 0.5) * 0.4, vx: 0, vy: 0, t: 0, max: 0.45, size: 0.16, color: 'rgba(224,231,255,0.55)' });
          this.particles.push({ x: pts[0].x, y: pts[0].y, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, t: 0, max: 0.35, size: 0.12, color: p.color });
        }
        continue;
      }
      // Solid snake: any stretch still lying across a wall or another snake
      // (left behind by Phantom) is drawn see-through.
      const ph = this._phasedCells(p, b);
      const n = p.body.length;
      const flag = function (j) { return ph[Math.min(j, n - 1)]; };
      if (!ph.some(Boolean)) strokeBody(ctx, pts, p.color, ts);
      else {
        let run = [pts[0]], runPh = flag(0) || flag(1);
        for (let j = 1; j < pts.length; j++) {
          const linkPh = flag(j - 1) || flag(j);
          if (linkPh !== runPh && run.length > 1) {
            ctx.globalAlpha = runPh ? 0.35 : 1; strokeBody(ctx, run, p.color, ts);
            run = [pts[j - 1]]; runPh = linkPh;
          } else if (run.length === 1) runPh = linkPh;
          run.push(pts[j]);
        }
        ctx.globalAlpha = runPh ? 0.35 : 1; strokeBody(ctx, run, p.color, ts);
      }
      ctx.globalAlpha = 1;
      this._drawHead(ctx, p, pts[0], b, ts);
      // Magnet about to run out: just the head flashes white (the body stays
      // solid, so it never looks like the snake is invincible).
      if (p.magnet && fading(p.fxMagnetLeft, t)) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath(); ctx.arc(pts[0].x * ts, pts[0].y * ts, ts * 0.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (this.t - this.trailT > 0.035) this.trailT = this.t;
  };

  // Magnet aura (the pull range itself isn't drawn): a soft glow, one slow ring
  // closing in on the head, and a few motes drifting in from each apple that's
  // actually being attracted — so the pull reads as aimed at real targets.
  // Blinks off (with a head flash) as it runs out.
  Renderer.prototype._drawMagnetField = function (ctx, p, h, ts) {
    const t = this.t;
    if (fading(p.fxMagnetLeft, t)) return;
    const cx = h.x * ts, cy = h.y * ts;
    ctx.save();
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    const gr = ts * (1.1 + 0.15 * pulse);
    const g = ctx.createRadialGradient(cx, cy, ts * 0.25, cx, cy, gr);
    g.addColorStop(0, 'rgba(251,113,133,0.38)');
    g.addColorStop(1, 'rgba(251,113,133,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, gr, 0, Math.PI * 2); ctx.fill();
    const k = (t * 0.7) % 1;
    ctx.globalAlpha = Math.sin(Math.PI * k) * 0.5;
    ctx.strokeStyle = '#FB7185';
    ctx.lineWidth = Math.max(1, ts * 0.06);
    ctx.beginPath(); ctx.arc(cx, cy, ts * (1.9 - 1.35 * k), 0, Math.PI * 2); ctx.stroke();
    // Motes flowing from each attracted apple into the head.
    const R = global.Snek.MAGNET_RANGE || 3;
    const hx = p.body[0].x, hy = p.body[0].y;
    const self = this;
    this.world.food.forEach(function (f) {
      if (f.kind !== 'apple' && f.kind !== 'special') return;
      if (Math.max(Math.abs(f.x - hx), Math.abs(f.y - hy)) > R) return;
      const st = self.foodAnim.get(f);
      const fx = ((st ? st.dx : f.x) + 0.5) * ts, fy = ((st ? st.dy : f.y) + 0.5) * ts;
      for (let i = 0; i < 3; i++) {
        const m = (t * 1.1 + i / 3) % 1;
        const e = m * m;                      // speeds up as it nears the head
        ctx.globalAlpha = Math.sin(Math.PI * m) * 0.85;
        ctx.fillStyle = '#FECDD3';
        ctx.beginPath(); ctx.arc(fx + (cx - fx) * e, fy + (cy - fy) * e, ts * 0.075, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.restore();
  };

  Renderer.prototype._drawHead = function (ctx, p, h, b, ts) {
    const d = global.Snek.DIRS[p.dir];
    const self = this;
    (function () {
      const cx = h.x * ts, cy = h.y * ts;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(cx, cy, ts * 0.46, 0, Math.PI * 2); ctx.fill();
      // Eyes, set forward and to each side of the heading.
      const px = -d.y, py = d.x;
      for (const side of [-1, 1]) {
        const ex = cx + (d.x * 0.16 + px * side * 0.2) * ts;
        const ey = cy + (d.y * 0.16 + py * side * 0.2) * ts;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(ex, ey, ts * 0.13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.arc(ex + d.x * ts * 0.05, ey + d.y * ts * 0.05, ts * 0.065, 0, Math.PI * 2); ctx.fill();
      }
      if (self.showHeadings || p.waiting) {
        const pulse = 0.55 + 0.45 * Math.sin(self.t * 8);
        ctx.fillStyle = 'rgba(255,255,255,' + (0.5 + 0.5 * pulse).toFixed(3) + ')';
        for (let k = 1; k <= 2; k++) {
          const ax = cx + d.x * ts * (0.55 + k * 0.55), ay = cy + d.y * ts * (0.55 + k * 0.55);
          ctx.beginPath();
          ctx.moveTo(ax + d.x * ts * 0.22, ay + d.y * ts * 0.22);
          ctx.lineTo(ax - d.x * ts * 0.12 + px * ts * 0.22, ay - d.y * ts * 0.12 + py * ts * 0.22);
          ctx.lineTo(ax - d.x * ts * 0.12 - px * ts * 0.22, ay - d.y * ts * 0.12 - py * ts * 0.22);
          ctx.closePath(); ctx.fill();
        }
      }
    }());
  };

  Renderer.prototype._drawDying = function (ctx, b, ts) {
    const t = this.t;
    const keep = [];
    for (const d of this.dying) {
      const age = t - d.t0;
      const n = d.cells.length;
      const flashing = age < FLASH_SEC;
      const white = flashing && (Math.floor(age / 0.06) % 2 === 0);
      let alive = false;
      for (let i = 0; i < n; i++) {
        const c = d.cells[i];
        const popAt = FLASH_SEC + i * d.step;
        const cx = (c.x + 0.5) * ts, cy = (c.y + 0.5) * ts;
        if (age < popAt) {
          alive = true;
          ctx.fillStyle = white ? '#ffffff' : d.color;
          ctx.globalAlpha = flashing ? 1 : 0.85;
          ctx.beginPath(); ctx.arc(cx, cy, ts * (i === 0 ? 0.46 : 0.38), 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          if (i >= d.popped) {
            d.popped = i + 1;
            for (let k = 0; k < 5; k++) {
              const a = Math.random() * Math.PI * 2, sp = 1.2 + Math.random() * 2.6;
              this.particles.push({ x: c.x + 0.5, y: c.y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, max: 0.4 + Math.random() * 0.25, size: 0.14, color: d.color });
            }
          }
          const pa = (age - popAt) / POP_SEC;
          if (pa < 1) {
            alive = true;
            ctx.strokeStyle = d.color;
            ctx.globalAlpha = 1 - pa;
            ctx.lineWidth = Math.max(1, ts * 0.1);
            ctx.beginPath(); ctx.arc(cx, cy, ts * (0.3 + pa * 0.5), 0, Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }
      if (alive) keep.push(d);
    }
    this.dying = keep;
  };

  Renderer.prototype._drawFx = function (ctx, ts, dt) {
    const keepP = [];
    for (const p of this.particles) {
      p.t += dt;
      if (p.t >= p.max) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= Math.max(0, 1 - dt * 3); p.vy *= Math.max(0, 1 - dt * 3);
      ctx.globalAlpha = 1 - p.t / p.max;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x * ts, p.y * ts, p.size * ts, 0, Math.PI * 2); ctx.fill();
      keepP.push(p);
    }
    this.particles = keepP.length > 600 ? keepP.slice(-600) : keepP;
    const keepR = [];
    for (const r of this.rings) {
      r.t += dt;
      if (r.t >= r.max) continue;
      const k = r.t / r.max;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, ts * 0.12 * (1 - k));
      ctx.beginPath(); ctx.arc(r.x * ts, r.y * ts, ts * (r.r0 + (r.r1 - r.r0) * k), 0, Math.PI * 2); ctx.stroke();
      keepR.push(r);
    }
    this.rings = keepR;
    const keepT = [];
    for (const p of this.pops) {
      p.t += dt;
      if (p.t >= p.max) continue;
      const k = p.t / p.max;
      ctx.globalAlpha = 1 - k * k;
      ctx.font = '900 ' + Math.max(12, Math.round(ts * 0.9)) + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const y = (p.y - 0.6 - k * 1.6) * ts;
      ctx.lineWidth = Math.max(2, ts * 0.16);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(p.text, p.x * ts, y);
      ctx.fillStyle = '#FFE58A';
      ctx.fillText(p.text, p.x * ts, y);
      keepT.push(p);
    }
    this.pops = keepT;
    ctx.globalAlpha = 1;
  };

  // Name tags (multiplayer), drawn outside the clip so a tag near the top edge
  // is never cut off. Long names are squeezed to a max width by fillText.
  Renderer.prototype._drawTags = function (ctx, b, ts, m) {
    const solo = this.world.mode === 'solo';
    const fs = Math.max(11, Math.round(ts * 0.48));
    ctx.font = '800 ' + fs + 'px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.world.players) {
      if (!p.alive || !p.body.length) continue;
      const pts = this._points(p, b);
      const h = pts[0];
      const hx = ((h.x % b.w) + b.w) % b.w, hy = ((h.y % b.h) + b.h) % b.h;
      let label = solo ? '' : p.name;
      if (!p.connected && !p.isBot) label = '📵 ' + label;
      if (label && p.magnet) label += ' 🧲';
      if (label && p.phantom) label += ' 👻';
      if (label) {
        const tw = Math.min(ctx.measureText(label).width, ts * 8);
        // Clear the heading arrows when they point up past the tag.
        const lift = (p.dir === 0 && (this.showHeadings || p.waiting)) ? ts * 2.4 : ts * 1.05;
        let x = hx * ts, y = hy * ts - lift;
        if (y - fs < 0) y = hy * ts + ts * 1.05;
        x = Math.max(tw / 2 + 6, Math.min(m.gw - tw / 2 - 6, x));
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        roundRect(ctx, x - tw / 2 - 6, y - fs * 0.7, tw + 12, fs * 1.4, fs * 0.5);
        ctx.fill();
        ctx.fillStyle = p.color;
        ctx.fillText(label, x, y, ts * 8);
      }
    }
  };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  global.SnekRender = { Renderer: Renderer };
})(typeof window !== 'undefined' ? window : globalThis);
