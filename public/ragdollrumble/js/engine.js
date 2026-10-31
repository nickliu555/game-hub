/* Ragdoll Rumble — ragdoll brawler engine (host-authoritative).
 *
 * Owns the Planck.js world: stages, the active-ragdoll fighters, attacks,
 * grabs, items, hazards, blast zones and sudden death. Runs ONLY on the host
 * browser, stepped at a fixed timestep from host.js. Pure logic: no DOM, no
 * canvas, no sockets — render.js draws it and bot.js reads it.
 *
 * Coordinates are metres with y pointing DOWN (same as the canvas), so gravity
 * is +y and "up" is negative y. The main floor of every stage sits at y = 0.
 *
 * Fighters are "active ragdolls": ten jointed bodies, but the torso is held up
 * by a spring that floats it a leg-length above the ground and is kept upright
 * by a PD torque, while joint motors pose the noodly limbs. Big hits switch
 * that support off and the whole body tumbles limp until it recovers. Attacks
 * use deterministic hitboxes — the floppy limbs are for show (and for comedy).
 */
(function (global) {
  'use strict';

  var planck = global.planck || (typeof require === 'function' ? require('planck') : null);
  if (!planck) throw new Error('Ragdoll Rumble needs planck.js');
  var Vec2 = planck.Vec2;

  // ---------------- Tunables ----------------
  var G = 30;                     // gravity, m/s²
  var VEL_ITERS = 8, POS_ITERS = 3;

  var TORSO_HW = 0.24, TORSO_HH = 0.45, HEAD_R = 0.27;
  var UA_HW = 0.065, UA_HH = 0.21, FA_HW = 0.06, FA_HH = 0.2;
  var TH_HW = 0.085, TH_HH = 0.24, SH_HW = 0.07, SH_HH = 0.24;
  var LEG_GAP = 0.9;              // torso bottom -> ground while standing
  var STAND_H = TORSO_HH + LEG_GAP;
  var FIGHTER_H = 2 * HEAD_R + 2 * TORSO_HH + LEG_GAP;

  var MOVE_SPEED = 8.5, AIR_SPEED = 8;
  var GROUND_GAIN = 12, GROUND_ACCEL = 75;
  var AIR_GAIN = 6, AIR_ACCEL = 46;
  var JUMP_V = 17, AIR_JUMP_V = 15.5;
  var JUMP_CUT = 0.5;             // vy multiplier when jump is released early
  var MAX_FALL = 16, FAST_FALL_ACCEL = 30, FAST_FALL_MAX = 26;
  var COYOTE = 0.09;
  var AIR_JUMPS = 2;              // double AND triple jump
  var WALL_JUMPS = Infinity;      // wall kicks per trip through the air (unlimited, all full strength)
  var WALL_KICK_X = 9, WALL_KICK_Y = 14;
  var WALL_SLIDE = 3;             // fall speed cap while holding into a wall
  var WALL_LOCK = 0.2;            // after a kick, ignore stick-into-the-wall this long

  var HOVER_K = 340, HOVER_C = 36, HOVER_MAX_UP = 230;
  var UPRIGHT_K = 14, UPRIGHT_C = 2.6;

  var TUMBLE_KB = 13;             // knockback (m/s) that knocks a fighter limp
  var KB_DECAY = 9;               // m/s² of horizontal knockback bleed while tumbling
  var DI_ACCEL = 9;               // directional influence while tumbling
  var CROUCH_DROP = 0.6;          // how far a duck lowers the torso
  var LAUNCH_ANGLE = 45 * Math.PI / 180;

  var CHARGE_START = 0.22;        // hold time before a press becomes a charge
  var CHARGE_FULL = 1.0;
  var CHARGE_AUTO = CHARGE_FULL + 1.0;   // a full charge can be held for a second before it fires itself
  var COMBO_WINDOW = 0.5;
  var SMASH_BASE_BONUS = 3.5, SMASH_GROWTH_BONUS = 8;   // added at full charge

  var GRAB_TIME = 2.0;
  var THROW_R = 1.05;               // how far in front a held ragdoll dangles
  var CHARGE_JUMP = 0.75;         // jumps (and wall kicks) are weaker while charging a smash
  var REEL_SEC = 0.8;             // after any hit you're 'reeling' and can be grabbed
  // Charging is safe from grabs; the opening comes once the smash fires —
  // longer for a bigger charge, and longer still if it misses.
  var SMASH_OPEN_MISS = [0.6, 1.0];   // [tap-charge, full charge] seconds
  var SMASH_OPEN_HIT = [0.35, 0.6];
  // A press that arrives just after an opening closes still grabs — covers the
  // phone → server → host trip so the stars you saw are the grab you get.
  var GRAB_GRACE = 0.15;
  // Down-air spike: an air punch aimed straight down that connects early in
  // its strike (you're right on top of them) drives an airborne victim
  // straight down. Off the stage that's usually a KO; over it they bounce.
  var SPIKE_EARLY = 0.6;            // fraction of the strike (t0→t1) that spikes
  var SPIKE_V = 18, SPIKE_GROWTH = 7;   // launch speed (m/s) at 0%, + per 100%
  var SPIKE_BOUNCE = [8, 13];       // floor-bounce speed range (m/s)
  var GRAB_K = 220, GRAB_C = 30;
  var MASH_STEP = 0.16;

  // Attack animation: arm lengths (for the fist hitbox) and how stiff the
  // arm motors get mid-attack so the visible arm keeps up with the hit.
  var UA_LEN = 2 * 0.21, FA_LEN = 2 * 0.2, ARM_LEN = UA_LEN + FA_LEN;
  var ATK_ARM_TORQUE = 22, ATK_ARM_SPEED = 70;
  var BAT_LEN = 1.45;               // grip → tip
  var BAT_HIT_R = 0.42;
  var ATK = {
    // lean: forward lean at the strike (rad), lunge: forward step (m/s), move: speed multiplier while attacking
    jab:      { lean: 0.12, lunge: 0,   move: 0.75 },
    finisher: { lean: 0.24, lunge: 3,   move: 0.5 },
    smash:    { lean: 0.3,  lunge: 3.5, move: 0.35 },
    bat:      { lean: 0.22, lunge: 1.5, move: 0.4 },
    toss:     { lean: 0.15, lunge: 0,   move: 0.6 },
  };

  var ITEM_R = 0.32;
  var ITEM_MAX = 2;
  var ITEM_LIFE = 14;
  var ITEM_TYPES = ['bat', 'bomb', 'glove', 'rock'];
  var BAT_USES = 4;
  var ROCK_USES = 2;               // throws per rock picked up
  var GLOVE_TIME = 10;
  var GLOVE_MULT = 1.5;
  var BOMB_FUSE = 1.3, BOMB_R = 3.2;

  // Bridge tiles crack from impacts (hard landings, bodies slammed into them),
  // never from someone simply standing still.
  var TILE_BREAK = 1;
  var KO_CREDIT_SEC = 8;
  var SD_SHRINK_SEC = 30;

  var CAT_GROUND = 0x1, CAT_BODY = 0x2, CAT_LIMB = 0x4, CAT_ITEM = 0x8;

  var HITS = {
    jab:      { d: 3,  base: 3.5, growth: 9,  reach: 1.15, t0: 0.05, t1: 0.13, dur: 0.22 },
    finisher: { d: 6,  base: 6,   growth: 16, reach: 1.25, t0: 0.06, t1: 0.16, dur: 0.36, up: 0.25 },
    smash:    { d: 10, base: 9,   growth: 22, reach: 1.35, t0: 0.06, t1: 0.18, dur: 0.5 },
    bat:      { d: 11, base: 7,   growth: 19, reach: 1.8,  t0: 0.1,  t1: 0.24, dur: 0.42 },
    toss:     { dur: 0.3 },
    throwF:   { d: 10, base: 8.5, growth: 20.5 },
    throwB:   { d: 11, base: 9,   growth: 21 },
    throwU:   { d: 9,  base: 10,  growth: 15 },
    slam:     { d: 12, base: 7,   growth: 6 },
    rock:     { d: 18, base: 10,  growth: 21 },
    bomb:     { d: 22, base: 11,  growth: 25 },
    spike:    { d: 12, base: 15,  growth: 8 },
    lava:     { d: 10, base: 21,  growth: 5 },
  };

  // ---------------- Stages ----------------
  // y is the floor surface; solids are boxes [x0,x1]×[y0,y1]; platforms are
  // one-way planks you can jump up through and drop down through.
  // spawnLine: left-to-right walkable [x0, x1, floorY] runs fighters are spread
  // evenly along (gaps between runs are skipped); the ends are the 1v1 spots.
  var STAGES = {
    rooftop: {
      name: 'Rooftop',
      solids: [{ x0: -12, x1: 12, y0: 0, y1: 3.2 }],
      platforms: [{ x0: -8.5, x1: -3.5, y: -3.8 }, { x0: 3.5, x1: 8.5, y: -3.8 }, { x0: -2.5, x1: 2.5, y: -7.4 }],
      spawnLine: [[-9, 9, 0]],
      view: { x0: -21, x1: 21, y0: -16, y1: 6 },
      blast: { x0: -27, x1: 27, y0: -23, y1: 17 },
      sdBlast: { x0: -14.5, x1: 14.5, y0: -12, y1: 6 },
    },
    ship: {
      name: 'Pirate Ship',
      deck: { x0: -13, x1: 13, thick: 1.2, amp: 0.11, period: 9 },
      deckPlatforms: [{ x0: -10, x1: -6, y: -3.6 }, { x0: 6, x1: 10, y: -3.6 }],
      platforms: [{ x0: -2.2, x1: 2.2, y: -7 }],
      spawnLine: [[-10, 10, 0]],
      view: { x0: -22, x1: 22, y0: -16, y1: 7 },
      blast: { x0: -28, x1: 28, y0: -23, y1: 17 },
      sdBlast: { x0: -15, x1: 15, y0: -12, y1: 6 },
    },
    crumble: {
      name: 'Crumble Bridge',
      solids: [{ x0: -15, x1: -11, y0: 0, y1: 4 }, { x0: 11, x1: 15, y0: 0, y1: 4 }],
      tiles: { x0: -11, x1: 11, n: 11, y0: 0, y1: 0.9 },
      platforms: [{ x0: -3, x1: 3, y: -4.4 }],
      spawnLine: [[-13.5, 13.5, 0]],   // across the bridge too
      view: { x0: -24, x1: 24, y0: -16, y1: 7 },
      blast: { x0: -30, x1: 30, y0: -23, y1: 19 },
      sdBlast: { x0: -17, x1: 17, y0: -12, y1: 7 },
    },
    peak: {
      name: 'Windy Peak',
      solids: [{ x0: -11, x1: 11, y0: 0, y1: 3.4 }],
      platforms: [{ x0: -7, x1: -2, y: -4.2 }, { x0: 2, x1: 7, y: -4.2 }],
      spawnLine: [[-9, 9, 0]],
      view: { x0: -21, x1: 21, y0: -15, y1: 6 },
      blast: { x0: -26, x1: 26, y0: -22, y1: 17 },
      sdBlast: { x0: -14, x1: 14, y0: -11, y1: 6 },
      wind: true,
    },
    factory: {
      name: 'Spike Factory',
      solids: [{ x0: -12, x1: 12, y0: 0, y1: 3.2 }],
      platforms: [{ x0: -9, x1: -4.5, y: -4 }, { x0: 4.5, x1: 9, y: -4 }, { x0: -2, x1: 2, y: -7.8 }],
      spawnLine: [[-9, 9, 0]],
      view: { x0: -21, x1: 21, y0: -16, y1: 6 },
      blast: { x0: -27, x1: 27, y0: -23, y1: 17 },
      sdBlast: { x0: -14.5, x1: 14.5, y0: -12, y1: 6 },
      roller: { y: -0.85, r: 0.85, speed: 8, every: 9, warn: 1.6, x0: -17, x1: 17 },
    },
    volcano: {
      name: 'Volcano',
      solids: [{ x0: -14, x1: -6.5, y0: 0, y1: 2 }, { x0: -3.2, x1: 3.2, y0: -1.4, y1: 0.6 }, { x0: 6.5, x1: 14, y0: 0, y1: 2 }],
      platforms: [{ x0: -2.5, x1: 2.5, y: -6 }],
      spawnLine: [[-12, -7.5, 0], [-2.4, 2.4, -1.4], [7.5, 12, 0]],   // skips the lava gaps
      view: { x0: -22, x1: 22, y0: -16, y1: 6 },
      blast: { x0: -28, x1: 28, y0: -23, y1: 17 },
      sdBlast: { x0: -16, x1: 16, y0: -12, y1: 8 },
      lava: { y: 3.4, sdY: -2.2 },
    },
  };
  var STAGE_IDS = ['rooftop', 'ship', 'crumble', 'peak', 'factory', 'volcano'];

  // ---------------- Helpers ----------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Fighter i of n, spread evenly (end to end) along a stage's spawn line. */
  function spawnPoint(line, i, n) {
    var total = 0, k;
    for (k = 0; k < line.length; k++) total += line[k][1] - line[k][0];
    var d = n > 1 ? total * i / (n - 1) : total / 2;
    for (k = 0; k < line.length; k++) {
      var len = line[k][1] - line[k][0];
      if (d <= len + 1e-9 || k === line.length - 1) return [line[k][0] + Math.min(d, len), line[k][2]];
      d -= len;
    }
    return [0, 0];
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function sign(v) { return v < 0 ? -1 : 1; }
  /** World angle of a limb pointing along (dx, dy) — a limb hanging straight down is 0. */
  function dirAngle(dx, dy) { return Math.atan2(-dx, dy); }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function distToSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var l2 = dx * dx + dy * dy;
    var t = l2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); }
  function easeInOut(t) { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeIn(t) { t = clamp(t, 0, 1); return t * t; }
  /** Unit vector of a limb at world angle a (0 = hanging straight down). */
  function limbDir(a) { return { x: -Math.sin(a), y: Math.cos(a) }; }
  /**
   * Two-link reach from shoulder s to target g (elbow bends downward).
   * Returns world angles for the upper arm and forearm.
   */
  function ik(sx, sy, gx, gy) {
    var dx = gx - sx, dy = gy - sy, d = Math.hypot(dx, dy);
    if (d >= ARM_LEN - 0.01 || d < 1e-4) { var a0 = dirAngle(dx, dy); return [a0, a0]; }
    var a = (UA_LEN * UA_LEN - FA_LEN * FA_LEN + d * d) / (2 * d);
    var h = Math.sqrt(Math.max(0, UA_LEN * UA_LEN - a * a));
    var mx = sx + dx * a / d, my = sy + dy * a / d;
    var e1 = { x: mx - dy * h / d, y: my + dx * h / d }, e2 = { x: mx + dy * h / d, y: my - dx * h / d };
    var e = e1.y > e2.y ? e1 : e2;
    return [dirAngle(e.x - sx, e.y - sy), dirAngle(gx - e.x, gy - e.y)];
  }
  function droppable(ground) { return !!ground && ground.kind === 'platform' && !ground.tile; }
  function circleHitsBox(cx, cy, r, b) {
    var nx = clamp(cx, b.x0, b.x1), ny = clamp(cy, b.y0, b.y1);
    return (cx - nx) * (cx - nx) + (cy - ny) * (cy - ny) <= r * r;
  }
  /** Snap a stick vector to one of 8 directions; neutral falls back to facing. */
  function aimFrom(x, y, facing) {
    if (Math.hypot(x, y) < 0.35) return { x: facing, y: 0 };
    var a = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * (Math.PI / 4);
    var ax = Math.cos(a), ay = Math.sin(a);
    if (Math.abs(ax) < 1e-6) ax = 0;
    if (Math.abs(ay) < 1e-6) ay = 0;
    return { x: ax, y: ay };
  }

  // ---------------- Fighter ----------------
  function Fighter(r, seat) {
    this.id = r.id;
    this.name = r.name || 'Player';
    this.seat = seat;
    this.color = r.color || '#ffffff';
    this.isBot = !!r.isBot;
    this.alive = true;
    this.dmg = 0;
    this.facing = 1;
    this.parts = null;
    this.partList = [];
    this.limbList = [];
    this.joints = null;
    this.mass = 1;
    this.in = { x: 0, y: 0, jump: false, action: false, jp: null, ap: null };
    this.q = { jump: false, action: false };
    this.actionHeldT = 0;
    this.grounded = false;
    this.ground = null;
    this.coyote = 0;
    this.airJumps = AIR_JUMPS;
    this.jumpLock = 0;
    this.jumpCut = true;
    this.dropT = 0;
    this.wallDir = 0;
    this.wallJumps = 0;
    this.wallLock = 0;
    this.crouch = false;
    this.stun = 0;
    this.tumble = false;
    this.tumbleT = 0;
    this.attack = null;
    this.anim = null;
    this.bat = null;
    this.charge = -1;
    this.pending = false;
    this.combo = 0;
    this.lastJabAt = -9;
    this.punchArm = 0;
    this.buffer = 0;
    this.grabbing = null;
    this.grabbedBy = null;
    this.grabImmune = 0;
    this.smashOpen = null;
    this.openAt = -99;
    this.spiked = false;
    this.item = null;
    this.gloveT = 0;
    this.hazardCd = 0;
    this.tileCd = 0;
    this.lastImpact = 0;
    this.lastHitBy = null;
    this.lastHitAt = -99;
    this.landedSinceHit = true;
    this.hitAt = -99;
    this.lastHitKind = '';
    this.diedAt = -1;
    this.killedBy = null;
    this.koPos = null;
    this.walkPh = 0;
    this.aabb = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this.flash = 0;
  }

  // ---------------- World ----------------
  function World(opts) {
    opts = opts || {};
    this.items = opts.items !== false;
    this.stageId = STAGES[opts.stage] ? opts.stage : 'rooftop';
    this.stage = STAGES[this.stageId];
    this.frozen = false;
    this.players = [];
    this.byId = {};
    this.time = 0;
    this.pw = null;
    this.rng = Math.random;
    this.itemList = [];
    this.itemTimer = 6;
    this.suddenDeath = false;
    this.sdT = 0;
    this.blast = null;
    this.events = [];
    this._kill = [];
    // Stage-specific live state.
    this.deck = null;
    this.tiles = [];
    this.wind = null;
    this.roller = null;
    this.lavaY = null;
  }

  World.prototype.reset = function (seed, roster) {
    this.rng = mulberry32(seed || 1);
    this.time = 0;
    this.players = [];
    this.byId = {};
    this.itemList = [];
    this.itemTimer = 5 + this.rng() * 4;
    this.suddenDeath = false;
    this.sdT = 0;
    this.blast = Object.assign({}, this.stage.blast);
    this._kill = [];
    this.events = [];
    this.pw = new planck.World({ gravity: Vec2(0, G) });
    this.pw.on('pre-solve', this._preSolve.bind(this));
    this._buildStage();
    var list = roster || [];
    for (var i = 0; i < list.length; i++) {
      var p = new Fighter(list[i], typeof list[i].seat === 'number' ? list[i].seat : i);
      var sp = spawnPoint(this.stage.spawnLine, i, list.length);
      p.facing = sp[0] < 0 || (sp[0] === 0 && i < list.length / 2) ? 1 : -1;
      this._buildRagdoll(p, sp[0], sp[1] - STAND_H - 0.05);
      this.players.push(p);
      this.byId[p.id] = p;
    }
    // Let everyone settle into their stance so the countdown shows fighters
    // standing, not mid-flop. Events from settling are discarded.
    var saveItems = this.items;
    this.items = false;
    for (var k = 0; k < 90; k++) this._tick(1 / 120);
    this.items = saveItems;
    this.time = 0;
    this.events = [];
    this.tiles.forEach(function (t) { t.load = 0; });
    if (this.deck) this.deck.body.setTransform(this.deck.body.getPosition(), 0);
  };

  // ---------------- Stage construction ----------------
  World.prototype._groundFixture = function (body, shape, data) {
    return body.createFixture(shape, {
      friction: 0.8,
      filterCategoryBits: CAT_GROUND,
      filterMaskBits: CAT_BODY | CAT_LIMB | CAT_ITEM,
      userData: data,
    });
  };

  World.prototype._buildStage = function () {
    var s = this.stage, pw = this.pw, self = this;
    var ground = pw.createBody({ type: 'static' });
    // Ground blocks are drawn reaching down off the bottom of the screen, so
    // make them solid all the way down too: their sides are walls you can
    // cling to and kick off at any height, not just near the top.
    var floorY = s.blast.y1 + 6;
    (s.solids || []).forEach(function (b) {
      var bottom = Math.max(b.y1, floorY);
      var hw = (b.x1 - b.x0) / 2, hh = (bottom - b.y0) / 2;
      self._groundFixture(ground, planck.Box(hw, hh, Vec2(b.x0 + hw, b.y0 + hh)), { kind: 'solid' });
    });
    (s.platforms || []).forEach(function (pl) {
      var hw = (pl.x1 - pl.x0) / 2;
      self._groundFixture(ground, planck.Box(hw, 0.12, Vec2(pl.x0 + hw, pl.y + 0.12)), { kind: 'platform', top: pl.y });
    });
    this.deck = null;
    if (s.deck) {
      var d = s.deck;
      var oy = d.thick / 2;
      var body = pw.createBody({ type: 'kinematic', position: Vec2(0, oy) });
      var dhw = (d.x1 - d.x0) / 2;
      this._groundFixture(body, planck.Box(dhw, oy, Vec2((d.x0 + d.x1) / 2, 0)), { kind: 'solid' });
      // The hull under the deck is solid too (matches its drawing), with
      // sloped sides you can kick off.
      this._groundFixture(body, planck.Polygon([
        Vec2(d.x0 - 0.6, -oy), Vec2(d.x1 + 0.6, -oy), Vec2(d.x1 - 2, oy + 4), Vec2(d.x0 + 2, oy + 4),
      ]), { kind: 'solid' });
      (s.deckPlatforms || []).forEach(function (pl) {
        var hw = (pl.x1 - pl.x0) / 2;
        // In the deck body's local frame (origin on the deck's centre line).
        self._groundFixture(body, planck.Box(hw, 0.12, Vec2(pl.x0 + hw, pl.y + 0.12 - oy)), { kind: 'platform', top: pl.y - oy });
      });
      this.deck = { body: body, amp: d.amp, period: d.period, d: d };
    }
    this.tiles = [];
    if (s.tiles) {
      var t = s.tiles, w = (t.x1 - t.x0) / t.n;
      for (var i = 0; i < t.n; i++) {
        var tile = { x0: t.x0 + i * w, x1: t.x0 + (i + 1) * w, y0: t.y0, y1: t.y1, state: 'solid', load: 0, timer: 0, body: null, fallY: 0, fallV: 0 };
        this._makeTile(tile);
        this.tiles.push(tile);
      }
    }
    this.wind = s.wind ? { state: 'idle', timer: 6 + this.rng() * 3, dir: 1, accel: 0 } : null;
    this.roller = s.roller ? { state: 'idle', timer: s.roller.every * 0.7, x: 0, dir: 1, cfg: s.roller } : null;
    this.lavaY = s.lava ? s.lava.y : null;
  };

  World.prototype._makeTile = function (tile) {
    var body = this.pw.createBody({ type: 'static' });
    var hw = (tile.x1 - tile.x0) / 2 - 0.02, hh = (tile.y1 - tile.y0) / 2;
    // Bridge planks are one-way, so a ragdoll that drops through a gap can
    // still jump back up through the bridge instead of bonking its head.
    this._groundFixture(body, planck.Box(hw, hh, Vec2(tile.x0 + hw + 0.02, tile.y0 + hh)), { kind: 'platform', top: tile.y0, tile: tile });
    tile.body = body;
  };

  // ---------------- Ragdoll construction ----------------
  World.prototype._buildRagdoll = function (p, x, y) {
    var pw = this.pw;
    var group = -(p.seat + 1);
    function mk(px, py, angDamp) {
      return pw.createBody({
        type: 'dynamic', position: Vec2(px, py), allowSleep: false,
        angularDamping: angDamp || 0, userData: { fighter: p },
      });
    }
    // Fighters pass through each other (like Smash) and are eased apart by
    // _separate(), so nobody can be shoved off a ledge just by walking into them.
    var bodyFix = { density: 3, friction: 0.4, restitution: 0.15, filterGroupIndex: group, filterCategoryBits: CAT_BODY, filterMaskBits: CAT_GROUND };
    var limbFix = { density: 0.9, friction: 0.7, restitution: 0.1, filterGroupIndex: group, filterCategoryBits: CAT_LIMB, filterMaskBits: 0 };

    var torso = mk(x, y, 0.5);
    torso.createFixture(planck.Box(TORSO_HW, TORSO_HH), bodyFix);
    var neck = Vec2(x, y - TORSO_HH);
    var head = mk(x, y - TORSO_HH - HEAD_R + 0.05, 0.5);
    head.createFixture(planck.Circle(HEAD_R), Object.assign({}, bodyFix, { density: 1.5 }));

    var sh = Vec2(x, y - TORSO_HH + 0.14);
    var hip = Vec2(x, y + TORSO_HH - 0.06);
    function limb(top, hw, hh) {
      var b = mk(top.x, top.y + hh, 1.5);
      b.createFixture(planck.Box(hw, hh), limbFix);
      return b;
    }
    var uaF = limb(sh, UA_HW, UA_HH), uaB = limb(sh, UA_HW, UA_HH);
    var elbow = Vec2(sh.x, sh.y + 2 * UA_HH);
    var faF = limb(elbow, FA_HW, FA_HH), faB = limb(elbow, FA_HW, FA_HH);
    var thF = limb(hip, TH_HW, TH_HH), thB = limb(hip, TH_HW, TH_HH);
    var knee = Vec2(hip.x, hip.y + 2 * TH_HH);
    var shF = limb(knee, SH_HW, SH_HH), shB = limb(knee, SH_HW, SH_HH);

    function rev(a, b, anchor, lo, hi) {
      var def = { enableMotor: true, maxMotorTorque: 2, motorSpeed: 0 };
      if (lo !== undefined) { def.enableLimit = true; def.lowerAngle = lo; def.upperAngle = hi; }
      return pw.createJoint(planck.RevoluteJoint(def, a, b, anchor));
    }
    p.joints = {
      neck: rev(torso, head, neck, -0.5, 0.5),
      shF: rev(torso, uaF, sh), shB: rev(torso, uaB, sh),
      elF: rev(uaF, faF, elbow, -2.7, 2.7), elB: rev(uaB, faB, elbow, -2.7, 2.7),
      hipF: rev(torso, thF, hip, -2.3, 2.3), hipB: rev(torso, thB, hip, -2.3, 2.3),
      knF: rev(thF, shF, knee, -2.6, 2.6), knB: rev(thB, shB, knee, -2.6, 2.6),
    };
    p.parts = { torso: torso, head: head, uaF: uaF, faF: faF, uaB: uaB, faB: faB, thF: thF, shF: shF, thB: thB, shB: shB };
    p.partList = [torso, head, uaF, faF, uaB, faB, thF, shF, thB, shB];
    p.limbList = [uaF, faF, uaB, faB, thF, shF, thB, shB];
    var m = 0;
    for (var i = 0; i < p.partList.length; i++) m += p.partList[i].getMass();
    p.mass = m;
  };

  World.prototype._setLimbCollision = function (p, on) {
    var mask = on ? CAT_GROUND : 0;
    for (var i = 0; i < p.limbList.length; i++) {
      for (var f = p.limbList[i].getFixtureList(); f; f = f.getNext()) {
        f.setFilterData({ groupIndex: -(p.seat + 1), categoryBits: CAT_LIMB, maskBits: mask });
      }
    }
  };

  World.prototype._destroyFighterBodies = function (p) {
    if (!p.parts) return;
    for (var i = 0; i < p.partList.length; i++) this.pw.destroyBody(p.partList[i]);
    p.parts = null;
    p.partList = [];
    p.limbList = [];
    p.joints = null;
  };

  // ---------------- One-way platforms ----------------
  World.prototype._preSolve = function (contact) {
    var fa = contact.getFixtureA(), fb = contact.getFixtureB();
    var da = fa.getUserData(), db = fb.getUserData();
    var plat = null, other = null;
    if (da && da.kind === 'platform') { plat = fa; other = fb; }
    else if (db && db.kind === 'platform') { plat = fb; other = fa; }
    if (!plat) return;
    var ob = other.getBody();
    var ud = ob.getUserData();
    var fighter = ud && ud.fighter;
    // Only a fighter's torso ever rests on a plank — a head or a floppy limb
    // catching the edge would leave the whole ragdoll dangling there.
    if (fighter && (fighter.dropT > 0 || !fighter.parts || ob !== fighter.parts.torso)) { contact.setEnabled(false); return; }
    var pb = plat.getBody();
    var local = pb.getLocalPoint(ob.getPosition());
    var top = plat.getUserData().top;
    var ext = fighter ? TORSO_HH : 0.25;
    var shape = other.getShape();
    if (shape.getType() === 'circle') ext = shape.getRadius();
    // Only solid from above: the body must be resting on (or just above) the top.
    var rel = ob.getLinearVelocity().y - pb.getLinearVelocityFromWorldPoint(ob.getPosition()).y;
    if (local.y + ext > top + 0.25 || rel < -0.5) contact.setEnabled(false);
  };

  // ---------------- Input ----------------
  /**
   * Phone input: stick (x, y), held buttons (b bit 1 = jump, bit 2 = action),
   * and press counters (jp/ap) so a tap that is pressed AND released between
   * two physics ticks still registers.
   */
  World.prototype.setInput = function (id, x, y, b, jp, ap) {
    var p = this.byId[id];
    if (!p || !p.alive) return;
    var inp = p.in;
    inp.x = clamp(Number(x) || 0, -1, 1);
    inp.y = clamp(Number(y) || 0, -1, 1);
    var bits = Number(b) | 0;
    var jumpHeld = !!(bits & 1), actHeld = !!(bits & 2);
    if (typeof jp === 'number') {
      if (inp.jp !== null && jp !== inp.jp) p.q.jump = true;
      else if (inp.jp === null && jumpHeld && !inp.jump) p.q.jump = true;
      inp.jp = jp;
    } else if (jumpHeld && !inp.jump) p.q.jump = true;
    if (typeof ap === 'number') {
      if ((inp.ap !== null && ap !== inp.ap) || (inp.ap === null && actHeld && !inp.action)) { p.q.action = true; p.actionHeldT = 0; }
      inp.ap = ap;
    } else if (actHeld && !inp.action) { p.q.action = true; p.actionHeldT = 0; }
    inp.jump = jumpHeld;
    inp.action = actHeld;
  };

  World.prototype.clearInputs = function () {
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      p.in.x = 0; p.in.y = 0; p.in.jump = false; p.in.action = false;
      p.q.jump = false; p.q.action = false;
    }
  };

  // ---------------- Queries ----------------
  World.prototype.playerById = function (id) { return this.byId[id] || null; };
  World.prototype.alivePlayers = function () { return this.players.filter(function (p) { return p.alive; }); };
  World.prototype.hudOf = function (p) {
    return { dmg: Math.round(p.dmg), item: p.item ? p.item.type : '', glove: p.gloveT > 0 };
  };
  World.prototype.posOf = function (p) {
    if (!p.parts) return p.koPos ? { x: p.koPos.x, y: p.koPos.y, vx: 0, vy: 0 } : { x: 0, y: 0, vx: 0, vy: 0 };
    var t = p.parts.torso, pos = t.getPosition(), v = t.getLinearVelocity();
    return { x: pos.x, y: pos.y, vx: v.x, vy: v.y };
  };
  /** Walkable top surfaces for bots: { x0, x1, y, oneWay }. */
  World.prototype.groundSpans = function () {
    var out = [];
    var s = this.stage;
    (s.solids || []).forEach(function (b) { out.push({ x0: b.x0, x1: b.x1, y: b.y0, oneWay: false }); });
    (s.platforms || []).forEach(function (b) { out.push({ x0: b.x0, x1: b.x1, y: b.y, oneWay: true }); });
    if (s.deck) {
      out.push({ x0: s.deck.x0, x1: s.deck.x1, y: 0, oneWay: false });
      (s.deckPlatforms || []).forEach(function (b) { out.push({ x0: b.x0, x1: b.x1, y: b.y, oneWay: true }); });
    }
    this.tiles.forEach(function (t) { if (t.state !== 'fallen') out.push({ x0: t.x0, x1: t.x1, y: t.y0, oneWay: true, crumbly: true }); });
    return out;
  };

  World.prototype.startSuddenDeath = function () {
    if (this.suddenDeath) return;
    this.suddenDeath = true;
    this.sdT = 0;
  };

  // ---------------- Step ----------------
  World.prototype.step = function (dt) {
    this.events = [];
    if (this.frozen || !this.pw) return this.events;
    this._tick(dt);
    return this.events;
  };

  World.prototype._tick = function (dt) {
    var ev = this.events;
    this.time += dt;
    this._updateStage(dt, ev);
    if (this.items) this._updateItemSpawns(dt, ev);
    var i;
    for (i = 0; i < this.players.length; i++) {
      var pl = this.players[i];
      if (pl.alive && pl.parts && pl.charge < 0 && this._openNow(pl)) pl.openAt = this.time;
      this._probeGround(pl, dt);
    }
    for (i = 0; i < this.players.length; i++) this._control(this.players[i], dt, ev);
    this._separate();
    this.pw.step(dt, VEL_ITERS, POS_ITERS);
    for (i = 0; i < this.players.length; i++) this._updateAabb(this.players[i]);
    this._updateItems(dt, ev);
    this._checkHazards(ev);
    this._checkKOs(ev);
    this._flushKills();
  };

  World.prototype._flushKills = function () {
    for (var i = 0; i < this._kill.length; i++) {
      var k = this._kill[i];
      if (k.fighter) this._destroyFighterBodies(k.fighter);
      else if (k.body) this.pw.destroyBody(k.body);
    }
    this._kill = [];
  };

  // ---------------- Stage dynamics ----------------
  World.prototype._updateStage = function (dt, ev) {
    var s = this.stage, rng = this.rng, i;
    if (this.suddenDeath) {
      this.sdT += dt;
      var k = clamp(this.sdT / SD_SHRINK_SEC, 0, 1);
      var a = s.blast, b = s.sdBlast;
      this.blast = { x0: lerp(a.x0, b.x0, k), x1: lerp(a.x1, b.x1, k), y0: lerp(a.y0, b.y0, k), y1: lerp(a.y1, b.y1, k) };
      if (s.lava) this.lavaY = lerp(s.lava.y, s.lava.sdY, k);
    }
    if (this.deck) {
      var w = 2 * Math.PI / this.deck.period;
      this.deck.body.setAngularVelocity(this.deck.amp * w * Math.cos(w * this.time));
    }
    for (i = 0; i < this.tiles.length; i++) {
      var t = this.tiles[i];
      if (t.state === 'solid') {
        if (t.load >= TILE_BREAK) { t.state = 'shake'; t.timer = 0.7; ev.push({ type: 'crack', x: (t.x0 + t.x1) / 2, y: t.y0 }); }
        t.load = Math.max(0, t.load - dt * 0.04);
      } else if (t.state === 'shake') {
        t.timer -= dt;
        if (t.timer <= 0) {
          t.state = 'fallen'; t.timer = 7; t.fallY = 0; t.fallV = 0;
          this._kill.push({ body: t.body }); t.body = null;
          ev.push({ type: 'crumble', x: (t.x0 + t.x1) / 2, y: t.y0 });
        }
      } else if (t.state === 'fallen') {
        t.fallV += G * dt; t.fallY += t.fallV * dt;
        t.timer -= dt;
        if (t.timer <= 0 && !this._tileOccupied(t)) {
          t.state = 'solid'; t.load = 0; this._makeTile(t);
          ev.push({ type: 'tileBack', x: (t.x0 + t.x1) / 2, y: t.y0 });
        }
      }
    }
    if (this.wind) {
      var wd = this.wind;
      wd.timer -= dt;
      if (wd.state === 'idle' && wd.timer <= 0) {
        wd.state = 'warn'; wd.timer = 1.6; wd.dir = rng() < 0.5 ? -1 : 1;
        ev.push({ type: 'gustWarn', dir: wd.dir });
      } else if (wd.state === 'warn' && wd.timer <= 0) {
        wd.state = 'blow'; wd.timer = 3;
        ev.push({ type: 'gust', dir: wd.dir });
      } else if (wd.state === 'blow' && wd.timer <= 0) {
        wd.state = 'idle'; wd.timer = 6 + rng() * 4;
      }
      var target = wd.state === 'blow' ? 15 * wd.dir : 0;
      wd.accel += (target - wd.accel) * Math.min(1, dt * 3);
    }
    if (this.roller) {
      var r = this.roller, c = r.cfg;
      r.timer -= dt;
      if (r.state === 'idle' && r.timer <= 0) {
        r.state = 'warn'; r.timer = c.warn; r.dir = rng() < 0.5 ? 1 : -1;
        r.x = r.dir > 0 ? c.x0 : c.x1;
        ev.push({ type: 'rollerWarn', dir: r.dir });
      } else if (r.state === 'warn' && r.timer <= 0) {
        r.state = 'roll';
        ev.push({ type: 'roller', dir: r.dir });
      } else if (r.state === 'roll') {
        r.x += r.dir * c.speed * dt;
        if ((r.dir > 0 && r.x > c.x1) || (r.dir < 0 && r.x < c.x0)) { r.state = 'idle'; r.timer = c.every * (0.8 + rng() * 0.4); }
      }
    }
  };

  World.prototype._tileOccupied = function (t) {
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.alive || !p.parts) continue;
      var a = p.aabb;
      if (a.x1 > t.x0 && a.x0 < t.x1 && a.y1 > t.y0 - 0.2 && a.y0 < t.y1) return true;
    }
    return false;
  };

  // ---------------- Ground probe ----------------
  World.prototype._probeGround = function (p, dt) {
    if (!p.alive || !p.parts) return;
    var torso = p.parts.torso;
    var pos = torso.getPosition(), vel = torso.getLinearVelocity();
    var reach = STAND_H + 0.55 + Math.max(0, vel.y) * 0.04;
    var best = null;
    var offs = [-0.22, 0, 0.22];
    for (var k = 0; k < offs.length; k++) {
      var x = pos.x + offs[k];
      var hit = null;
      this.pw.rayCast(Vec2(x, pos.y), Vec2(x, pos.y + reach), function (fix, point, normal, fraction) {
        var ud = fix.getUserData();
        if (!ud || (ud.kind !== 'solid' && ud.kind !== 'platform')) return -1;
        if (ud.kind === 'platform') {
          if (p.dropT > 0) return -1;
          if (point.y < pos.y + TORSO_HH - 0.3) return -1;
        }
        hit = { fix: fix, y: point.y, kind: ud.kind, tile: ud.tile || null };
        return fraction;
      });
      if (hit && (!best || hit.y < best.y)) best = hit;
    }
    p.ground = best;
    // A spiked ragdoll that reaches the floor bounces back up, still limp.
    if (p.spiked && p.tumble && best && vel.y > 3 && best.y - pos.y < STAND_H + 0.25) {
      p.spiked = false;
      var bv = clamp(vel.y * 0.55, SPIKE_BOUNCE[0], SPIKE_BOUNCE[1]);
      this._setVel(p, vel.x * 0.4, -bv);
      p.tumbleT = Math.max(p.tumbleT, 0.4);
      if (best.tile) best.tile.load += 0.7;
      this.events.push({ type: 'spikeBounce', id: p.id, x: pos.x, y: best.y });
      return;
    }
    var was = p.grounded;
    p.grounded = !!best && !p.tumble && !p.grabbedBy && p.jumpLock <= 0 && vel.y > -3;
    if (p.grounded) {
      var gb = best.fix.getBody();
      var gv = gb.getLinearVelocityFromWorldPoint(Vec2(pos.x, best.y));
      best.vx = gv.x; best.vy = gv.y;
      best.angle = gb.getType() === 'kinematic' ? gb.getAngle() : 0;
      p.coyote = COYOTE;
      if (!was && best.tile && vel.y > 9) best.tile.load += (vel.y - 6) / 10;
      if (!was) this.events.push({ type: 'land', id: p.id, x: pos.x, y: best.y, v: vel.y });
    }
  };

  // ---------------- Per-fighter control ----------------
  World.prototype._control = function (p, dt, ev) {
    if (!p.alive || !p.parts) return;
    var torso = p.parts.torso;
    var pos = torso.getPosition(), vel = torso.getLinearVelocity();
    var inp = p.in;
    var M = p.mass;

    p.stun = Math.max(0, p.stun - dt);
    p.coyote = Math.max(0, p.coyote - dt);
    p.wallLock = Math.max(0, p.wallLock - dt);
    p.jumpLock = Math.max(0, p.jumpLock - dt);
    p.dropT = Math.max(0, p.dropT - dt);
    p.grabImmune = Math.max(0, p.grabImmune - dt);
    p.hazardCd = Math.max(0, p.hazardCd - dt);
    p.buffer = Math.max(0, p.buffer - dt);
    p.flash = Math.max(0, p.flash - dt);
    if (p.gloveT > 0) p.gloveT = Math.max(0, p.gloveT - dt);
    if (inp.action) p.actionHeldT += dt;

    var jumpPress = p.q.jump, actPress = p.q.action;
    p.q.jump = false; p.q.action = false;

    // ---- Being carried ----
    if (p.grabbedBy) {
      if (actPress && p.grabbedBy.grabbing && !p.grabbedBy.grabbing.throwing) {
        p.grabbedBy.grabbing.t -= MASH_STEP * (1 - Math.min(0.6, p.dmg / 250));
      }
      this._pose(p, 'limp');
      return;
    }

    // ---- Tumbling (limp ragdoll) ----
    if (p.tumble) {
      p.tumbleT -= dt;
      var vx = vel.x;
      if (Math.abs(vx) > MOVE_SPEED * 0.5) {
        this._addVel(p, -sign(vx) * Math.min(Math.abs(vx) - MOVE_SPEED * 0.5, KB_DECAY * dt), 0);
      }
      if (Math.hypot(inp.x, inp.y) > 0.3) torso.applyForceToCenter(Vec2(inp.x * DI_ACCEL * M, inp.y * DI_ACCEL * 0.5 * M), true);
      this._windForce(p, false);
      this._clampFall(p, MAX_FALL + 10);
      if (p.tumbleT <= 0) this._endTumble(p);
      this._pose(p, 'limp');
      return;
    }

    var canAct = p.stun <= 0;
    var grounded = p.grounded;
    if (grounded) { p.airJumps = AIR_JUMPS; p.wallJumps = 0; p.landedSinceHit = true; }
    p.wallDir = grounded ? 0 : this._wallSide(p);

    // ---- Facing ----
    // Carrying someone locks your facing, so stick-away + ACTION is a back throw.
    if (canAct && !p.attack && p.charge < 0 && !p.grabbing && Math.abs(inp.x) > 0.25) p.facing = inp.x > 0 ? 1 : -1;
    var spinning = !!(p.grabbing && p.grabbing.throwing);

    // ---- Drop-through: stick (mostly straight) down on a plank, no buttons ----
    // Holding JUMP or ACTION — or being mid-punch, charging or grabbing — keeps
    // you on the plank, so down-aimed attacks and slams never drop you.
    // Floating planks can be dropped through; the Crumble Bridge can't (it's
    // only one-way from below so a fallen ragdoll can jump back up onto it).
    var onPlank = grounded && droppable(p.ground);
    if (canAct && onPlank && inp.y > 0.7 && Math.abs(inp.x) < 0.5 && !inp.action && !inp.jump &&
        !jumpPress && !actPress && !p.attack && !p.pending && p.charge < 0 && !p.grabbing) {
      p.dropT = 0.32; p.jumpLock = 0.1; p.grounded = false; grounded = false;
      ev.push({ type: 'drop', id: p.id });
    }

    // ---- Duck: the same stick-down on solid ground squats you in place ----
    var wasCrouch = p.crouch;
    p.crouch = canAct && grounded && !onPlank && inp.y > 0.7 && Math.abs(inp.x) < 0.5 && !inp.action && !inp.jump &&
      !jumpPress && !actPress && !p.attack && !p.pending && p.charge < 0 && !p.grabbing;
    if (p.crouch && !wasCrouch) ev.push({ type: 'crouch', id: p.id });

    // ---- Jump / drop-through ----
    if (canAct && jumpPress && !spinning) {
      var jk = p.charge >= 0 ? CHARGE_JUMP : 1;
      if (grounded || p.coyote > 0) {
        if (inp.y > 0.6 && droppable(p.ground) && p.charge < 0) {
          p.dropT = 0.32; p.jumpLock = 0.1; p.grounded = false; grounded = false;
          ev.push({ type: 'drop', id: p.id });
        } else {
          this._jump(p, JUMP_V * jk);
          grounded = false;
          ev.push({ type: 'jump', id: p.id, x: pos.x, y: pos.y + STAND_H });
        }
      } else if (p.wallDir && p.wallJumps < WALL_JUMPS) {
        // Wall kick: up and away from the wall at full strength, and it doesn't
        // cost an air jump. A few per trip through the air; landing resets them.
        p.wallJumps++;
        this._setVel(p, -p.wallDir * WALL_KICK_X * jk, -WALL_KICK_Y * jk);
        if (p.charge < 0) p.facing = -p.wallDir;   // a charge keeps its direction
        p.wallLock = WALL_LOCK;
        p.jumpLock = 0.14;
        p.jumpCut = true;   // always a full kick, even from a quick tap
        ev.push({ type: 'walljump', id: p.id, x: pos.x + p.wallDir * TORSO_HW, y: pos.y, dir: p.wallDir });
      } else if (p.airJumps > 0) {
        p.airJumps--;
        this._jump(p, AIR_JUMP_V * jk);
        ev.push({ type: 'airjump', id: p.id, x: pos.x, y: pos.y + TORSO_HH });
      }
    }
    vel = torso.getLinearVelocity();
    if (!p.jumpCut && !inp.jump && vel.y < -4) {
      this._addVel(p, 0, -vel.y * (1 - JUMP_CUT));
      p.jumpCut = true;
    }
    if (vel.y >= 0) p.jumpCut = true;

    // ---- Actions ----
    if (canAct) this._actions(p, actPress, dt, ev);
    else if (actPress) p.buffer = 0.2;

    // ---- Movement ----
    vel = torso.getLinearVelocity();
    var mul = 1;
    if (spinning) mul = 0;
    else if (p.charge >= 0) mul = 0.35;
    else if (p.grabbing) mul = 0.55;
    else if (p.attack && grounded) mul = ATK[p.attack.type].move;
    var stickX = canAct && !p.crouch ? inp.x : 0;
    if (p.wallLock > 0 && stickX * p.facing < 0) stickX = 0;
    if (grounded) {
      var gvx = p.ground.vx || 0;
      var target = stickX * MOVE_SPEED * mul + gvx;
      var ax = clamp((target - vel.x) * GROUND_GAIN, -GROUND_ACCEL, GROUND_ACCEL);
      if (p.ground.angle) ax += G * Math.sin(p.ground.angle) * 0.55;
      torso.applyForceToCenter(Vec2(ax * M, 0), true);
    } else if (Math.abs(stickX) > 0.1) {
      var ax2 = (stickX * AIR_SPEED * mul - vel.x) * AIR_GAIN;
      // Plain air control only half-brakes knockback-speed momentum.
      if (Math.abs(vel.x) > AIR_SPEED && sign(ax2) !== sign(vel.x)) ax2 *= 0.5;
      torso.applyForceToCenter(Vec2(clamp(ax2, -AIR_ACCEL, AIR_ACCEL) * M, 0), true);
    }
    this._windForce(p, grounded);

    // ---- Support: hover spring + upright torque ----
    if (grounded) {
      var err = (p.ground.y - STAND_H + (p.crouch ? CROUCH_DROP : 0)) - pos.y;
      var dv = vel.y - (p.ground.vy || 0);
      var ay = clamp(-G + HOVER_K * err - HOVER_C * dv, -G - HOVER_MAX_UP, 0);
      torso.applyForceToCenter(Vec2(0, ay * M), true);
    } else {
      var fast = canAct && inp.y > 0.7 && vel.y > -2;
      if (fast) torso.applyForceToCenter(Vec2(0, FAST_FALL_ACCEL * M), true);
      // Holding into a wall slows the slide to a cling, giving time to kick off.
      var cling = canAct && p.wallDir && inp.x * p.wallDir > 0.4 && !fast;
      this._clampFall(p, cling ? WALL_SLIDE : (fast ? FAST_FALL_MAX : MAX_FALL));
    }
    var lean = clamp((vel.x - (grounded ? (p.ground.vx || 0) : 0)) * 0.012, -0.12, 0.12);
    // Throw your weight into a blow: lean back on the wind-up, in on the strike.
    if (p.attack && p.anim) lean += p.anim.lean * p.facing;
    else if (p.charge >= 0) lean -= 0.1 * p.facing;
    torso.applyTorque(M * (UPRIGHT_K * wrapPi(lean - torso.getAngle()) - UPRIGHT_C * torso.getAngularVelocity()), true);

    // ---- Carrying a victim ----
    if (p.grabbing) this._carry(p, dt, ev);

    // ---- Pose ----
    if (grounded) {
      var rv = Math.abs(vel.x - (p.ground.vx || 0));
      if (rv > 0.6) p.walkPh += rv * dt * 2.1;
    }
    this._pose(p, grounded ? 'ground' : 'air');
  };

  /** Soft push between overlapping fighters, so crowds spread out instead of stacking. */
  World.prototype._separate = function () {
    var ps = this.players;
    for (var i = 0; i < ps.length; i++) {
      var a = ps[i];
      if (!a.alive || !a.parts || a.grabbedBy) continue;
      for (var k = i + 1; k < ps.length; k++) {
        var b = ps[k];
        if (!b.alive || !b.parts || b.grabbedBy || a.grabbing && a.grabbing.victim === b || b.grabbing && b.grabbing.victim === a) continue;
        var pa = a.parts.torso.getPosition(), pb = b.parts.torso.getPosition();
        var dx = pb.x - pa.x, dy = pb.y - pa.y;
        if (Math.abs(dy) > 1.6 || Math.abs(dx) > 0.7) continue;
        var push = (0.7 - Math.abs(dx)) * 40;
        var s = dx === 0 ? (i % 2 ? 1 : -1) : sign(dx);
        a.parts.torso.applyForceToCenter(Vec2(-s * push * a.mass, 0), true);
        b.parts.torso.applyForceToCenter(Vec2(s * push * b.mass, 0), true);
      }
    }
  };

  /** -1 / +1 if the side of solid ground is right beside the torso, else 0. */
  World.prototype._wallSide = function (p) {
    var pos = p.parts.torso.getPosition();
    var reach = TORSO_HW + 0.3;
    for (var side = -1; side <= 1; side += 2) {
      var offs = [-0.3, 0.2];
      for (var k = 0; k < offs.length; k++) {
        var y = pos.y + offs[k], hit = false;
        this.pw.rayCast(Vec2(pos.x, y), Vec2(pos.x + side * reach, y), function (fix, point, normal, fraction) {
          var ud = fix.getUserData();
          if (!ud || ud.kind !== 'solid') return -1;
          if (Math.abs(normal.x) < 0.7) return -1;
          hit = true;
          return fraction;
        });
        if (hit) return side;
      }
    }
    return 0;
  };

  World.prototype._windForce = function (p, grounded) {
    if (!this.wind || Math.abs(this.wind.accel) < 0.05) return;
    p.parts.torso.applyForceToCenter(Vec2(this.wind.accel * p.mass * (grounded ? 0.55 : 1), 0), true);
  };

  World.prototype._clampFall = function (p, max) {
    var v = p.parts.torso.getLinearVelocity();
    if (v.y > max) this._addVel(p, 0, max - v.y);
  };

  World.prototype._addVel = function (p, dx, dy) {
    for (var i = 0; i < p.partList.length; i++) {
      var b = p.partList[i], v = b.getLinearVelocity();
      b.setLinearVelocity(Vec2(v.x + dx, v.y + dy));
    }
  };

  World.prototype._setVel = function (p, vx, vy) {
    for (var i = 0; i < p.partList.length; i++) p.partList[i].setLinearVelocity(Vec2(vx, vy));
  };

  World.prototype._jump = function (p, v) {
    var cur = p.parts.torso.getLinearVelocity();
    var gvy = (p.grounded && p.ground && p.ground.vy) ? Math.min(0, p.ground.vy) : 0;
    this._addVel(p, 0, (-v + gvy) - cur.y);
    p.grounded = false;
    p.coyote = 0;
    p.jumpLock = 0.14;
    p.jumpCut = false;
  };

  // ---------------- Actions ----------------
  World.prototype._actions = function (p, press, dt, ev) {
    var inp = p.in;
    if (press && (p.attack || p.charge >= 0 || p.pending)) { p.buffer = 0.2; press = false; }
    if (!press && p.buffer > 0 && !p.attack && p.charge < 0 && !p.pending) { press = true; p.buffer = 0; }

    if (press) {
      // Contextual actions fire instantly on the press…
      if (p.grabbing) { this._throwVictim(p, ev); return; }
      if (p.item && p.item.type === 'bat') { this._startAttack(p, 'bat', ev); return; }
      if (p.item) { this._toss(p, ev); return; }
      // Holding the stick (mostly straight) down means a down-punch, never a grab.
      var victim = (inp.y > 0.5 && Math.abs(inp.x) < 0.5) ? null : this._grabCandidate(p);
      if (victim) { this._startGrab(p, victim, ev); return; }
      // One thing at a time: in boxing gloves you can't hold a bat, bomb or
      // rock (another glove just tops the gloves up).
      var it = this._itemNear(p, p.gloveT > 0 ? 'glove' : null);
      if (it) { this._pickup(p, it, ev); return; }
      // …a bare punch waits to see whether this is a tap (jab) or a hold (smash).
      p.pending = true;
      p.actionHeldT = 0;
      if (inp.action) return;
    }

    if (p.pending) {
      if (!inp.action) {
        p.pending = false;
        var combo = (this.time - p.lastJabAt) < COMBO_WINDOW ? p.combo + 1 : 1;
        p.combo = combo >= 3 ? 0 : combo;
        p.lastJabAt = this.time;
        p.punchArm = 1 - p.punchArm;
        this._startAttack(p, combo >= 3 ? 'finisher' : 'jab', ev);
      } else if (p.actionHeldT >= CHARGE_START) {
        p.pending = false;
        p.charge = 0;
        p.combo = 0;
        p.smashOpen = null;
        p.openAt = -99;
        // The smash is locked to the way the stick pointed when the charge
        // began: you can still shuffle while charging, but the blow can't be
        // re-aimed or turned round.
        p.chargeAim = aimFrom(inp.x, inp.y, p.facing);
        if (p.chargeAim.x !== 0) p.facing = p.chargeAim.x > 0 ? 1 : -1;
        ev.push({ type: 'charge', id: p.id });
      }
    }
    if (p.charge >= 0) {
      p.charge += dt;
      if (!inp.action || p.charge >= CHARGE_AUTO) {
        var c = clamp(p.charge / CHARGE_FULL, 0, 1);
        p.charge = -1;
        this._startAttack(p, 'smash', ev, c, p.chargeAim);
        p.chargeAim = null;
        p.smashOpen = { t0: this.time, c: c, hit: false };
      }
    }
    if (p.attack) {
      var a = p.attack;
      a.t += dt;
      p.anim = this._attackAnim(p);
      // Step into the blow as the strike starts.
      var cfg = ATK[a.type];
      if (!a.lunged && a.spec.t0 !== undefined && a.t >= a.spec.t0) {
        a.lunged = true;
        if (cfg.lunge && p.grounded && Math.abs(a.aim.x) > 0.3) this._addVel(p, sign(a.aim.x) * cfg.lunge * (1 + 0.4 * (a.charge || 0)), 0);
      }
      if (p.anim.active) this._attackHits(p, a, ev, p.anim);
      if (a.t >= a.spec.dur) {
        if (!a.connected && a.type !== 'toss') ev.push({ type: 'whiff', id: p.id, kind: a.type });
        p.attack = null;
        p.anim = null;
      }
    }
  };

  /**
   * The attack animation, as world angles for both arms plus where the fist
   * (or bat) is right now. The pose drives the visible arm to exactly these
   * angles with stiff motors, and the hitbox is built from the same numbers —
   * so a punch lands where and when you see the fist arrive.
   */
  World.prototype._attackAnim = function (p) {
    var a = p.attack, f = p.facing, sp = a.spec, t = a.t;
    var sh = this._shoulder(p);
    var L = ATK[a.type].lean;
    function W(s) { return -f * s; }
    var aimW = dirAngle(a.aim.x, a.aim.y);
    var aimS = -f * aimW;
    if (aimS < -Math.PI / 2) aimS += 2 * Math.PI;
    if (aimS > 1.5 * Math.PI) aimS -= 2 * Math.PI;
    var out = { lean: 0, active: false, hitPts: [], hitR: 0.3, fist: null, bat: null, armF: true, armB: false };
    var k;

    if (a.type === 'bat') return this._batAnim(p, a, sh, out);

    if (a.type === 'toss') {
      k = easeOut(t / 0.12);
      out.uaF = lerp(W(-0.9), aimW, k); out.faF = lerp(W(-0.4), aimW, k);
      out.uaB = W(0.2); out.faB = W(1.6);
      out.lean = L * (k - Math.max(0, (t - 0.12) / 0.18));
      return out;
    }

    // Punches: wind up (cock the arm, lean back) → snap out (elbow straightens,
    // fist drives along the aim, lean in) → brief hold → ease back to guard.
    var guardU = 0.35, guardF = 2.0, cockU = -0.55, cockF = 1.8;
    if (a.type === 'smash') { cockU = -1.0; cockF = 1.4; }
    var startU = a.type === 'smash' ? cockU : guardU, startF = a.type === 'smash' ? cockF : guardF;
    var hold = 0.05, u, fa, ext = 0, lean;
    if (t < sp.t0) {
      k = easeOut(t / sp.t0);
      u = lerp(startU, cockU, k); fa = lerp(startF, cockF, k); lean = -0.4 * L * k;
    } else if (t < sp.t1) {
      k = easeOut((t - sp.t0) / (sp.t1 - sp.t0));
      u = lerp(cockU, aimS, k); fa = lerp(cockF, aimS, k); ext = k; lean = lerp(-0.4 * L, L, k);
    } else if (t < sp.t1 + hold) {
      u = aimS; fa = aimS; ext = 1; lean = L;
    } else {
      k = easeInOut((t - sp.t1 - hold) / Math.max(0.01, sp.dur - sp.t1 - hold));
      u = lerp(aimS, guardU, k); fa = lerp(aimS, guardF, k); ext = 1 - k; lean = L * (1 - k);
    }
    var useBack = a.type === 'jab' && p.punchArm === 1;
    if (useBack) {
      out.uaB = W(u); out.faB = W(fa); out.uaF = W(0.6); out.faF = W(2.2);
      out.armB = true; out.armF = false;
    } else {
      out.uaF = W(u); out.faF = W(fa);
      // The other arm pulls back for balance on the big hits.
      if (a.type === 'jab') { out.uaB = W(0.5); out.faB = W(2.2); }
      else { out.uaB = W(-0.6 * Math.max(ext, 0.3)); out.faB = W(0.5); }
    }
    out.lean = lean;
    var du = limbDir(W(u)), df = limbDir(W(fa));
    var fist = { x: sh.x + du.x * UA_LEN + df.x * FA_LEN, y: sh.y + du.y * UA_LEN + df.y * FA_LEN };
    out.fist = fist;
    out.ext = ext;
    // Live while the fist is driving out and for a beat at full extension. The
    // punch's force reaches a little past the knuckles (its reach stat).
    out.active = t >= sp.t0 && t <= sp.t1 + 0.03 && ext > 0.35;
    if (out.active) {
      var reach = sp.reach * (a.type === 'smash' ? 1 + (a.charge || 0) * 0.1 : 1);
      var extra = Math.max(0, reach - ARM_LEN) * ext;
      out.hitPts = [fist, { x: fist.x + a.aim.x * extra, y: fist.y + a.aim.y * extra }];
    }
    return out;
  };

  /**
   * A two-handed baseball swing: bat cocked back over the shoulder, then swung
   * round through the aim and on into a follow-through over the front
   * shoulder. In this side view the bat foreshortens as it sweeps past the
   * camera. The hitbox is the bat itself, wherever it is that instant.
   */
  World.prototype._batAnim = function (p, a, sh, out) {
    var f = p.facing, sp = a.spec, t = a.t, L = ATK.bat.lean;
    var A = { x: a.aim.x, y: a.aim.y };
    var c1 = { x: -A.y, y: A.x }, c2 = { x: A.y, y: -A.x };
    var P = (Math.abs(c1.y - c2.y) > 1e-6) ? (c1.y < c2.y ? c1 : c2) : (c1.x * f < 0 ? c1 : c2);
    var rest = this._batRest(p, sh);
    var dir, len = 1, grip, lean, k, psi, active = false;
    var back = { x: -A.x + P.x * 0.25, y: -A.y + P.y * 0.25 };
    var bl = Math.hypot(back.x, back.y); back.x /= bl; back.y /= bl;
    var gBack = { x: sh.x - A.x * 0.12, y: sh.y + 0.28 }, gFront = { x: sh.x + A.x * 0.42 + A.y * 0, y: sh.y + 0.22 + A.y * 0.35 };
    if (t < sp.t0) {
      k = easeOut(t / sp.t0);
      dir = { x: lerp(rest.dx, back.x, k), y: lerp(rest.dy, back.y, k) };
      grip = { x: lerp(rest.gx, gBack.x, k), y: lerp(rest.gy, gBack.y, k) };
      lean = -0.35 * L * k;
    } else if (t < sp.t1) {
      k = easeIn((t - sp.t0) / (sp.t1 - sp.t0));
      psi = Math.PI * (1 - k);
      dir = { x: A.x * Math.cos(psi) + P.x * Math.sin(psi) * 0.35, y: A.y * Math.cos(psi) + P.y * Math.sin(psi) * 0.35 };
      grip = { x: lerp(gBack.x, gFront.x, k), y: lerp(gBack.y, gFront.y, k) };
      lean = lerp(-0.35 * L, L, k);
      active = psi < 2.1;
    } else {
      k = easeOut((t - sp.t1) / Math.max(0.01, sp.dur - sp.t1));
      psi = -1.35 * k;
      dir = { x: A.x * Math.cos(psi) + P.x * Math.abs(Math.sin(psi)) * 0.95, y: A.y * Math.cos(psi) + P.y * Math.abs(Math.sin(psi)) * 0.95 };
      grip = { x: lerp(gFront.x, rest.gx, k * 0.6), y: lerp(gFront.y, rest.gy, k * 0.6) };
      lean = L * (1 - k);
      active = psi > -0.3;
    }
    len = Math.hypot(dir.x, dir.y) || 1;
    dir.x /= len; dir.y /= len;
    len = Math.min(1, len);
    var arms = ik(sh.x, sh.y, grip.x, grip.y);
    var arms2 = ik(sh.x, sh.y, grip.x - dir.x * 0.14 * len, grip.y - dir.y * 0.14 * len);
    out.uaF = arms[0]; out.faF = arms[1]; out.uaB = arms2[0]; out.faB = arms2[1];
    out.armF = out.armB = true;
    out.lean = lean;
    out.bat = { gx: grip.x, gy: grip.y, dx: dir.x, dy: dir.y, len: len };
    out.active = active;
    out.hitR = BAT_HIT_R;
    if (active) {
      var r = BAT_LEN * len;
      out.hitPts = [0.45, 0.72, 1].map(function (q) { return { x: grip.x + dir.x * r * q, y: grip.y + dir.y * r * q }; });
    }
    return out;
  };

  /** Bat resting on the back shoulder, held in both hands at the chest. */
  World.prototype._batRest = function (p, sh) {
    var f = p.facing;
    var dx = -f * 0.5, dy = -Math.sqrt(0.75);
    return { gx: sh.x + f * 0.3, gy: sh.y + 0.32, dx: dx, dy: dy, len: 1 };
  };

  World.prototype._startAttack = function (p, type, ev, charge, lockedAim) {
    var aim = lockedAim || aimFrom(p.in.x, p.in.y, p.facing);
    if (aim.x !== 0) p.facing = aim.x > 0 ? 1 : -1;
    p.attack = { type: type, spec: HITS[type], t: 0, aim: aim, hit: {}, connected: false, charge: charge || 0 };
    p.anim = this._attackAnim(p);
    ev.push({ type: 'swing', id: p.id, kind: type, charge: charge || 0 });
  };

  World.prototype._shoulder = function (p) {
    return p.parts.torso.getWorldPoint(Vec2(0, -TORSO_HH + 0.14));
  };

  World.prototype._attackHits = function (p, a, ev, anim) {
    var spec = a.spec;
    var pts = anim.hitPts;
    var fistR = anim.hitR;
    for (var i = 0; i < this.players.length; i++) {
      var v = this.players[i];
      if (v === p || !v.alive || !v.parts || a.hit[v.id] || v.grabbedBy === p) continue;
      // A duck lets straight jabs, finishers and bat swings sail overhead;
      // anything aimed downward (and every smash) still connects.
      if (v.crouch && a.type !== 'smash' && a.aim.y < 0.5) continue;
      var hitAt = null;
      for (var k = 0; k < pts.length && !hitAt; k++) {
        if (this._hurtDist(v, pts[k].x, pts[k].y) < fistR) hitAt = pts[k];
      }
      if (!hitAt) continue;
      a.hit[v.id] = true;
      a.connected = true;
      if (a.type === 'smash' && p.smashOpen) p.smashOpen.hit = true;
      var spec2 = spec, mult = 1;
      if (a.type === 'smash') {
        spec2 = { d: spec.d + 8 * a.charge, base: spec.base + SMASH_BASE_BONUS * a.charge, growth: spec.growth + SMASH_GROWTH_BONUS * a.charge };
      }
      if (p.gloveT > 0 && a.type !== 'bat') { mult = GLOVE_MULT; spec2 = { d: spec2.d + 2, base: spec2.base, growth: spec2.growth, up: spec2.up }; }
      if (this._isSpike(p, v, a)) {
        var sb = SPIKE_V + (a.type === 'smash' ? 5 * a.charge : a.type === 'finisher' ? 1 : 0);
        this._hit(p, v, { d: spec2.d + 3, base: sb, growth: SPIKE_GROWTH }, mult, 0, 1, ev,
          { kind: a.type, spike: true, fixedDir: { x: 0, y: 1 }, x: hitAt.x, y: hitAt.y, charge: a.charge });
        continue;
      }
      this._hit(p, v, spec2, mult, a.aim.x, a.aim.y, ev, { kind: a.type, x: hitAt.x, y: hitAt.y, charge: a.charge });
      if (a.type === 'bat' && p.item && p.item.type === 'bat') {
        p.item.uses--;
        if (p.item.uses <= 0) { p.item = null; ev.push({ type: 'break', id: p.id, x: hitAt.x, y: hitAt.y }); }
      }
    }
  };

  /**
   * A spike: a punch thrown in the air, aimed straight down, that lands on an
   * airborne victim early in its strike — i.e. from right on top of them. A
   * late, full-reach connection is just a normal down hit.
   */
  World.prototype._isSpike = function (p, v, a) {
    if (a.type !== 'jab' && a.type !== 'finisher' && a.type !== 'smash') return false;
    if (p.grounded || v.grounded || a.aim.y < 0.9) return false;
    return a.t <= a.spec.t0 + SPIKE_EARLY * (a.spec.t1 - a.spec.t0);
  };

  /** Distance from a point to a fighter's hurtbox (torso capsule + head). */
  World.prototype._hurtDist = function (v, x, y) {
    var t = v.parts.torso;
    var a = t.getWorldPoint(Vec2(0, -TORSO_HH)), b = t.getWorldPoint(Vec2(0, TORSO_HH));
    var dT = distToSeg(x, y, a.x, a.y, b.x, b.y) - TORSO_HW - 0.05;
    var h = v.parts.head.getPosition();
    var dH = Math.hypot(x - h.x, y - h.y) - HEAD_R;
    return Math.min(dT, dH);
  };

  /**
   * Land a hit: add damage, then launch. Knockback grows with the victim's
   * damage % (Smash-style), so the punch that tickles at 0% sends a battered
   * ragdoll into orbit.
   */
  World.prototype._hit = function (attacker, v, spec, mult, dirX, dirY, ev, opts) {
    if (!v.alive || !v.parts) return;
    opts = opts || {};
    mult = mult || 1;
    v.dmg = Math.min(999, v.dmg + spec.d);
    var kb = (spec.base + spec.growth * v.dmg / 100) * mult;
    var d = opts.fixedDir || this._launchDir(dirX, dirY, v, spec);
    if (v.grabbedBy) this._releaseGrab(v.grabbedBy, false);
    if (v.grabbing) this._releaseGrab(v, false);
    v.attack = null;
    v.charge = -1;
    v.pending = false;
    v.crouch = false;
    v.combo = 0;
    this._setVel(v, d.x * kb, d.y * kb);
    // Flinch: the blow rocks the body back before the upright spring catches it.
    var flinch = Math.min(7, 1.5 + kb * 0.35) * (d.x >= 0 ? 1 : -1);
    v.parts.torso.setAngularVelocity(v.parts.torso.getAngularVelocity() + flinch);
    v.parts.head.setAngularVelocity(v.parts.head.getAngularVelocity() + flinch * 1.4);
    v.lastImpact = kb;
    v.stun = 0.06 + kb * 0.022;
    v.hitAt = this.time;
    v.lastHitKind = opts.kind || 'hit';
    v.flash = 0.12;
    v.spiked = false;
    if (opts.spike) {
      // Knocked limp long enough that recovering from below the ledge is hard.
      v.spiked = true;
      this._startTumble(v, clamp(0.5 + v.dmg * 0.004, 0.5, 1.0));
      if (v.item || v.gloveT > 0) this._dropItem(v);
    }
    if (kb >= TUMBLE_KB) this._startTumble(v, v.stun);
    if (kb >= TUMBLE_KB && (v.item || v.gloveT > 0)) this._dropItem(v);
    if (attacker && attacker !== v) { v.lastHitBy = attacker.id; v.lastHitAt = this.time; v.landedSinceHit = false; }
    else v.lastHitBy = this._creditFor(v);
    var vp = v.parts.torso.getPosition();
    ev.push({
      type: 'hit', id: v.id, by: attacker ? attacker.id : null, kind: opts.kind || 'hit',
      x: opts.x !== undefined ? opts.x : vp.x, y: opts.y !== undefined ? opts.y : vp.y,
      kb: kb, d: spec.d, dmg: v.dmg, dx: d.x, dy: d.y, charge: opts.charge || 0, spike: !!opts.spike,
    });
  };

  World.prototype._launchDir = function (ax, ay, v, spec) {
    var up = spec && spec.up ? spec.up : 0;
    var dx, dy;
    if (ay < -0.5) { dx = ax * 0.35; dy = -1; }
    else if (ay > 0.5) {
      if (v.grounded) { dx = (ax || 0) * 0.6; dy = -0.7; }
      else { dx = ax * 0.3; dy = 1; }
    } else {
      var s = ax === 0 ? 1 : sign(ax);
      var ang = LAUNCH_ANGLE + up;
      dx = s * Math.cos(ang); dy = -Math.sin(ang);
    }
    var l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };

  World.prototype._startTumble = function (p, t) {
    p.tumble = true;
    p.tumbleT = Math.max(p.tumbleT, t);
    p.grounded = false;
    this._setLimbCollision(p, true);
  };

  World.prototype._endTumble = function (p) {
    p.tumble = false;
    p.spiked = false;
    p.tumbleT = 0;
    p.stun = Math.max(p.stun, 0.12);
    p.airJumps = Math.max(p.airJumps, 1);
    this._setLimbCollision(p, false);
  };

  // ---------------- Grabs ----------------
  /**
   * The opening itself: reeling from a hit (jabs excepted, so a jab-jab-
   * finisher chain flows), knocked limp, or just after firing a smash.
   * The same for every grabber, so the dizzy stars mean the same to everyone.
   */
  World.prototype._openNow = function (v) {
    var reeling = (v.stun > 0 || (this.time - v.hitAt) < REEL_SEC) && v.lastHitKind !== 'jab';
    return !!(reeling || v.tumble || this._smashOpen(v));
  };

  /**
   * Can v be grabbed right now (ignoring distance)? Charging always protects —
   * even if an older opening hasn't run out yet. With `grace`, an opening
   * that closed a moment ago still counts (input latency).
   */
  World.prototype._vulnerable = function (v, grace) {
    if (!v.alive || !v.parts || v.grabbedBy || v.grabbing || v.grabImmune > 0 || v.charge >= 0) return false;
    if (this._openNow(v)) return true;
    return !!grace && (this.time - v.openAt) < GRAB_GRACE;
  };

  /** Is v still in the opening after firing a smash? */
  World.prototype._smashOpen = function (v) {
    var o = v.smashOpen;
    if (!o) return false;
    var win = o.hit ? SMASH_OPEN_HIT : SMASH_OPEN_MISS;
    if (this.time - o.t0 < win[0] + (win[1] - win[0]) * o.c) return true;
    v.smashOpen = null;
    return false;
  };

  World.prototype._grabCandidate = function (p) {
    var pos = p.parts.torso.getPosition();
    var best = null, bestD = 1e9;
    for (var i = 0; i < this.players.length; i++) {
      var v = this.players[i];
      if (v === p || !this._vulnerable(v, true)) continue;
      var vp = v.parts.torso.getPosition();
      // Reach well in front, and a little behind (you spin round to grab).
      var fx = (vp.x - pos.x) * p.facing;
      if (fx < -1.0 || fx > 1.8 || Math.abs(vp.y - pos.y) > 1.8) continue;
      var d = Math.hypot(vp.x - pos.x, vp.y - pos.y) + (fx < 0 ? 0.6 : 0);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  };

  World.prototype._startGrab = function (p, v, ev) {
    if (v.tumble) { v.tumble = false; v.tumbleT = 0; this._setLimbCollision(v, false); }
    v.attack = null;
    v.charge = -1;
    v.smashOpen = null;
    v.openAt = -99;
    v.pending = false;
    v.crouch = false;
    v.stun = 0;
    if (v.item || v.gloveT > 0) this._dropItem(v);
    var dxv = v.parts.torso.getPosition().x - p.parts.torso.getPosition().x;
    if (Math.abs(dxv) > 0.05) p.facing = dxv > 0 ? 1 : -1;
    p.attack = null;
    p.pending = false;
    p.grabbing = { victim: v, t: GRAB_TIME };
    v.grabbedBy = p;
    v.grounded = false;
    var vp = v.parts.torso.getPosition();
    ev.push({ type: 'grab', id: p.id, victim: v.id, x: vp.x, y: vp.y });
  };

  World.prototype._carry = function (p, dt, ev) {
    var g = p.grabbing, v = g.victim;
    if (!v.alive || !v.parts) { p.grabbing = null; return; }
    // phi: where the victim dangles around you (0 = in front, -pi/2 = overhead,
    // pi = behind). A throw swings them round the arc, then lets go.
    var phi = 0, K = GRAB_K, C = GRAB_C;
    if (g.throwing) {
      var th = g.throwing;
      th.t += dt;
      var q = th.t / th.dur;
      phi = q < 0.5 ? lerp(th.keys[0], th.keys[1], easeInOut(q * 2)) : lerp(th.keys[1], th.keys[2], easeIn((q - 0.5) * 2));
      K = GRAB_K * 2.2; C = GRAB_C * 1.6;
      if (th.t >= th.dur) { this._releaseThrow(p, ev); return; }
    } else {
      g.t -= dt;
      if (g.t <= 0) {
        this._releaseGrab(p, true);
        ev.push({ type: 'escape', id: v.id, from: p.id });
        return;
      }
    }
    var t = p.parts.torso, pos = t.getPosition(), vel = t.getLinearVelocity();
    var tx = pos.x + p.facing * THROW_R * Math.cos(phi), ty = pos.y - 0.35 + THROW_R * Math.sin(phi);
    var vt = v.parts.torso, vpos = vt.getPosition(), vvel = vt.getLinearVelocity();
    var ax = K * (tx - vpos.x) - C * (vvel.x - vel.x);
    var ay = -G + K * (ty - vpos.y) - C * (vvel.y - vel.y);
    vt.applyForceToCenter(Vec2(ax * v.mass, ay * v.mass), true);
    // The carrier feels the load (but plants their feet for a throw).
    if (!g.throwing) t.applyForceToCenter(Vec2(-ax * v.mass * 0.3, 0), true);
  };

  World.prototype._releaseGrab = function (p, escaped) {
    var g = p.grabbing;
    if (!g) return;
    var v = g.victim;
    p.grabbing = null;
    v.grabbedBy = null;
    v.grabImmune = 0.8;
    if (escaped && v.parts && p.parts) {
      var dir = this.posOf(v).x >= this.posOf(p).x ? 1 : -1;
      this._setVel(v, dir * 7, -5);
      this._addVel(p, -dir * 4, 0);
      p.stun = Math.max(p.stun, 0.25);
    }
  };

  /**
   * Start a throw. The stick picks the direction relative to the way you face
   * (forward, back, up, or down for a slam); the victim is swung round you on a
   * short arc first so everyone can see it coming.
   */
  World.prototype._throwVictim = function (p, ev) {
    var g = p.grabbing;
    if (!g || g.throwing) return;
    var x = p.in.x * p.facing, y = p.in.y, dir;
    if (y < -0.5 && Math.abs(x) < 0.7) dir = 'u';
    else if (y > 0.5 && Math.abs(x) < 0.7) dir = 'd';
    else if (x < -0.3) dir = 'b';
    else dir = 'f';
    // [start, wind-up, release] angles around the thrower, and duration.
    var T = { f: [0, -1.35, 0.2, 0.2], b: [0, -1.6, -Math.PI, 0.24], u: [0, 0.55, -1.57, 0.18], d: [0, -1.57, 1.05, 0.22] }[dir];
    g.throwing = { dir: dir, t: 0, dur: T[3], keys: [T[0], T[1], T[2]] };
    ev.push({ type: 'throwStart', id: p.id, victim: g.victim.id, dir: dir });
  };

  World.prototype._releaseThrow = function (p, ev) {
    var g = p.grabbing, v = g.victim, dir = g.throwing.dir, f = p.facing;
    var pv = p.parts.torso.getLinearVelocity();
    this._releaseGrab(p, false);
    v.grabImmune = 0.5;
    var spec = dir === 'b' ? HITS.throwB : dir === 'u' ? HITS.throwU : dir === 'd' ? HITS.slam : HITS.throwF;
    var ang = 40 * Math.PI / 180, fd;
    if (dir === 'u') fd = { x: 0.08 * f, y: -1 };
    else if (dir === 'd') fd = { x: 0.15 * f, y: -1 };   // slammed into the floor, bounces up
    else fd = { x: (dir === 'b' ? -f : f) * Math.cos(ang), y: -Math.sin(ang) };
    var l = Math.hypot(fd.x, fd.y); fd.x /= l; fd.y /= l;
    ev.push({ type: 'throw', id: p.id, victim: v.id, dir: dir });
    this._hit(p, v, spec, 1, fd.x, fd.y, ev, { kind: dir === 'd' ? 'slam' : 'throw', fixedDir: fd });
    // A running throw carries your momentum.
    if (v.parts) this._addVel(v, pv.x * 0.5, 0);
    p.attack = { type: 'toss', spec: HITS.toss, t: 0, aim: { x: fd.x, y: fd.y }, hit: {}, connected: true, charge: 0 };
    p.anim = this._attackAnim(p);
  };

  /**
   * Ids of fighters who are open to a grab right now (for the on-screen cue),
   * wherever they are on the stage.
   */
  World.prototype.grabbableIds = function () {
    var out = {};
    for (var i = 0; i < this.players.length; i++) {
      if (this._vulnerable(this.players[i], false)) out[this.players[i].id] = true;
    }
    return out;
  };

  // ---------------- Items ----------------
  World.prototype._updateItemSpawns = function (dt, ev) {
    this.itemTimer -= dt;
    if (this.itemTimer > 0) return;
    this.itemTimer = 8 + this.rng() * 6;
    if (this.itemList.length >= ITEM_MAX) return;
    var spot = this._itemSpot();
    if (!spot) { this.itemTimer = 1.5; return; }   // nowhere safe right now — try again soon
    var type = ITEM_TYPES[Math.floor(this.rng() * ITEM_TYPES.length)];
    this._spawnItem(type, spot.x, spot.y, 0, 0, 'ground', null);
    ev.push({ type: 'itemSpawn', item: type, x: spot.x, y: spot.y });
  };

  /**
   * A safe resting place for a new item: on top of real ground or a floating
   * platform (never a crumbly bridge plank), clear of the edges, inside the
   * current blast zone, above any lava, and not on top of a fighter or another
   * item. Returns the item's centre, or null if nowhere is safe right now.
   */
  World.prototype._itemSpot = function () {
    var spans = this.groundSpans().filter(function (s) { return !s.crumbly && s.x1 - s.x0 >= 2.5; });
    if (!spans.length) return null;
    var total = 0, i;
    for (i = 0; i < spans.length; i++) total += spans[i].x1 - spans[i].x0;
    for (var tries = 0; tries < 16; tries++) {
      var r = this.rng() * total, sp = spans[0];
      for (i = 0; i < spans.length; i++) { r -= spans[i].x1 - spans[i].x0; if (r <= 0) { sp = spans[i]; break; } }
      var x = sp.x0 + 1 + this.rng() * (sp.x1 - sp.x0 - 2);
      if (x < this.blast.x0 + 3 || x > this.blast.x1 - 3) continue;
      // Find the real surface right now (the ship's deck tilts).
      var top = null;
      this.pw.rayCast(Vec2(x, sp.y - 1.5), Vec2(x, sp.y + 1.5), function (fix, point, normal, fraction) {
        var ud = fix.getUserData();
        if (!ud || (ud.kind !== 'solid' && ud.kind !== 'platform') || ud.tile) return -1;
        top = point.y;
        return fraction;
      });
      if (top === null) continue;
      if (this.lavaY !== null && top > this.lavaY - 1) continue;
      var y = top - ITEM_R - 0.01;
      var clear = true;
      for (i = 0; i < this.players.length && clear; i++) {
        var p = this.players[i];
        if (!p.alive || !p.parts) continue;
        var q = p.parts.torso.getPosition();
        if (Math.abs(q.x - x) < 1.6 && Math.abs(q.y - y) < 2.5) clear = false;
      }
      for (i = 0; i < this.itemList.length && clear; i++) {
        var b = this.itemList[i].body;
        if (b && Math.hypot(b.getPosition().x - x, b.getPosition().y - y) < 1.5) clear = false;
      }
      if (clear) return { x: x, y: y };
    }
    return null;
  };

  World.prototype._spawnItem = function (type, x, y, vx, vy, state, owner) {
    // An item lying around doesn't roll (so it stays put on the rocking deck);
    // a thrown one tumbles through the air.
    var body = this.pw.createBody({ type: 'dynamic', position: Vec2(x, y), bullet: true, angularDamping: 0.6, fixedRotation: state === 'ground' });
    var it = { type: type, body: body, state: state, owner: owner, age: 0, thrownT: 0, fuse: BOMB_FUSE, uses: type === 'bat' ? BAT_USES : type === 'rock' ? ROCK_USES : 1 };
    body.createFixture(planck.Circle(ITEM_R), {
      density: type === 'rock' ? 4 : 1, friction: 0.6, restitution: type === 'bomb' ? 0.45 : 0.25,
      filterCategoryBits: CAT_ITEM, filterMaskBits: CAT_GROUND, userData: { item: it },
    });
    body.setUserData({ item: it });
    body.setLinearVelocity(Vec2(vx, vy));
    this.itemList.push(it);
    return it;
  };

  World.prototype._removeItem = function (it) {
    var idx = this.itemList.indexOf(it);
    if (idx >= 0) this.itemList.splice(idx, 1);
    if (it.body) { this._kill.push({ body: it.body }); it.body = null; }
  };

  World.prototype._itemNear = function (p, onlyType) {
    var pos = p.parts.torso.getPosition();
    var best = null, bestD = 1e9;
    for (var i = 0; i < this.itemList.length; i++) {
      var it = this.itemList[i];
      if (it.state !== 'ground' || !it.body || (onlyType && it.type !== onlyType)) continue;
      var ip = it.body.getPosition();
      var dx = Math.abs(ip.x - pos.x);
      if (dx > 1.4 || ip.y < pos.y - TORSO_HH - 1 || ip.y > pos.y + STAND_H + 0.5) continue;
      if (dx < bestD) { bestD = dx; best = it; }
    }
    return best;
  };

  World.prototype._pickup = function (p, it, ev) {
    var ip = it.body.getPosition();
    ev.push({ type: 'pickup', id: p.id, item: it.type, x: ip.x, y: ip.y });
    this._removeItem(it);
    if (it.type === 'glove') { p.gloveT = Math.max(p.gloveT, it.gloveT || GLOVE_TIME); return; }
    p.item = { type: it.type, uses: it.uses };
  };

  World.prototype.handPoint = function (p) {
    var sh = this._shoulder(p);
    return { x: sh.x + p.facing * 0.7, y: sh.y + 0.25 };
  };

  /**
   * Knocked limp or grabbed: whatever you're holding falls out of your hands —
   * boxing gloves included (they keep their remaining time for whoever picks
   * them up next).
   */
  World.prototype._dropItem = function (p) {
    if (!p.parts) { p.item = null; p.gloveT = 0; return; }
    var h = this.handPoint(p);
    if (p.item) {
      var it = this._spawnItem(p.item.type, h.x, h.y, 0, -3, 'ground', null);
      it.uses = p.item.uses;
    }
    if (p.gloveT > 0.5) {
      var g = this._spawnItem('glove', h.x - p.facing * 0.3, h.y, -p.facing * 1.5, -3, 'ground', null);
      g.gloveT = p.gloveT;
    }
    p.item = null;
    p.gloveT = 0;
  };

  World.prototype._toss = function (p, ev) {
    var aim = aimFrom(p.in.x, p.in.y, p.facing);
    if (aim.x !== 0) p.facing = aim.x > 0 ? 1 : -1;
    var h = this.handPoint(p);
    var v = p.parts.torso.getLinearVelocity();
    var speed = p.item.type === 'rock' ? 15 : 17;
    var vx = aim.x * speed + v.x * 0.4;
    var vy = aim.y * speed - (aim.y > 0.5 ? 0 : 4);
    var it = this._spawnItem(p.item.type, h.x, h.y, vx, vy, 'thrown', p);
    // Each throw spends one charge; a rock with charges left stays in hand.
    // (A thrown rock that misses lands as a one-throw rock.)
    it.uses = 1;
    if (p.item.uses > 1) p.item.uses--;
    else p.item = null;
    p.attack = { type: 'toss', spec: HITS.toss, t: 0, aim: aim, hit: {}, connected: true, charge: 0 };
    ev.push({ type: 'toss', id: p.id, item: it.type });
  };

  World.prototype._updateItems = function (dt, ev) {
    var list = this.itemList.slice();
    var b = this.blast;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it.body) continue;
      it.age += dt;
      var pos = it.body.getPosition(), vel = it.body.getLinearVelocity();
      // Wind only pushes items in flight — anything lying on the stage stays put.
      if (it.state === 'thrown' && this.wind && Math.abs(this.wind.accel) > 0.05) it.body.applyForceToCenter(Vec2(this.wind.accel * it.body.getMass() * 0.6, 0), true);
      var inLava = this.lavaY !== null && pos.y > this.lavaY;
      if (pos.x < b.x0 || pos.x > b.x1 || pos.y > b.y1 + 2 || inLava) {
        if (inLava) ev.push({ type: 'sizzle', x: pos.x, y: this.lavaY });
        this._removeItem(it);
        continue;
      }
      if (it.state === 'ground') {
        if (it.age > ITEM_LIFE) { ev.push({ type: 'poof', x: pos.x, y: pos.y }); this._removeItem(it); }
        continue;
      }
      // Thrown.
      it.thrownT += dt;
      if (it.type === 'bomb') {
        it.fuse -= dt;
        if (it.fuse <= 0) { this._explode(it, ev); continue; }
      }
      var hitV = null;
      for (var k = 0; k < this.players.length; k++) {
        var v = this.players[k];
        if (!v.alive || !v.parts) continue;
        if (v === it.owner) continue;   // your own throw never hits you
        // Flat throws fly over a duck; lobbed or falling ones still land.
        if (v.crouch && Math.abs(vel.y) < Math.abs(vel.x)) continue;
        if (this._hurtDist(v, pos.x, pos.y) < ITEM_R + 0.05) { hitV = v; break; }
      }
      var sp = Math.hypot(vel.x, vel.y);
      if (hitV) {
        if (it.type === 'bomb') { this._explode(it, ev); continue; }
        if (sp > 4) {
          var dx = vel.x / sp, dy = vel.y / sp;
          var spec = it.type === 'rock' ? HITS.rock : { d: 6, base: 6, growth: 10 };
          this._hit(it.owner, hitV, spec, 1, Math.abs(dx) > 0.3 ? sign(dx) : 0, dy < -0.5 ? -1 : (dy > 0.5 ? 1 : 0), ev, { kind: it.type, x: pos.x, y: pos.y });
          ev.push({ type: 'shatter', item: it.type, x: pos.x, y: pos.y });
          this._removeItem(it);
          continue;
        }
      }
      // It only settles once it's come to rest on something — the slow
      // top of a high lob is still a live throw.
      if (it.thrownT > 0.4 && sp < 3 && this._itemTouching(it)) { it.state = 'ground'; it.owner = null; it.age = 0; it.body.setFixedRotation(true); it.body.setAngularVelocity(0); }
    }
  };

  World.prototype._itemTouching = function (it) {
    for (var ce = it.body.getContactList(); ce; ce = ce.next) {
      if (ce.contact.isTouching()) return true;
    }
    return false;
  };

  World.prototype._explode = function (it, ev) {
    var pos = it.body.getPosition();
    var cx = pos.x, cy = pos.y;
    ev.push({ type: 'explode', x: cx, y: cy, r: BOMB_R });
    for (var i = 0; i < this.players.length; i++) {
      var v = this.players[i];
      if (!v.alive || !v.parts) continue;
      var vp = v.parts.torso.getPosition();
      var d = Math.hypot(vp.x - cx, vp.y - cy);
      if (d > BOMB_R) continue;
      var k = 1 - 0.5 * d / BOMB_R;
      var dx = (vp.x - cx) / (d || 1), dy = (vp.y - cy) / (d || 1) - 0.8;
      var l = Math.hypot(dx, dy) || 1;
      var spec = { d: Math.round(HITS.bomb.d * k), base: HITS.bomb.base * k, growth: HITS.bomb.growth * k };
      this._hit(it.owner, v, spec, 1, 0, 0, ev, { kind: 'bomb', fixedDir: { x: dx / l, y: dy / l } });
    }
    this._removeItem(it);
  };

  // ---------------- After physics ----------------
  World.prototype._updateAabb = function (p) {
    if (!p.alive || !p.parts) return;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < p.partList.length; i++) {
      var q = p.partList[i].getPosition();
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
    var a = p.aabb;
    a.x0 = x0 - 0.2; a.x1 = x1 + 0.2; a.y0 = y0 - 0.3; a.y1 = y1 + 0.25;
  };

  World.prototype._checkHazards = function (ev) {
    var r = this.roller;
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.alive || !p.parts) continue;
      if (p.tumble && this.tiles.length) this._slamTiles(p);
      if (p.hazardCd > 0) continue;
      if (r && r.state === 'roll' && circleHitsBox(r.x, r.cfg.y, r.cfg.r, p.aabb)) {
        p.hazardCd = 0.7;
        var pos = p.parts.torso.getPosition();
        var away = Math.abs(pos.x - r.x) < 0.2 ? r.dir : (pos.x >= r.x ? 1 : -1);
        this._hit(null, p, HITS.spike, 1, away, 0, ev, { kind: 'spike', fixedDir: { x: away * 0.45, y: -0.89 } });
        continue;
      }
      if (this.lavaY !== null && p.aabb.y1 - 0.25 > this.lavaY) {
        p.hazardCd = 0.5;
        var pp = p.parts.torso.getPosition();
        this._hit(null, p, HITS.lava, 1, 0, -1, ev, { kind: 'lava', fixedDir: { x: 0, y: -1 }, x: pp.x, y: this.lavaY });
      }
    }
  };

  World.prototype._slamTiles = function (p) {
    var v = p.parts.torso.getLinearVelocity();
    if (p.tileCd > this.time || v.y < -1) return;
    for (var k = 0; k < this.tiles.length; k++) {
      var t = this.tiles[k];
      if (t.state !== 'solid' || p.aabb.x1 < t.x0 || p.aabb.x0 > t.x1) continue;
      if (Math.abs(p.aabb.y1 - t.y0) > 0.45) continue;
      t.load += 0.55 + Math.min(0.6, Math.abs(p.lastImpact || 0) / 40);
      p.tileCd = this.time + 0.5;
      return;
    }
  };

  /**
   * Who gets the KO: the last fighter to hit you, as long as you haven't
   * landed since (however long you spent clinging to a wall) — or, if you
   * have, for a few seconds after that hit.
   */
  World.prototype._creditFor = function (p) {
    if (!p.lastHitBy) return null;
    return (!p.landedSinceHit || this.time - p.lastHitAt < KO_CREDIT_SEC) ? p.lastHitBy : null;
  };

  World.prototype._checkKOs = function (ev) {
    var b = this.blast;
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.alive || !p.parts) continue;
      var pos = p.parts.torso.getPosition();
      if (pos.x >= b.x0 && pos.x <= b.x1 && pos.y >= b.y0 && pos.y <= b.y1) continue;
      var vel = p.parts.torso.getLinearVelocity();
      p.alive = false;
      p.diedAt = this.time;
      p.killedBy = this._creditFor(p);
      p.koPos = { x: clamp(pos.x, b.x0, b.x1), y: clamp(pos.y, b.y0, b.y1) };
      if (p.grabbing) this._releaseGrab(p, false);
      if (p.grabbedBy) this._releaseGrab(p.grabbedBy, false);
      p.item = null;
      p.attack = null;
      p.charge = -1;
      p.pending = false;
      var side = pos.x < b.x0 ? 'left' : pos.x > b.x1 ? 'right' : pos.y < b.y0 ? 'top' : 'bottom';
      ev.push({ type: 'ko', id: p.id, by: p.killedBy, x: p.koPos.x, y: p.koPos.y, side: side, vx: vel.x, vy: vel.y });
      this._kill.push({ fighter: p });
    }
  };

  // ---------------- Posing (joint motors) ----------------
  function drive(j, target, torque, maxSpd) {
    var err = wrapPi(target - j.getJointAngle());
    var m = maxSpd || 26;
    j.setMaxMotorTorque(torque);
    j.setMotorSpeed(clamp(err * (maxSpd ? 45 : 20), -m, m));
  }

  /**
   * Point every limb toward a target world angle. Poses are written as a
   * "swing from hanging straight down toward the facing side", so one table
   * serves both facings: world angle = -facing × swing.
   */
  World.prototype._pose = function (p, mode) {
    var j = p.joints, f = p.facing;
    var torsoA = p.parts.torso.getAngle();
    function W(swing) { return -f * swing; }
    if (mode === 'limp') {
      p.bat = null;
      var limp = p.grabbedBy ? 0.35 : 0.12;
      for (var k in j) { if (k === 'neck') continue; j[k].setMaxMotorTorque(limp); j[k].setMotorSpeed(0); }
      drive(j.neck, 0, 0.6);
      return;
    }
    var ARM = 4.5, LEG = 6;
    var uaF, faF, uaB, faB, thF, shF, thB, shB;
    var ph = p.walkPh, s = Math.sin(ph);
    var vel = p.parts.torso.getLinearVelocity();
    var moving = mode === 'ground' && Math.abs(vel.x - ((p.ground && p.ground.vx) || 0)) > 0.6;

    if (mode === 'ground' && p.crouch) {
      // Squat: knees forward, feet back, fists up by the face.
      thF = W(1.3); shF = W(-1.1);
      thB = W(1.05); shB = W(-1.35);
      uaF = W(0.9); faF = W(2.6);
      uaB = W(0.7); faB = W(2.4);
    } else if (mode === 'ground') {
      if (moving) {
        var a = 0.62 * s;
        thF = W(a); thB = W(-a);
        shF = W(a - 0.15 - 0.9 * Math.max(0, Math.cos(ph)));
        shB = W(-a - 0.15 - 0.9 * Math.max(0, -Math.cos(ph)));
      } else {
        thF = W(0.22); shF = W(0.06);
        thB = W(-0.2); shB = W(-0.3);
      }
      var sw = moving ? -0.55 * s : 0;
      uaF = W(0.35 + sw); faF = W(2.0 + sw * 0.5);
      uaB = W(0.15 - sw); faB = W(1.8 - sw * 0.5);
    } else {
      var rising = vel.y < 0;
      thF = W(rising ? 1.0 : 0.55); shF = W(rising ? 0.1 : 0.2);
      thB = W(rising ? 0.2 : -0.25); shB = W(rising ? -0.6 : -0.45);
      uaF = W(rising ? 2.3 : 1.5); faF = W(rising ? 2.7 : 1.9);
      uaB = W(rising ? -2.0 : -1.3); faB = W(rising ? -2.4 : -1.6);
    }

    var a2 = p.attack;
    var stiffF = false, stiffB = false;
    var sh = this._shoulder(p);
    p.bat = null;
    if (a2 && p.anim) {
      // Mid-attack the arms follow the attack animation exactly (stiff motors),
      // because that animation is also where the hitbox is.
      uaF = p.anim.uaF; faF = p.anim.faF; uaB = p.anim.uaB; faB = p.anim.faB;
      stiffF = p.anim.armF; stiffB = p.anim.armB;
      if (p.anim.bat) p.bat = p.anim.bat;
    } else if (p.charge >= 0) {
      // Charging: lead fist cocked way back, other hand up in guard.
      var wob = Math.sin(this.time * 40) * 0.06 * clamp(p.charge, 0, 1);
      uaF = W(-1.0 + wob); faF = W(1.4 + wob);
      uaB = W(0.9); faB = W(2.2);
      stiffF = true;
    } else if (p.grabbing && p.grabbing.victim.parts) {
      // Both hands on the victim.
      var vp = p.grabbing.victim.parts.torso.getPosition();
      var gx = vp.x - sh.x, gy = vp.y - sh.y, gl = Math.hypot(gx, gy) || 1;
      var rr = Math.min(gl, ARM_LEN - 0.02);
      var r1 = ik(sh.x, sh.y, sh.x + gx / gl * rr, sh.y + gy / gl * rr);
      var r2 = ik(sh.x, sh.y, sh.x + gx / gl * rr * 0.85, sh.y + gy / gl * rr * 0.85 + 0.1);
      uaF = r1[0]; faF = r1[1]; uaB = r2[0]; faB = r2[1];
      stiffF = stiffB = !!p.grabbing.throwing;
    } else if (p.item && p.item.type === 'bat') {
      // Bat resting on the shoulder, both hands on the handle.
      var rest = this._batRest(p, sh);
      var b1 = ik(sh.x, sh.y, rest.gx, rest.gy);
      var b2 = ik(sh.x, sh.y, rest.gx - rest.dx * 0.14, rest.gy - rest.dy * 0.14);
      uaF = b1[0]; faF = b1[1]; uaB = b2[0]; faB = b2[1];
      p.bat = rest;
    } else if (p.item) {
      uaF = W(0.9); faF = W(1.9);
    }

    var tq = p.stun > 0 ? 0.5 : 1;
    // Children are driven relative to their TARGET parent angle, so a pose is
    // reached cleanly instead of chasing a parent that is still swinging.
    var tF = stiffF ? ATK_ARM_TORQUE : ARM * tq, tB = stiffB ? ATK_ARM_TORQUE : ARM * tq;
    var sF = stiffF ? ATK_ARM_SPEED : 0, sB = stiffB ? ATK_ARM_SPEED : 0;
    drive(j.shF, uaF - torsoA, tF, sF); drive(j.elF, faF - uaF, tF * 0.8, sF);
    drive(j.shB, uaB - torsoA, tB, sB); drive(j.elB, faB - uaB, tB * 0.8, sB);
    drive(j.hipF, thF - torsoA, LEG * tq); drive(j.knF, shF - thF, LEG * 0.8 * tq);
    drive(j.hipB, thB - torsoA, LEG * tq); drive(j.knB, shB - thB, LEG * 0.8 * tq);
    drive(j.neck, 0, 1.2);
  };

  // ---------------- Exports ----------------
  global.RagdollRumble = {
    World: World,
    STAGES: STAGES, spawnPoint: spawnPoint,
    STAGE_IDS: STAGE_IDS,
    HITS: HITS,
    ITEM_TYPES: ITEM_TYPES,
    TORSO_HW: TORSO_HW, TORSO_HH: TORSO_HH, HEAD_R: HEAD_R,
    UA_HW: UA_HW, FA_HW: FA_HW, TH_HW: TH_HW, SH_HW: SH_HW,
    UA_HH: UA_HH, FA_HH: FA_HH, TH_HH: TH_HH, SH_HH: SH_HH,
    LEG_GAP: LEG_GAP, STAND_H: STAND_H, CROUCH_DROP: CROUCH_DROP, FIGHTER_H: FIGHTER_H,
    MOVE_SPEED: MOVE_SPEED, JUMP_V: JUMP_V, AIR_JUMP_V: AIR_JUMP_V, AIR_JUMPS: AIR_JUMPS, WALL_JUMPS: WALL_JUMPS, WALL_KICK_Y: WALL_KICK_Y, WALL_SLIDE: WALL_SLIDE, G: G,
    TUMBLE_KB: TUMBLE_KB, SPIKE_EARLY: SPIKE_EARLY, SPIKE_V: SPIKE_V, REEL_SEC: REEL_SEC, GRAB_GRACE: GRAB_GRACE, CHARGE_JUMP: CHARGE_JUMP, SMASH_OPEN_MISS: SMASH_OPEN_MISS, SMASH_OPEN_HIT: SMASH_OPEN_HIT, CHARGE_FULL: CHARGE_FULL, CHARGE_START: CHARGE_START, CHARGE_AUTO: CHARGE_AUTO, BAT_LEN: BAT_LEN,
    GRAB_TIME: GRAB_TIME, GLOVE_TIME: GLOVE_TIME, ROCK_USES: ROCK_USES, BOMB_R: BOMB_R, ITEM_R: ITEM_R,
    SD_SHRINK_SEC: SD_SHRINK_SEC,
    aimFrom: aimFrom,
    mulberry32: mulberry32,
  };
})(typeof window !== 'undefined' ? window : globalThis);
