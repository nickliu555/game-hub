(function () {
  'use strict';

  // Blob Ball renderer — a sunset beach court with squishy jelly blobs. Purely a
  // view over a BlobBall.World: engine units are converted to an isotropic
  // space (X = x, Y = y / 2, up) where a blob is a 50-unit dome and the ball
  // a 12.5-unit sphere. Squash & stretch, eyes, moods and particles are all
  // render-only and never touch the physics.

  var BB = window.BlobBall;
  var COURT_W = BB.W;
  var SKY_H = BB.CEIL / 2;          // 400 — the ceiling, in iso units
  var SAND_H = 64;                  // sand band drawn under the ground line
  var R = BB.BLOB_R / 2;            // 50
  var BR = BB.BALL_R / 2;           // 12.5
  var NET_H = BB.NET_DRAW_H / 2;    // 52
  var NET_HW = BB.NET_DRAW_HALF;    // 6
  var HORIZON = 92;                 // sea line, iso units above the ground
  var FONT = '"Fredoka One", "Inter", system-ui, sans-serif';

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function mix(hex, toward, k) {
    var a = hexToRgb(hex);
    var b = toward === 'w' ? [255, 255, 255] : (toward === 'k' ? [20, 10, 30] : hexToRgb(toward));
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * k) + ',' + Math.round(a[1] + (b[1] - a[1]) * k) + ',' + Math.round(a[2] + (b[2] - a[2]) * k) + ')';
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.S = 1;
    this.ox = 0;
    this.oy = 0;
    this.bg = null;
    this.time = 0;
    this.particles = [];
    this.rings = [];
    this.trail = [];
    this.clouds = [];
    // Spread evenly across the sky (with a little jitter) so they never clump.
    for (var i = 0; i < 6; i++) {
      this.clouds.push({
        x: i * (1300 / 6) - 150 + Math.random() * 80,
        y: (i % 2 ? 250 : 320) + Math.random() * 60,
        w: 70 + Math.random() * 90,
        v: 4 + Math.random() * 7,
        a: 0.18 + Math.random() * 0.2,
      });
    }
    this.fx = world.blobs.map(function (b) {
      return { sq: 0, sv: 0, lean: 0, blinkIn: 1 + Math.random() * 3, blinkT: 0, mood: null };
    });
    this.resize();
  }

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    var rect = c.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    var boxH = SKY_H + SAND_H;
    this.S = Math.min(c.width / COURT_W, c.height / boxH);
    this.ox = (c.width - COURT_W * this.S) / 2;
    this.oy = (c.height - boxH * this.S) / 2 + SKY_H * this.S;
    this.buildBackground();
  };

  // ---------------- Static background (cached per size) ----------------
  Renderer.prototype.buildBackground = function () {
    var c = this.canvas;
    var bg = document.createElement('canvas');
    bg.width = c.width;
    bg.height = c.height;
    var g = bg.getContext('2d');
    var S = this.S, ox = this.ox, oy = this.oy;
    var yOf = function (Y) { return oy - Y * S; };
    var horizonPx = yOf(HORIZON);

    // Sky.
    var sky = g.createLinearGradient(0, 0, 0, horizonPx);
    sky.addColorStop(0, '#1B2660');
    sky.addColorStop(0.42, '#4D3A8F');
    sky.addColorStop(0.74, '#C8668A');
    sky.addColorStop(0.92, '#F59A72');
    sky.addColorStop(1, '#FFC98A');
    g.fillStyle = sky;
    g.fillRect(0, 0, bg.width, horizonPx + 1);

    // A few stars high up.
    g.fillStyle = 'rgba(255,255,255,0.7)';
    var seed = 7;
    var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (var i = 0; i < 60; i++) {
      var sx = rnd() * bg.width;
      var sy = rnd() * horizonPx * 0.45;
      var sr = (0.4 + rnd() * 1.1) * Math.max(1, S * 0.6);
      g.globalAlpha = 0.25 + rnd() * 0.5;
      g.beginPath(); g.arc(sx, sy, sr, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;

    // Sun, half sunk into the sea.
    var sunX = ox + 735 * S, sunY = yOf(HORIZON + 10), sunR = 64 * S;
    var glow = g.createRadialGradient(sunX, sunY, sunR * 0.5, sunX, sunY, sunR * 3.4);
    glow.addColorStop(0, 'rgba(255,214,140,0.55)');
    glow.addColorStop(1, 'rgba(255,170,120,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, bg.width, horizonPx);
    var sunG = g.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
    sunG.addColorStop(0, '#FFF2C4');
    sunG.addColorStop(1, '#FFB36B');
    g.fillStyle = sunG;
    g.save();
    g.beginPath(); g.rect(0, 0, bg.width, horizonPx); g.clip();
    g.beginPath(); g.arc(sunX, sunY, sunR, 0, Math.PI * 2); g.fill();
    g.restore();

    // Far islands on the horizon.
    g.fillStyle = 'rgba(70,40,110,0.75)';
    g.beginPath();
    g.moveTo(ox + 40 * S, horizonPx);
    g.quadraticCurveTo(ox + 120 * S, horizonPx - 34 * S, ox + 210 * S, horizonPx - 12 * S);
    g.quadraticCurveTo(ox + 260 * S, horizonPx - 22 * S, ox + 330 * S, horizonPx);
    g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(ox + 860 * S, horizonPx);
    g.quadraticCurveTo(ox + 920 * S, horizonPx - 18 * S, ox + 1010 * S, horizonPx - 8 * S);
    g.lineTo(ox + 1010 * S, horizonPx);
    g.closePath(); g.fill();

    // Sea.
    var seaBottom = yOf(14);
    var sea = g.createLinearGradient(0, horizonPx, 0, seaBottom);
    sea.addColorStop(0, '#5B5FA8');
    sea.addColorStop(0.35, '#3D6FAE');
    sea.addColorStop(1, '#2E8FB5');
    g.fillStyle = sea;
    g.fillRect(0, horizonPx, bg.width, seaBottom - horizonPx + 1);
    // Sun glitter column.
    for (var k = 0; k < 16; k++) {
      var t = k / 15;
      var yy = horizonPx + 4 * S + t * (seaBottom - horizonPx - 10 * S);
      var ww = (60 - t * 30) * S * (0.6 + rnd() * 0.6);
      g.fillStyle = 'rgba(255,214,150,' + (0.55 - t * 0.35).toFixed(2) + ')';
      g.fillRect(sunX - ww / 2 + (rnd() - 0.5) * 20 * S, yy, ww, Math.max(1, 2.2 * S));
    }
    // Foam line.
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(0, seaBottom - 3 * S, bg.width, Math.max(1, 3 * S));

    // Back beach (behind the blobs) down to the ground line.
    var back = g.createLinearGradient(0, seaBottom, 0, oy);
    back.addColorStop(0, '#E9C58E');
    back.addColorStop(1, '#F3D6A0');
    g.fillStyle = back;
    g.fillRect(0, seaBottom, bg.width, oy - seaBottom + 1);

    // Court sand.
    var sand = g.createLinearGradient(0, oy, 0, bg.height);
    sand.addColorStop(0, '#F6DDA8');
    sand.addColorStop(0.5, '#E8C17E');
    sand.addColorStop(1, '#D3A35E');
    g.fillStyle = sand;
    g.fillRect(0, oy, bg.width, bg.height - oy);
    // Grain.
    for (var n = 0; n < 900; n++) {
      var gx = rnd() * bg.width;
      var gy = oy + rnd() * (bg.height - oy);
      g.fillStyle = rnd() < 0.5 ? 'rgba(160,110,50,0.22)' : 'rgba(255,245,220,0.35)';
      g.fillRect(gx, gy, Math.max(1, S * 1.2), Math.max(1, S * 1.2));
    }
    // Ground line + court lines.
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(ox, oy - 1.5 * S, COURT_W * S, 3 * S);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(ox + (BB.NET_X - 2) * S, oy, 4 * S, SAND_H * 0.55 * S);

    // Court edges: if the screen is wider/taller than the court, mark the
    // walls and ceiling the ball bounces off.
    if (ox > 2) {
      g.fillStyle = 'rgba(10,8,30,0.28)';
      g.fillRect(0, 0, ox, bg.height);
      g.fillRect(ox + COURT_W * S, 0, bg.width - ox - COURT_W * S, bg.height);
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.fillRect(ox - 2 * S, 0, 2 * S, oy);
      g.fillRect(ox + COURT_W * S, 0, 2 * S, oy);
    }
    var ceilPx = yOf(SKY_H);
    if (ceilPx > 2) {
      g.fillStyle = 'rgba(10,8,30,0.28)';
      g.fillRect(0, 0, bg.width, ceilPx);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillRect(ox, ceilPx - 2 * S, COURT_W * S, 2 * S);
    }
    this.bg = bg;
  };

  // ---------------- Effects ----------------
  Renderer.prototype.handleEvent = function (e) {
    var w = this.world;
    if (e.t === 'land') {
      var b = w.blobs[e.seat];
      var f = this.fx[e.seat];
      f.sv -= 1.2 + Math.min(30, e.v || 0) * 0.09;
      this.dust(b.x, 5 + Math.round(Math.min(30, e.v || 0) / 3));
    } else if (e.t === 'jump') {
      this.fx[e.seat].sv += 1.6;
      this.dust(w.blobs[e.seat].x, 4);
    } else if (e.t === 'hit') {
      if (e.cont) return;
      this.fx[e.seat].sv -= 0.9;
      this.ring(e.x, e.y / 2, '#ffffff', 0.35);
      this.sparks(e.x, e.y / 2, '#ffffff', 5);
    } else if (e.t === 'wall' || e.t === 'net' || e.t === 'ceil') {
      this.ring(e.x, e.y / 2, '#ffffff', 0.25);
    } else if (e.t === 'ground') {
      this.sand(e.x, Math.min(26, 6 + (e.v || 0)), e.point);
    }
  };

  Renderer.prototype.dust = function (x, n) {
    for (var i = 0; i < n; i++) {
      var dir = i % 2 ? 1 : -1;
      this.particles.push({
        x: x + dir * (R * 0.6 + Math.random() * R * 0.4), y: 2,
        vx: dir * (30 + Math.random() * 80), vy: 20 + Math.random() * 40, g: 120,
        life: 0, max: 0.35 + Math.random() * 0.3, r: 2.5 + Math.random() * 3, color: '#F3DDB0', soft: true,
      });
    }
  };
  Renderer.prototype.sand = function (x, n, big) {
    for (var i = 0; i < n * (big ? 2 : 1); i++) {
      var a = Math.PI * (0.15 + Math.random() * 0.7);
      var sp = (big ? 90 : 50) + Math.random() * (big ? 180 : 90);
      this.particles.push({
        x: x + (Math.random() - 0.5) * 10, y: 1,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 520,
        life: 0, max: 0.5 + Math.random() * 0.5, r: 1.8 + Math.random() * 2.6,
        color: Math.random() < 0.5 ? '#E6BE7C' : '#F7E2B5', soft: false,
      });
    }
    this.rings.push({ x: x, y: 0, t: 0, dur: big ? 0.6 : 0.35, color: '#FFFFFF', flat: true, size: big ? 1 : 0.55 });
  };
  Renderer.prototype.ring = function (x, y, color, dur) {
    this.rings.push({ x: x, y: y, t: 0, dur: dur, color: color, flat: false, size: 1 });
  };
  Renderer.prototype.sparks = function (x, y, color, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 60 + Math.random() * 120;
      this.particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0, life: 0, max: 0.25 + Math.random() * 0.2, r: 1.6 + Math.random() * 1.6, color: color, soft: false });
    }
  };
  // Confetti burst in a player's colour over their half.
  Renderer.prototype.celebrate = function (seat, color) {
    var cx = seat === 0 ? 250 : 750;
    var cols = [color, '#FFFFFF', '#FFD23F', mix(color, 'w', 0.5)];
    for (var i = 0; i < 70; i++) {
      var a = Math.PI * (0.2 + Math.random() * 0.6);
      var sp = 160 + Math.random() * 260;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 160, y: 10,
        vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1), vy: Math.sin(a) * sp, g: 300,
        life: 0, max: 1.1 + Math.random() * 0.8, r: 2.5 + Math.random() * 3, color: cols[i % cols.length], soft: false, conf: true, rot: Math.random() * 6,
      });
    }
  };
  Renderer.prototype.setMood = function (seat, mood) {
    if (this.fx[seat]) this.fx[seat].mood = mood || null;
  };
  Renderer.prototype.clearMoods = function () {
    this.fx.forEach(function (f) { f.mood = null; });
  };
  Renderer.prototype.clearTrail = function () { this.trail.length = 0; };

  // ---------------- Frame ----------------
  Renderer.prototype.render = function (alpha, dt) {
    var ctx = this.ctx;
    var w = this.world;
    var c = this.canvas;
    var S = this.S;
    dt = Math.min(0.05, dt || 0);
    this.time += dt;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bg) ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(S, 0, 0, S, this.ox, this.oy);

    this.drawClouds(dt);

    var ball = w.ball;
    var bx = ball.px + (ball.x - ball.px) * alpha;
    var bY = (ball.py + (ball.y - ball.py) * alpha) / 2;
    var spin = ball.pspin + (ball.spin - ball.pspin) * alpha;

    // Shadows first, so everything stands on them.
    for (var i = 0; i < w.blobs.length; i++) {
      var p = w.blobs[i];
      var px = p.px + (p.x - p.px) * alpha;
      var pY = (p.py + (p.y - p.py) * alpha) / 2;
      var k = clamp(1 - pY / 160, 0.35, 1);
      ctx.fillStyle = 'rgba(90,50,20,' + (0.28 * k).toFixed(3) + ')';
      ctx.beginPath(); ctx.ellipse(px, 3, R * 1.05 * k, 7 * k, 0, 0, Math.PI * 2); ctx.fill();
    }
    var bk = clamp(1 - bY / 300, 0.15, 1);
    ctx.fillStyle = 'rgba(90,50,20,' + (0.3 * bk).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(bx, 3, BR * 1.3 * bk, 4 * bk, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(90,50,20,0.22)';
    ctx.beginPath(); ctx.ellipse(BB.NET_X + 6, 3, NET_HW * 2.6, 4, 0, 0, Math.PI * 2); ctx.fill();

    this.drawNet();

    for (var j = 0; j < w.blobs.length; j++) this.drawBlob(w.blobs[j], this.fx[j], alpha, dt, bx, bY);

    this.drawBall(bx, bY, spin, ball);
    this.drawEffects(dt);
    this.drawTags();
  };

  Renderer.prototype.drawClouds = function (dt) {
    var ctx = this.ctx;
    for (var i = 0; i < this.clouds.length; i++) {
      var cl = this.clouds[i];
      cl.x += cl.v * dt;
      if (cl.x - cl.w > 1150) cl.x = -150 - cl.w;
      ctx.fillStyle = 'rgba(255,214,226,' + cl.a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(cl.x, -cl.y, cl.w, cl.w * 0.16, 0, 0, Math.PI * 2);
      ctx.ellipse(cl.x - cl.w * 0.35, -cl.y - cl.w * 0.1, cl.w * 0.42, cl.w * 0.17, 0, 0, Math.PI * 2);
      ctx.ellipse(cl.x + cl.w * 0.25, -cl.y - cl.w * 0.13, cl.w * 0.36, cl.w * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  Renderer.prototype.drawNet = function () {
    var ctx = this.ctx;
    var x = BB.NET_X;
    var top = -NET_H;
    // Post.
    var g = ctx.createLinearGradient(x - NET_HW, 0, x + NET_HW, 0);
    g.addColorStop(0, '#C9CFE0');
    g.addColorStop(0.45, '#FFFFFF');
    g.addColorStop(1, '#9AA3BD');
    ctx.fillStyle = g;
    roundRect(ctx, x - NET_HW, top, NET_HW * 2, NET_H + 2, 3);
    ctx.fill();
    // Mesh.
    ctx.save();
    ctx.beginPath(); ctx.rect(x - NET_HW + 1.5, top + 8, NET_HW * 2 - 3, NET_H - 10); ctx.clip();
    ctx.strokeStyle = 'rgba(40,50,90,0.35)';
    ctx.lineWidth = 0.9;
    for (var yy = top + 4; yy < 4; yy += 5) {
      ctx.beginPath(); ctx.moveTo(x - NET_HW, yy); ctx.lineTo(x + NET_HW, yy + 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + NET_HW, yy); ctx.lineTo(x - NET_HW, yy + 5); ctx.stroke();
    }
    ctx.restore();
    // Top tape.
    ctx.fillStyle = '#FF5C5C';
    roundRect(ctx, x - NET_HW - 1, top - 1, NET_HW * 2 + 2, 7, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(x - NET_HW, top + 0.5, NET_HW * 2, 1.6);
  };

  Renderer.prototype.drawBlob = function (p, f, alpha, dt, ballX, ballY) {
    var ctx = this.ctx;
    var x = p.px + (p.x - p.px) * alpha;
    var Y = (p.py + (p.y - p.py) * alpha) / 2;
    var vx = p.x - p.px;
    var vy = p.y - p.py;
    var face = p.seat === 0 ? 1 : -1;

    // Squash & stretch: a damped spring kicked by jumps, landings and hits.
    f.sv += (-260 * f.sq - 13 * f.sv) * dt;
    f.sq = clamp(f.sq + f.sv * dt, -0.32, 0.3);
    var air = Y > 0.5 ? clamp(vy * 0.004, -0.06, 0.1) : 0;
    var breathe = Math.sin(this.time * 2.6 + p.seat * 1.7) * 0.014;
    var sy = 1 + f.sq + air + breathe;
    var sx = 1 - (sy - 1) * 0.75;
    f.lean += ((-vx / 8) * 0.2 - f.lean) * Math.min(1, dt * 10);

    var dim = !p.isBot && !p.connected;
    ctx.save();
    ctx.globalAlpha = dim ? 0.55 : 1;
    ctx.translate(x, -Y);
    ctx.transform(1, 0, f.lean, 1, 0, 0);
    var rx = R * sx, ry = R * sy;

    // Body.
    var body = ctx.createRadialGradient(-rx * 0.35, -ry * 0.72, R * 0.08, 0, -ry * 0.35, R * 1.25);
    body.addColorStop(0, mix(p.color, 'w', 0.55));
    body.addColorStop(0.45, p.color);
    body.addColorStop(1, mix(p.color, 'k', 0.35));
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, Math.PI, Math.PI * 2);
    ctx.quadraticCurveTo(0, 5, -rx, 0);
    ctx.closePath();
    ctx.fillStyle = body;
    ctx.shadowColor = rgba(p.color, 0.45);
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = mix(p.color, 'k', 0.45);
    ctx.stroke();

    // Gloss.
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.ellipse(-rx * 0.42, -ry * 0.66, rx * 0.2, ry * 0.1, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(-rx * 0.17, -ry * 0.82, R * 0.05, 0, Math.PI * 2); ctx.fill();

    // Face.
    var mood = f.mood;
    f.blinkIn -= dt;
    if (f.blinkIn <= 0) { f.blinkT = 0.13; f.blinkIn = 2.2 + Math.random() * 3.5; }
    if (f.blinkT > 0) f.blinkT -= dt;
    var blink = f.blinkT > 0;
    var fx = face * R * 0.14;
    var eyeY = -ry * 0.5;
    var eyes = [fx - R * 0.26 * sx, fx + R * 0.26 * sx];
    // Pupils look at the ball.
    var lx = ballX - x, ly = ballY - (Y + R * 0.5);
    var ll = Math.sqrt(lx * lx + ly * ly) || 1;
    var px = lx / ll * R * 0.075, py = -ly / ll * R * 0.075;
    for (var e = 0; e < 2; e++) {
      var ex = eyes[e];
      if (mood === 'happy') {
        ctx.strokeStyle = '#1B1030';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(ex, eyeY + R * 0.05, R * 0.11, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
        continue;
      }
      if (blink) {
        ctx.strokeStyle = '#1B1030';
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(ex - R * 0.12, eyeY); ctx.lineTo(ex + R * 0.12, eyeY); ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.ellipse(ex, eyeY, R * 0.16, R * 0.19 * Math.min(1.15, sy), 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = mix(p.color, 'k', 0.5);
      ctx.stroke();
      ctx.fillStyle = '#1B1030';
      ctx.beginPath(); ctx.arc(ex + px, eyeY + py, R * 0.085, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(ex + px - R * 0.03, eyeY + py - R * 0.035, R * 0.028, 0, Math.PI * 2); ctx.fill();
      if (mood === 'sad') {
        ctx.strokeStyle = '#1B1030';
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        var inner = (e === 0 ? 1 : -1);
        ctx.beginPath();
        ctx.moveTo(ex - inner * R * 0.13, eyeY - R * 0.2);
        ctx.lineTo(ex + inner * R * 0.11, eyeY - R * 0.27);
        ctx.stroke();
      }
    }
    // Cheeks.
    ctx.fillStyle = 'rgba(255,120,150,0.38)';
    ctx.beginPath(); ctx.ellipse(eyes[0] - R * 0.08, eyeY + R * 0.2, R * 0.09, R * 0.05, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(eyes[1] + R * 0.08, eyeY + R * 0.2, R * 0.09, R * 0.05, 0, 0, Math.PI * 2); ctx.fill();
    // Mouth.
    var my = eyeY + R * 0.25;
    ctx.strokeStyle = '#1B1030';
    ctx.fillStyle = '#5A1630';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    var close = ll < 120 && ly > 0;
    if (mood === 'happy') {
      ctx.beginPath(); ctx.arc(fx, my - R * 0.02, R * 0.12, 0.1, Math.PI - 0.1); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (mood === 'sad') {
      ctx.beginPath(); ctx.arc(fx, my + R * 0.1, R * 0.09, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke();
    } else if (close) {
      ctx.beginPath(); ctx.ellipse(fx, my + R * 0.01, R * 0.05, R * 0.065, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(fx, my - R * 0.04, R * 0.08, 0.35, Math.PI - 0.35); ctx.stroke();
    }
    ctx.restore();
  };

  Renderer.prototype.drawBall = function (x, Y, spin, ball) {
    var ctx = this.ctx;
    var w = this.world;
    var sp = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy * 0.25);
    if (!w.ballHeld && sp > 7) {
      this.trail.push({ x: x, y: Y });
      if (this.trail.length > 7) this.trail.shift();
    } else if (this.trail.length) {
      this.trail.shift();
    }
    for (var i = 0; i < this.trail.length; i++) {
      var t = this.trail[i];
      var a = (i + 1) / (this.trail.length + 1);
      ctx.fillStyle = 'rgba(255,250,230,' + (a * 0.22).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(t.x, -t.y, BR * (0.45 + 0.5 * a), 0, Math.PI * 2); ctx.fill();
    }

    // Serve: a pulsing halo while the ball hangs over the server.
    if (w.ballHeld) {
      var pulse = 0.5 + 0.5 * Math.sin(this.time * 7);
      ctx.strokeStyle = 'rgba(255,240,180,' + (0.35 + pulse * 0.45).toFixed(3) + ')';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, -Y, BR + 6 + pulse * 6, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.save();
    ctx.translate(x, -Y);
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#FAF7EE';
    ctx.beginPath(); ctx.arc(0, 0, BR, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, BR, 0, Math.PI * 2); ctx.clip();
    ctx.rotate(spin);
    var cols = ['#FFCB2F', '#2F66E8', '#FFCB2F'];
    for (var k = 0; k < 3; k++) {
      var a0 = k * Math.PI * 2 / 3;
      ctx.strokeStyle = cols[k];
      ctx.lineWidth = BR * 0.42;
      ctx.beginPath();
      ctx.arc(Math.cos(a0) * BR * 1.15, Math.sin(a0) * BR * 1.15, BR * 0.92, a0 + Math.PI - 0.95, a0 + Math.PI + 0.95);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(40,40,70,0.45)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(Math.cos(a0) * BR * 1.15, Math.sin(a0) * BR * 1.15, BR * 0.71, a0 + Math.PI - 1.1, a0 + Math.PI + 1.1);
      ctx.stroke();
    }
    ctx.restore();
    var shade = ctx.createRadialGradient(-BR * 0.35, -BR * 0.4, BR * 0.1, 0, 0, BR * 1.05);
    shade.addColorStop(0, 'rgba(255,255,255,0.55)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0)');
    shade.addColorStop(1, 'rgba(30,20,60,0.35)');
    ctx.fillStyle = shade;
    ctx.beginPath(); ctx.arc(0, 0, BR, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(40,40,70,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  };

  Renderer.prototype.drawEffects = function (dt) {
    var ctx = this.ctx;
    for (var i = this.rings.length - 1; i >= 0; i--) {
      var r = this.rings[i];
      r.t += dt;
      if (r.t >= r.dur) { this.rings.splice(i, 1); continue; }
      var k = r.t / r.dur;
      ctx.strokeStyle = rgba(r.color, (1 - k) * 0.75);
      ctx.lineWidth = 2.5 * (1 - k) + 0.5;
      ctx.beginPath();
      if (r.flat) ctx.ellipse(r.x, -r.y, (10 + 60 * k) * r.size, (3 + 9 * k) * r.size, 0, 0, Math.PI * 2);
      else ctx.arc(r.x, -r.y, BR + 22 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (var j = this.particles.length - 1; j >= 0; j--) {
      var q = this.particles[j];
      q.life += dt;
      if (q.life >= q.max) { this.particles.splice(j, 1); continue; }
      q.vy -= q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.y < 0 && !q.conf) { q.y = 0; q.vy *= -0.3; q.vx *= 0.6; }
      var fade = 1 - q.life / q.max;
      ctx.globalAlpha = q.soft ? fade * 0.7 : fade;
      ctx.fillStyle = q.color;
      if (q.conf) {
        q.rot += dt * 8;
        ctx.save();
        ctx.translate(q.x, -q.y);
        ctx.rotate(q.rot);
        ctx.fillRect(-q.r, -q.r * 0.5, q.r * 2, q.r);
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(q.x, -q.y, q.r * (q.soft ? 1 + (1 - fade) : 1), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  // Names on the sand under each half.
  Renderer.prototype.drawTags = function () {
    var ctx = this.ctx;
    var w = this.world;
    for (var i = 0; i < w.blobs.length; i++) {
      var p = w.blobs[i];
      if (!p.name) continue;
      var cx = p.seat === 0 ? 250 : 750;
      var label = (p.isBot ? '🤖 ' : '') + p.name;
      var sub = !p.isBot && !p.connected ? 'reconnecting…' : '';
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '400 22px ' + FONT;
      label = ellipsize(ctx, label, 380);
      var tw = ctx.measureText(label).width;
      var y = sub ? 22 : 30;
      ctx.fillStyle = 'rgba(80,45,15,0.28)';
      roundRect(ctx, cx - tw / 2 - 16, y - 16, tw + 32, 32, 16);
      ctx.fill();
      ctx.globalAlpha = sub ? 0.7 : 1;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(label, cx, y + 1);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(cx - tw / 2 - 6, y, 4, 0, Math.PI * 2); ctx.fill();
      if (sub) {
        ctx.globalAlpha = 1;
        ctx.font = '400 16px ' + FONT;
        ctx.fillStyle = 'rgba(70,40,20,0.85)';
        ctx.fillText(sub, cx, y + 27);
      }
      ctx.restore();
    }
  };

  function ellipsize(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  window.BlobBallRender = { Renderer: Renderer, mix: mix };
}());
