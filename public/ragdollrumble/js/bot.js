/* Ragdoll Rumble — CPU fighters.
 *
 * A bot reads the shared World and drives its fighter through exactly the same
 * input path a phone uses (stick + jump/action presses), so it can't do
 * anything a human couldn't. Difficulty changes how fast it reacts, how well
 * it recovers to the stage, how often it charges smashes and how readily it
 * dodges. Runs on the host only.
 */
(function (global) {
  'use strict';

  var NM = global.RagdollRumble;

  var DIFF = {
    easy:   { react: 0.38, aggro: 0.45, recover: 0.75, charge: 0.08, dodge: 0.15, duck: 0,    items: 0.4, range: 1.15, spike: 0.1, guard: 0.3 },
    normal: { react: 0.22, aggro: 0.75, recover: 0.85, charge: 0.22, dodge: 0.45, duck: 0.3,  items: 0.7, range: 1.25, spike: 0.4, guard: 0.65 },
    hard:   { react: 0.12, aggro: 0.95, recover: 1.0,  charge: 0.35, dodge: 0.8,  duck: 0.55, items: 0.9, range: 1.3,  spike: 0.8, guard: 0.95 },
  };

  function sign(v) { return v < 0 ? -1 : 1; }

  /** rng is optional (defaults to Math.random) so tests can replay a fight. */
  function Bot(id, difficulty, rng) {
    this.id = id;
    this.cfg = DIFF[difficulty] || DIFF.normal;
    this.rnd = rng || Math.random;
    this.think = this.rnd() * 0.3;
    this.jp = 0; this.ap = 0;
    this.x = 0; this.y = 0;
    this.jumpHeld = false; this.actHeld = false;
    this.jumpHold = 0; this.actHold = 0;
    this.targetId = null;
    this.retarget = 0;
    this.wander = 0;
    this.guardId = null; this.guardT = 0;
    this.egId = null; this.egT = 0; this.egGo = false;   // edge-guard decision (sticky)
    this.hop = null;        // a platform hop in flight: { span, dir, t }
    this.guardOn = null;    // chasing down someone we knocked off: { id, go, until }
  }

  Bot.prototype._pressJump = function (hold) {
    this.jp = (this.jp + 1) & 255;
    this.jumpHeld = true;
    this.jumpHold = hold || 0.25;
  };
  Bot.prototype._pressAction = function (hold) {
    this.ap = (this.ap + 1) & 255;
    this.actHeld = true;
    this.actHold = hold || 0.05;
  };

  Bot.prototype.update = function (world, dt) {
    var p = world.playerById(this.id);
    if (!p || !p.alive || !p.parts) return;
    if (this.jumpHold > 0) { this.jumpHold -= dt; if (this.jumpHold <= 0) this.jumpHeld = false; }
    if (this.actHold > 0) { this.actHold -= dt; if (this.actHold <= 0) this.actHeld = false; }
    this.think -= dt;
    this.retarget -= dt;
    this.guardT = Math.max(0, this.guardT - dt);
    this.egT = Math.max(0, this.egT - dt);
    if (this.think <= 0) {
      this.think = this.cfg.react * (0.7 + this.rnd() * 0.6);
      this._decide(world, p);
    }
    world.setInput(this.id, this.x, this.y, (this.jumpHeld ? 1 : 0) | (this.actHeld ? 2 : 0), this.jp, this.ap);
  };

  /** Is there something to stand on below (x, footY)? */
  function groundBelow(spans, x, footY, margin) {
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (x >= s.x0 - margin && x <= s.x1 + margin && s.y >= footY - 0.6) return s;
    }
    return null;
  }

  /** The closest place to land: { x, y } of a walkable surface. */
  function nearestSpan(spans, x, footY) {
    var best = null, bd = 1e9;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      // A solid block overhead can't be reached from below; a plank can.
      if (!s.oneWay && s.y < footY - 0.6) continue;
      var cx = Math.max(s.x0 + 1, Math.min(s.x1 - 1, x));
      var d = Math.abs(cx - x) + Math.max(0, footY - s.y) * 0.3;
      if (d < bd) { bd = d; best = { x: cx, y: s.y }; }
    }
    return best || { x: 0, y: 0 };
  }
  function nearestSpanX(spans, x, footY) { return nearestSpan(spans, x, footY).x; }

  // ---------------- Platform navigation ----------------
  /** The surface someone with feet at (x, footY) is standing on (or just above). */
  function spanUnder(spans, x, footY) {
    var best = null;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (x < s.x0 - 0.15 || x > s.x1 + 0.15 || s.y < footY - 0.6) continue;
      if (!best || s.y < best.y) best = s;
    }
    return best;
  }
  function sameSpan(a, b) { return a && b && a.x0 === b.x0 && a.x1 === b.x1 && a.y === b.y; }
  function droppable(s) { return s.oneWay && !s.crumbly; }
  /** Walk straight from one to the other (touching, same level — e.g. bridge tiles). */
  function joined(a, b) { return Math.abs(a.y - b.y) < 0.3 && Math.max(a.x0, b.x0) <= Math.min(a.x1, b.x1) + 0.3; }
  /** Can a fighter standing on a get onto b with a walk, hop, jump (+air jumps) or drop? */
  function canReach(a, b) {
    if (b.shaky) return false;                  // a bridge tile about to give way
    if (joined(a, b)) return true;
    var lap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    var rise = a.y - b.y;                       // > 0: b is higher
    if (lap > 0.8) return rise > 0 ? rise < 7 : droppable(a);
    var gap = Math.max(b.x0 - a.x1, a.x0 - b.x1, 0);
    return gap < 7 && rise < 5;
  }
  /** First surface on the way from span `from` to span `to` (BFS over hops), or null. */
  function nextSpan(spans, from, to) {
    if (!from || !to || sameSpan(from, to)) return null;
    var seen = [from], queue = [{ s: from, first: null }];
    while (queue.length) {
      var cur = queue.shift();
      for (var i = 0; i < spans.length; i++) {
        var n = spans[i];
        if (seen.some(function (v) { return sameSpan(v, n); }) || !canReach(cur.s, n)) continue;
        var first = cur.first || n;
        if (sameSpan(n, to)) return first;
        seen.push(n);
        queue.push({ s: n, first: first });
      }
    }
    return null;
  }

  /**
   * Take one step toward span `to` (and point gx on it): walk along joined
   * surfaces, hop gaps, jump up to planks, drop through them. Returns false if
   * there's nothing to do (already there, or no way across).
   */
  Bot.prototype._navTo = function (world, p, me, spans, foot, to, gx) {
    var from = spanUnder(spans, me.x, foot);
    if (!p.grounded || !from || !to || sameSpan(from, to)) return false;
    var n = nextSpan(spans, from, to);
    if (!n) return false;
    if (joined(from, n)) { this.x = sign((sameSpan(n, to) ? gx : (n.x0 + n.x1) / 2) - me.x); return true; }
    var lo = Math.max(from.x0, n.x0), hi = Math.min(from.x1, n.x1);
    if (hi - lo > 0.8) {
      // Stacked: jump straight up to it, or drop through the plank we're on.
      var px = Math.max(lo + 0.6, Math.min(hi - 0.6, me.x));
      if (Math.abs(px - me.x) > 0.6) { this.x = sign(px - me.x); return true; }
      if (n.y < from.y) { this._pressJump(0.35); this.hop = { span: n, dir: 0, t: world.time }; }
      else { this.y = 1; this._pressJump(0.1); }
      this.x = 0;
      this.think = 0.05;
      return true;
    }
    // Side by side: run at the ledge and hop across.
    var dir = n.x0 >= from.x1 - 0.01 ? 1 : -1;
    var edge = dir > 0 ? from.x1 : from.x0;
    var toEdge = (edge - me.x) * dir;
    this.x = dir;
    // Think again before running out of floor (slow thinkers would walk off).
    this.think = Math.min(this.think, Math.max(0.05, (toEdge - 1.5) / 9));
    if (toEdge < 1.5) {
      var rise = from.y - n.y, gap = Math.max(n.x0 - from.x1, from.x0 - n.x1, 0);
      // A low hop where it'll do (softer landing — a full jump cracks bridge tiles).
      this._pressJump((rise < -0.8 && gap < 1.5) || (Math.abs(rise) < 0.5 && gap < 3.2) ? 0.13 : 0.32);
      this.hop = { span: n, dir: dir, t: world.time };
      this.think = 0.05;
    }
    return true;
  };

  /** Mid-hop: steer for the landing, spending air jumps if we'd fall short. */
  Bot.prototype._flyHop = function (world, p, me, foot, spans) {
    var h = this.hop, n = h.span;
    if (p.grounded && world.time - h.t > 0.15) { this.hop = null; return false; }
    if (world.time - h.t > 3 || foot > n.y + 3 || p.tumble || p.grabbedBy) { this.hop = null; return false; }
    // The tile we were hopping to crumbled (or is about to): bail out and recover.
    var still = null;
    for (var i = 0; i < spans.length; i++) if (sameSpan(spans[i], n)) still = spans[i];
    if (!still || still.shaky) { this.hop = null; return false; }
    if (p.grounded) return false;
    // Land a little way onto it — and brake, so a narrow ledge isn't overshot.
    var into = Math.min(1.3, (n.x1 - n.x0) / 2);
    var lx = Math.max(n.x0 + into, Math.min(n.x1 - into, me.x));
    this.x = Math.max(-1, Math.min(1, (lx - me.x) * 1.2 - me.vx * 0.15));
    // Short of it and sinking toward its level: spend an air jump.
    var over = me.x > n.x0 + 0.2 && me.x < n.x1 - 0.2;
    if (me.vy > -1.5 && p.airJumps > 0 && (over ? foot > n.y + 0.5 : foot > n.y - 0.4)) this._pressJump(0.3);
    this.think = 0.05;
    return true;
  };

  /** In the air beside someone (with ground under us): punch them. */
  Bot.prototype._airAttack = function (world, p, me) {
    if (p.attack || p.charge >= 0 || p.pending || (p.item && p.item.type)) return false;
    for (var i = 0; i < world.players.length; i++) {
      var q = world.players[i];
      if (q === p || !q.alive || !q.parts || q.grabbedBy) continue;
      var qp = world.posOf(q), dx = qp.x - me.x, dy = qp.y - me.y;
      if (Math.abs(dx) < 1.4 && dy > -1.5 && dy < 0.7) {
        if (this.rnd() > this.cfg.aggro) return false;
        this.x = sign(dx); this.y = dy < -0.7 ? -1 : 0;
        this._pressAction(0.04);
        this.think = 0.15;
        return true;
      }
    }
    return false;
  };

  /**
   * Knocked someone off the stage? Don't lose interest: head for the ledge
   * they're trying to get back to and contest it — knock them back out as
   * they come in, jump up to meet them, throw things at them. (Diving off to
   * spike them is _edgeGuard's job.) Decided once per trip off the stage.
   */
  Bot.prototype._guard = function (world, p, me, spans, foot) {
    if (!p.grounded || p.charge >= 0) return false;
    var g = this.guardOn, q = g && world.playerById(g.id), i;
    var airborne = function (v) { return v && v.alive && v.parts && !v.grounded && !v.grabbedBy; };
    var off = function (v) {
      if (!airborne(v)) return false;
      var vp = world.posOf(v);
      return !groundBelow(spans, vp.x, vp.y + NM.STAND_H, 0);
    };
    // Keep at it until they've actually landed (drifting back over the stage
    // is exactly when they're easiest to hit).
    if (g && (!airborne(q) || world.time > g.until)) { this.guardOn = g = q = null; }
    if (!g) {
      for (i = 0; i < world.players.length; i++) {
        var v = world.players[i];
        if (v === p || v.lastHitBy !== p.id || !off(v)) continue;
        g = this.guardOn = { id: v.id, go: this.rnd() < this.cfg.guard, until: world.time + 7 };
        q = v;
        break;
      }
    }
    if (!g || !g.go || !q) return false;

    // The ledge they'll come back to.
    var qp = world.posOf(q), qfoot = qp.y + NM.STAND_H, L = null, ex = 0, bd = 1e9;
    for (i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.y < qfoot - 6) continue;
      var e = Math.abs(qp.x - s.x0) < Math.abs(qp.x - s.x1) ? s.x0 : s.x1;
      var d = Math.abs(qp.x - e) + Math.abs(qfoot - s.y) * 0.5 + (s.oneWay ? 1.5 : 0);
      if (d < bd) { bd = d; L = s; ex = e; }
    }
    if (!L) return false;
    var side = ex === L.x1 ? 1 : -1;
    var post = ex - side * 0.8;
    var dx = qp.x - me.x, dy = qp.y - me.y, adx = Math.abs(dx);
    if (adx < 4) this.think = Math.min(this.think, this.cfg.react * 0.6);

    // Throw what we're holding at them.
    if (p.item && p.item.type !== 'bat' && adx < 10 && Math.abs(dy) < 6) {
      this.x = sign(dx); this.y = dy < -1.5 ? -0.7 : (dy > 1.5 ? 0.7 : 0);
      this._pressAction(0.05);
      return true;
    }
    if (!sameSpan(spanUnder(spans, me.x, foot), L)) {
      if (this._navTo(world, p, me, spans, foot, L, post)) return true;
      return false;
    }
    // Where they'll be when a punch thrown now arrives.
    var lead = 0.15, G = NM.G || 30;
    var fx = qp.x + qp.vx * lead, fy = qp.y + qp.vy * lead + 0.5 * G * lead * lead;
    var rdx = fx - me.x, rdy = fy - me.y, reach = p.item && p.item.type === 'bat' ? 1.9 : 1.45;
    if (Math.abs(rdx) < reach && rdy > -2.1 && rdy < 0.9) {
      if (rdy < -0.6) { this.x = Math.abs(rdx) < 0.5 ? 0 : sign(rdx); this.y = -1; }   // swat them out of the air
      else this.x = sign(rdx);                                                       // level: knock them back out
      if (!p.item && rdy > -0.6 && q.dmg > 60 && this.rnd() < this.cfg.charge) { this._pressAction(0.3); this.think = this.actHold + 0.05; }
      else this._pressAction(0.04);
      this.edgeOk = true;
      return true;
    }
    // Clinging to the wall just below the lip: punch down-and-out at them.
    if (adx < 1.7 && dy > 0.3 && dy < 1.9 && sign(dx) === side) {
      this.x = side * 0.7; this.y = 0.7;
      this._pressAction(0.04);
      this.edgeOk = true;
      return true;
    }
    // Dropping back in from above: get under where they'll land, a step inside
    // them, so the punch knocks them back the way they came.
    var standY = L.y - NM.STAND_H, drop = standY - qp.y;
    if (drop > 0.5) {
      var tf = (qp.vy + Math.sqrt(Math.max(0, qp.vy * qp.vy + 2 * G * drop))) / G;
      var landX = qp.x + qp.vx * tf;
      // (They'll steer for the lip, so don't wander far from it.)
      var inward = Math.max(0.8, Math.min(2.2, (ex - landX) * side + 1.0));
      post = Math.max(L.x0 + 0.6, Math.min(L.x1 - 0.6, ex - side * inward));
    }
    // Otherwise hold the ledge (right at the lip — we mean to be there).
    this.x = Math.abs(post - me.x) > 0.3 ? sign(post - me.x) * (Math.abs(post - me.x) < 1 ? 0.5 : 1) : 0;
    this.edgeOk = true;
    return true;
  };

  /** In the air with a rival just below: stick straight down + punch = spike. */
  Bot.prototype._trySpike = function (world, p, me) {
    if (p.attack || p.charge >= 0 || p.pending || (p.item && p.item.type)) return false;
    for (var i = 0; i < world.players.length; i++) {
      var q = world.players[i];
      if (q === p || !q.alive || !q.parts || q.grounded || q.grabbedBy) continue;
      var qp = world.posOf(q);
      // It has to land with the foot — them a leg's length below — to spike.
      // Closing fast, that window flies by, so check where they'll be over
      // the whole time the stomp might land.
      var hit = false, rx = 0;
      for (var lead = 0.06; lead <= 0.221 && !hit; lead += 0.02) {
        rx = (qp.x + qp.vx * lead) - (me.x + me.vx * lead);
        var dy = (qp.y + qp.vy * lead) - (me.y + me.vy * lead);
        hit = Math.abs(rx) < 0.6 && dy > 1.9 && dy < 2.6;
      }
      var gap = qp.y - me.y;
      if (!hit && gap > 1 && gap < 4.5 && Math.abs(qp.x - me.x) < 1.5) this.think = Math.min(this.think, 0.03);
      if (hit) {
        if (this.rnd() >= this.cfg.spike) return false;
        // A small sideways nudge still aims straight down (stick within ±22°).
        this.x = Math.max(-0.35, Math.min(0.35, rx)); this.y = 1;
        this._pressAction(0.04);
        this.think = 0.18;
        return true;
      }
    }
    return false;
  };

  /**
   * Standing near a ledge while a rival recovers below it: walk to the edge,
   * then hop out over them so _trySpike can drive them down.
   */
  Bot.prototype._edgeGuard = function (world, p, me, spans, foot) {
    if (!p.grounded || (p.item && p.item.type) || p.charge >= 0) return false;
    var s = groundBelow(spans, me.x, foot, 0);
    if (!s || s.oneWay) return false;
    for (var i = 0; i < world.players.length; i++) {
      var q = world.players[i];
      if (q === p || !q.alive || !q.parts || q.grounded || q.grabbedBy) continue;
      var qp = world.posOf(q), qfoot = qp.y + NM.STAND_H;
      // (No margin: someone clinging to the side of the stage is off it.)
      if (groundBelow(spans, qp.x, qfoot, 0)) continue;
      var side = qp.x > s.x1 ? 1 : qp.x < s.x0 ? -1 : 0;
      if (!side) continue;
      var edge = side > 0 ? s.x1 : s.x0;
      var beyond = (qp.x - edge) * side, below = qfoot - s.y, dist = (edge - me.x) * side;
      if (beyond > 3.5 || below < 0.3 || below > 11 || dist < 0 || dist > 5) continue;
      // Decide once per recovery whether to go for it, rather than dithering.
      if (this.egId !== q.id || this.egT <= 0) { this.egId = q.id; this.egT = 1.5; this.egGo = this.rnd() < this.cfg.spike; }
      if (!this.egGo) return false;
      // (_decide stops a walk about 1.3m short of the ledge.)
      if (dist > 1.6) { this.x = side; return true; }
      // Hold the ledge until they're a stomp's distance below, then go —
      // dropping onto them as they rise, the foot meets them.
      if (beyond < 2 && below > 2.3 && below < 6) {
        this.x = side;
        this._pressJump(0.02);   // a tiny hop off the ledge, then drop onto them
        this.guardId = q.id; this.guardT = 0.8;
        this.think = 0.06;
        return true;
      }
      this.x = 0;
      return true;
    }
    return false;
  };

  /** Decide, then refuse to walk off a ledge unless the move includes a jump. */
  Bot.prototype._decide = function (world, p) {
    var jp0 = this.jp;
    this.edgeOk = false;
    this._choose(world, p);
    if (!p.grounded || this.x === 0 || this.jp !== jp0 || this.edgeOk) return;
    var me = world.posOf(p);
    if (!groundBelow(world.groundSpans(), me.x + sign(this.x) * 1.3, me.y + NM.STAND_H, 0)) this.x = 0;
  };

  Bot.prototype._choose = function (world, p) {
    var cfg = this.cfg, me = world.posOf(p);
    var foot = me.y + NM.STAND_H;
    var spans = world.groundSpans();
    this.x = 0; this.y = 0;

    // ---- Being carried: mash out ----
    if (p.grabbedBy) {
      this.think = 0.08 + (1 - cfg.aggro) * 0.12;
      this._pressAction(0.04);
      return;
    }

    // ---- Carrying someone: throw them toward the nearer edge ----
    // Facing is locked while carrying, so pushing toward an edge behind you is
    // a (stronger) back throw. Battered victims sometimes get launched upward.
    if (p.grabbing) {
      if (p.grabbing.throwing) return;
      var edge = me.x < 0 ? -1 : 1;
      var victim = p.grabbing.victim;
      var upThrow = victim && victim.dmg > 120 && this.rnd() < 0.35;
      this.x = upThrow ? 0 : edge;
      this.y = upThrow ? -1 : 0;
      if (p.grabbing.t < 1.4 || this.rnd() < 0.35) { this._pressAction(0.05); }
      return;
    }

    // ---- Spike anyone right underneath (only with a jump left to get back) ----
    if (!p.grounded && (groundBelow(spans, me.x, foot, 0.3) || p.airJumps > 0) && this._trySpike(world, p, me)) return;
    // ---- Mid platform-hop: fly it ----
    if (this.hop && this._flyHop(world, p, me, foot, spans)) return;
    // ---- In the air next to someone, over solid ground: hit them ----
    if (!p.grounded && groundBelow(spans, me.x, foot, 0.3) && this._airAttack(world, p, me)) return;
    // Just hopped off to edge-guard: drift over the victim (recovery resumes after).
    if (this.guardT > 0 && !p.grounded && p.airJumps > 0) {
      var gq = world.playerById(this.guardId);
      if (gq && gq.alive && gq.parts && !gq.grounded) {
        var gp = world.posOf(gq);
        // Close the gap, damped by our own drift so we settle over them.
        this.x = Math.max(-1, Math.min(1, (gp.x - me.x) * 2 - me.vx * 0.12));
        this.think = 0.04;
        return;
      }
      this.guardT = 0;
    }

    // ---- Off stage: get back ----
    var under = groundBelow(spans, me.x, foot, 0.3);
    if (!under && !p.grounded) {
      this.think = Math.min(this.think, 0.08);
      if (this.rnd() > cfg.recover) return;
      var tgt = nearestSpan(spans, me.x, foot);
      var home = tgt.x;
      this.x = sign(home - me.x);
      // The one air jump is the final hop on: only spend it when it can
      // actually reach (within about a jump's height below the landing spot),
      // or when there's no wall to climb.
      var below = foot - tgt.y;
      var far = Math.abs(home - me.x) > 3.5;
      var hopReaches = below < 3 && below > -0.4;
      if (p.airJumps > 0 && me.vy > -2 && hopReaches && !(p.wallDir && below > 2)) {
        this._pressJump(0.3);
        return;
      }
      // Up against the side of the stage: cling, then kick off the wall
      // (every kick is full strength, up to the per-trip limit).
      if (p.wallDir && me.vy > -1 && p.wallJumps < NM.WALL_JUMPS) {
        this.x = p.wallDir;
        this._pressJump(0.3);
        this.think = 0.12;
        return;
      }
      if (!p.wallDir && me.vy > -2 && p.airJumps > 0 && (below > -0.4 || (far && below > -3))) this._pressJump(0.3);
      return;
    }

    // ---- Hazards ----
    if (world.roller && world.roller.state !== 'idle' && p.grounded) {
      var r = world.roller;
      var coming = r.state === 'warn' || (sign(me.x - r.x) === r.dir && Math.abs(me.x - r.x) < 5.5);
      if (coming && this.rnd() < cfg.dodge + 0.2) {
        if (r.state === 'roll' && Math.abs(me.x - r.x) < 3.2) this._pressJump(0.3);
        this.x = -r.dir * 0.4;
      }
    }
    if (world.lavaY !== null && foot > world.lavaY - 1.5) {
      this._pressJump(0.3);
      this.x = sign(nearestSpanX(spans, me.x, foot) - me.x);
      return;
    }

    // ---- Edge-guard: hop off over someone recovering below the ledge ----
    if (this._edgeGuard(world, p, me, spans, foot)) return;
    // ---- …and chase down anyone we knocked off, rather than forget them ----
    if (this._guard(world, p, me, spans, foot)) return;

    // ---- Pick a target ----
    var target = this.targetId ? world.playerById(this.targetId) : null;
    if (!target || !target.alive || this.retarget <= 0) {
      var best = null, bd = 1e9;
      for (var k = 0; k < world.players.length; k++) {
        var q = world.players[k];
        if (q === p || !q.alive || !q.parts) continue;
        var qp = world.posOf(q);
        // Don't chase someone who's already flying off the stage.
        if (!groundBelow(spans, qp.x, qp.y + NM.STAND_H, 0.5)) continue;
        var d = Math.hypot(qp.x - me.x, (qp.y - me.y) * 1.5) - q.dmg * 0.01;
        if (d < bd) { bd = d; best = q; }
      }
      target = best;
      this.targetId = best ? best.id : null;
      this.retarget = 1.5 + this.rnd() * 2;
    }

    // ---- Grab an item first if one's close ----
    if (!p.item && world.itemList.length && this.rnd() < cfg.items) {
      var near = null, nd = 7;
      for (var m = 0; m < world.itemList.length; m++) {
        var it = world.itemList[m];
        if (it.state !== 'ground' || !it.body) continue;
        // In boxing gloves only another glove can be picked up.
        if (p.gloveT > 0 && it.type !== 'glove') continue;
        var ip = it.body.getPosition();
        var idd = Math.abs(ip.x - me.x);
        if (idd < nd && Math.abs(ip.y - foot) < 2.5) { nd = idd; near = ip; }
      }
      if (near) {
        if (nd < 1.1 && p.grounded) { this._pressAction(0.05); return; }
        this.x = sign(near.x - me.x);
        return;
      }
    }

    if (target && !groundBelow(spans, world.posOf(target).x, world.posOf(target).y + NM.STAND_H, 0.5)) target = null;
    if (!target) { this._idle(world, p, me, spans, foot); return; }
    var tp = world.posOf(target);
    var dx = tp.x - me.x, dy = tp.y - me.y;
    var adx = Math.abs(dx);

    // ---- Duck a straight punch that's about to land ----
    if (cfg.duck && p.grounded && p.ground && !(p.ground.kind === 'platform' && !p.ground.tile) && adx < 1.9 && Math.abs(dy) < 1 &&
        sign(dx) === -target.facing && (target.pending || (target.attack && target.attack.type !== 'smash' &&
        target.attack.aim.y < 0.5 && target.attack.t < target.attack.spec.t1)) && this.rnd() < cfg.duck) {
      this.x = 0; this.y = 1;
      this.think = 0.3;
      return;
    }

    // ---- Dodge a charging smash ----
    if (target.charge >= 0 && adx < 2.6 && this.rnd() < cfg.dodge) {
      // A jab knocks them out of the charge — punish it if close enough, otherwise hop away.
      if (adx < 1.6 && Math.abs(dy) < 1.2 && this.rnd() < cfg.aggro) { this.x = sign(dx) * 0.3; this._pressAction(0.04); return; }
      this.x = -sign(dx);
      if (p.grounded) this._pressJump(0.25);
      return;
    }

    // ---- Thrown items ----
    if (p.item && p.item.type !== 'bat') {
      if (adx < 10 && Math.abs(dy) < 2.5 && this.rnd() < cfg.aggro) {
        this.x = sign(dx);
        this.y = dy < -1.5 ? -0.7 : 0;
        this._pressAction(0.05);
        return;
      }
    }

    // ---- Close range: fight ----
    var reach = (p.item && p.item.type === 'bat') ? cfg.range + 0.5 : cfg.range;
    if (adx < reach && Math.abs(dy) < 1.4) {
      if (this.rnd() > cfg.aggro) { this.x = -sign(dx) * 0.6; return; }
      this.x = sign(dx) * 0.4;
      if (dy < -0.9) this.y = -1;
      var vulnerable = target.stun > 0 || target.tumble;
      if (!vulnerable && !p.item && target.dmg > 55 && this.rnd() < cfg.charge) {
        this._pressAction(0.35 + this.rnd() * 0.6);
        this.think = this.actHold + 0.05;
        return;
      }
      this._pressAction(0.04);
      return;
    }

    // ---- Target just overhead: hop up and swing at them ----
    if (adx < 1.6 && dy < -1.2 && dy > -4.5 && p.grounded) {
      this.x = sign(dx) * 0.3;
      this._pressJump(0.3);
      return;
    }

    // ---- Approach: on another surface? Find a way over there ----
    if (p.grounded) {
      var tSpan = spanUnder(spans, tp.x, tp.y + NM.STAND_H);
      if (tSpan && this._navTo(world, p, me, spans, foot, tSpan, tp.x)) return;
    }
    var dir = sign(dx);
    var aheadX = me.x + dir * 1.4;
    var safeAhead = groundBelow(spans, aheadX, foot, 0.1);
    if (p.grounded && !safeAhead) {
      // At a ledge: only hop a gap that's short enough to clear, toward a
      // target that's actually over there — otherwise wait at the edge.
      var gap = 1e9;
      for (var gi = 0; gi < spans.length; gi++) {
        var gs = spans[gi];
        if (Math.abs(gs.y - foot) > 1.6) continue;
        var dgap = dir > 0 ? gs.x0 - me.x : me.x - gs.x1;
        if (dgap > 0 && dgap < gap) gap = dgap;
      }
      if (gap < 4 && adx < 6 && tp.y < me.y + 1 && this.rnd() < 0.5) { this.x = dir; this._pressJump(0.3); }
      else this.x = 0;
    } else {
      this.x = dir;
    }
    if (dy < -2.2 && adx < 4 && p.grounded) this._pressJump(0.3);
    // Keep the last air jump in reserve for getting home.
    else if (dy < -2.2 && !p.grounded && me.vy > 0 && p.airJumps > 1 && under) this._pressJump(0.25);
    else if (dy > 2.5 && adx < 3 && p.grounded && p.ground && p.ground.kind === 'platform' && !p.ground.tile) { this.y = 1; this._pressJump(0.1); }
  };

  Bot.prototype._idle = function (world, p, me, spans, foot) {
    this.wander -= 1;
    if (this.wander <= 0) { this.wander = 4 + this.rnd() * 6; this.wdir = this.rnd() < 0.5 ? -1 : 1; }
    if (!groundBelow(spans, me.x + this.wdir * 1.4, foot, 0.1)) this.wdir = -this.wdir;
    this.x = this.wdir * 0.6;
  };

  global.RagdollRumbleBot = { Bot: Bot, DIFF: DIFF };
})(typeof window !== 'undefined' ? window : globalThis);
