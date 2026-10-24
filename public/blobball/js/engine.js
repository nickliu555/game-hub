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
  var SQUEEZE_STEP = 12;       // x-units a tick a pinned ball slides out from under a blob

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

  // Team play (3–4 blobs) uses a court 1.5× wider; the net, ceiling, jump and
  // ball physics are unchanged. Each side spawns one blob near the net and one
  // at the back (a lone blob stands mid-court).
  var TEAM_W = 1500;
  var BACK_X = 220;
  var FRONT_GAP = 210;         // front spawn: this far from the net

  // Once a point is decided the ball plays on (dead) and settles on the sand.
  var DEAD_BOUNCE = 0.62;
  var DEAD_FRICTION = 0.82;
  var DEAD_ROLL = 0.985;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Court geometry. 1v1 matches the original constants exactly.
  function makeGeo(teams) {
    var w = teams ? TEAM_W : W;
    var net = w / 2;
    return {
      teams: !!teams,
      W: w,
      NET_X: net,
      WALL_MAX: w - (W - WALL_MAX),
      LIMITS: [[50, net - (NET_X - LIMITS[0][1])], [net + (LIMITS[1][0] - NET_X), w - 50]],
      // kind: 'solo' (1v1), 'mid' (a lone blob in team play), 'back' or 'front'.
      spot: function (side, kind) {
        var x = kind === 'back' ? BACK_X : (kind === 'front' ? net - FRONT_GAP : (teams ? net / 2 : HOME[0]));
        return side === 0 ? x : w - x;
      },
    };
  }
  var GEO_1V1 = makeGeo(false);

  function sideOf(x, geo) { return x < (geo || GEO_1V1).NET_X ? 0 : 1; }

  function makeBlob(r, seat, i) {
    return {
      id: r.id,
      name: r.name,
      i: i,
      seat: seat,
      color: r.color,
      isBot: !!r.isBot,
      connected: r.connected !== false,
      x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0,
      held: { l: false, r: false, j: false },
      jumpBuf: 0,
      airTicks: 0,
      lastHitTick: -99,
      ai: null,
    };
  }

  // opts.roster: [{ id, name, seat (0 left / 1 right), slot, color, isBot }].
  // Entries without a seat take sides by index. opts.teams allows two blobs a
  // side on the wide court; otherwise it's one blob a side.
  function World(opts) {
    var roster = (opts && opts.roster) || [];
    this.teams = !!(opts && opts.teams);
    this.geo = makeGeo(this.teams);
    var per = this.teams ? 2 : 1;
    var picked = [[], []];
    for (var k = 0; k < roster.length; k++) {
      var r = roster[k];
      var side = (r.seat === 0 || r.seat === 1) ? r.seat : (k % 2);
      if (picked[side].length < per) picked[side].push(r);
    }
    this.blobs = [];
    this.sideBlobs = [[], []];
    for (var s = 0; s < 2; s++) {
      if (!picked[s].length) picked[s].push({ id: 'empty-' + s, name: '', isBot: true });
      picked[s].sort(function (a, b) { return (a.slot | 0) - (b.slot | 0); });
      for (var m = 0; m < picked[s].length; m++) {
        var blob = makeBlob(picked[s][m], s, this.blobs.length);
        this.blobs.push(blob);
        this.sideBlobs[s].push(blob);
      }
    }
    // Serve rotation: whose turn it is on each team, and who stands at the back.
    this.serveTurn = [-1, -1];
    this.backIdx = [this.sideBlobs[0][0].i, this.sideBlobs[1][0].i];
    this.serverIdx = this.sideBlobs[0][0].i;
    for (var q = 0; q < this.blobs.length; q++) {
      var b0 = this.blobs[q];
      b0.x = b0.px = this.spotOf(b0);
    }
    var sx = this.spotOf(this.blobs[0]);
    this.ball = { x: sx, y: SERVE_Y, vx: 0, vy: 0, px: sx, py: SERVE_Y, spin: 0, pspin: 0, sq: this.blobs.map(function () { return false; }) };
    this.events = [];
    this.blobsLocked = true;   // inputs ignored (countdown, serve hold, dead ball)
    this.ballHeld = true;      // ball hovers in place (serve hold)
    this.live = false;         // a ground touch scores
    // Has the ball been touched since the serve? The server's contacts only
    // count once they have moved left/right: a ball left bouncing on their head
    // (waiting, or just jumping in place) isn't a touch yet.
    this.touched = false;
    this.serverMoved = false;
    this.serveSeat = 0;
    this.tick = 0;
    this.rng = (opts && opts.rng) || Math.random;
  }

  World.prototype.byId = function (id) {
    for (var i = 0; i < this.blobs.length; i++) if (this.blobs[i].id === id) return this.blobs[i];
    return null;
  };

  // Where a blob stands for a serve: 1v1 home, or front/back (mid if alone).
  World.prototype.spotOf = function (p) {
    if (!this.teams) return this.geo.spot(p.seat, 'solo');
    if (this.sideBlobs[p.seat].length < 2) return this.geo.spot(p.seat, 'mid');
    return this.geo.spot(p.seat, p.i === this.backIdx[p.seat] ? 'back' : 'front');
  };

  World.prototype.server = function () { return this.blobs[this.serverIdx] || null; };

  // Reset every blob home and hang the ball above the server. Nothing moves
  // until release(). `again` re-serves with the same player (kick-off after the
  // countdown, or a whiffed serve); otherwise the team's next player serves.
  // The server stands at the back with any teammate up front, so a team swaps
  // front/back exactly when its serve passes to the other teammate.
  World.prototype.setupServe = function (seat, again) {
    this.serveSeat = seat === 1 ? 1 : 0;
    var team = this.sideBlobs[this.serveSeat];
    if (!again || this.serveTurn[this.serveSeat] < 0) {
      this.serveTurn[this.serveSeat] = (this.serveTurn[this.serveSeat] + 1) % team.length;
    }
    var server = team[this.serveTurn[this.serveSeat]];
    this.serverIdx = server.i;
    this.backIdx[this.serveSeat] = server.i;
    for (var i = 0; i < this.blobs.length; i++) {
      var p = this.blobs[i];
      p.x = p.px = this.spotOf(p);
      p.y = p.py = 0;
      p.vx = p.vy = 0;
      p.jumpBuf = 0;
      p.airTicks = 0;
      p.lastHitTick = -99;
      if (p.ai) { p.ai.wait = 0; p.ai.lastBallSide = -1; p.ai.move = 0; p.ai.turn = 0; }
    }
    var b = this.ball;
    b.x = b.px = server.x;
    b.y = b.py = SERVE_Y;
    b.vx = b.vy = 0;
    for (var k = 0; k < b.sq.length; k++) b.sq[k] = false;
    this.blobsLocked = true;
    this.ballHeld = true;
    this.live = false;
    this.touched = false;
    this.serverMoved = false;
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
    if (p.vx !== 0 && this.live && p.i === this.serverIdx) this.serverMoved = true;
    if (!locked && p.y === 0 && (j || p.jumpBuf > 0)) {
      p.vy = JUMP_V;
      p.airTicks = 0;
      p.jumpBuf = 0;
      this.events.push({ t: 'jump', seat: p.seat, i: p.i });
    }
    if (p.jumpBuf > 0) p.jumpBuf--;
    if (!j && p.vy > HOP_CUT_V && p.airTicks >= MIN_HOP_TICKS) p.vy = HOP_CUT_V;

    if (p.vx !== 0) {
      var lim = this.geo.LIMITS[p.seat];
      p.x = clamp(p.x + p.vx, lim[0], lim[1]);
    }
    if (p.vy !== 0 || p.y > 0) {
      p.vy -= BLOB_G;
      p.y += p.vy;
      p.airTicks++;
      if (p.y <= 0) {
        this.events.push({ t: 'land', seat: p.seat, i: p.i, v: -p.vy });
        p.y = 0;
        p.vy = 0;
      }
    }
  };

  // Teammates bump: their domes (radius 50 across, iso units) can't overlap, so
  // they shove each other sideways — a runner pushes a standing teammate along,
  // and one coming down on the other's head slides off. The shove per tick is
  // capped so a landing slides apart instead of snapping.
  var BUMP_STEP = 8;
  World.prototype._bump = function () {
    var half = BLOB_R / 2;
    for (var s = 0; s < 2; s++) {
      var team = this.sideBlobs[s];
      if (team.length < 2) continue;
      var p = team[0], q = team[1];
      var dy = Math.abs(q.y - p.y) / 2;
      if (dy >= half) continue;
      var need = half + Math.sqrt(half * half - dy * dy);
      var dx = q.x - p.x;
      if (Math.abs(dx) >= need) continue;
      var dir = dx > 0 ? 1 : (dx < 0 ? -1 : (q.px > p.px ? 1 : (q.px < p.px ? -1 : (q.i > p.i ? 1 : -1))));
      var push = Math.min((need - Math.abs(dx)) / 2, BUMP_STEP);
      var lim = this.geo.LIMITS[s];
      var np = clamp(p.x - dir * push, lim[0], lim[1]);
      var nq = clamp(q.x + dir * push, lim[0], lim[1]);
      // One pinned against a limit: the other takes the whole shove.
      var gap = Math.abs(dx) + 2 * push;
      if (np !== p.x - dir * push) nq = clamp(np + dir * gap, lim[0], lim[1]);
      else if (nq !== q.x + dir * push) np = clamp(nq - dir * gap, lim[0], lim[1]);
      p.x = np;
      q.x = nq;
    }
  };

  // The original's ball/blob bounce: the ball reflects off the dome AND picks
  // up the blob's own velocity, which is what makes spikes and lobs work.
  function collideBlob(b, p, geo) {
    var dx = 2 * (b.x - p.x);
    var dy = b.y - p.y;
    // A ball that came from under the blob meets its flat base, never the dome:
    // resolving it against the dome would pop it straight up through the blob.
    if (b.py - p.py < 0 || b.sq[p.i]) return collideUnderside(b, p, dx, dy, geo);
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

  // The blob's flat base (and its rim, where the base meets the dome) is solid
  // from below. A ball the blob comes down on with no room beneath (it's on the
  // sand) squirts out sideways a few units a tick until it's clear — `b.sq`
  // remembers that in-progress squeeze so the dome can't grab it half-way.
  function collideUnderside(b, p, dx, dy, geo) {
    var wasSq = b.sq[p.i];
    var sign = dx < 0 ? -1 : 1;
    if (Math.abs(dx) >= HIT_R || dy <= -BALL_R) { b.sq[p.i] = false; return false; }
    var nx = 0, ny = -1, tx = dx, ty = -BALL_R;
    if (!wasSq && Math.abs(dx) > BLOB_R) {
      var cx = dx - sign * BLOB_R, cy = Math.min(dy, 0);
      var d = Math.sqrt(cx * cx + cy * cy);
      if (d >= BALL_R) return false;
      if (d < 1e-6) { nx = sign; ny = 0; } else { nx = cx / d; ny = cy / d; }
      tx = sign * BLOB_R + nx * BALL_R;
      ty = ny * BALL_R;
    }

    if (p.y + ty < BALL_R) {
      var lo = b.x < geo.NET_X ? WALL_MIN : geo.NET_X + NET_BAND;
      var hi = b.x < geo.NET_X ? geo.NET_X - NET_BAND : geo.WALL_MAX;
      var out = p.x + sign * HIT_R / 2;
      if (out < lo || out > hi) { sign = -sign; out = p.x + sign * HIT_R / 2; }
      // Measured from where the ball started the tick, so its own drift doesn't add to the slide.
      var gap = out - b.px;
      b.x = b.px + clamp(gap, -SQUEEZE_STEP, SQUEEZE_STEP);
      b.y = BALL_R;
      b.sq[p.i] = Math.abs(gap) > SQUEEZE_STEP;
      b.vx = b.sq[p.i] ? 0 : clamp(p.vx + sign * SQUEEZE_STEP, -MAX_VX, MAX_VX);
      if (b.vy > 0) b.vy = 0;
      return !wasSq;
    }

    b.sq[p.i] = false;
    b.x = p.x + tx / 2;
    b.y = p.y + ty;
    var along = nx * (b.vx - p.vx) + ny * (b.vy - p.vy);
    if (along >= 0) return false;
    b.vx += p.vx - 2 * nx * along;
    b.vy += p.vy - 2 * ny * along;
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
  function bounceStatic(b, rng, px, py, geo) {
    var NET_X = geo.NET_X;
    var hit = 0;
    if (b.x < WALL_MIN) { b.x = WALL_MIN; b.vx = -b.vx; hit |= 1; }
    else if (b.x > geo.WALL_MAX) { b.x = geo.WALL_MAX; b.vx = -b.vx; hit |= 1; }
    if (b.y > CEIL - BALL_R) { b.y = CEIL - BALL_R; if (b.vy > 0) b.vy = -b.vy; hit |= 2; }
    // The post's faces are checked along the ball's whole path this tick, not
    // just where it ends: a ball shoved up a face can't clip the top corner.
    var L = NET_X - NET_BAND, R = NET_X + NET_BAND;
    if (px <= L && b.x > L && b.x !== px && py + (b.y - py) * (L - px) / (b.x - px) < NET_TOP) {
      b.x = L;
      if (b.vx > 0) b.vx = -b.vx;
      hit |= 4;
    } else if (px >= R && b.x < R && b.x !== px && py + (b.y - py) * (R - px) / (b.x - px) < NET_TOP) {
      b.x = R;
      if (b.vx < 0) b.vx = -b.vx;
      hit |= 4;
    } else if (b.x > L && b.x < R && b.y < NET_TOP) {
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

    // Push the ball out of the post before each blob sees it — and again after
    // every touch, since a blob pressed against the net can shove it back in —
    // so no blob can ever touch the ball through the post.
    var geo = this.geo;
    var hit = bounceStatic(b, this.rng, b.px, b.py, geo);
    for (var i = 0; i < this.blobs.length; i++) {
      var p = this.blobs[i];
      // collideBlob can move the ball even when it doesn't count as a hit, so
      // re-resolve the post after every blob, not just after a hit.
      var touched = collideBlob(b, p, geo);
      hit |= bounceStatic(b, this.rng, b.px, b.py, geo);
      if (touched) {
        var cont = this.tick - p.lastHitTick <= HIT_CHAIN_TICKS;
        p.lastHitTick = this.tick;
        if (p.i !== this.serverIdx || this.serverMoved) this.touched = true;
        this.events.push({ t: 'hit', seat: p.seat, i: p.i, x: b.x, y: b.y, speed: Math.sqrt(b.vx * b.vx + b.vy * b.vy), live: this.live, cont: cont });
      }
    }
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
        // A serve nobody touched (the server whiffed it completely, or only
        // ever bounced it on their head without moving) doesn't count: no
        // point, the same player serves again. Once it's been touched it's
        // live and the landing scores as normal.
        if (!this.touched) {
          this.events.push({ t: 'ground', x: b.x, v: impact, point: false, miss: true });
          b.vy = impact * DEAD_BOUNCE;
          b.vx *= DEAD_FRICTION;
          return { point: false, missedServe: true, serverSeat: this.serveSeat, serverIdx: this.serverIdx, x: b.x };
        }
        var scorer = b.x > geo.NET_X ? 0 : 1;
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
    this._bump();
    return this._stepBall();
  };

  // ---------------- CPU ----------------
  // Plans off a forward simulation of the ball (walls, ceiling and net, no
  // blobs), gets behind where it will come down so the dome knocks it toward
  // the net, and jumps when a leap would meet the ball high on its own side.
  // To be beatable from a phone its feet are slow and it hesitates whenever it
  // starts moving or reverses — like a thumb on the phone's ◀ ▶ buttons.
  var AI_THINK_MIN = 3;
  var AI_THINK_MAX = 6;
  var AI_AIM = 16;
  var AI_AIM_NOISE = 14;
  var AI_JUMP_CHANCE = 0.72;
  var AI_SPEED = 0.9;           // sideways speed vs a player's
  var AI_TURN_MIN = 7;          // ticks to start moving / reverse ("thumb lag")
  var AI_TURN_MAX = 10;
  var PLAN_TICKS = 120;
  // Only jump for a meeting within the jump's rise (~0.3 s), and only once in
  // position. Looking further ahead had it leap early — or mid-run — and the
  // ball (deep serves especially) passed under it as it came back down.
  var JUMP_LOOK = 14;
  var JUMP_IN_PLACE = 24;

  function predictPath(ball, n, geo) {
    geo = geo || GEO_1V1;
    var b = { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy };
    var path = [];
    for (var t = 0; t < n; t++) {
      b.vy -= BALL_G;
      if (b.vy < -MAX_VY) b.vy = -MAX_VY;
      var px = b.x, py = b.y;
      b.x += b.vx;
      b.y += b.vy;
      bounceStatic(b, null, px, py, geo);
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
  function jumpMeets(p, path, dir, geo) {
    var sy = 0, vy = JUMP_V;
    for (var t = 0; t < Math.min(path.length, JUMP_LOOK); t++) {
      vy -= BLOB_G;
      sy += vy;
      if (sy < 0) break;
      var q = path[t];
      if (sideOf(q.x, geo) !== p.seat) continue;
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
    if (!p.ai) p.ai = { wait: 0, target: this.spotOf(p), aim: AI_AIM, jumpHold: 0, lastBallSide: -1 };
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
    var geo = this.geo;
    var path = predictPath(b, PLAN_TICKS, geo);
    var land = landingAt(path, HIT_R - 10);
    var lim = geo.LIMITS[p.seat];
    var landSide = land ? sideOf(land.x, geo) : sideOf(b.x, geo);
    var home = this.spotOf(p);
    var team = this.sideBlobs[p.seat];
    var mate = team.length > 1 ? (team[0] === p ? team[1] : team[0]) : null;
    // With a teammate the half splits between the front and back spots: a CPU
    // only goes for balls coming down in its own zone, and otherwise holds its
    // spot so the two don't pile onto the same ball.
    var mine = true;
    if (mate && land) {
      var split = (home + this.spotOf(mate)) / 2;
      var front = Math.abs(home - geo.NET_X) < Math.abs(split - geo.NET_X);
      mine = (Math.abs(land.x - geo.NET_X) < Math.abs(split - geo.NET_X)) === front;
    }

    if (land && landSide === p.seat && mine) {
      // Fresh aim noise per incoming ball, not per think.
      if (ai.lastBallSide !== p.seat) ai.aim = clamp(AI_AIM + (rng() * 2 - 1) * AI_AIM_NOISE, 8, 34);
      // Close to the net the dome has to sit further back to lift it over.
      var nearNet = Math.abs(land.x - geo.NET_X) < 110 ? 14 : 0;
      ai.target = clamp(land.x - dir * (ai.aim + nearNet), lim[0], lim[1]);
    } else {
      ai.target = clamp(home + (mate ? 0 : dir * 50), lim[0], lim[1]);
    }
    ai.lastBallSide = landSide;

    var inPlace = Math.abs(ai.target - p.x) < JUMP_IN_PLACE;
    if (p.y === 0 && inPlace && sideOf(b.x, geo) === p.seat && jumpMeets(p, path, dir, geo) && rng() < AI_JUMP_CHANCE) {
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
    TEAM_W: TEAM_W,
    makeGeo: makeGeo,
    AI_TURN_MIN: AI_TURN_MIN,
    SERVE_Y: SERVE_Y,
    predictPath: predictPath,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlobBall = api;
}(typeof window !== 'undefined' ? window : this));
