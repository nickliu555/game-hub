(function (root) {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────
  // Nong engine — Pong for 2, 3 or 4 paddles, stepped at a fixed 60 Hz on the
  // host browser. Units are arena units and speeds are PER TICK.
  //
  // Arenas (all centred on the origin, screen coordinates, y down):
  //   2P rectangle: seat 0 defends the left side, seat 1 the right side, the
  //                 top and bottom are walls.
  //   3P triangle:  pointing up — seat 0 the base, seat 1 the right slant,
  //                 seat 2 the left slant.
  //   4P square:    seat 0 the bottom, seat 1 the right, seat 2 the top,
  //                 seat 3 the left — every paddle runs straight across or
  //                 straight up/down, exactly like its phone slider.
  // Mirrors axisFor()/angleFor() in server/nong/game.js (which way each paddle runs).
  //
  // On the polygon arenas each side keeps a short solid stretch at both
  // corners, so the paddle can always cover its whole goal mouth. There the
  // paddle's face sits flush with the wall line: a ball that glances off a
  // corner can never slip along the wall into the goal behind the paddle.
  // When a player is eliminated their whole side becomes a solid wall.
  // ───────────────────────────────────────────────────────────────────────

  var BALL_R = 7;
  var PADDLE_THICK = 12;
  var START_SPEED = 6;
  // Serves leave the centre slower so whoever receives has time to react; the
  // first return lifts the ball straight back to rally speed.
  var SERVE_SPEED = START_SPEED * 0.6;
  var SPEED_UP = 1.08;
  var MAX_SPEED = 15;
  var MAX_BOUNCE = 55 * Math.PI / 180;
  // A human paddle chases the phone slider by closing this share of the gap
  // every tick (capped per tick), so it lands under the thumb within a few
  // frames yet still glides smoothly over network jitter.
  var PADDLE_FOLLOW = 0.6;
  var PADDLE_MAX_STEP = 70;
  var PADDLE_MIN_STEP = 6;
  var SERVE_SPREAD = 24 * Math.PI / 180;
  var IDLE_TICKS = 10 * 60;
  // How far past the goal line the ball must travel before the point counts
  // on the 2P court (its dotted goal line is the side itself).
  var GOAL_DEPTH = BALL_R * 2;

  var BOT_REACTION_TICKS = 7;
  var BOT_SPEED = 9.1;
  // Aim error as a share of half the paddle: tight on a slow ball, and wide
  // enough at full speed that a long rally ends in a miss.
  var BOT_ERROR_BASE = 0.5;
  var BOT_ERROR_SPEED = 1.3;

  // The 3P/4P arenas are scaled up against the ball's speed: neighbouring sides
  // meet at a corner, so on a 2P-sized field a ball hit by the player next to
  // you arrives with almost no time to react. Paddles grow a bit more than the
  // field, so each covers a generous share of its goal.
  var POLY_SCALE = 1.7;
  var POLY_PADDLE_SCALE = 2;
  // The ball and paddle thickness grow too, so they still read clearly on a TV
  // once the larger field is fitted to the screen.
  var POLY_BALL_SCALE = 1.4;

  function layoutFor(n) {
    var verts, owners, paddleLen, inset, gap, goalLine, goalDepth, ui = 1;
    var ballR = BALL_R, thick = PADDLE_THICK;
    if (n === 2) {
      var W = 800, H = 480;
      verts = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]];
      owners = [null, 1, null, 0];
      paddleLen = 92; inset = 22; gap = 0;
      goalLine = 0; goalDepth = GOAL_DEPTH;
    } else if (n === 3) {
      var R3 = 340 * POLY_SCALE, s60 = Math.sin(Math.PI / 3);
      verts = [[0, -R3], [R3 * s60, R3 / 2], [-R3 * s60, R3 / 2]];
      owners = [1, 0, 2];
      paddleLen = Math.round(92 * POLY_PADDLE_SCALE); gap = 64 * POLY_SCALE; ui = POLY_SCALE;
    } else {
      // Same side length as the old diamond, so neighbours sit just as far apart.
      var H4 = 310 * POLY_SCALE / Math.SQRT2;
      verts = [[-H4, -H4], [H4, -H4], [H4, H4], [-H4, H4]];
      owners = [2, 1, 0, 3];
      paddleLen = Math.round(84 * POLY_PADDLE_SCALE); gap = 52 * POLY_SCALE; ui = POLY_SCALE;
    }
    if (n !== 2) {
      ballR = BALL_R * POLY_BALL_SCALE;
      thick = PADDLE_THICK * POLY_SCALE;
      // The paddle's face sits exactly on the wall line, and the dotted goal
      // line sits just behind the paddle, forming a shallow pocket. A point
      // counts once the ball has fully crossed it.
      inset = -thick / 2;
      goalLine = thick + 8 * ui;
      goalDepth = goalLine + ballR;
    }
    var sides = verts.map(function (a, i) {
      var b = verts[(i + 1) % verts.length];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.hypot(dx, dy);
      var tx = dx / len, ty = dy / len;
      var nx = -ty, ny = tx;
      // Inward normal: point it at the centroid (the origin).
      if ((0 - a[0]) * nx + (0 - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
      var owner = owners[i];
      return {
        ax: a[0], ay: a[1], bx: b[0], by: b[1],
        len: len, tx: tx, ty: ty, nx: nx, ny: ny,
        owner: owner,
        g0: owner === null ? 0 : gap,
        g1: owner === null ? len : len - gap,
      };
    });
    // `ui`: how much larger than the 2P court the arena is, so the renderer can
    // keep labels and lines the same size on screen.
    return { n: n, verts: verts, sides: sides, paddleLen: paddleLen, inset: inset, goalLine: goalLine, goalDepth: goalDepth, ui: ui, ballR: ballR, paddleThick: thick };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Fold a 1-D position back into [lo, hi] as if it bounced off both ends.
  function fold(v, lo, hi) {
    var span = hi - lo;
    if (span <= 0) return lo;
    var p = (v - lo) % (2 * span);
    if (p < 0) p += 2 * span;
    return lo + (p <= span ? p : 2 * span - p);
  }

  function World(opts) {
    var roster = (opts && opts.roster) || [];
    var n = Math.max(2, Math.min(4, roster.length || 2));
    var L = layoutFor(n);
    this.n = n;
    this.verts = L.verts;
    this.sides = L.sides;
    this.paddleLen = L.paddleLen;
    this.inset = L.inset;
    this.goalLine = L.goalLine;
    this.goalDepth = L.goalDepth;
    this.ui = L.ui;
    this.ballR = L.ballR;
    this.paddleThick = L.paddleThick;
    this.rand = (opts && opts.rand) || Math.random;
    this.frozen = true;
    this.tick = 0;
    this.events = [];
    this.sinceHit = 0;
    this.lastHitSeat = null;

    var self = this;
    this.paddles = [];
    this.byId = new Map();
    for (var s = 0; s < n; s++) {
      var sideIndex = -1;
      for (var i = 0; i < this.sides.length; i++) if (this.sides[i].owner === s) sideIndex = i;
      var side = this.sides[sideIndex];
      var r = roster[s] || { id: 'seat-' + s, name: 'P' + (s + 1) };
      var sMin = side.g0 + this.paddleLen / 2;
      var sMax = side.g1 - this.paddleLen / 2;
      var axis = r.axis || (Math.abs(side.ty) > Math.abs(side.tx) + 1e-6 ? 'v' : 'h');
      var p = {
        id: r.id,
        name: r.name,
        seat: s,
        color: r.color || '#ffffff',
        isBot: !!r.isBot,
        connected: r.connected !== false,
        side: sideIndex,
        axis: axis,
        // Does the phone's "forward" (right / down) run along the side's tangent?
        forward: axis === 'h' ? side.tx >= 0 : side.ty >= 0,
        sMin: sMin,
        sMax: sMax,
        s: (sMin + sMax) / 2,
        prevS: (sMin + sMax) / 2,
        target: (sMin + sMax) / 2,
        alive: true,
        botNext: 0,
        botErr: 0,
      };
      this.paddles.push(p);
      this.byId.set(p.id, p);
    }
    this.ball = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, speed: 0, mouth: -1 };
    self.resetBall();
  }

  World.prototype.resetBall = function () {
    var b = this.ball;
    b.x = b.y = b.px = b.py = 0;
    b.vx = b.vy = 0;
    b.speed = 0;
    b.mouth = -1;
    b.hidden = false;
    this.sinceHit = 0;
    this.lastHitSeat = null;
  };

  /** u: 0..1 along the phone slider (left→right or top→bottom on screen). */
  World.prototype.setInput = function (id, u) {
    var p = this.byId.get(id);
    if (!p || p.isBot) return;
    var f = clamp(+u || 0, 0, 1);
    if (!p.forward) f = 1 - f;
    p.target = p.sMin + f * (p.sMax - p.sMin);
  };

  World.prototype.setConnected = function (id, on) {
    var p = this.byId.get(id);
    if (p) p.connected = !!on;
  };

  World.prototype.eliminate = function (id) {
    var p = this.byId.get(id);
    if (p) p.alive = false;
  };

  World.prototype.aliveSeats = function () {
    return this.paddles.filter(function (p) { return p.alive; }).map(function (p) { return p.seat; });
  };

  /** Serve from the centre toward `seat`'s side (or a random live side). */
  World.prototype.serve = function (seat) {
    this.resetBall();
    var alive = this.aliveSeats();
    if (seat === null || seat === undefined || alive.indexOf(seat) < 0) {
      seat = alive[Math.floor(this.rand() * alive.length)];
    }
    var side = this.sides[this.paddles[seat].side];
    var base = Math.atan2(-side.ny, -side.nx);
    var ang = base + (this.rand() * 2 - 1) * SERVE_SPREAD;
    var b = this.ball;
    b.speed = SERVE_SPEED;
    b.vx = Math.cos(ang) * b.speed;
    b.vy = Math.sin(ang) * b.speed;
    this.events.push({ t: 'serve', seat: seat });
    return seat;
  };

  World.prototype.paddleCenter = function (p, s) {
    var side = this.sides[p.side];
    var at = s === undefined ? p.s : s;
    return {
      x: side.ax + side.tx * at + side.nx * this.inset,
      y: side.ay + side.ty * at + side.ny * this.inset,
    };
  };

  World.prototype.stepBots = function () {
    var b = this.ball;
    var half = this.paddleLen / 2;
    for (var i = 0; i < this.paddles.length; i++) {
      var p = this.paddles[i];
      if (!p.isBot || !p.alive) continue;
      if (this.tick < p.botNext) continue;
      p.botNext = this.tick + BOT_REACTION_TICKS;
      var side = this.sides[p.side];
      var vn = b.vx * side.nx + b.vy * side.ny;
      var mid = (p.sMin + p.sMax) / 2;
      if (this.frozen || b.speed === 0 || vn >= -0.05) {
        p.target = mid;
        continue;
      }
      var dist = (b.x - side.ax) * side.nx + (b.y - side.ay) * side.ny;
      var front = this.inset + this.paddleThick / 2 + this.ballR;
      var time = Math.max(0, (dist - front) / -vn);
      var t = (b.x - side.ax) * side.tx + (b.y - side.ay) * side.ty;
      var vt = b.vx * side.tx + b.vy * side.ty;
      var pred = t + vt * time;
      // The 2P court has walls at both ends of each paddle's side — fold the
      // bounces in. The polygon corners are too messy to predict, so clamp.
      pred = this.n === 2 ? fold(pred, this.ballR, side.len - this.ballR) : clamp(pred, 0, side.len);
      if (p.botAim !== this.lastHitSeat + ':' + Math.round(vn * 10)) {
        p.botAim = this.lastHitSeat + ':' + Math.round(vn * 10);
        p.botErr = (this.rand() * 2 - 1) * half * (BOT_ERROR_BASE + BOT_ERROR_SPEED * b.speed / MAX_SPEED);
      }
      p.target = pred + p.botErr;
    }
  };

  /** Advance one 60 Hz tick. Returns { seat } when a goal is conceded, { idle } on a stall. */
  World.prototype.step = function () {
    this.tick++;
    var i, p;
    // Work out each paddle's move for this tick; it is applied in small slices
    // inside the ball's substeps, so a fast swipe can't leap over the ball.
    var deltas = [];
    var maxD = 0;
    for (i = 0; i < this.paddles.length; i++) {
      p = this.paddles[i];
      p.prevS = p.s;
      var d = 0;
      if (p.alive) {
        var tgt = clamp(p.target, p.sMin, p.sMax);
        var gap = tgt - p.s;
        if (p.isBot) d = clamp(gap, -BOT_SPEED, BOT_SPEED);
        else if (Math.abs(gap) <= PADDLE_MIN_STEP * this.ui) d = gap;
        else d = (gap < 0 ? -1 : 1) * Math.min(PADDLE_MAX_STEP * this.ui, Math.max(PADDLE_MIN_STEP * this.ui, Math.abs(gap) * PADDLE_FOLLOW));
      }
      deltas.push(d);
      if (Math.abs(d) > maxD) maxD = Math.abs(d);
    }
    var self = this;
    function settlePaddles() {
      for (var j = 0; j < self.paddles.length; j++) self.paddles[j].s = self.paddles[j].prevS + deltas[j];
    }
    var b = this.ball;
    b.px = b.x; b.py = b.y;
    if (this.frozen || b.speed === 0) { settlePaddles(); return null; }

    this.sinceHit++;
    if (this.sinceHit > IDLE_TICKS) { settlePaddles(); return { idle: true }; }

    var R = this.ballR;
    var half = this.paddleLen / 2;
    var thick = this.paddleThick / 2;
    var front = this.inset + thick + R;
    var reach = half + R * 0.8;
    // Neither the ball nor a paddle moves more than about a ball radius per substep.
    var sub = Math.max(1, Math.ceil(b.speed / 4), Math.ceil(maxD / R));
    for (var k = 0; k < sub; k++) {
      for (i = 0; i < this.paddles.length; i++) {
        p = this.paddles[i];
        p.s = p.prevS + deltas[i] * (k + 1) / sub;
      }
      var ox = b.x, oy = b.y;
      b.x += b.vx / sub;
      b.y += b.vy / sub;
      for (i = 0; i < this.sides.length; i++) {
        var side = this.sides[i];
        var dist = (b.x - side.ax) * side.nx + (b.y - side.ay) * side.ny;
        var vn = b.vx * side.nx + b.vy * side.ny;
        p = side.owner === null ? null : this.paddles[side.owner];
        var live = !!(p && p.alive);

        // Paddle face: the ball crossed the front plane this substep.
        if (live && vn < 0 && b.mouth !== i) {
          var pdist = (ox - side.ax) * side.nx + (oy - side.ay) * side.ny;
          if (pdist >= front - 1e-6 && dist < front) {
            var f = (pdist - front) / (pdist - dist);
            var cx = ox + (b.x - ox) * f;
            var cy = oy + (b.y - oy) * f;
            var tc = (cx - side.ax) * side.tx + (cy - side.ay) * side.ty;
            if (Math.abs(tc - p.s) <= reach) {
              this.returnBall(side, p, tc);
              continue;
            }
          }
        }

        // The rest of the paddle is solid too: its rounded ends and body. A ball
        // that slips round the face (off a corner wall, or a paddle sliding
        // into it) is deflected instead of passing through.
        if (live) {
          var bt = (b.x - side.ax) * side.tx + (b.y - side.ay) * side.ty;
          var qt = clamp(bt, p.s - half, p.s + half);
          var lt = bt - qt;
          var ld = dist - this.inset;
          var dd = Math.sqrt(lt * lt + ld * ld);
          if (dd < thick + R) {
            var onFace = qt > p.s - half && qt < p.s + half;
            if (onFace && ld > 0) {
              // Overlapping the face from the arena side: a return, as if it
              // had come straight in (the paddle got there in time).
              this.returnBall(side, p, bt);
              continue;
            }
            var nt = dd > 1e-6 ? lt / dd : 0;
            var nd = dd > 1e-6 ? ld / dd : -1;
            var nx = side.tx * nt + side.nx * nd;
            var ny = side.ty * nt + side.ny * nd;
            var vdn = b.vx * nx + b.vy * ny;
            if (vdn < 0) {
              b.vx -= 2 * vdn * nx;
              b.vy -= 2 * vdn * ny;
              this.sinceHit = 0;
              this.lastHitSeat = p.seat;
              this.events.push({ t: 'hit', seat: p.seat, speed: b.speed });
            }
            b.x += nx * (thick + R - dd);
            b.y += ny * (thick + R - dd);
            dist = (b.x - side.ax) * side.nx + (b.y - side.ay) * side.ny;
            vn = b.vx * side.nx + b.vy * side.ny;
          }
        }

        if (dist >= R) {
          if (b.mouth === i) b.mouth = -1;
          continue;
        }
        var t = (b.x - side.ax) * side.tx + (b.y - side.ay) * side.ty;
        var inMouth = live && t >= side.g0 && t <= side.g1;
        if (inMouth || b.mouth === i) {
          b.mouth = i;
          if (dist < -this.goalDepth) {
            this.events.push({ t: 'goal', seat: p.seat });
            b.speed = 0; b.vx = b.vy = 0;
            b.hidden = true;
            settlePaddles();
            return { seat: p.seat };
          }
          continue;
        }
        if (vn < 0) {
          b.vx -= 2 * vn * side.nx;
          b.vy -= 2 * vn * side.ny;
          this.events.push({ t: 'wall' });
        }
        b.x += (R - dist) * side.nx;
        b.y += (R - dist) * side.ny;
      }
    }
    return null;
  };

  // Classic Pong return off the paddle face: the further from the centre the
  // ball meets the paddle (`tc`, along the side), the steeper it leaves.
  World.prototype.returnBall = function (side, p, tc) {
    var b = this.ball;
    var rel = clamp((tc - p.s) / (this.paddleLen / 2), -1, 1);
    var ang = rel * MAX_BOUNCE;
    var front = this.inset + this.paddleThick / 2 + this.ballR;
    b.speed = Math.min(MAX_SPEED, Math.max(START_SPEED, b.speed * SPEED_UP));
    b.vx = (side.nx * Math.cos(ang) + side.tx * Math.sin(ang)) * b.speed;
    b.vy = (side.ny * Math.cos(ang) + side.ty * Math.sin(ang)) * b.speed;
    b.x = side.ax + side.tx * tc + side.nx * (front + 0.01);
    b.y = side.ay + side.ty * tc + side.ny * (front + 0.01);
    b.mouth = -1;
    this.sinceHit = 0;
    this.lastHitSeat = p.seat;
    this.events.push({ t: 'hit', seat: p.seat, speed: b.speed });
  };

  var api = {
    World: World,
    layoutFor: layoutFor,
    fold: fold,
    BALL_R: BALL_R,
    PADDLE_THICK: PADDLE_THICK,
    START_SPEED: START_SPEED,
    SERVE_SPEED: SERVE_SPEED,
    MAX_SPEED: MAX_SPEED,
    IDLE_TICKS: IDLE_TICKS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Nong = api;
}(typeof window !== 'undefined' ? window : this));
