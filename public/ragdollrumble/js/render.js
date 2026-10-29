/* Ragdoll Rumble — canvas renderer.
 *
 * Draws a RagdollRumble.World: a stage-themed backdrop, the stage itself, its
 * hazards, items, the ragdoll fighters and their effects, plus off-screen
 * markers for anyone flying past the camera. A smoothed camera zooms to frame
 * every fighter still in the round. Read-only: it never touches the physics.
 */
(function (global) {
  'use strict';

  var NM = global.RagdollRumble;
  var HITSTOP_BIG = 0.07, HITSTOP_HUGE = 0.12, HITSTOP_KO = 0.16;
  var OUTLINE = '#1a0d05';
  var WOOD = '#E2B27A';             // light beech, the mannequin's body
  var GRAIN = 'rgba(120,64,24,0.32)';
  var PAINT = '#2a1608';             // painted-on face
  // Render at most ~1080p worth of pixels: painting a full 4K backing store
  // every frame is what drags the frame rate down on laptops and TVs.
  var MAX_PIXELS = 1920 * 1080 * 1.1;
  var QUALITY_MIN = 0.6;
  var BOMB_FUSE = 1.3;               // matches the engine's fuse, for the burning-fuse art

  var THEMES = {
    rooftop: { sky: ['#1b1838', '#3d2b5e'], far: '#2a2348', mid: '#231d3d', solid: '#4a4466', top: '#7d76a3', plat: '#9a8a64', platTop: '#c7b78a', windows: '#ffd36b' },
    ship: { sky: ['#ff9b6b', '#6b3f86'], far: '#c86a6a', mid: '#2a5c7a', solid: '#7a4a24', top: '#b07a44', plat: '#8b5a2b', platTop: '#c48b52', sea: '#1d4f6e', seaTop: '#3f86a8' },
    crumble: { sky: ['#f3c681', '#d97a3a'], far: '#c46a3a', mid: '#9a4f2a', solid: '#7a4a2a', top: '#b0784a', plat: '#8a6a4a', platTop: '#c49a6a', tile: '#b38d5d', tileTop: '#d9b483' },
    peak: { sky: ['#8ecbff', '#e9f5ff'], far: '#b6cfe4', mid: '#8aa5bd', solid: '#64748a', top: '#f4f8fc', plat: '#8a7a64', platTop: '#d8e6f2' },
    factory: { sky: ['#22272e', '#11141a'], far: '#2c333c', mid: '#363e48', solid: '#535d69', top: '#8693a1', plat: '#5b6672', platTop: '#ffcf3f' },
    volcano: { sky: ['#3b0f0a', '#140403'], far: '#4a1a10', mid: '#2a0e08', solid: '#3a2a2a', top: '#6a4a44', plat: '#4a3a3a', platTop: '#8a6a5a', lava: '#ff5a1a', lavaTop: '#ffb23f' },
  };

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
    else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.quality = 1;
    this._perf = { last: 0, n: 0, slow: 0, best: 1e9 };
    this.dpr = 1;
    this.reduced = false;
    try { this.reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    this.cam = null;
    this.parts = [];
    this.rings = [];
    this.labels = [];
    this.streaks = [];
    this.shake = 0;
    this.flash = 0;
    this.hitStop = 0;
    this.t = 0;
    this.resize();
  }

  Renderer.prototype.setWorld = function (world) { this.world = world; this.cam = null; };

  Renderer.prototype.clearFx = function () {
    this.parts = []; this.rings = []; this.labels = []; this.streaks = [];
    this.shake = 0; this.flash = 0; this.hitStop = 0;
  };

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    var dev = Math.max(1, Math.min(3, global.devicePixelRatio || 1));
    var cap = Math.sqrt(MAX_PIXELS / Math.max(1, c.clientWidth * c.clientHeight));
    this.dpr = Math.max(0.5, Math.min(dev, cap) * this.quality);
    var w = Math.max(1, Math.round(c.clientWidth * this.dpr));
    var h = Math.max(1, Math.round(c.clientHeight * this.dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    // UI text scales with the screen so tags stay readable on a big TV.
    this.ui = clamp(c.clientHeight / 640, 0.8, 1.8) * this.dpr;
  };

  // ---------------- Camera ----------------
  Renderer.prototype._targetCam = function () {
    var w = this.world, s = w.stage, v = s.view;
    var aspect = this.canvas.width / Math.max(1, this.canvas.height);
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
    for (var i = 0; i < w.players.length; i++) {
      var p = w.players[i];
      if (!p.alive || !p.parts) continue;
      var q = p.parts.torso.getPosition();
      // Ignore fighters far outside the stage view — the off-screen marker covers them.
      var qx = clamp(q.x, v.x0, v.x1), qy = clamp(q.y, v.y0, v.y1);
      x0 = Math.min(x0, qx); x1 = Math.max(x1, qx); y0 = Math.min(y0, qy); y1 = Math.max(y1, qy);
      any = true;
    }
    if (!any) { x0 = -8; x1 = 8; y0 = -4; y1 = 0; }
    x0 -= 5; x1 += 5; y0 -= 5; y1 += 3.5;
    var minW = 22;
    var cw = Math.max(minW, x1 - x0, (y1 - y0) * aspect);
    var vw = v.x1 - v.x0, vh = v.y1 - v.y0;
    cw = Math.min(cw, Math.max(vw, vh * aspect));
    var ch = cw / aspect;
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (cw < vw) cx = clamp(cx, v.x0 + cw / 2, v.x1 - cw / 2); else cx = (v.x0 + v.x1) / 2;
    if (ch < vh) cy = clamp(cy, v.y0 + ch / 2, v.y1 - ch / 2); else cy = v.y1 - ch / 2;
    return { x: cx, y: cy, w: cw };
  };

  Renderer.prototype._updateCam = function (dt) {
    var t = this._targetCam();
    if (!this.cam) { this.cam = t; return; }
    var k = 1 - Math.exp(-dt * 2.8);
    this.cam.x += (t.x - this.cam.x) * k;
    this.cam.y += (t.y - this.cam.y) * k;
    this.cam.w += (t.w - this.cam.w) * k;
  };

  // ---------------- Effects ----------------
  Renderer.prototype._burst = function (x, y, n, color, speed, life, size, grav) {
    if (this.reduced) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
      this.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life * (0.6 + Math.random() * 0.6), max: life, color: color, size: size * (0.6 + Math.random() * 0.7), grav: grav === undefined ? 18 : grav });
    }
  };
  Renderer.prototype._ring = function (x, y, r0, r1, color, life, width) {
    this.rings.push({ x: x, y: y, r0: r0, r1: r1, color: color, life: life, max: life, width: width || 0.12 });
  };
  Renderer.prototype._label = function (x, y, text, color, big) {
    this.labels.push({ x: x, y: y, text: text, color: color, life: 1.1, max: 1.1, big: !!big });
  };
  Renderer.prototype.addShake = function (m) { if (!this.reduced) this.shake = Math.min(1.6, this.shake + m); };

  Renderer.prototype._colorOf = function (id) {
    var p = this.world && this.world.playerById(id);
    return p ? p.color : '#ffffff';
  };

  var BIG_WORDS = ['WHAM!', 'POW!', 'BONK!', 'SPLAT!', 'THWACK!'];

  Renderer.prototype.onEvent = function (ev) {
    switch (ev.type) {
      case 'hit': {
        var kb = ev.kb || 0;
        // Throws aren't blows: no sparks, no freeze, no WHAM — the victim just
        // gets flung (speed trail), and a slam kicks up floor dust.
        if (ev.kind === 'throw') {
          this.flings = this.flings || {};
          this.flings[ev.id] = { until: this.t + 0.7, pts: [] };
          break;
        }
        if (ev.kind === 'slam') {
          this._burst(ev.x, ev.y + 0.9, 18, 'rgba(230,215,190,0.85)', 5, 0.55, 0.2, -3);
          this._burst(ev.x, ev.y + 0.9, 8, 'rgba(255,255,255,0.7)', 3, 0.4, 0.14, -1);
          this.addShake(0.35);
          break;
        }
        var c = ev.kind === 'lava' ? '#ffb23f' : '#fff6c2';
        this._burst(ev.x, ev.y, 6 + Math.min(18, kb * 0.5), c, 4 + kb * 0.25, 0.35, 0.12, 0);
        this._ring(ev.x, ev.y, 0.2, 0.6 + kb * 0.04, c, 0.25, 0.1);
        if (kb >= 20) { this.hitStop = Math.max(this.hitStop, this.reduced ? 0 : (kb >= 32 ? HITSTOP_HUGE : HITSTOP_BIG)); this.addShake(Math.min(0.9, kb * 0.02)); }
        else if (!this.reduced) this.hitStop = Math.max(this.hitStop, 0.03 + Math.min(0.04, kb * 0.003));
        if (kb >= 26) this._label(ev.x, ev.y - 1, BIG_WORDS[(Math.random() * BIG_WORDS.length) | 0], '#ffe14f', true);
        if (ev.kind === 'spike') this._burst(ev.x, ev.y, 10, '#ff4d4d', 6, 0.4, 0.1, 10);
        if (ev.kind === 'lava') this._burst(ev.x, ev.y, 18, '#ff6a1a', 8, 0.6, 0.16, -4);
        break;
      }
      case 'ko': {
        var col = this._colorOf(ev.id);
        this.hitStop = Math.max(this.hitStop, this.reduced ? 0 : HITSTOP_KO);
        this.addShake(1.2);
        this.flash = this.reduced ? 0 : 0.35;
        this._ring(ev.x, ev.y, 0.5, 9, col, 0.6, 0.5);
        this._ring(ev.x, ev.y, 0.3, 5, '#ffffff', 0.4, 0.3);
        this._burst(ev.x, ev.y, 40, col, 18, 0.9, 0.22, 0);
        this.streaks.push({ x: ev.x, y: ev.y, side: ev.side, color: col, life: 0.8, max: 0.8 });
        this._label(ev.x, ev.y, 'KO!', col, true);
        break;
      }
      case 'explode':
        this._ring(ev.x, ev.y, 0.3, ev.r, '#ffb23f', 0.4, 0.4);
        this._ring(ev.x, ev.y, 0.2, ev.r * 0.7, '#ffffff', 0.25, 0.25);
        this._burst(ev.x, ev.y, 34, '#ff7a18', 12, 0.7, 0.24, 6);
        this._burst(ev.x, ev.y, 16, '#444444', 5, 1.1, 0.4, -3);
        this.addShake(0.9);
        this.hitStop = Math.max(this.hitStop, this.reduced ? 0 : HITSTOP_BIG);
        break;
      case 'grab': this._ring(ev.x, ev.y, 0.2, 1.2, '#ffffff', 0.25, 0.1); break;
      case 'throwStart': {
        var tp = this.world.playerById(ev.id);
        if (tp && tp.parts) { var tq = tp.parts.torso.getPosition(); this._ring(tq.x, tq.y - 0.35, 0.4, 1.6, 'rgba(255,255,255,0.7)', 0.22, 0.08); }
        break;
      }
      case 'throw': break;
      case 'escape': {
        var ep = this.world.playerById(ev.id);
        if (ep && ep.parts) { var eq = ep.parts.torso.getPosition(); this._burst(eq.x, eq.y, 10, '#ffffff', 5, 0.35, 0.1, 0); }
        break;
      }
      case 'itemSpawn': this._burst(ev.x, ev.y, 14, '#fff6c2', 3, 0.5, 0.1, 0); this._ring(ev.x, ev.y, 0.1, 1.2, '#ffe14f', 0.4, 0.08); break;
      case 'pickup': this._burst(ev.x, ev.y, 12, '#ffe14f', 4, 0.5, 0.1, 0); this._ring(ev.x, ev.y, 0.2, 1, '#ffe14f', 0.3, 0.08); break;
      case 'land': if (ev.v > 13) this._burst(ev.x, ev.y, 8, 'rgba(255,255,255,0.7)', 3, 0.35, 0.16, -2); break;
      case 'jump': this._burst(ev.x, ev.y, 5, 'rgba(255,255,255,0.6)', 2.5, 0.3, 0.14, -2); break;
      case 'walljump': this._burst(ev.x, ev.y, 8, 'rgba(255,255,255,0.75)', 3, 0.3, 0.13, -1); this._ring(ev.x, ev.y, 0.15, 0.8, 'rgba(255,255,255,0.8)', 0.25, 0.08); break;
      case 'airjump': this._ring(ev.x, ev.y + 0.9, 0.2, 0.9, 'rgba(255,255,255,0.8)', 0.28, 0.08); break;
      case 'crack': this._burst(ev.x, ev.y, 10, '#d9b483', 3, 0.5, 0.12, 12); break;
      case 'crumble': this._burst(ev.x, ev.y, 18, '#b38d5d', 5, 0.8, 0.2, 16); this.addShake(0.3); break;
      case 'tileBack': this._burst(ev.x, ev.y, 8, '#ffffff', 2, 0.4, 0.1, -2); break;
      case 'sizzle': this._burst(ev.x, ev.y, 10, '#ff8a3d', 4, 0.6, 0.14, -6); break;
      case 'shatter': this._burst(ev.x, ev.y, 14, '#9a9a9a', 6, 0.6, 0.14, 16); break;
      case 'poof': this._burst(ev.x, ev.y, 10, 'rgba(255,255,255,0.7)', 2, 0.5, 0.2, -2); break;
      case 'break': this._burst(ev.x, ev.y, 12, '#a0703a', 6, 0.6, 0.12, 16); break;
      default: break;
    }
  };

  Renderer.prototype._stepFx = function (dt) {
    this.t += dt;
    var i;
    for (i = this.parts.length - 1; i >= 0; i--) {
      var p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) { this.parts.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      p.vx *= 1 - dt * 1.5;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = this.rings.length - 1; i >= 0; i--) { this.rings[i].life -= dt; if (this.rings[i].life <= 0) this.rings.splice(i, 1); }
    for (i = this.labels.length - 1; i >= 0; i--) { this.labels[i].life -= dt; if (this.labels[i].life <= 0) this.labels.splice(i, 1); }
    for (i = this.streaks.length - 1; i >= 0; i--) { this.streaks[i].life -= dt; if (this.streaks[i].life <= 0) this.streaks.splice(i, 1); }
    this.shake = Math.max(0, this.shake - dt * 3);
    this.flash = Math.max(0, this.flash - dt * 1.6);
  };

  // ---------------- Frame ----------------
  /**
   * Dynamic resolution: if frames keep missing the display's refresh, step the
   * render resolution down (never below QUALITY_MIN) so play stays smooth.
   */
  Renderer.prototype._watchPerf = function () {
    var now = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    var pf = this._perf, gap = now - pf.last;
    pf.last = now;
    if (gap <= 0 || gap > 150) return;    // tab hidden, paused or first frame
    if (gap < pf.best) pf.best = gap;
    pf.n++;
    if (gap > Math.max(pf.best * 1.6, 20)) pf.slow++;
    if (pf.n < 120) return;
    if (pf.slow > pf.n * 0.15 && this.quality > QUALITY_MIN) {
      this.quality = Math.max(QUALITY_MIN, this.quality * 0.8);
      this.resize();
    }
    pf.n = 0; pf.slow = 0;
  };

  Renderer.prototype.render = function (dt) {
    if (!this.world || !this.world.pw) return;
    this._watchPerf();
    dt = Math.min(0.1, dt || 0);
    this._frameDt = dt;
    this._stepFx(dt);
    this._updateCam(dt);
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    var cam = this.cam;
    var scale = W / cam.w;
    var sx = 0, sy = 0;
    if (this.shake > 0) { sx = (Math.random() - 0.5) * this.shake * 0.6; sy = (Math.random() - 0.5) * this.shake * 0.6; }
    this.view = { x0: cam.x - cam.w / 2, x1: cam.x + cam.w / 2, y0: cam.y - (H / scale) / 2, y1: cam.y + (H / scale) / 2, scale: scale };
    var theme = THEMES[this.world.stageId] || THEMES.rooftop;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._drawSky(ctx, W, H, theme, this.world.stageId);
    ctx.setTransform(scale, 0, 0, scale, W / 2 - (cam.x + sx) * scale, H / 2 - (cam.y + sy) * scale);
    this._drawBackdrop(ctx, theme);
    this._drawStage(ctx, theme);
    this._drawHazards(ctx, theme);
    this._drawItems(ctx);
    this._drawFighters(ctx);
    this._drawFx(ctx);
    this._drawBlast(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._drawTags(ctx, scale, sx, sy);
    this._drawOffscreen(ctx, W, H, scale);
    this._drawStreaks(ctx, W, H);
    this._drawWindWarn(ctx, W, H);
    if (this.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (this.flash * 0.5).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  };

  Renderer.prototype._w2s = function (x, y) {
    var v = this.view, W = this.canvas.width, H = this.canvas.height;
    return { x: (x - this.cam.x) * v.scale + W / 2, y: (y - this.cam.y) * v.scale + H / 2 };
  };

  // ---------------- Backdrops ----------------
  /**
   * The sky is a CSS gradient behind a transparent canvas — the browser
   * composites it for free instead of the canvas repainting every pixel of it
   * every frame. The canvas only needs clearing.
   */
  Renderer.prototype._drawSky = function (ctx, W, H, th, id) {
    if (this._skyId !== id) {
      this._skyId = id;
      this.canvas.style.background = 'linear-gradient(to bottom, ' + th.sky[0] + ', ' + th.sky[1] + ')';
    }
    ctx.clearRect(0, 0, W, H);
  };

  Renderer.prototype._drawBackdrop = function (ctx, th) {
    var id = this.world.stageId, v = this.view, cx = this.cam.x, t = this.t, i;
    var px = cx * 0.55; // parallax: distant shapes drift slower than the stage
    ctx.save();
    if (id === 'rooftop' || id === 'factory') {
      for (i = -12; i < 12; i++) {
        var bw = 3 + ((i * 7919) % 5 + 5) % 5;
        var bh = 6 + ((i * 104729) % 9 + 9) % 9;
        var bx = px + i * 5.2;
        ctx.fillStyle = th.far;
        ctx.fillRect(bx, 4 - bh - 3, bw, bh + 20);
        if (id === 'rooftop') {
          ctx.fillStyle = th.windows;
          ctx.globalAlpha = 0.35;
          for (var wy = 0; wy < bh - 1; wy += 1.4) for (var wx = 0.4; wx < bw - 0.4; wx += 1.1) {
            if (((i * 31 + wy * 7 + wx * 13) | 0) % 3 === 0) ctx.fillRect(bx + wx, 4 - bh - 2 + wy, 0.5, 0.6);
          }
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = th.mid;
          ctx.fillRect(bx + bw * 0.3, 4 - bh - 6, 0.6, 4);
        }
      }
    } else if (id === 'ship') {
      ctx.fillStyle = '#ffd38a';
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(px * 0.5 + 8, -10, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    } else if (id === 'crumble' || id === 'peak') {
      ctx.fillStyle = th.far;
      ctx.beginPath(); ctx.moveTo(px - 60, 12);
      for (i = -12; i <= 12; i++) ctx.lineTo(px + i * 5, (i % 2 ? -4 : -11) + (i % 3) * 1.5);
      ctx.lineTo(px + 60, 12); ctx.closePath(); ctx.fill();
      if (id === 'peak') {
        ctx.fillStyle = '#ffffff';
        for (i = -12; i <= 12; i += 2) { var tx = px + i * 5; ctx.beginPath(); ctx.moveTo(tx - 1.6, -8.2 + (i % 3) * 1.5); ctx.lineTo(tx, -11 + (i % 3) * 1.5); ctx.lineTo(tx + 1.6, -8.2 + (i % 3) * 1.5); ctx.fill(); }
      }
      ctx.fillStyle = th.mid;
      ctx.beginPath(); ctx.moveTo(cx * 0.3 - 60, 14);
      for (i = -10; i <= 10; i++) ctx.lineTo(cx * 0.3 + i * 6, (i % 2 ? 0 : -5));
      ctx.lineTo(cx * 0.3 + 60, 14); ctx.closePath(); ctx.fill();
    } else if (id === 'volcano') {
      ctx.fillStyle = th.far;
      ctx.beginPath(); ctx.moveTo(px - 22, 8); ctx.lineTo(px - 5, -12); ctx.lineTo(px + 5, -12); ctx.lineTo(px + 22, 8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ff5a1a'; ctx.globalAlpha = 0.5 + 0.2 * Math.sin(t * 2);
      ctx.fillRect(px - 5, -12.4, 10, 0.6);
      ctx.globalAlpha = 1;
    }
    if (id === 'peak' || this.world.wind) this._drawWindStreaks(ctx, v);
    ctx.restore();
  };

  Renderer.prototype._drawWindStreaks = function (ctx, v) {
    var wd = this.world.wind;
    if (!wd) return;
    var a = Math.abs(wd.accel) / 15;
    if (a < 0.05) return;
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * a).toFixed(3) + ')';
    ctx.lineWidth = 0.08;
    ctx.lineCap = 'round';
    var t = this.t;
    for (var i = 0; i < 26; i++) {
      var y = v.y0 + ((i * 3.7) % (v.y1 - v.y0));
      var span = v.x1 - v.x0 + 20;
      var x = v.x0 - 10 + (((i * 13.1) + t * 30 * (wd.accel > 0 ? 1 : -1)) % span + span) % span;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 3 * Math.sign(wd.accel), y); ctx.stroke();
    }
  };

  // ---------------- Stage ----------------
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  Renderer.prototype._solid = function (ctx, b, th) {
    ctx.fillStyle = th.solid;
    rr(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0 + 30, 0.3);
    ctx.fill();
    ctx.fillStyle = th.top;
    rr(ctx, b.x0, b.y0, b.x1 - b.x0, 0.45, 0.2);
    ctx.fill();
  };
  Renderer.prototype._plank = function (ctx, x0, x1, y, th) {
    ctx.fillStyle = th.plat;
    rr(ctx, x0, y, x1 - x0, 0.36, 0.15);
    ctx.fill();
    ctx.fillStyle = th.platTop;
    rr(ctx, x0, y, x1 - x0, 0.12, 0.06);
    ctx.fill();
  };

  Renderer.prototype._drawStage = function (ctx, th) {
    var w = this.world, s = w.stage, self = this;
    var lava = w.lavaY !== null;
    if (w.stageId === 'ship') this._drawSea(ctx, th, true);
    (s.solids || []).forEach(function (b) { self._solid(ctx, b, th); });
    if (w.stageId === 'factory') {
      // Hazard stripes along the floor edge.
      var b0 = s.solids[0];
      ctx.save(); ctx.beginPath(); ctx.rect(b0.x0, b0.y0 + 0.45, b0.x1 - b0.x0, 0.35); ctx.clip();
      for (var x = b0.x0 - 1; x < b0.x1 + 1; x += 0.8) {
        ctx.fillStyle = '#ffcf3f'; ctx.beginPath(); ctx.moveTo(x, b0.y0 + 0.8); ctx.lineTo(x + 0.4, b0.y0 + 0.45); ctx.lineTo(x + 0.8, b0.y0 + 0.45); ctx.lineTo(x + 0.4, b0.y0 + 0.8); ctx.fill();
      }
      ctx.restore();
    }
    (s.platforms || []).forEach(function (pl) { self._plank(ctx, pl.x0, pl.x1, pl.y, th); });
    if (w.deck) {
      var d = w.deck.body, dp = d.getPosition(), da = d.getAngle(), dd = w.deck.d;
      // Mast up to the crow's nest.
      ctx.fillStyle = '#5a3a1a';
      ctx.fillRect(-0.25, -7, 0.5, 7.2);
      ctx.fillStyle = 'rgba(245,235,215,0.92)';
      ctx.beginPath(); ctx.moveTo(0.3, -6.4); ctx.quadraticCurveTo(4.2 + Math.sin(this.t) * 0.3, -4.2, 0.3, -1.6); ctx.closePath(); ctx.fill();
      ctx.save();
      ctx.translate(dp.x, dp.y); ctx.rotate(da);
      var oy = dd.thick / 2;
      ctx.fillStyle = '#4a2a12';
      ctx.beginPath(); ctx.moveTo(dd.x0 - 0.6, -oy); ctx.lineTo(dd.x1 + 0.6, -oy); ctx.lineTo(dd.x1 - 2, oy + 4); ctx.lineTo(dd.x0 + 2, oy + 4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = th.solid;
      ctx.fillRect(dd.x0, -oy, dd.x1 - dd.x0, dd.thick);
      ctx.fillStyle = th.top;
      ctx.fillRect(dd.x0, -oy, dd.x1 - dd.x0, 0.3);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.05;
      for (var px = dd.x0 + 1.3; px < dd.x1; px += 1.3) { ctx.beginPath(); ctx.moveTo(px, -oy + 0.3); ctx.lineTo(px, oy); ctx.stroke(); }
      (s.deckPlatforms || []).forEach(function (pl) {
        ctx.fillStyle = '#5a3a1a';
        ctx.fillRect(pl.x0 + 0.4, pl.y - oy, 0.25, -pl.y);
        ctx.fillRect(pl.x1 - 0.65, pl.y - oy, 0.25, -pl.y);
        self._plank(ctx, pl.x0, pl.x1, pl.y - oy, th);
      });
      ctx.restore();
      this._drawSea(ctx, th, false);
    }
    var t = this.t;
    w.tiles.forEach(function (tile) {
      if (tile.state === 'fallen') {
        if (tile.fallY > 20) return;
        ctx.globalAlpha = clamp(1 - tile.fallY / 20, 0, 1);
        self._tile(ctx, tile, th, 0, tile.fallY, tile.fallY * 0.03);
        ctx.globalAlpha = 1;
        return;
      }
      var jx = tile.state === 'shake' ? Math.sin(t * 70 + tile.x0) * 0.06 : 0;
      self._tile(ctx, tile, th, jx, 0, 0, tile.state === 'shake' || tile.load > 0.4);
    });
    if (lava) this._drawLava(ctx, th);
  };

  Renderer.prototype._tile = function (ctx, tile, th, dx, dy, rot, cracked) {
    var w = tile.x1 - tile.x0 - 0.06, h = tile.y1 - tile.y0;
    ctx.save();
    ctx.translate(tile.x0 + 0.03 + w / 2 + dx, tile.y0 + h / 2 + dy);
    ctx.rotate(rot);
    ctx.fillStyle = th.tile;
    rr(ctx, -w / 2, -h / 2, w, h, 0.12); ctx.fill();
    ctx.fillStyle = th.tileTop;
    rr(ctx, -w / 2, -h / 2, w, 0.2, 0.08); ctx.fill();
    if (cracked) {
      ctx.strokeStyle = 'rgba(40,20,10,0.8)'; ctx.lineWidth = 0.06;
      ctx.beginPath(); ctx.moveTo(-w * 0.3, -h / 2); ctx.lineTo(-w * 0.05, 0); ctx.lineTo(-w * 0.2, h / 2);
      ctx.moveTo(-w * 0.05, 0); ctx.lineTo(w * 0.3, h * 0.1); ctx.stroke();
    }
    ctx.restore();
  };

  Renderer.prototype._drawSea = function (ctx, th, back) {
    var v = this.view, t = this.t;
    var base = back ? 2.4 : 3.2;
    ctx.fillStyle = back ? th.mid : th.sea;
    ctx.beginPath(); ctx.moveTo(v.x0 - 2, v.y1 + 5);
    for (var x = v.x0 - 2; x <= v.x1 + 2; x += 0.8) ctx.lineTo(x, base + Math.sin(x * 0.6 + t * (back ? 1.1 : 1.6)) * 0.35);
    ctx.lineTo(v.x1 + 2, v.y1 + 5); ctx.closePath(); ctx.fill();
    if (!back) {
      ctx.strokeStyle = th.seaTop; ctx.lineWidth = 0.12;
      ctx.beginPath();
      for (var x2 = v.x0 - 2; x2 <= v.x1 + 2; x2 += 0.8) ctx.lineTo(x2, base + Math.sin(x2 * 0.6 + t * 1.6) * 0.35);
      ctx.stroke();
    }
  };

  Renderer.prototype._drawLava = function (ctx, th) {
    var v = this.view, t = this.t, y = this.world.lavaY;
    // Heat glow above the surface: a cheap gradient strip (a shadow blur here
    // cost more than the rest of the frame).
    var gl = ctx.createLinearGradient(0, y - 1.4, 0, y + 0.2);
    gl.addColorStop(0, 'rgba(255,90,26,0)'); gl.addColorStop(1, 'rgba(255,90,26,0.55)');
    ctx.fillStyle = gl;
    ctx.fillRect(v.x0 - 2, y - 1.4, v.x1 - v.x0 + 4, 1.6);
    ctx.fillStyle = th.lava;
    ctx.beginPath(); ctx.moveTo(v.x0 - 2, v.y1 + 30);
    for (var x = v.x0 - 2; x <= v.x1 + 2; x += 0.6) ctx.lineTo(x, y + Math.sin(x * 0.9 + t * 2) * 0.18);
    ctx.lineTo(v.x1 + 2, v.y1 + 30); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = th.lavaTop; ctx.lineWidth = 0.14;
    ctx.beginPath();
    for (var x2 = v.x0 - 2; x2 <= v.x1 + 2; x2 += 0.6) ctx.lineTo(x2, y + Math.sin(x2 * 0.9 + t * 2) * 0.18);
    ctx.stroke();
    ctx.fillStyle = '#ffd36b';
    for (var i = 0; i < 8; i++) {
      var bx = v.x0 + ((i * 7.3 + t * 0.8) % (v.x1 - v.x0));
      var ph = (t * 1.3 + i * 0.37) % 1;
      ctx.globalAlpha = 1 - ph;
      ctx.beginPath(); ctx.arc(bx, y + 0.3 - ph * 0.8, 0.12 + ph * 0.15, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  // ---------------- Hazards ----------------
  Renderer.prototype._drawHazards = function (ctx) {
    var r = this.world.roller;
    if (!r) return;
    var c = r.cfg;
    if (r.state === 'roll') {
      ctx.save();
      ctx.translate(r.x, c.y);
      ctx.rotate(r.x / c.r);
      ctx.fillStyle = '#c5ccd6';
      for (var i = 0; i < 10; i++) {
        var a = i / 10 * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a - 0.18) * c.r * 0.8, Math.sin(a - 0.18) * c.r * 0.8);
        ctx.lineTo(Math.cos(a) * c.r * 1.25, Math.sin(a) * c.r * 1.25);
        ctx.lineTo(Math.cos(a + 0.18) * c.r * 0.8, Math.sin(a + 0.18) * c.r * 0.8);
        ctx.fill();
      }
      ctx.fillStyle = '#6a7380';
      ctx.beginPath(); ctx.arc(0, 0, c.r * 0.85, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffcf3f';
      ctx.beginPath(); ctx.arc(0, 0, c.r * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (r.state === 'warn') {
      var on = Math.floor(this.t * 6) % 2 === 0;
      var wx = r.dir > 0 ? this.view.x0 + 1.6 : this.view.x1 - 1.6;
      if (on) {
        ctx.fillStyle = '#ffcf3f';
        ctx.beginPath(); ctx.moveTo(wx, c.y - 1.3); ctx.lineTo(wx + 1.1, c.y + 0.6); ctx.lineTo(wx - 1.1, c.y + 0.6); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#1a1a1a';
        ctx.font = 'bold 1.2px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('!', wx, c.y + 0.05);
      }
    }
  };

  Renderer.prototype._drawWindWarn = function (ctx, W, H) {
    var wd = this.world.wind;
    if (!wd || wd.state !== 'warn') return;
    if (Math.floor(this.t * 5) % 2) return;
    var s = this.ui;
    var x = wd.dir > 0 ? 40 * s : W - 40 * s;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '900 ' + Math.round(54 * s) + 'px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(wd.dir > 0 ? '💨 ➜' : '⬅ 💨', x + (wd.dir > 0 ? 40 * s : -40 * s), H * 0.3);
    ctx.restore();
  };

  // ---------------- Items ----------------
  // ---------------- Item art ----------------
  // Every item is drawn in its own local frame (about one item-radius across)
  // with a thick dark outline so it reads on every stage background.

  /**
   * A boxing glove, knuckles pointing along +x and the thumb on top: padded
   * leather mitt, thumb lobe, white laced cuff with a colored band.
   */
  function drawGlove(ctx, x, y, ang, k, cuffColor, flipY) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(k, flipY ? -k : k);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.055;
    ctx.strokeStyle = OUTLINE;
    // Cuff.
    rr(ctx, -0.46, -0.15, 0.3, 0.3, 0.07);
    ctx.fillStyle = '#f2efe8'; ctx.fill(); ctx.stroke();
    ctx.fillStyle = cuffColor || '#e8322b';
    ctx.fillRect(-0.41, -0.15, 0.07, 0.3);
    ctx.strokeStyle = 'rgba(26,13,5,0.55)'; ctx.lineWidth = 0.025;
    ctx.beginPath();
    ctx.moveTo(-0.31, -0.1); ctx.lineTo(-0.21, 0.04); ctx.moveTo(-0.21, -0.1); ctx.lineTo(-0.31, 0.04);
    ctx.moveTo(-0.31, 0.0); ctx.lineTo(-0.21, 0.12); ctx.moveTo(-0.21, 0.0); ctx.lineTo(-0.31, 0.12);
    ctx.stroke();
    // Mitt.
    var g = ctx.createLinearGradient(0, -0.3, 0, 0.26);
    g.addColorStop(0, '#ff6a5e'); g.addColorStop(0.45, '#e8322b'); g.addColorStop(1, '#a51b16');
    ctx.fillStyle = g; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.055;
    ctx.beginPath();
    ctx.moveTo(-0.2, -0.2);
    ctx.bezierCurveTo(-0.06, -0.33, 0.24, -0.33, 0.31, -0.08);
    ctx.bezierCurveTo(0.36, 0.11, 0.24, 0.25, 0.04, 0.24);
    ctx.bezierCurveTo(-0.08, 0.24, -0.18, 0.22, -0.2, 0.17);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Knuckle crease and thumb lobe.
    ctx.strokeStyle = 'rgba(26,13,5,0.45)'; ctx.lineWidth = 0.03;
    ctx.beginPath(); ctx.moveTo(0.16, -0.24); ctx.quadraticCurveTo(0.08, 0.0, 0.16, 0.2); ctx.stroke();
    ctx.fillStyle = '#d42a24'; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.05;
    ctx.beginPath(); ctx.ellipse(-0.02, -0.06, 0.15, 0.085, -0.25, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Shine.
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.035; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.02, -0.25); ctx.quadraticCurveTo(0.17, -0.27, 0.24, -0.17); ctx.stroke();
    ctx.restore();
  }

  /**
   * A wooden baseball bat in the bat frame: handle end (with knob) at y = +0.55,
   * rounded barrel end at y = -0.55.
   */
  function drawBat(ctx) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.05;
    ctx.strokeStyle = OUTLINE;
    var g = ctx.createLinearGradient(-0.14, 0, 0.14, 0);
    g.addColorStop(0, '#9a6630'); g.addColorStop(0.35, '#e0a865'); g.addColorStop(0.6, '#c98d4c'); g.addColorStop(1, '#8a5a28');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-0.045, 0.5);
    ctx.lineTo(-0.05, 0.18);
    ctx.bezierCurveTo(-0.07, 0.0, -0.13, -0.18, -0.135, -0.36);
    ctx.lineTo(-0.135, -0.46);
    ctx.quadraticCurveTo(-0.135, -0.58, 0, -0.58);
    ctx.quadraticCurveTo(0.135, -0.58, 0.135, -0.46);
    ctx.lineTo(0.135, -0.36);
    ctx.bezierCurveTo(0.13, -0.18, 0.07, 0.0, 0.05, 0.18);
    ctx.lineTo(0.045, 0.5);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Grip tape.
    ctx.fillStyle = '#2b2b33';
    ctx.fillRect(-0.05, 0.24, 0.1, 0.26);
    ctx.strokeRect(-0.05, 0.24, 0.1, 0.26);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.02;
    for (var yy = 0.27; yy < 0.5; yy += 0.06) { ctx.beginPath(); ctx.moveTo(-0.05, yy + 0.03); ctx.lineTo(0.05, yy - 0.01); ctx.stroke(); }
    // Knob.
    ctx.fillStyle = '#7a4e22'; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.05;
    ctx.beginPath(); ctx.ellipse(0, 0.53, 0.085, 0.045, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Wood shine + grain.
    ctx.strokeStyle = 'rgba(255,240,210,0.65)'; ctx.lineWidth = 0.03; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-0.07, -0.45); ctx.bezierCurveTo(-0.08, -0.25, -0.05, -0.05, -0.03, 0.12); ctx.stroke();
    ctx.strokeStyle = 'rgba(90,50,15,0.35)'; ctx.lineWidth = 0.015;
    ctx.beginPath(); ctx.moveTo(0.06, -0.48); ctx.bezierCurveTo(0.07, -0.3, 0.04, -0.1, 0.025, 0.1); ctx.stroke();
  }

  /**
   * A cartoon bomb: glossy black ball, metal cap, rope fuse. `lit` (0..1) is
   * how much fuse is left — it visibly burns down, sparking at the tip.
   */
  function drawBomb(ctx, R, lit, t) {
    var danger = lit !== null && lit < 0.45;
    if (danger && Math.floor(t * 14) % 2 === 0) {
      ctx.fillStyle = 'rgba(255,59,48,0.45)';
      ctx.beginPath(); ctx.arc(0, 0, R * 1.55, 0, Math.PI * 2); ctx.fill();
    }
    var g = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R * 1.05);
    g.addColorStop(0, '#6b6f78'); g.addColorStop(0.45, '#2a2c33'); g.addColorStop(1, '#0d0d10');
    ctx.fillStyle = g; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.055;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Shine.
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(-R * 0.38, -R * 0.42, R * 0.2, R * 0.11, -0.7, 0, Math.PI * 2); ctx.fill();
    // Cap (tilted to the upper right).
    ctx.save();
    ctx.rotate(0.55);
    ctx.fillStyle = '#9aa1ab'; ctx.lineWidth = 0.045;
    rr(ctx, -R * 0.3, -R - 0.08, R * 0.6, 0.13, 0.03); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-R * 0.22, -R - 0.06, R * 0.4, 0.025);
    // Fuse: a curling rope from the cap; burns down when lit.
    var full = [{ x: 0, y: -R - 0.08 }, { x: 0.05, y: -R - 0.2 }, { x: 0.17, y: -R - 0.24 }, { x: 0.22, y: -R - 0.34 }];
    var keep = lit === null ? 1 : Math.max(0.05, lit);
    var pts = [full[0]];
    var segs = full.length - 1, upto = keep * segs;
    for (var i = 1; i <= segs; i++) {
      if (i <= upto) pts.push(full[i]);
      else { var f = upto - (i - 1); if (f > 0) pts.push({ x: full[i - 1].x + (full[i].x - full[i - 1].x) * f, y: full[i - 1].y + (full[i].y - full[i - 1].y) * f }); break; }
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.075;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y); ctx.stroke();
    ctx.strokeStyle = '#d8b47a'; ctx.lineWidth = 0.04;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(90,60,20,0.6)'; ctx.lineWidth = 0.04; ctx.setLineDash([0.025, 0.03]);
    ctx.stroke(); ctx.setLineDash([]);
    if (lit !== null) {
      // Spark: a flickering star at the burning tip.
      var tip = pts[pts.length - 1], fl = 0.75 + 0.35 * Math.sin(t * 47) * Math.sin(t * 31);
      ctx.translate(tip.x, tip.y);
      ctx.rotate(t * 9);
      ctx.fillStyle = '#ff8a1e';
      starPath(ctx, 8, 0.15 * fl, 0.05); ctx.fill();
      ctx.fillStyle = '#ffe14f';
      starPath(ctx, 8, 0.1 * fl, 0.035); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, 0, 0.03, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function starPath(ctx, n, ro, ri) {
    ctx.beginPath();
    for (var i = 0; i < n * 2; i++) {
      var a = i * Math.PI / n, r = i % 2 ? ri : ro;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
  }

  /** A chunky boulder: rounded lumpy outline, lit facet, cracks and speckles. */
  var ROCK_SHAPE = [1, 0.84, 0.97, 0.8, 1.02, 0.88, 0.83, 0.96];
  function drawRock(ctx, R) {
    var n = ROCK_SHAPE.length, pts = [];
    for (var i = 0; i < n; i++) {
      var a = i / n * Math.PI * 2 - Math.PI / 2;
      pts.push({ x: Math.cos(a) * R * ROCK_SHAPE[i] * 1.08, y: Math.sin(a) * R * ROCK_SHAPE[i] * 0.95 });
    }
    function blob() {
      ctx.beginPath();
      var m0 = { x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2 };
      ctx.moveTo(m0.x, m0.y);
      for (var j = 0; j < n; j++) {
        var c = pts[j], d = pts[(j + 1) % n];
        ctx.quadraticCurveTo(c.x, c.y, (c.x + d.x) / 2, (c.y + d.y) / 2);
      }
      ctx.closePath();
    }
    var g = ctx.createLinearGradient(-R, -R, R, R);
    g.addColorStop(0, '#bdb6a8'); g.addColorStop(0.5, '#8d877d'); g.addColorStop(1, '#5e5a54');
    ctx.fillStyle = g; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.055; ctx.lineJoin = 'round';
    blob(); ctx.fill(); ctx.stroke();
    // Lit top facet.
    ctx.save(); blob(); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(-R, -R * 0.2); ctx.lineTo(-R * 0.1, -R * 1.1); ctx.lineTo(R * 0.55, -R); ctx.lineTo(R * 0.1, -R * 0.15); ctx.closePath(); ctx.fill();
    // Cracks and speckles.
    ctx.strokeStyle = 'rgba(30,25,20,0.55)'; ctx.lineWidth = 0.025; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(R * 0.15, -R * 0.15); ctx.lineTo(R * 0.35, R * 0.15); ctx.lineTo(R * 0.25, R * 0.45);
    ctx.moveTo(R * 0.35, R * 0.15); ctx.lineTo(R * 0.6, R * 0.25); ctx.stroke();
    ctx.fillStyle = 'rgba(40,35,30,0.4)';
    [[-0.45, 0.35], [-0.2, 0.55], [0.5, -0.35], [-0.55, -0.05]].forEach(function (q) { ctx.beginPath(); ctx.arc(q[0] * R, q[1] * R, 0.022, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
  }

  Renderer.prototype._itemShape = function (ctx, type, x, y, ang, t, fuse) {
    var R = NM.ITEM_R;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang || 0);
    if (type === 'bat') {
      // Lying around (not in hand) the bat leans over at item size.
      ctx.rotate(1.15);
      ctx.scale(0.78, 0.78);
      drawBat(ctx);
    } else if (type === 'bomb') {
      drawBomb(ctx, R, fuse === undefined ? null : Math.max(0, fuse / BOMB_FUSE), t);
    } else if (type === 'glove') {
      drawGlove(ctx, 0, 0, -0.75, 1, '#ffffff', false);
    } else if (type === 'rock') {
      drawRock(ctx, R);
    }
    ctx.restore();
  };

  /** A held bat: handle in the grip, fat end along the swing, foreshortened as it sweeps past the camera. */
  Renderer.prototype._drawBat = function (ctx, b) {
    ctx.save();
    ctx.translate(b.gx, b.gy);
    ctx.rotate(Math.atan2(b.dx, -b.dy));
    ctx.scale(1, Math.max(0.12, b.len) * NM.BAT_LEN / 1.1);
    ctx.translate(0, -0.55);
    drawBat(ctx);
    ctx.restore();
  };

  Renderer.prototype._drawItems = function (ctx) {
    var list = this.world.itemList, t = this.t;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it.body) continue;
      var p = it.body.getPosition();
      if (it.state === 'ground' && it.age > 11 && Math.floor(t * 8) % 2) continue;
      var bob = 0;
      if (it.state === 'ground') {
        // A pick-up: soft glow underneath, a gentle bob, and the odd twinkle.
        bob = this.reduced ? 0 : -0.06 - 0.05 * Math.sin(t * 3 + i * 1.7);
        ctx.save();
        var glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, NM.ITEM_R * 2.1);
        glow.addColorStop(0, 'rgba(255,225,79,' + (0.32 + 0.12 * Math.sin(t * 5)).toFixed(3) + ')');
        glow.addColorStop(1, 'rgba(255,225,79,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(p.x, p.y, NM.ITEM_R * 2.1, 0, Math.PI * 2); ctx.fill();
        var tw = (t * 0.8 + i * 0.37) % 1;
        if (tw < 0.25 && !this.reduced) {
          var ts = Math.sin(tw / 0.25 * Math.PI);
          ctx.translate(p.x + NM.ITEM_R * 0.9, p.y + bob - NM.ITEM_R * 0.9);
          ctx.fillStyle = 'rgba(255,255,255,' + (0.9 * ts).toFixed(3) + ')';
          starPath(ctx, 4, 0.12 * ts, 0.025); ctx.fill();
        }
        ctx.restore();
      }
      this._itemShape(ctx, it.type, p.x, p.y + bob, it.body.getAngle(), t, it.state === 'thrown' && it.type === 'bomb' ? it.fuse : undefined);
    }
  };

  // ---------------- Fighters ----------------
  function seg(b, hh) {
    var p = b.getPosition(), a = b.getAngle();
    var sx = -Math.sin(a) * hh, sy = Math.cos(a) * hh;
    return [p.x - sx, p.y - sy, p.x + sx, p.y + sy];
  }

  Renderer.prototype._drawFighters = function (ctx) {
    var ps = this.world.players;
    this.chargeFull = this.chargeFull || {};
    this._drawTrails(ctx);
    var grabbable = this.world.grabbableIds ? this.world.grabbableIds() : {};
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!p.alive || !p.parts) continue;
      var k = p.charge >= 0 ? Math.min(1, p.charge / NM.CHARGE_FULL) : -1;
      if (k >= 0) this._chargeFx(p, k);
      else this.chargeFull[p.id] = false;
      var open = !!grabbable[p.id];
      if (open) this._dizzy(ctx, p, false);
      // A charging ragdoll trembles harder the longer it holds.
      var jit = k > 0 && !this.reduced ? 0.02 + 0.05 * k : 0;
      if (jit) { ctx.save(); ctx.translate((Math.random() - 0.5) * jit * 2, (Math.random() - 0.5) * jit); }
      this._dazed = open;
      this._drawFighter(ctx, p);
      this._dazed = false;
      if (jit) ctx.restore();
      if (open) this._dizzy(ctx, p, true);
    }
  };

  /**
   * "Open to a grab" cue: gold stars circling the head (the eyes also turn
   * to spirals, in _face). Drawn in two passes so the stars orbit behind the
   * head (back pass) and in front of it (front pass).
   */
  Renderer.prototype._dizzy = function (ctx, p, front) {
    var V = global.planck.Vec2, t = this.t;
    var top = p.parts.torso.getWorldPoint(V(0, -NM.TORSO_HH - 0.12 - NM.HEAD_R * 2.4 - 0.22));
    var n = 4, spin = this.reduced ? 0 : t * 5;
    for (var i = 0; i < n; i++) {
      var a = spin + i * Math.PI * 2 / n;
      var depth = Math.sin(a);   // > 0 = in front of the head
      if ((depth > 0) !== front) continue;
      var x = top.x + Math.cos(a) * 0.52, y = top.y + depth * 0.13;
      var r = 0.14 + 0.04 * depth;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a * 1.5);
      ctx.globalAlpha = front ? 1 : 0.7;
      starPath(ctx, 5, r + 0.04, (r + 0.04) * 0.48); ctx.fillStyle = OUTLINE; ctx.fill();
      starPath(ctx, 5, r, r * 0.48); ctx.fillStyle = '#FFD640'; ctx.fill();
      ctx.beginPath(); ctx.arc(-r * 0.2, -r * 0.2, r * 0.18, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
      ctx.restore();
    }
  };

  /**
   * Motion smears: a fading streak behind a punching fist and a swept ribbon
   * behind a swinging bat, so fast strikes read as one motion.
   */
  Renderer.prototype._drawTrails = function (ctx) {
    var ps = this.world.players, now = this.t, keep = 0.11;
    this.trails = this.trails || {};
    this._drawFlings(ctx);
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], tr = this.trails[p.id] || (this.trails[p.id] = []);
      var a = p.alive && p.parts && p.attack && p.anim ? p.anim : null;
      if (a && a.bat && a.active) {
        var r = NM.BAT_LEN * a.bat.len;
        tr.push({ t: now, bat: true, gx: a.bat.gx, gy: a.bat.gy, x: a.bat.gx + a.bat.dx * r, y: a.bat.gy + a.bat.dy * r });
      } else if (a && a.fist && a.ext > 0.05 && p.attack.t >= p.attack.spec.t0 && p.attack.t <= p.attack.spec.t1 + 0.05) {
        tr.push({ t: now, x: a.fist.x, y: a.fist.y });
      }
      while (tr.length && now - tr[0].t > keep) tr.shift();
      if (!a) tr.length = 0;
      if (tr.length < 2 || this.reduced) continue;
      ctx.save();
      if (tr[0].bat) {
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.beginPath();
        ctx.moveTo(tr[0].gx, tr[0].gy);
        for (var k = 0; k < tr.length; k++) ctx.lineTo(tr[k].x, tr[k].y);
        for (var m = tr.length - 1; m >= 0; m--) ctx.lineTo(tr[m].gx, tr[m].gy);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.lineCap = 'round';
        for (var n = 1; n < tr.length; n++) {
          var f = n / (tr.length - 1);
          ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 * f).toFixed(3) + ')';
          ctx.lineWidth = 0.05 + 0.2 * f;
          ctx.beginPath(); ctx.moveTo(tr[n - 1].x, tr[n - 1].y); ctx.lineTo(tr[n].x, tr[n].y); ctx.stroke();
        }
      }
      ctx.restore();
    }
  };

  /** A thrown ragdoll leaves a fading speed streak in its own color as it flies. */
  Renderer.prototype._drawFlings = function (ctx) {
    var fl = this.flings || {};
    for (var id in fl) {
      var f = fl[id], p = this.world.playerById(id);
      if (!p || !p.alive || !p.parts || this.t > f.until) { delete fl[id]; continue; }
      var q = p.parts.torso.getPosition();
      f.pts.push({ x: q.x, y: q.y });
      if (f.pts.length > 14) f.pts.shift();
      if (f.pts.length < 2 || this.reduced) continue;
      var fade = Math.min(1, (f.until - this.t) / 0.3);
      ctx.save();
      ctx.lineCap = 'round';
      for (var k = 1; k < f.pts.length; k++) {
        var u = k / (f.pts.length - 1);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = 0.45 * u * fade;
        ctx.lineWidth = 0.1 + 0.4 * u;
        ctx.beginPath(); ctx.moveTo(f.pts[k - 1].x, f.pts[k - 1].y); ctx.lineTo(f.pts[k].x, f.pts[k].y); ctx.stroke();
        ctx.globalAlpha = 0.5 * u * fade;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.04 + 0.12 * u;
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  /** Sparks sucked into the charging fist, and a flash the moment it's full. */
  Renderer.prototype._chargeFx = function (p, k) {
    var f = p.parts.faF.getWorldPoint(global.planck.Vec2(0, NM.FA_HH));
    var dt = this._frameDt || 1 / 60;
    var rate = (this.reduced ? 6 : 26) + 40 * k;
    var n = Math.floor(rate * dt + Math.random());
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, r = 0.9 + Math.random() * 0.7, life = 0.22 + Math.random() * 0.12;
      this.parts.push({ x: f.x + Math.cos(a) * r, y: f.y + Math.sin(a) * r, vx: -Math.cos(a) * r / life, vy: -Math.sin(a) * r / life, life: life, max: life, color: k >= 1 ? '#ffffff' : (Math.random() < 0.5 ? '#ffe14f' : '#ff9a3d'), size: 0.05 + Math.random() * 0.05, grav: 0 });
    }
    if (k >= 1 && !this.chargeFull[p.id]) {
      this.chargeFull[p.id] = true;
      this._ring(f.x, f.y, 0.2, 1.6, '#ffffff', 0.35, 0.14);
      this._burst(f.x, f.y, 14, '#fff6c2', 6, 0.35, 0.09, 0);
    }
  };

  var LIMB_STEPS = 12;

  /**
   * A limb as one smooth curve: a quadratic through the two segment
   * ends and their shared joint, with a travelling wiggle that is pinned to
   * zero at both tips. Returns sampled points with unit normals (for gloss).
   */
  function limbPath(a, b, amp, phase) {
    var x0 = a[0], y0 = a[1], x2 = b[2], y2 = b[3];
    var mx = (a[2] + b[0]) / 2, my = (a[3] + b[1]) / 2;
    var cx = 2 * mx - (x0 + x2) / 2, cy = 2 * my - (y0 + y2) / 2;
    var pts = [];
    for (var i = 0; i <= LIMB_STEPS; i++) {
      var u = i / LIMB_STEPS, v = 1 - u;
      var x = v * v * x0 + 2 * v * u * cx + u * u * x2;
      var y = v * v * y0 + 2 * v * u * cy + u * u * y2;
      var dx = 2 * v * (cx - x0) + 2 * u * (x2 - cx);
      var dy = 2 * v * (cy - y0) + 2 * u * (y2 - cy);
      var l = Math.hypot(dx, dy) || 1;
      var nx = -dy / l, ny = dx / l;
      var w = amp * Math.sin(Math.PI * u) * Math.sin(u * Math.PI * 3 - phase);
      pts.push({ x: x + nx * w, y: y + ny * w, nx: nx, ny: ny });
    }
    return pts;
  }
  /**
   * One smooth curve through a list of points (Catmull-Rom, so it passes through
   * every joint without corners), with the same pinned travelling wiggle.
   */
  function curveThrough(P, amp, phase) {
    var raw = [], n = P.length, per = 6, i, k;
    for (i = 0; i < n - 1; i++) {
      var p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
      for (k = 0; k < per; k++) {
        var t = k / per, t2 = t * t, t3 = t2 * t;
        raw.push({
          x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        });
      }
    }
    raw.push({ x: P[n - 1].x, y: P[n - 1].y });
    var m = raw.length - 1, out = [];
    for (i = 0; i <= m; i++) {
      var a = raw[Math.max(0, i - 1)], b = raw[Math.min(m, i + 1)];
      var dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      var nx = -dy / l, ny = dx / l, u = i / m;
      var w = amp * Math.sin(Math.PI * u) * Math.sin(u * Math.PI * 3 - phase);
      out.push({ x: raw[i].x + nx * w, y: raw[i].y + ny * w, nx: nx, ny: ny });
    }
    return out;
  }
  function strokePts(ctx, pts, w, c, from, to) {
    ctx.strokeStyle = c; ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[from].x, pts[from].y);
    for (var i = from + 1; i <= to; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  /**
   * A tapered wooden segment from (ax, ay) radius ra to (bx, by) radius rb,
   * with a dark outline, a soft highlight along one side and a few grain lines.
   */
  function woodSeg(ctx, ax, ay, bx, by, ra, rb, col, ow, seed) {
    var th = Math.atan2(by - ay, bx - ax), H = Math.PI / 2;
    function path(e) {
      ctx.beginPath();
      ctx.arc(ax, ay, ra + e, th + H, th + 3 * H);
      ctx.arc(bx, by, rb + e, th - H, th + H);
      ctx.closePath();
    }
    path(ow); ctx.fillStyle = OUTLINE; ctx.fill();
    path(0); ctx.fillStyle = col; ctx.fill();
    ctx.save();
    path(0); ctx.clip();
    var nx = -Math.sin(th), ny = Math.cos(th);
    if (ny > 0) { nx = -nx; ny = -ny; }   // highlight on the screen-up side
    var r = (ra + rb) / 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,240,215,0.45)'; ctx.lineWidth = r * 0.5;
    ctx.beginPath(); ctx.moveTo(ax + nx * r * 0.45, ay + ny * r * 0.45); ctx.lineTo(bx + nx * r * 0.45, by + ny * r * 0.45); ctx.stroke();
    ctx.strokeStyle = 'rgba(70,35,10,0.22)'; ctx.lineWidth = r * 0.6;
    ctx.beginPath(); ctx.moveTo(ax - nx * r * 0.75, ay - ny * r * 0.75); ctx.lineTo(bx - nx * r * 0.75, by - ny * r * 0.75); ctx.stroke();
    ctx.strokeStyle = GRAIN; ctx.lineWidth = 0.012;
    for (var g = 0; g < 2; g++) {
      var o = (g ? -0.25 : 0.15) * r, w = 0.25 * r * (seed % 2 ? 1 : -1);
      ctx.beginPath();
      ctx.moveTo(ax + nx * o, ay + ny * o);
      ctx.quadraticCurveTo((ax + bx) / 2 + nx * (o + w), (ay + by) / 2 + ny * (o + w), bx + nx * o, by + ny * o);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A glossy painted wooden bead (the ball joints). */
  function bead(ctx, x, y, r, col, ow) {
    ctx.beginPath(); ctx.arc(x, y, r + ow, 0, Math.PI * 2); ctx.fillStyle = OUTLINE; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.beginPath(); ctx.arc(x + r * 0.08, y + r * 0.1, r * 0.78, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x - r * 0.06, y - r * 0.06, r * 0.72, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.38, r * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
  }

  /**
   * A fighter is a posable wooden artist's mannequin: rigid tapered segments
   * of grained wood joined by glossy beads painted in the team color, an
   * egg-shaped head with a little painted face, and team-color accessories —
   * headband, wristbands and sneakers (plus boxing gloves when picked up).
   * Drawing only — the hitboxes are the physics bodies underneath.
   */
  Renderer.prototype._drawFighter = function (ctx, p) {
    var P = p.parts, self = this, V = global.planck.Vec2;
    var uaF = seg(P.uaF, NM.UA_HH), faF = seg(P.faF, NM.FA_HH);
    var uaB = seg(P.uaB, NM.UA_HH), faB = seg(P.faB, NM.FA_HH);
    var thF = seg(P.thF, NM.TH_HH), shF = seg(P.shF, NM.SH_HH);
    var thB = seg(P.thB, NM.TH_HH), shB = seg(P.shB, NM.SH_HH);
    var team = p.color, flash = p.flash > 0;
    var wood = flash ? '#ffffff' : WOOD, woodBack = flash ? '#e8e8e8' : shade(WOOD, -0.2);
    var gear = flash ? '#ffffff' : team, gearBack = flash ? '#e8e8e8' : shade(team, -0.25);
    var ow = 0.05, headR = NM.HEAD_R * 1.18;
    var ha = P.head.getAngle(), ta = P.torso.getAngle(), f = p.facing;
    var v = P.torso.getLinearVelocity();
    var mid = P.torso.getPosition();
    var neckTop = P.torso.getWorldPoint(V(0, -NM.TORSO_HH - 0.12));
    var hc = P.torso.getWorldPoint(V(0, -NM.TORSO_HH - 0.12 - headR * 1.0));
    var hips = P.torso.getWorldPoint(V(0, NM.TORSO_HH));
    ctx.lineJoin = 'round';

    // Charging glow.
    if (p.charge >= 0) {
      var c = Math.min(1, p.charge / NM.CHARGE_FULL);
      var pulse = 0.5 + 0.5 * Math.sin(this.t * (14 + 22 * c));
      if (p.charge > NM.CHARGE_AUTO - 0.35) pulse = Math.floor(this.t * 16) % 2;
      var hot = c >= 1 ? '#ffffff' : (c > 0.5 ? '#ff9a3d' : '#ffe14f');
      var spread = 0.16 + 0.22 * c + 0.06 * pulse;
      var core = curveThrough([{ x: hips.x, y: hips.y }, { x: mid.x, y: mid.y }, { x: hc.x, y: hc.y }], 0, 0);
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.35 * c * (0.6 + 0.4 * pulse);
      ctx.lineCap = 'round';
      [limbPath(uaB, faB, 0, 0), limbPath(thB, shB, 0, 0), limbPath(thF, shF, 0, 0), core, limbPath(uaF, faF, 0, 0)].forEach(function (pts) {
        strokePts(ctx, pts, (pts === core ? 0.6 : 0.16) + spread * 2, hot, 0, pts.length - 1);
      });
      ctx.beginPath(); ctx.arc(hc.x, hc.y, headR + spread, 0, Math.PI * 2); ctx.fillStyle = hot; ctx.fill();
      ctx.globalAlpha = 0.45 + 0.4 * pulse;
      ctx.beginPath(); ctx.arc(faF[2], faF[3], 0.22 + 0.45 * c + 0.08 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    /** Pull segment ends in a little so the beads show between them. */
    function trim(sg, k) {
      var dx = sg[2] - sg[0], dy = sg[3] - sg[1], l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      return [sg[0] + dx * k, sg[1] + dy * k, sg[2] - dx * k, sg[3] - dy * k];
    }
    function arm(ua, fa, w, g, sd) {
      var u = trim(ua, 0.06), fo = trim(fa, 0.05);
      woodSeg(ctx, u[0], u[1], u[2], u[3], 0.085, 0.062, w, ow, sd);
      woodSeg(ctx, fo[0], fo[1], fo[2], fo[3], 0.066, 0.05, w, ow, sd + 1);
      // Sweatband round the wrist.
      var dx = fa[2] - fa[0], dy = fa[3] - fa[1], l = Math.hypot(dx, dy) || 1;
      var wx = fa[0] + dx * 0.72, wy = fa[1] + dy * 0.72, nx = -dy / l * 0.075, ny = dx / l * 0.075;
      ctx.lineCap = 'round';
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.1 + ow * 2;
      ctx.beginPath(); ctx.moveTo(wx - nx, wy - ny); ctx.lineTo(wx + nx, wy + ny); ctx.stroke();
      ctx.strokeStyle = g; ctx.lineWidth = 0.1; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 0.018;
      ctx.beginPath(); ctx.moveTo(wx - nx * 0.8 + dx / l * 0.03, wy - ny * 0.8 + dy / l * 0.03); ctx.lineTo(wx + nx * 0.8 + dx / l * 0.03, wy + ny * 0.8 + dy / l * 0.03); ctx.stroke();
      bead(ctx, ua[0], ua[1], 0.085, g, ow);       // shoulder
      bead(ctx, ua[2], ua[3], 0.066, g, ow);       // elbow
    }
    /** A flat wooden paddle hand with a carved thumb. */
    function hand(fa, w) {
      var dx = fa[2] - fa[0], dy = fa[3] - fa[1], l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      var x = fa[2] + dx * 0.06, y = fa[3] + dy * 0.06;
      woodSeg(ctx, fa[2] - dx * 0.01, fa[3] - dy * 0.01, x + dx * 0.06, y + dy * 0.06, 0.06, 0.075, w, ow, 1);
      var tx = -dy * f, ty = dx * f;
      if (ty > 0) { tx = -tx; ty = -ty; }
      woodSeg(ctx, x, y, x + tx * 0.09 + dx * 0.02, y + ty * 0.09 + dy * 0.02, 0.035, 0.028, w, ow * 0.8, 0);
    }
    function leg(th, sh, w, g, sd) {
      var t = trim(th, 0.07), s2 = trim(sh, 0.06);
      woodSeg(ctx, t[0], t[1], t[2], t[3], 0.11, 0.078, w, ow, sd);
      woodSeg(ctx, s2[0], s2[1], s2[2], s2[3], 0.08, 0.058, w, ow, sd + 1);
      bead(ctx, th[2], th[3], 0.078, g, ow);       // knee
    }
    function boot(sh, col) {
      var dx = sh[2] - sh[0], dy = sh[3] - sh[1], dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      var tx = -dy, ty = dx;
      if (tx * f < 0) { tx = -tx; ty = -ty; }
      var down = (-ty * dx + tx * dy) >= 0 ? 1 : -1;
      ctx.save();
      ctx.translate(sh[2] + dx * 0.05, sh[3] + dy * 0.05);
      ctx.rotate(Math.atan2(ty, tx));
      ctx.lineWidth = ow; ctx.strokeStyle = OUTLINE; ctx.fillStyle = col;
      rr(ctx, -0.12, -0.09, 0.33, 0.18, 0.08); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      rr(ctx, -0.12, down > 0 ? 0.045 : -0.09, 0.33, 0.045, 0.02); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 0.02;
      ctx.beginPath(); ctx.moveTo(0.0, -0.05 * down); ctx.lineTo(0.06, 0.0); ctx.moveTo(0.06, -0.05 * down); ctx.lineTo(0.12, 0.0); ctx.stroke();
      ctx.restore();
    }

    // ---- Back limbs ----
    arm(uaB, faB, woodBack, gearBack, 3);
    if (!p.gloveT) hand(faB, woodBack);
    leg(thB, shB, woodBack, gearBack, 5);
    boot(shB, gearBack);

    // ---- Body: carved chest, waist bead and pelvis ----
    ctx.save();
    ctx.translate(mid.x, mid.y);
    ctx.rotate(ta);
    var hh = NM.TORSO_HH;
    function chestPath(e) {
      ctx.beginPath();
      ctx.moveTo(-0.2 - e, -hh + 0.02 - e);
      ctx.quadraticCurveTo(0, -hh - 0.08 - e, 0.2 + e, -hh + 0.02 - e);
      ctx.quadraticCurveTo(0.3 + e, -hh + 0.1, 0.26 + e, -hh + 0.3);
      ctx.quadraticCurveTo(0.22 + e, 0.0, 0.15 + e, 0.06 + e);
      ctx.quadraticCurveTo(0, 0.11 + e, -0.15 - e, 0.06 + e);
      ctx.quadraticCurveTo(-0.22 - e, 0.0, -0.26 - e, -hh + 0.3);
      ctx.quadraticCurveTo(-0.3 - e, -hh + 0.1, -0.2 - e, -hh + 0.02 - e);
      ctx.closePath();
    }
    function pelvisPath(e) {
      ctx.beginPath();
      ctx.moveTo(-0.15 - e, 0.17 - e);
      ctx.quadraticCurveTo(0, 0.12 - e, 0.15 + e, 0.17 - e);
      ctx.quadraticCurveTo(0.25 + e, 0.3, 0.2 + e, hh + 0.02);
      ctx.quadraticCurveTo(0, hh + 0.12 + e, -0.2 - e, hh + 0.02);
      ctx.quadraticCurveTo(-0.25 - e, 0.3, -0.15 - e, 0.17 - e);
      ctx.closePath();
    }
    function carve(pathFn, col) {
      pathFn(ow); ctx.fillStyle = OUTLINE; ctx.fill();
      pathFn(0); ctx.fillStyle = col; ctx.fill();
      ctx.save(); pathFn(0); ctx.clip();
      var g = ctx.createLinearGradient(-0.3 * f, 0, 0.3 * f, 0);
      g.addColorStop(0, 'rgba(255,240,215,0.45)'); g.addColorStop(0.5, 'rgba(255,240,215,0)'); g.addColorStop(1, 'rgba(70,35,10,0.25)');
      ctx.fillStyle = g; ctx.fillRect(-0.4, -hh - 0.2, 0.8, hh * 2 + 0.4);
      ctx.strokeStyle = GRAIN; ctx.lineWidth = 0.012;
      for (var gi = -1; gi <= 1; gi++) {
        ctx.beginPath(); ctx.moveTo(gi * 0.09 - 0.02, -hh - 0.1);
        ctx.bezierCurveTo(gi * 0.09 + 0.05, -0.2, gi * 0.09 - 0.05, 0.1, gi * 0.09 + 0.02, hh + 0.1); ctx.stroke();
      }
      ctx.restore();
    }
    carve(pelvisPath, wood);
    bead(ctx, 0, 0.12, 0.12, gear, ow);            // waist
    carve(chestPath, wood);
    // Carved pecs.
    ctx.strokeStyle = 'rgba(70,35,10,0.4)'; ctx.lineWidth = 0.018; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-0.17, -hh + 0.24); ctx.quadraticCurveTo(-0.08, -hh + 0.32, 0, -hh + 0.25);
    ctx.quadraticCurveTo(0.08, -hh + 0.32, 0.17, -hh + 0.24);
    ctx.stroke();
    ctx.restore();
    // Hip beads, then the near leg over the body.
    bead(ctx, thB[0], thB[1], 0.09, gearBack, ow);
    leg(thF, shF, wood, gear, 7);
    bead(ctx, thF[0], thF[1], 0.09, gear, ow);
    boot(shF, gear);

    // ---- Neck peg and head ----
    var nb = P.torso.getWorldPoint(V(0, -NM.TORSO_HH + 0.02));
    woodSeg(ctx, nb.x, nb.y, neckTop.x, neckTop.y, 0.075, 0.065, wood, ow, 0);
        ctx.save();
    ctx.translate(hc.x, hc.y);
    ctx.rotate(ha + 0.12 * f);
    var ex = headR * 0.86, ey = headR * 1.02;
    function egg(e) {
      ctx.beginPath();
      ctx.moveTo(0, -ey - e);
      ctx.bezierCurveTo(ex * 1.1 + e, -ey - e, ex + e, ey * 0.75 + e, 0, ey + e);
      ctx.bezierCurveTo(-ex - e, ey * 0.75 + e, -ex * 1.1 - e, -ey - e, 0, -ey - e);
      ctx.closePath();
    }
    egg(ow); ctx.fillStyle = OUTLINE; ctx.fill();
    egg(0); ctx.fillStyle = wood; ctx.fill();
    ctx.save(); egg(0); ctx.clip();
    var hg = ctx.createRadialGradient(-ex * 0.35, -ey * 0.4, headR * 0.05, 0, 0, headR * 1.2);
    hg.addColorStop(0, 'rgba(255,240,215,0.55)'); hg.addColorStop(0.55, 'rgba(255,240,215,0)'); hg.addColorStop(1, 'rgba(70,35,10,0.3)');
    ctx.fillStyle = hg; ctx.fillRect(-ex * 1.3, -ey * 1.3, ex * 2.6, ey * 2.6);
    ctx.strokeStyle = GRAIN; ctx.lineWidth = 0.012;
    [-0.35, 0.1, 0.5].forEach(function (k) {
      ctx.beginPath(); ctx.ellipse(-f * ex * 0.4, ey * k, ex * (0.5 + Math.abs(k) * 0.3), ey * 0.12, 0, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
    });
    ctx.restore();
    // Headband with fluttering tails.
    var hby = -ey * 0.58, half = ex * 1.04 * Math.sqrt(Math.max(0, 1 - (hby / ey) * (hby / ey))) + 0.03;
    var bk = -f, flut = Math.sin(this.t * 10 + p.seat) * 0.06;
    var vxl = Math.max(-1, Math.min(1, v.x * 0.05)) * f;
    var tl = [{ x: bk * half, y: hby }, { x: bk * (half + 0.22) + vxl * 0.1 * bk, y: hby + 0.06 + flut }, { x: bk * (half + 0.42) + vxl * 0.25 * bk, y: hby + 0.16 - flut }];
    ctx.lineCap = 'round';
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.1 + ow * 2;
    ctx.beginPath(); ctx.moveTo(tl[0].x, tl[0].y); ctx.quadraticCurveTo(tl[1].x, tl[1].y, tl[2].x, tl[2].y); ctx.stroke();
    ctx.strokeStyle = gear; ctx.lineWidth = 0.1; ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 0.12 + ow * 2;
    ctx.beginPath(); ctx.moveTo(-half, hby); ctx.quadraticCurveTo(0, hby + 0.05, half, hby); ctx.stroke();
    ctx.strokeStyle = gear; ctx.lineWidth = 0.12; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.022;
    ctx.beginPath(); ctx.moveTo(-half + 0.03, hby - 0.035); ctx.quadraticCurveTo(0, hby + 0.015, half - 0.03, hby - 0.035); ctx.stroke();
    ctx.lineCap = 'round';
    self._face(ctx, p, headR);
    ctx.restore();

    if (p.bat) this._drawBat(ctx, p.bat);
    arm(uaF, faF, wood, gear, 1);
    if (!p.gloveT) hand(faF, wood);

    if (p.gloveT > 0) {
      [faB, faF].forEach(function (fa) {
        var dx = fa[2] - fa[0], dy = fa[3] - fa[1], l = Math.hypot(dx, dy) || 1;
        drawGlove(ctx, fa[2] + dx / l * 0.2, fa[3] + dy / l * 0.2, Math.atan2(dy, dx), 0.95, team, dx < 0);
      });
    }
    if (p.item && p.item.type !== 'bat') this._itemShape(ctx, p.item.type, faF[2], faF[3] + 0.1, 0, this.t);
    if (p.grabbedBy) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = 'bold 0.5px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('!!', hc.x + 0.6, hc.y - 0.5);
    }
  };

  /**
   * The painted face (drawn in the head's frame): two little painted eyes with
   * a glint, rosy cheeks and a small smile — stern brows and a gritted line
   * when attacking, painted X's and an "o" when knocked limp.
   */
  Renderer.prototype._face = function (ctx, p, R) {
    var f = p.facing;
    var cx = f * R * 0.3, ey = R * 0.08;
    var eyes = [cx - R * 0.24, cx + R * 0.24];
    var angry = p.charge >= 0 || (p.attack && p.attack.type !== 'toss');
    var limp = p.tumble || p.grabbedBy;
    ctx.lineCap = 'round';
    ctx.fillStyle = 'rgba(230,80,80,0.35)';
    eyes.forEach(function (x) { ctx.beginPath(); ctx.ellipse(x + f * R * 0.04, ey + R * 0.24, R * 0.11, R * 0.07, 0, 0, Math.PI * 2); ctx.fill(); });
    ctx.strokeStyle = PAINT; ctx.fillStyle = PAINT;
    if (this._dazed) {
      // Open to a grab: spinning spiral eyes.
      var spin = this.reduced ? 0 : this.t * 9;
      ctx.lineWidth = 0.02;
      eyes.forEach(function (x, i) {
        ctx.fillStyle = '#fbf3e4';
        ctx.beginPath(); ctx.ellipse(x, ey, R * 0.19, R * 0.21, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        for (var k = 0; k <= 40; k++) {
          var u = k / 40, a = u * Math.PI * 4 + (i ? spin : -spin), rr2 = R * 0.16 * u;
          var px = x + Math.cos(a) * rr2, py = ey + Math.sin(a) * rr2 * 1.15;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      });
      ctx.lineWidth = 0.028;
      ctx.beginPath(); ctx.ellipse(cx, ey + R * 0.36, R * 0.07, R * 0.09, 0, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    if (limp) {
      ctx.lineWidth = 0.032;
      eyes.forEach(function (x) {
        var r = R * 0.1;
        ctx.beginPath(); ctx.moveTo(x - r, ey - r); ctx.lineTo(x + r, ey + r); ctx.moveTo(x + r, ey - r); ctx.lineTo(x - r, ey + r); ctx.stroke();
      });
      ctx.lineWidth = 0.028;
      ctx.beginPath(); ctx.ellipse(cx, ey + R * 0.36, R * 0.07, R * 0.09, 0, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    eyes.forEach(function (x) {
      ctx.fillStyle = PAINT;
      ctx.beginPath(); ctx.ellipse(x, ey, R * 0.085, R * 0.12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.arc(x - R * 0.025, ey - R * 0.05, R * 0.03, 0, Math.PI * 2); ctx.fill();
    });
    ctx.strokeStyle = PAINT; ctx.lineWidth = 0.03;
    if (angry) {
      ctx.beginPath();
      ctx.moveTo(eyes[0] - R * 0.12, ey - R * 0.24); ctx.lineTo(eyes[0] + R * 0.1, ey - R * 0.15);
      ctx.moveTo(eyes[1] + R * 0.12, ey - R * 0.24); ctx.lineTo(eyes[1] - R * 0.1, ey - R * 0.15);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - R * 0.15, ey + R * 0.36); ctx.lineTo(cx + R * 0.15, ey + R * 0.36); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(cx, ey + R * 0.2, R * 0.17, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
    }
  };

  Renderer.prototype._drawFx = function (ctx) {
    var i;
    for (i = 0; i < this.parts.length; i++) {
      var p = this.parts[i];
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    for (i = 0; i < this.rings.length; i++) {
      var r = this.rings[i], k = 1 - r.life / r.max;
      ctx.globalAlpha = clamp(r.life / r.max, 0, 1);
      ctx.strokeStyle = r.color; ctx.lineWidth = r.width;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  /** In sudden death the closing blast zone is drawn as a red pulsing frame. */
  Renderer.prototype._drawBlast = function (ctx) {
    var w = this.world;
    if (!w.suddenDeath || !w.blast) return;
    var b = w.blast;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,59,48,' + (0.55 + 0.3 * Math.sin(this.t * 6)).toFixed(3) + ')';
    ctx.lineWidth = 0.25;
    ctx.setLineDash([0.8, 0.5]);
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,59,48,0.12)';
    var v = this.view;
    ctx.fillRect(v.x0 - 5, v.y0 - 5, b.x0 - v.x0 + 5, v.y1 - v.y0 + 10);
    ctx.fillRect(b.x1, v.y0 - 5, v.x1 - b.x1 + 5, v.y1 - v.y0 + 10);
    ctx.fillRect(b.x0, v.y0 - 5, b.x1 - b.x0, b.y0 - v.y0 + 5);
    ctx.restore();
  };

  // ---------------- Screen-space overlays ----------------
  function truncate(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  }

  Renderer.prototype._drawTags = function (ctx) {
    var ps = this.world.players, s = this.ui;
    ctx.save();
    ctx.font = '800 ' + Math.round(13 * s) + 'px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Lay the tags out first, then nudge any that collide upward so a crowd
    // of ragdolls still has readable names.
    var tags = [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!p.alive || !p.parts) continue;
      var hp = p.parts.head.getPosition();
      var sp = this._w2s(hp.x, hp.y - NM.HEAD_R - 0.95);
      var label = truncate(ctx, p.name, 140 * s);
      var tw = ctx.measureText(label).width + 16 * s, th = 20 * s;
      tags.push({ p: p, x: sp.x, y: sp.y, ax: sp.x, ay: sp.y, w: tw, h: th, label: label });
    }
    tags.sort(function (a, b) { return b.y - a.y; });
    for (var a = 0; a < tags.length; a++) {
      for (var guard = 0; guard < 8; guard++) {
        var moved = false;
        for (var b = 0; b < a; b++) {
          var A = tags[a], B = tags[b];
          if (Math.abs(A.x - B.x) < (A.w + B.w) / 2 + 2 * s && Math.abs(A.y - B.y) < A.h + 2 * s) {
            A.y = B.y - A.h - 3 * s; moved = true;
          }
        }
        if (!moved) break;
      }
    }
    for (var t = 0; t < tags.length; t++) {
      var g = tags[t], gp = g.p;
      if (g.y !== g.ay) {
        ctx.strokeStyle = gp.color; ctx.lineWidth = 1.5 * s;
        ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(g.ax, g.ay); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      rr(ctx, g.x - g.w / 2, g.y - g.h, g.w, g.h, g.h / 2); ctx.fill();
      ctx.strokeStyle = gp.color; ctx.lineWidth = 2 * s; ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(g.label, g.x, g.y - g.h / 2 + 0.5 * s);
      if (g.y === g.ay) {
        ctx.fillStyle = gp.color;
        ctx.beginPath(); ctx.moveTo(g.x - 5 * s, g.y); ctx.lineTo(g.x + 5 * s, g.y); ctx.lineTo(g.x, g.y + 6 * s); ctx.closePath(); ctx.fill();
      }
    }
    // Popping words (WHAM!, KO!).
    for (var k = 0; k < this.labels.length; k++) {
      var l = this.labels[k];
      if (!l.text) continue;
      var a = clamp(l.life / l.max, 0, 1);
      var q = this._w2s(l.x, l.y - (1 - a) * 1.5);
      var size = (l.big ? 44 : 22) * s * (1 + (1 - a) * 0.2);
      ctx.globalAlpha = a;
      ctx.font = '900 ' + Math.round(size) + 'px Inter, sans-serif';
      ctx.lineWidth = 6 * s; ctx.strokeStyle = OUTLINE;
      var lx = clamp(q.x, size * 1.4, this.canvas.width - size * 1.4), ly = clamp(q.y, size, this.canvas.height - size);
      ctx.strokeText(l.text, lx, ly);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, lx, ly);
    }
    ctx.restore();
  };

  /** A bubble at the screen edge for every fighter the camera can't see. */
  Renderer.prototype._drawOffscreen = function (ctx, W, H) {
    var ps = this.world.players, s = this.ui;
    var m = 34 * s, R = 22 * s;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!p.alive || !p.parts) continue;
      var q = p.parts.torso.getPosition();
      var sp = this._w2s(q.x, q.y);
      if (sp.x > -10 && sp.x < W + 10 && sp.y > -10 && sp.y < H + 10) continue;
      var bx = clamp(sp.x, m, W - m), by = clamp(sp.y, m, H - m);
      var ang = Math.atan2(sp.y - by, sp.x - bx);
      var dist = Math.hypot(sp.x - bx, sp.y - by) / this.view.scale;
      var k = clamp(1 - dist / 30, 0.55, 1);
      ctx.save();
      ctx.translate(bx, by);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * (R * k + 12 * s), Math.sin(ang) * (R * k + 12 * s));
      ctx.lineTo(Math.cos(ang + 0.5) * R * k, Math.sin(ang + 0.5) * R * k);
      ctx.lineTo(Math.cos(ang - 0.5) * R * k, Math.sin(ang - 0.5) * R * k);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(0, 0, R * k, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3 * s; ctx.strokeStyle = p.color; ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(0, 0, R * k * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  };

  /** KO streaks: a burst of color shooting in from the edge the fighter left by. */
  Renderer.prototype._drawStreaks = function (ctx, W, H) {
    for (var i = 0; i < this.streaks.length; i++) {
      var st = this.streaks[i];
      var a = clamp(st.life / st.max, 0, 1);
      var sp = this._w2s(st.x, st.y);
      var x = clamp(sp.x, 0, W), y = clamp(sp.y, 0, H);
      var dir = st.side === 'left' ? 0 : st.side === 'right' ? Math.PI : st.side === 'top' ? Math.PI / 2 : -Math.PI / 2;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(dir);
      ctx.globalAlpha = a;
      var len = Math.max(W, H) * 0.55 * (1.2 - a * 0.4);
      var g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, st.color); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, -len * 0.22); ctx.lineTo(len, len * 0.22); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.9).toFixed(3) + ')';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len * 0.8, -len * 0.06); ctx.lineTo(len * 0.8, len * 0.06); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  };

  global.RagdollRumbleRender = { Renderer: Renderer, THEMES: THEMES };
})(typeof window !== 'undefined' ? window : globalThis);
