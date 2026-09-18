(function () {
  'use strict';

  // Nockey host renderer — draws the whole rink fitted to the canvas
  // (no camera follow: everyone watches the same TV).

  var COLORS = {
    ice: '#EEF6FC',
    iceAlt: '#DCEAF6',
    line: 'rgba(23,60,92,0.30)',
    blueLine: '#2F7DE0',
    redLine: '#E43B3B',
    out: '#0E2233',
    red: '#E43B3B',
    redDeep: '#8E1E1E',
    blue: '#2F7DE0',
    blueDeep: '#173F79',
    puck: '#22242B',
    puckDeep: '#0D0E12',
    rail: '#F4F9F5',
    kickplate: 'rgba(226,195,104,0.85)',
    frameRed: '#D8332F',
    frameRedDeep: '#8A1A17',
    frameBlue: '#3B8AEA',
    frameBlueDeep: '#17457F',
    mesh: 'rgba(255,255,255,0.40)',
    creaseFill: 'rgba(120,190,235,0.45)',
  };

  function lerp(a, b, t) { return a + (b - a) * t; }

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.flash = 0;
    this.flashTeam = null;
    this.trail = [];
    this.particles = [];
    this.resize();
  }

  Renderer.prototype.setWorld = function (world) {
    this.world = world;
    this.trail.length = 0;
    this.particles.length = 0;
    this.resize();
  };

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = c.clientWidth || 800;
    var h = c.clientHeight || 450;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = w;
    this.ch = h;
    this._fit();
  };

  Renderer.prototype._fit = function () {
    var S = this.world.stadium;
    var padX = 44;
    var padY = 30;
    var worldW = (S.outX + padX) * 2;
    var worldH = (S.outY + padY) * 2;
    this.scale = Math.min(this.cw / worldW, this.ch / worldH);
    this.ox = this.cw / 2;
    this.oy = this.ch / 2;
  };

  Renderer.prototype.goalFlash = function (team) {
    this.flash = 1;
    this.flashTeam = team;
  };

  // Particle splash for goals. Coordinates are world units, speeds per second.
  Renderer.prototype.spawnBurst = function (x, y, color, n) {
    n = n || 20;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 60 + Math.random() * 260;
      this.particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.7 + Math.random() * 0.7, age: 0,
        color: color, r: 1.6 + Math.random() * 3.2,
      });
    }
  };

  Renderer.prototype._updateParticles = function (dt) {
    var alive = [];
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      alive.push(p);
    }
    this.particles = alive;
  };

  Renderer.prototype._drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype.render = function (alpha, dt) {
    var ctx = this.ctx;
    var S = this.world.stadium;
    if (typeof alpha !== 'number') alpha = 1;
    if (typeof dt !== 'number' || !(dt > 0)) dt = 1 / 60;
    this._fit();

    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.fillStyle = COLORS.out;
    ctx.fillRect(0, 0, this.cw, this.ch);

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);

    this._drawPitch(ctx, S);
    this._drawGoals(ctx, S);

    var ball = this.world.ball;
    var bx = lerp(ball.px, ball.x, alpha);
    var by = lerp(ball.py, ball.y, alpha);
    this._drawTrail(ctx, bx, by, ball);

    var players = this.world.players;
    for (var i = 0; i < players.length; i++) {
      this._drawPlayer(ctx, players[i], alpha);
    }
    this._drawBall(ctx, bx, by);

    if (this.particles.length) {
      this._updateParticles(dt);
      this._drawParticles(ctx);
    }

    ctx.restore();

    if (this.flash > 0) {
      var col = this.flashTeam === 'red' ? '228,59,59' : '47,125,224';
      ctx.fillStyle = 'rgba(' + col + ',' + (this.flash * 0.34) + ')';
      ctx.fillRect(0, 0, this.cw, this.ch);
      this.flash = Math.max(0, this.flash - 0.03);
    }
  };

  // The rounded outline of the sheet. Matches the corner arcs in the engine, so
  // the puck never looks like it is riding over the boards.
  Renderer.prototype._rinkPath = function (ctx, S, inset) {
    var hw = S.halfW - inset;
    var hh = S.halfH - inset;
    var r = Math.max(0, (S.corner || 0) - inset);
    ctx.beginPath();
    ctx.moveTo(-hw + r, -hh);
    ctx.lineTo(hw - r, -hh);
    ctx.arcTo(hw, -hh, hw, -hh + r, r);
    ctx.lineTo(hw, hh - r);
    ctx.arcTo(hw, hh, hw - r, hh, r);
    ctx.lineTo(-hw + r, hh);
    ctx.arcTo(-hw, hh, -hw, hh - r, r);
    ctx.lineTo(-hw, -hh + r);
    ctx.arcTo(-hw, -hh, -hw + r, -hh, r);
    ctx.closePath();
  };

  Renderer.prototype._drawPitch = function (ctx, S) {
    var w = S.halfW * 2;
    var h = S.halfH * 2;

    // Every marking is clipped to the rink outline, so the lines die on the
    // corner curve instead of squaring off.
    ctx.save();
    this._rinkPath(ctx, S, 0);
    ctx.clip();

    // Freshly resurfaced ice: bright down the middle, cooler by the boards.
    ctx.fillStyle = COLORS.ice;
    ctx.fillRect(-S.halfW, -S.halfH, w, h);
    var sheen = ctx.createRadialGradient(0, 0, S.halfH * 0.15, 0, 0, S.halfW * 1.05);
    sheen.addColorStop(0, 'rgba(255,255,255,0.55)');
    sheen.addColorStop(0.62, 'rgba(226,240,250,0.28)');
    sheen.addColorStop(1, 'rgba(176,205,231,0.55)');
    ctx.fillStyle = sheen;
    ctx.fillRect(-S.halfW, -S.halfH, w, h);

    var lw = Math.max(4, S.halfW * 0.016);
    var blueX = S.halfW * 0.34;

    // Each end zone is washed in the colour of the team defending it, so you can
    // tell at a glance which net is which.
    for (var zs = -1; zs <= 1; zs += 2) {
      var rgb = zs < 0 ? '228,59,59' : '47,125,224';
      var zone = ctx.createLinearGradient(zs * S.halfW, 0, zs * blueX, 0);
      zone.addColorStop(0, 'rgba(' + rgb + ',0.34)');
      zone.addColorStop(0.55, 'rgba(' + rgb + ',0.12)');
      zone.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = zone;
      ctx.fillRect(Math.min(zs * S.halfW, zs * blueX), -S.halfH, S.halfW - blueX, h);
    }

    // Red centre line, flanked by the two blue lines.
    ctx.fillStyle = COLORS.blueLine;
    ctx.fillRect(-blueX - lw / 2, -S.halfH, lw, h);
    ctx.fillRect(blueX - lw / 2, -S.halfH, lw, h);
    ctx.fillStyle = COLORS.redLine;
    ctx.fillRect(-lw / 2, -S.halfH, lw, h);

    // Goal creases — pale blue ice inside a red outline, spanning the mouth.
    var crease = S.goalHalf;
    for (var side = -1; side <= 1; side += 2) {
      ctx.beginPath();
      ctx.arc(side * S.halfW, 0, crease,
        side < 0 ? -Math.PI / 2 : Math.PI / 2,
        side < 0 ? Math.PI / 2 : Math.PI * 1.5);
      ctx.closePath();
      ctx.fillStyle = COLORS.creaseFill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.redLine;
      ctx.stroke();
    }

    var dotR = Math.max(2.5, S.halfW * 0.009);

    // Centre face-off circle and spot.
    this._faceOff(ctx, 0, 0, S.circle, dotR, COLORS.blueLine, false);

    // Four end-zone circles, plus the neutral-zone dots by the blue lines.
    var fx = S.halfW * 0.62;
    var fy = S.halfH * 0.52;
    var nx = blueX + S.halfW * 0.10;
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sy = -1; sy <= 1; sy += 2) {
        this._faceOff(ctx, sx * fx, sy * fy, S.circle * 0.78, dotR, COLORS.redLine, true);
        ctx.beginPath();
        ctx.arc(sx * nx, sy * fy, dotR, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.redLine;
        ctx.fill();
      }
    }

    // Referee's crease, centred on the near board.
    var refR = Math.min(S.circle * 0.42, S.halfH * 0.22);
    ctx.beginPath();
    ctx.arc(0, S.halfH, refR, Math.PI, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.redLine;
    ctx.stroke();

    ctx.restore();

    this._drawBoards(ctx, S);
  };

  // A face-off circle with its spot at the centre, optionally with the four
  // hash-mark pairs that only the end-zone circles carry.
  Renderer.prototype._faceOff = function (ctx, x, y, r, dotR, color, hash) {
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    if (hash) {
      var off = r * 0.31;
      var edge = Math.sqrt(Math.max(0, r * r - off * off));
      var len = r * 0.26;
      ctx.beginPath();
      for (var hy = -1; hy <= 1; hy += 2) {
        for (var hx = -1; hx <= 1; hx += 2) {
          ctx.moveTo(x + hx * off, y + hy * edge);
          ctx.lineTo(x + hx * off, y + hy * (edge + len));
        }
      }
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  // One continuous rounded run of boards, broken only at the two goal mouths so
  // the puck visibly enters the net instead of passing through a wall.
  Renderer.prototype._boardPath = function (ctx, S, inset) {
    var hw = S.halfW - inset;
    var hh = S.halfH - inset;
    var gh = S.goalHalf;
    var r = Math.max(0, (S.corner || 0) - inset);
    ctx.beginPath();
    ctx.moveTo(hw, gh);
    ctx.lineTo(hw, hh - r);
    ctx.arcTo(hw, hh, hw - r, hh, r);
    ctx.lineTo(-hw + r, hh);
    ctx.arcTo(-hw, hh, -hw, hh - r, r);
    ctx.lineTo(-hw, gh);
    ctx.moveTo(-hw, -gh);
    ctx.lineTo(-hw, -hh + r);
    ctx.arcTo(-hw, -hh, -hw + r, -hh, r);
    ctx.lineTo(hw - r, -hh);
    ctx.arcTo(hw, -hh, hw, -hh + r, r);
    ctx.lineTo(hw, -gh);
  };

  Renderer.prototype._drawBoards = function (ctx, S) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this._boardPath(ctx, S, 0);
    ctx.strokeStyle = 'rgba(6,24,40,0.40)';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.strokeStyle = COLORS.rail;
    ctx.lineWidth = 4.5;
    ctx.stroke();
    // The kickplate strip along the bottom of the boards.
    this._boardPath(ctx, S, 3.2);
    ctx.strokeStyle = COLORS.kickplate;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  };

  // A goal seen from above: two posts, a short straight run back, then the
  // curved back bar.
  Renderer.prototype._goalPath = function (ctx, S, side) {
    var gh = S.goalHalf;
    var d = S.netDepth;
    var line = side * S.halfW;
    var outer = side * (S.halfW + d);
    var knee = side * (S.halfW + d * 0.35);
    ctx.beginPath();
    ctx.moveTo(line, -gh);
    ctx.lineTo(knee, -gh);
    ctx.quadraticCurveTo(outer, -gh, outer, -gh * 0.5);
    ctx.lineTo(outer, gh * 0.5);
    ctx.quadraticCurveTo(outer, gh, knee, gh);
    ctx.lineTo(line, gh);
  };

  Renderer.prototype._drawGoals = function (ctx, S) {
    var gh = S.goalHalf;
    var d = S.netDepth;
    for (var side = -1; side <= 1; side += 2) {
      var line = side * S.halfW;
      var x0 = Math.min(line, side * (S.halfW + d));

      // Plain white mesh — the frame and the end zone carry the team colour.
      this._goalPath(ctx, S, side);
      ctx.save();
      ctx.clip();
      ctx.fillStyle = 'rgba(12,32,52,0.55)';
      ctx.fillRect(x0, -gh, d, gh * 2);
      ctx.strokeStyle = COLORS.mesh;
      ctx.lineWidth = 0.8;
      for (var m = -gh - d; m <= gh + d; m += 8) {
        ctx.beginPath(); ctx.moveTo(x0, m); ctx.lineTo(x0 + d, m + d); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, m); ctx.lineTo(x0 + d, m - d); ctx.stroke();
      }
      ctx.restore();

      // Tubular frame in the defending team's colour.
      this._goalPath(ctx, S, side);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.38)';
      ctx.lineWidth = 6.5;
      ctx.stroke();
      ctx.strokeStyle = side < 0 ? COLORS.frameRed : COLORS.frameBlue;
      ctx.lineWidth = 3.5;
      ctx.stroke();

      // The goal line is a marking on the ice, not part of the frame, so it
      // stays thinner than the tubing.
      ctx.strokeStyle = side < 0 ? COLORS.redLine : COLORS.blueLine;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(line, -gh);
      ctx.lineTo(line, gh);
      ctx.stroke();
    }

    for (var i = 0; i < S.posts.length; i++) {
      var p = S.posts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.x < 0 ? COLORS.frameRed : COLORS.frameBlue;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = p.x < 0 ? COLORS.frameRedDeep : COLORS.frameBlueDeep;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.r - 1), 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  Renderer.prototype._drawTrail = function (ctx, bx, by, ball) {
    var speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    var last = this.trail[this.trail.length - 1];
    // Face-off/restore teleports the puck — drop the old trail so it can't
    // streak across the rink.
    if (last && Math.abs(bx - last.x) + Math.abs(by - last.y) > ball.r * 6) this.trail.length = 0;
    if (speed > 1.2) this.trail.push({ x: bx, y: by });
    else if (this.trail.length) this.trail.shift();   // drain at ANY slower speed
    while (this.trail.length > 14) this.trail.shift();
    for (var i = 0; i < this.trail.length; i++) {
      var t = (i + 1) / this.trail.length;
      ctx.beginPath();
      ctx.arc(this.trail[i].x, this.trail[i].y, ball.r * 0.75 * t, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(96,146,192,' + (0.30 * t) + ')';
      ctx.fill();
    }
  };

  Renderer.prototype._drawPlayer = function (ctx, p, alpha) {
    var x = lerp(p.px, p.x, alpha);
    var y = lerp(p.py, p.y, alpha);
    var fill = p.team === 'red' ? COLORS.red : COLORS.blue;
    var edge = p.team === 'red' ? COLORS.redDeep : COLORS.blueDeep;

    ctx.globalAlpha = p.connected ? 1 : 0.45;

    ctx.beginPath();
    ctx.arc(x, y + 3, p.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,52,82,0.22)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.inKick ? '#FFFFFF' : edge;
    ctx.stroke();

    if (p.kickFlash > 0) {
      ctx.beginPath();
      ctx.arc(x, y, p.r + 4 + (8 - p.kickFlash), 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,' + (p.kickFlash / 10) + ')';
      ctx.stroke();
    }

    // Name plate under the skater — kept short so a full roster stays readable.
    var label = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name;
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var w = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    var rx = x - w / 2 - 5;
    var ry = y + p.r + 4;
    var rw = w + 10;
    var rh = 16;
    var rr = 5;
    ctx.moveTo(rx + rr, ry);
    ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr);
    ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr);
    ctx.arcTo(rx, ry + rh, rx, ry, rr);
    ctx.arcTo(rx, ry, rx + rw, ry, rr);
    ctx.fill();
    ctx.fillStyle = p.connected ? '#fff' : 'rgba(255,255,255,0.75)';
    ctx.fillText(label, x, ry + 2);

    if (p.emote && p.emote.until > Date.now()) {
      ctx.font = '22px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(p.emote.e, x, y - p.r - 6);
    }

    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawBall = function (ctx, bx, by) {
    var r = this.world.ball.r;
    // Shadow on the ice.
    ctx.beginPath();
    ctx.arc(bx, by + 3, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,52,82,0.30)';
    ctx.fill();

    // A puck is a squat cylinder: the darker rim is its side, the lighter face
    // sits slightly above it so it reads as having thickness.
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.puckDeep;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(bx, by - r * 0.16, r * 0.92, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.puck;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.stroke();
  };

  window.NockeyRender = { Renderer: Renderer, COLORS: COLORS };
}());
