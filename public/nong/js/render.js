(function () {
  'use strict';

  // Retro neon renderer for Nong. Draws the arena outline, the goal mouths in
  // each seat's colour, the paddles, a trailing ball and a name tag outside
  // every side. Purely a view over a Nong.World.

  var BG = '#07060F';
  var FLOOR = '#0D0B1E';
  var WALL = '#E9E6FF';
  var DEAD = '#4A4560';
  var TAG_W = 250;    // max width of a name tag beside a slanted side
  var TRAIL = 10;

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.dpr = 1;
    this.trail = [];
    this.flashes = [];
    this.particles = [];
    this.mode = 'points';
    this.scores = {};
    this.target = 0;
    this.lastTime = 0;
    var self = this;
    this.bounds = (function () {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      world.verts.forEach(function (v) {
        minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
        minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
      });
      // Room outside the arena for the name tags.
      var padX = world.n === 2 ? 24 : TAG_W + 40;
      var padTop = world.n === 2 ? 72 : 30;
      var padBottom = world.n === 3 ? 84 : (world.n === 2 ? 24 : 30);
      return { minX: minX - padX, maxX: maxX + padX, minY: minY - padTop, maxY: maxY + padBottom };
    }());
    self.resize();
  }

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    var rect = c.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    var bw = this.bounds.maxX - this.bounds.minX;
    var bh = this.bounds.maxY - this.bounds.minY;
    this.scale = Math.min(c.width / bw, c.height / bh);
    this.ox = c.width / 2 - ((this.bounds.minX + this.bounds.maxX) / 2) * this.scale;
    this.oy = c.height / 2 - ((this.bounds.minY + this.bounds.maxY) / 2) * this.scale;
  };

  Renderer.prototype.setScores = function (mode, scores, target) {
    this.mode = mode;
    this.scores = scores || {};
    this.target = target || 0;
  };

  Renderer.prototype.flashSide = function (seat, color) {
    this.flashes.push({ seat: seat, color: color, t: 0, dur: 0.9 });
  };

  Renderer.prototype.burst = function (x, y, color, count) {
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 60 + Math.random() * 320;
      this.particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.5 + Math.random() * 0.7, color: color, size: 3 + Math.random() * 4 });
    }
  };

  Renderer.prototype.clearTrail = function () { this.trail.length = 0; };

  function ellipsize(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  Renderer.prototype.render = function (alpha, dt) {
    var ctx = this.ctx;
    var w = this.world;
    var c = this.canvas;
    var S = this.scale;
    dt = dt || 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(S, 0, 0, S, this.ox, this.oy);

    // Floor.
    ctx.beginPath();
    w.verts.forEach(function (v, i) { if (i) ctx.lineTo(v[0], v[1]); else ctx.moveTo(v[0], v[1]); });
    ctx.closePath();
    ctx.fillStyle = FLOOR;
    ctx.fill();

    // Centre line (2P) / centre spot.
    ctx.save();
    ctx.strokeStyle = 'rgba(233,230,255,0.22)';
    ctx.lineWidth = 4;
    if (w.n === 2) {
      ctx.setLineDash([16, 16]);
      ctx.beginPath();
      ctx.moveTo(0, w.verts[0][1] + 8);
      ctx.lineTo(0, w.verts[2][1] - 8);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 40, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Big classic score digits in the 2P court.
    if (w.n === 2 && this.mode === 'points') {
      ctx.save();
      ctx.font = '900 110px "Press Start 2P", ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(233,230,255,0.13)';
      var top = w.verts[0][1] + 26;
      ctx.fillText(String(this.scores[w.paddles[0].id] || 0), -200, top);
      ctx.fillText(String(this.scores[w.paddles[1].id] || 0), 200, top);
      ctx.restore();
    }

    // Sides: walls, corner stretches, goal mouths.
    var self = this;
    w.sides.forEach(function (side) {
      var p = side.owner === null ? null : w.paddles[side.owner];
      var live = !!(p && p.alive);
      ctx.save();
      ctx.lineCap = 'round';
      if (!p) {
        line(ctx, side, 0, side.len, WALL, 8, 10);
      } else if (!live) {
        line(ctx, side, 0, side.len, DEAD, 12, 0);
      } else {
        if (side.g0 > 0) line(ctx, side, 0, side.g0, WALL, 8, 10);
        if (side.g1 < side.len) line(ctx, side, side.g1, side.len, WALL, 8, 10);
        ctx.setLineDash([10, 12]);
        goalLine(ctx, side, w.goalLine, hexA(p.color, 0.55), 3, 0);
      }
      ctx.restore();
    });

    // Side flashes when a point is conceded.
    for (var fi = this.flashes.length - 1; fi >= 0; fi--) {
      var fl = this.flashes[fi];
      fl.t += dt;
      if (fl.t >= fl.dur) { this.flashes.splice(fi, 1); continue; }
      var pp = w.paddles[fl.seat];
      if (!pp) continue;
      var sd = w.sides[pp.side];
      var k = 1 - fl.t / fl.dur;
      ctx.save();
      ctx.lineCap = 'round';
      goalLine(ctx, sd, w.goalLine, hexA(fl.color, k), 10 + 18 * k, 30 * k);
      ctx.restore();
    }

    // Paddles.
    w.paddles.forEach(function (p) {
      if (!p.alive) return;
      var side = w.sides[p.side];
      var s = p.prevS + (p.s - p.prevS) * alpha;
      var cpos = w.paddleCenter(p, s);
      ctx.save();
      ctx.translate(cpos.x, cpos.y);
      ctx.rotate(Math.atan2(side.ty, side.tx));
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 22;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.connected || p.isBot ? 1 : 0.55;
      roundRect(ctx, -w.paddleLen / 2, -window.Nong.PADDLE_THICK / 2, w.paddleLen, window.Nong.PADDLE_THICK, 4);
      ctx.fill();
      ctx.restore();
    });

    // Ball + trail.
    var b = w.ball;
    var bx = b.px + (b.x - b.px) * alpha;
    var by = b.py + (b.y - b.py) * alpha;
    if (b.speed > 0) {
      this.trail.push({ x: bx, y: by });
      if (this.trail.length > TRAIL) this.trail.shift();
    } else {
      this.trail.length = 0;
    }
    var R = window.Nong.BALL_R;
    for (var ti = 0; ti < this.trail.length; ti++) {
      var tp = this.trail[ti];
      var a = (ti + 1) / (this.trail.length + 1);
      ctx.fillStyle = 'rgba(233,230,255,' + (a * 0.28).toFixed(3) + ')';
      var tr = R * (0.5 + 0.5 * a);
      ctx.fillRect(tp.x - tr, tp.y - tr, tr * 2, tr * 2);
    }
    ctx.save();
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#ffffff';
    if (!b.hidden && !(b.speed === 0 && w.frozen && Math.floor(performance.now() / 300) % 2)) {
      ctx.fillRect(bx - R, by - R, R * 2, R * 2);
    }
    ctx.restore();

    // Particles.
    for (var pi = this.particles.length - 1; pi >= 0; pi--) {
      var q = this.particles[pi];
      q.life += dt;
      if (q.life >= q.max) { this.particles.splice(pi, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      q.vx *= 0.96; q.vy *= 0.96;
      ctx.globalAlpha = 1 - q.life / q.max;
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.globalAlpha = 1;

    // Name tags outside each side.
    w.paddles.forEach(function (p) { self.drawTag(p); });
  };

  Renderer.prototype.drawTag = function (p) {
    var ctx = this.ctx;
    var w = this.world;
    var side = w.sides[p.side];
    var mx, my, maxW, align = 'center';
    if (w.n === 2) {
      // Classic court: names sit above each half, like an arcade marquee.
      mx = p.seat === 0 ? -200 : 200;
      my = w.verts[0][1] - 38;
      maxW = 360;
    } else {
      // Clear of the recessed goal line behind the paddle.
      mx = (side.ax + side.bx) / 2 - side.nx * (w.goalLine + 26);
      my = (side.ay + side.by) / 2 - side.ny * (w.goalLine + 26);
      maxW = TAG_W;
      // Anchor the text away from the arena so it never overlaps the floor.
      if (-side.nx > 0.3) align = 'left';
      else if (-side.nx < -0.3) align = 'right';
      else my -= side.ny * 6;
    }
    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.font = '800 24px Inter, system-ui, sans-serif';
    var name = (p.isBot ? '🤖 ' : '') + p.name;
    var label = ellipsize(ctx, name, maxW);
    ctx.globalAlpha = p.alive ? (p.connected || p.isBot ? 1 : 0.6) : 0.45;
    ctx.fillStyle = p.alive ? p.color : DEAD;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6;
    var sub = '';
    if (!p.alive) sub = 'OUT';
    else if (this.mode === 'lives') {
      var lives = this.scores[p.id] || 0;
      sub = new Array(lives + 1).join('♥ ').trim();
    } else if (!p.connected && !p.isBot) sub = 'reconnecting…';
    ctx.fillText(label, mx, sub ? my - 13 : my);
    if (sub) {
      ctx.font = '800 20px Inter, system-ui, sans-serif';
      ctx.fillStyle = p.alive ? (sub === 'reconnecting…' ? '#bdb7d9' : p.color) : DEAD;
      ctx.fillText(ellipsize(ctx, sub, maxW), mx, my + 14);
    }
    ctx.restore();
  };

  function line(ctx, side, t0, t1, color, width, glow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; } else { ctx.shadowBlur = 0; }
    ctx.beginPath();
    ctx.moveTo(side.ax + side.tx * t0, side.ay + side.ty * t0);
    ctx.lineTo(side.ax + side.tx * t1, side.ay + side.ty * t1);
    ctx.stroke();
  }

  // The dotted goal line. On the polygon arenas it sits `off` behind the wall
  // line, joined to the corner walls at both ends to form a shallow pocket.
  function goalLine(ctx, side, off, color, width, glow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; } else { ctx.shadowBlur = 0; }
    function pt(t, o) { return [side.ax + side.tx * t - side.nx * o, side.ay + side.ty * t - side.ny * o]; }
    var a = pt(side.g0, 0), b = pt(side.g0, off), c = pt(side.g1, off), d = pt(side.g1, 0);
    ctx.beginPath();
    if (off > 0) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); } else ctx.moveTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    if (off > 0) ctx.lineTo(d[0], d[1]);
    ctx.stroke();
  }

  function roundRect(ctx, x, y, w, h, r) {
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

  function hexA(hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  window.NongRender = { Renderer: Renderer, hexA: hexA };
}());
