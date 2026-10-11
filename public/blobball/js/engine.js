(function (root) {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────
  // Blob Ball engine — Slime Volleyball, stepped at a fixed 50 Hz on the host
  // browser (the original applet's tick rate).
  //
  // Units deliberately match the original game so the feel carries over 1:1:
  //   • x runs 0..1000 across the court, y runs UP from the ground (y = 0).
  //   • The original drew y at HALF the scale of x (a 1000×1000 world on a
  //     2:1 screen), so a blob's 100-unit radius in y is 50 units across.
  //     The ball/blob collision keeps the original's 2·dx weighting for that.
  //   • Every speed and gravity value is per tick.
  // The renderer converts to an isotropic space with X = x, Y = y / 2.
  // ───────────────────────────────────────────────────────────────────────

  var TICK_HZ = 50;
  var W = 1000;

  var BLOB_R = 100;            // y-units (50 across)
  var BALL_R = 25;             // y-units (12.5 across)
  var HIT_R = BLOB_R + BALL_R; // 125
  var FUDGE = 5;

  var MOVE_SPEED = 8;
  var JUMP_V = 31;
  var BLOB_G = 2;
  // Variable jump: letting go of JUMP while still rising cuts the climb. The
  // first few ticks always fire so a quick tap is a consistent little hop.
  var HOP_CUT_V = 6;
  var MIN_HOP_TICKS = 3;
  var JUMP_BUFFER_TICKS = 5;   // a press just before landing still jumps
  // A rising/falling blob can outrun the ball's speed cap and touch it again a
  // tick or two later. Contacts this close together are one touch: flagged
  // `cont` so the boing and hit sparks play once.
  var HIT_CHAIN_TICKS = 8;

  var BALL_G = 1;
  var MAX_VX = 15;
  var MAX_VY = 22;

  var WALL_MIN = 15;
  var WALL_MAX = 985;
  var CEIL = 800;              // the top of the court, in y-units

  // The net: a ball centre inside x ∈ (480, 520) below y = 140 hits the post.
  var NET_X = 500;
  var NET_BAND = 20;
  var NET_TOP = 140;
    var NET_DRAW_H = 104;        // drawn height in y-units (≈ a blob's height)
  var NET_DRAW_HALF = 6;       // drawn half-width in x-units

  var LIMITS = [[50, 445], [555, 950]];
  var HOME = [200, 800];
  var SERVE_Y = 356;

  // Once a point is decided the ball plays on (dead) and settles on the sand.
  var DEAD_BOUNCE = 0.62;
  var DEAD_FRICTION = 0.82;
  var DEAD_ROLL = 0.985;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function sideOf(x) { return x < NET_X ? 0 : 1; }

  function makeBlob(r, seat) {
    return {
      id: r.id,
      name: r.name,
      seat: seat,
      color: r.color,
      isBot: !!r.isBot,
      connected: r.connected !== false,
      x: HOME[seat], y: 0, vx: 0, vy: 0, px: HOME[seat], py: 0,
      held: { l: false, r: false, j: false },
      jumpBuf: 0,
      airTicks: 0,
      lastHitTick: -99,
      ai: null,
    };
  }

  function World(opts) {
    var roster = (opts && opts.roster) || [];
    this.blobs = [];
    for (var s = 0; s < 2; s++) {
      var r = roster[s] || { id: 'empty-' + s, name: '', isBot: true };
      this.blobs.push(makeBlob(r, s));
    }
    this.ball = { x: HOME[0], y: SERVE_Y, vx: 0, vy: 0, px: HOME[0], py: SERVE_Y, spin: 0, pspin: 0 };
    this.events = [];
    this.blobsLocked = true;   // inputs ignored (countdown, serve hold, dead ball)
    this.ballHeld = true;      // ball hovers in place (serve hold)
    this.live = false;         // a ground touch scores
    this.serveSeat = 0;
    this.tick = 0;
    this.rng = (opts && opts.rng) || Math.random;
  }

  World.prototype.byId = function (id) {
    for (var i = 0; i < this.blobs.length; i++) if (this.blobs[i].id === id) return this.blobs[i];
    return null;
  };

  // Reset every blob home and hang the ball above the server. Nothing moves
  // until release().
  World.prototype.setupServe = function (seat) {
    this.serveSeat = seat === 1 ? 1 : 0;
    for (var i = 0; i < this.blobs.length; i++) {
      var p = this.blobs[i];
      p.x = p.px = HOME[p.seat];
      p.y = p.py = 0;
      p.vx = p.vy = 0;
      p.jumpBuf = 0;
      p.airTicks = 0;
      p.lastHitTick = -99;
      if (p.ai) { p.ai.wait = 0; p.ai.lastBallSide = -1; p.ai.move = 0; p.ai.turn = 0; }
    }
    var b = this.ball;
    b.x = b.px = HOME[this.serveSeat];
    b.y = b.py = SERVE_Y;
    b.vx = b.vy = 0;
    this.blobsLocked = true;
    this.ballHeld = true;
    this.live = false;
  };

  World.prototype.release = function () {
    this.blobsLocked = false;
    this.ballHeld = false;
    this.live = true;
  };

  // c: 0 = left, 1 = right, 2 = jump. Held state is always recorded so a
  // button already down when play goes live acts on the very first tick.
  World.prototype.setInput = function (id, c, down) {
    var p = this.byId(id);
    if (!p) return;
    var on = !!down;
    if (c === 0) p.held.l = on;
    else if (c === 1) p.held.r = on;
    else if (c === 2) {
      if (on && !p.held.j) p.jumpBuf = JUMP_BUFFER_TICKS;
      p.held.j = on;
    }
  };

  World.prototype.clearInput = function (id) {
    var p = this.byId(id);
    if (!p) return;
    p.held.l = p.held.r = p.held.j = false;
    p.jumpBuf = 0;
  };

  World.prototype.setConnected = function (id, on) {
    var p = this.byId(id);
    if (!p) return;
    p.connected = !!on;
    if (!on) this.clearInput(id);
  };

  World.prototype._stepBlob = function (p) {
    p.px = p.x;
    p.py = p.y;
    var locked = this.blobsLocked;
    var l = !locked && p.held.l;
    var r = !locked && p.held.r;
    var j = !locked && p.held.j;
    // The CPU's feet are slower than a player's, to match how fiddly sideways
    // movement is on a phone.
    var speed = p.isBot ? MOVE_SPEED * AI_SPEED : MOVE_SPEED;
    p.vx = l && !r ? -speed : (r && !l ? speed : 0);
    if (!locked && p.y === 0 && (j || p.jumpBuf > 0)) {
      p.vy = JUMP_V;
      p.airTicks = 0;
      p.jumpBuf = 0;
      this.events.push({ t: 'jump', seat: p.seat });
    }
    if (p.jumpBuf > 0) p.jumpBuf--;
    if (!j && p.vy > HOP_CUT_V && p.airTicks >= MIN_HOP_TICKS) p.vy = HOP_CUT_V;

    if (p.vx !== 0) {
      var lim = LIMITS[p.seat];
      p.x = clamp(p.x + p.vx, lim[0], lim[1]);
    }
    if (p.vy !== 0 || p.y > 0) {
      p.vy -= BLOB_G;
      p.y += p.vy;
      p.airTicks++;
      if (p.y <= 0) {
        this.events.push({ t: 'land', seat: p.seat, v: -p.vy });
        p.y = 0;
        p.vy = 0;
      }
    }
  };

  // The original's ball/blob bounce: the ball reflects off the dome AND picks
  // up the blob's own velocity, which is what makes spikes and lobs work.
  function collideBlob(b, p) {
    var dx = 2 * (b.x - p.x);
    var dy = b.y - p.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (!(dy > 0 && dist < HIT_R && dist > FUDGE)) return false;
    var dvx = b.vx - p.vx;
    var dvy = b.vy - p.vy;
    b.x = p.x + (HIT_R / 2) * dx / dist;
    b.y = p.y + HIT_R * dy / dist;
    var along = (dx * dvx + dy * dvy) / dist;
    if (along > 0) return false;
    b.vx += p.vx - 2 * dx * along / dist;
    b.vy += p.vy - 2 * dy * along / dist;
    b.vx = clamp(b.vx, -MAX_VX, MAX_VX);
    b.vy = clamp(b.vy, -MAX_VY, MAX_VY);
    return true;
  }

  // Walls, ceiling and net. Shared by the live ball and the CPU's prediction.
  // (px, py) is where the ball was before this tick's move. The net post is
  // solid: a ball found inside it is resolved by where it came FROM — onto the
  // top if it was above the post, otherwise back out the side it started on —
  // so neither a fast drop nor a blob shoving it sideways can ever carry it
  // through to the other half. Returns a bitmask: 1 wall, 2 ceiling, 4 net.
  function bounceStatic(b, rng, px, py) {
    var hit = 0;
    if (b.x < WALL_MIN) { b.x = WALL_MIN; b.vx = -b.vx; hit |= 1; }
    else if (b.x > WALL_MAX) { b.x = WALL_MAX; b.vx = -b.vx; hit |= 1; }
    if (b.y > CEIL - BALL_R) { b.y = CEIL - BALL_R; if (b.vy > 0) b.vy = -b.vy; hit |= 2; }
    if (b.x > NET_X - NET_BAND && b.x < NET_X + NET_BAND && b.y < NET_TOP) {
      if (py >= NET_TOP) {
        // Landed on the top: sit it right on the cap (fully outside the post).
        b.y = NET_TOP;
        if (b.vy < 0) b.vy = -b.vy;
        // A ball dropping dead-centre would bounce on the post top forever.
        if (Math.abs(b.vx) < 0.5) b.vx = (rng ? (rng() < 0.5 ? -1 : 1) : (px < NET_X ? -1 : 1));
      } else if (px < NET_X) {
        b.x = NET_X - NET_BAND;
        if (b.vx > 0) b.vx = -b.vx;
      } else {
        b.x = NET_X + NET_BAND;
        if (b.vx < 0) b.vx = -b.vx;
      }
      hit |= 4;
    }
    return hit;
  }

  World.prototype._stepBall = function () {
    var b = this.ball;
    b.px = b.x;
    b.py = b.y;
    b.pspin = b.spin;
    if (this.ballHeld) return null;

    b.vy -= BALL_G;
    if (b.vy < -MAX_VY) b.vy = -MAX_VY;
    b.x += b.vx;
    b.y += b.vy;

    for (var i = 0; i < this.blobs.length; i++) {
      var p = this.blobs[i];
      if (collideBlob(b, p)) {
        var cont = this.tick - p.lastHitTick <= HIT_CHAIN_TICKS;
        p.lastHitTick = this.tick;
        this.events.push({ t: 'hit', seat: p.seat, x: b.x, y: b.y, speed: Math.sqrt(b.vx * b.vx + b.vy * b.vy), live: this.live, cont: cont });
      }
    }

    var hit = bounceStatic(b, this.rng, b.px, b.py);
    if (hit & 1) this.events.push({ t: 'wall', x: b.x, y: b.y });
    if (hit & 2) this.events.push({ t: 'ceil', x: b.x, y: b.y });
    if (hit & 4) this.events.push({ t: 'net', x: b.x, y: b.y, speed: Math.sqrt(b.vx * b.vx + b.vy * b.vy) });

    b.spin += b.vx * 0.012;

    if (b.y <= BALL_R) {
      var impact = -b.vy;
      b.y = BALL_R;
      if (this.live) {
        this.live = false;
        this.blobsLocked = true;
        var scorer = b.x > NET_X ? 0 : 1;
        this.events.push({ t: 'ground', x: b.x, v: impact, point: true });
        b.vy = impact * DEAD_BOUNCE;
        b.vx *= DEAD_FRICTION;
        return { point: true, scorerSeat: scorer, loserSeat: 1 - scorer, x: b.x };
      }
      if (impact > 2) {
        this.events.push({ t: 'ground', x: b.x, v: impact, point: false });
        b.vy = impact * DEAD_BOUNCE;
        b.vx *= DEAD_FRICTION;
      } else {
        b.vy = 0;
        b.vx *= DEAD_ROLL;
        if (Math.abs(b.vx) < 0.05) b.vx = 0;
      }
    }
    return null;
  };

  World.prototype.step = function () {
    this.tick++;
    for (var i = 0; i < this.blobs.length; i++) this._stepBlob(this.blobs[i]);
    return this._stepBall();
  };

  // ---------------- CPU ----------------
  // Plans off a forward simulation of the ball (walls, ceiling and net, no
  // blobs), gets behind where it will come down so the dome knocks it toward
  // the net, and jumps when a leap would meet the ball high on its own side.
  // To be beatable from a phone, its only handicap is sideways movement: it
  // reads the ball and jumps as sharply as ever, but its feet are slow and it
  // hesitates whenever it starts moving or reverses — like a thumb on the
  // phone's ◀ ▶ buttons.
  var AI_THINK_MIN = 3;
  var AI_THINK_MAX = 6;
  var AI_AIM = 16;
  var AI_AIM_NOISE = 14;
  var AI_JUMP_CHANCE = 0.72;
  var AI_SPEED = 0.9;           // sideways speed vs a player's
  var AI_TURN_MIN = 4;          // ticks to start moving / reverse ("thumb lag")
  var AI_TURN_MAX = 6;
  var PLAN_TICKS = 120;

  function predictPath(ball, n) {
    var b = { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy };
    var path = [];
    for (var t = 0; t < n; t++) {
      b.vy -= BALL_G;
      if (b.vy < -MAX_VY) b.vy = -MAX_VY;
      var px = b.x, py = b.y;
      b.x += b.vx;
      b.y += b.vy;
      bounceStatic(b, null, px, py);
      path.push({ x: b.x, y: b.y, vy: b.vy });
      if (b.y <= BALL_R) break;
    }
    return path;
  }

  // Where (and when) the ball centre next comes down through height `y`.
  function landingAt(path, y) {
    for (var t = 0; t < path.length; t++) {
      if (path[t].vy < 0 && path[t].y <= y) return { x: path[t].x, t: t + 1 };
    }
    return path.length ? { x: path[path.length - 1].x, t: path.length } : null;
  }

  // Would a jump started now meet the ball on our side within the next ticks?
  function jumpMeets(p, path, dir) {
    var sy = 0, vy = JUMP_V;
    for (var t = 0; t < Math.min(path.length, 22); t++) {
      vy -= BLOB_G;
      sy += vy;
      if (sy < 0) break;
      var q = path[t];
      if (sideOf(q.x) !== p.seat) continue;
      var dx = 2 * (q.x - p.x);
      var dy = q.y - sy;
      if (dy > 20 && Math.sqrt(dx * dx + dy * dy) < HIT_R + 10 && (q.x - p.x) * dir > 4) return true;
    }
    return false;
  }

  World.prototype.stepBots = function () {
    for (var i = 0; i < this.blobs.length; i++) {
      var p = this.blobs[i];
      if (p.isBot) this._think(p);
    }
  };

  World.prototype._think = function (p) {
    var rng = this.rng;
    if (!p.ai) p.ai = { wait: 0, target: HOME[p.seat], aim: AI_AIM, jumpHold: 0, lastBallSide: -1 };
    var ai = p.ai;
    if (ai.jumpHold > 0) {
      ai.jumpHold--;
      if (ai.jumpHold === 0 || p.vy < 0) { p.held.j = false; ai.jumpHold = 0; }
    }
    if (this.blobsLocked) {
      p.held.l = p.held.r = p.held.j = false;
      ai.jumpHold = 0;
      ai.move = 0;
      ai.turn = 0;
      return;
    }
    if (ai.wait > 0) { ai.wait--; this._steer(p); return; }
    ai.wait = AI_THINK_MIN + Math.floor(rng() * (AI_THINK_MAX - AI_THINK_MIN + 1));

    var dir = p.seat === 0 ? 1 : -1;   // toward the net
    var b = this.ball;
    var path = predictPath(b, PLAN_TICKS);
    var land = landingAt(path, HIT_R - 10);
    var lim = LIMITS[p.seat];
    var landSide = land ? sideOf(land.x) : sideOf(b.x);

    if (land && landSide === p.seat) {
      // Fresh aim noise per incoming ball, not per think.
      if (ai.lastBallSide !== p.seat) ai.aim = clamp(AI_AIM + (rng() * 2 - 1) * AI_AIM_NOISE, 8, 34);
      // Close to the net the dome has to sit further back to lift it over.
      var nearNet = Math.abs(land.x - NET_X) < 110 ? 14 : 0;
      ai.target = clamp(land.x - dir * (ai.aim + nearNet), lim[0], lim[1]);
    } else {
      ai.target = clamp(HOME[p.seat] + dir * 50, lim[0], lim[1]);
    }
    ai.lastBallSide = landSide;

    if (p.y === 0 && sideOf(b.x) === p.seat && jumpMeets(p, path, dir) && rng() < AI_JUMP_CHANCE) {
      p.held.j = true;
      ai.jumpHold = 18;
    }
    this._steer(p);
  };

  // Like a thumb on the phone: letting go is instant, but starting to move or
  // reversing takes a moment before the new direction is pressed.
  World.prototype._steer = function (p) {
    var ai = p.ai;
    var d = ai.target - p.x;
    var want = d < -5 ? -1 : (d > 5 ? 1 : 0);
    if (want === 0) { ai.move = 0; ai.turn = 0; }
    else if (want !== ai.move) {
      if (!ai.turn) {
        ai.move = 0;
        ai.turn = AI_TURN_MIN + Math.floor(this.rng() * (AI_TURN_MAX - AI_TURN_MIN + 1));
      } else if (--ai.turn === 0) {
        ai.move = want;
      }
    }
    p.held.l = ai.move === -1;
    p.held.r = ai.move === 1;
  };

  var api = {
    World: World,
    TICK_HZ: TICK_HZ,
    W: W,
    BLOB_R: BLOB_R,
    BALL_R: BALL_R,
    HIT_R: HIT_R,
    MOVE_SPEED: MOVE_SPEED,
    JUMP_V: JUMP_V,
    BLOB_G: BLOB_G,
    HOP_CUT_V: HOP_CUT_V,
    MIN_HOP_TICKS: MIN_HOP_TICKS,
    BALL_G: BALL_G,
    MAX_VX: MAX_VX,
    MAX_VY: MAX_VY,
    WALL_MIN: WALL_MIN,
    WALL_MAX: WALL_MAX,
    CEIL: CEIL,
    NET_X: NET_X,
    NET_BAND: NET_BAND,
    NET_TOP: NET_TOP,
    NET_DRAW_H: NET_DRAW_H,
    NET_DRAW_HALF: NET_DRAW_HALF,
    LIMITS: LIMITS,
    HOME: HOME,
    AI_TURN_MIN: AI_TURN_MIN,
    SERVE_Y: SERVE_Y,
    predictPath: predictPath,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlobBall = api;
}(typeof window !== 'undefined' ? window : this));
