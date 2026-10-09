/* Snake Party — game engine (runs on the HOST browser; also loadable in Node
 * via a window/global shim for the headless test).
 *
 * Grid world bounded by deadly edges: a head that would leave the board dies
 * on the spot (no wrapping). The engine is tick-based: every call to
 * step() advances every living snake exactly one cell. The host decides WHEN to
 * step (that is how the speed ramps up), so the engine itself is deterministic
 * and never reads a clock.
 *
 * Movement is simultaneous: every snake picks its next cell first, then all
 * collisions are judged against the post-move board, so nobody gets an
 * advantage from update order. A tail that moves away this tick is a free cell;
 * two heads landing on the same cell (or swapping cells) kill both snakes, and
 * a head driven off the board dies at the edge.
 *
 * Moves are split into SUB sub-ticks: the host calls substep() SUB times per
 * normal move. A normal snake moves every SUB sub-ticks and a Phantom snake
 * every PHANTOM_PERIOD, which makes Phantom exactly SUB / PHANTOM_PERIOD times
 * faster with an even pace. step() is one full normal move (SUB sub-ticks).
 *
 * Power-ups (multiplayer): pickups sit on the board like food.
 *   • Magnet — apples and golden apples within MAGNET_RANGE drift toward the
 *     head, one cell per move, into open cells only (or straight into the head).
 *   • Phantom — faster, and the head passes through walls and every snake
 *     (its own body too); other snakes pass through it as well. Edges still
 *     kill. When it ends the speed drops at once, but the snake stays ghosted
 *     until its head is in an open cell, so it never dies the instant it ends.
 * Only heads ever crash: a body left lying across a wall or another snake
 * after Phantom is harmless, and solid again for everyone else.
 *
 * Human snakes start each round WAITING: they hold still on their spawn until
 * their player's first turn input (or until the host releases them), so a
 * player who is still picking their phone back up isn't driven into a wall.
 * A waiting snake is a solid obstacle for everyone else.
 */
(function (global) {
  'use strict';

  // Direction indices: 0=up 1=down 2=left 3=right (mirrors the player relay).
  const DIRS = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
  const REVERSE = [1, 0, 3, 2];

  const START_LEN = 3;
  const MAX_QUEUE = 3;          // buffered turns (lets "up, left" taps both land)
  const APPLE_SAFE_DIST = 3;    // never spawn an apple right in front of a head
  const SPECIAL_VALUE = 5;      // a crashed snake leaves one special apple worth this much length
  const SUB = 6;                // sub-ticks per normal move
  const PHANTOM_PERIOD = 5;     // sub-ticks per Phantom move (SUB / 5 = 1.2× speed)
  const MAGNET_RANGE = 3;       // Magnet pulls food within this many cells (Chebyshev)
  const MAGNET_STEPS = 2;       // cells a pulled apple moves per magnet-snake move (faster than the snake)
  const POWER_SAFE_DIST = 4;    // never spawn a power-up right in front of a head

  function World(opts) {
    opts = opts || {};
    this.maps = opts.maps;
    this.rng = opts.rng || Math.random;
    this.players = [];
    this.byId = new Map();
    this.board = null;
    /** @type {Map<number, {x:number,y:number,kind:string,value?:number}>} */
    this.food = new Map();
    this.tick = 0;
    this.mode = 'multi';
    this.appleTarget = 1;
  }

  World.prototype.setRoster = function (roster) {
    this.players = (roster || []).map(function (r, i) {
      return {
        id: r.id, name: r.name, color: r.color,
        seat: r.seat != null ? r.seat : i,
        isBot: !!r.isBot,
        connected: r.connected !== false,
        body: [], prevBody: [], dir: 3, queue: [],
        alive: true, waiting: false, grow: 0, apples: 0, specials: 0, maxLen: 0,
        cd: SUB, since: 0, period: SUB, phantom: null, magnet: false, powers: 0,
        diedAt: null, deathCause: null, killer: null, finalLength: 0,
      };
    });
    this.byId = new Map(this.players.map(function (p) { return [p.id, p]; }));
  };

  World.prototype.idx = function (x, y) { return y * this.board.w + x; };
  World.prototype.inBounds = function (x, y) { return x >= 0 && y >= 0 && x < this.board.w && y < this.board.h; };

  /** Fresh round on map `mapIndex`. opts.mode: 'solo' (one apple) | 'multi'. */
  World.prototype.reset = function (mapIndex, opts) {
    opts = opts || {};
    this.mode = opts.mode === 'solo' ? 'solo' : 'multi';
    this.board = this.maps.build(mapIndex, this.players.length);
    this.food = new Map();
    this.tick = 0;
    this.sub = 0;
    const spawns = this.board.spawns;
    this.players.forEach(function (p, i) {
      const s = spawns[(p.seat != null ? p.seat : i) % spawns.length];
      const back = DIRS[REVERSE[s.dir]];
      p.body = [];
      for (let k = 0; k < START_LEN; k++) {
        p.body.push({ x: s.x + back.x * k, y: s.y + back.y * k });
      }
      p.prevBody = p.body.map(copyCell);
      p.dir = s.dir;
      p.queue = [];
      p.alive = true;
      p.waiting = !p.isBot;
      p.grow = 0;
      p.apples = 0;
      p.specials = 0;
      p.maxLen = START_LEN;
      p.diedAt = null;
      p.deathCause = null;
      p.killer = null;
      p.finalLength = START_LEN;
      p.cd = SUB; p.since = 0; p.period = SUB;
      p.phantom = null; p.magnet = false; p.powers = 0;
    });
    this.appleTarget = this.mode === 'solo' ? 1 : 2 + this.players.length;
    this.topUpApples();
  };

  /** A player's turn request. Ignores no-ops and instant reversals. The first
   *  input of a round also releases a waiting snake (straight ahead counts). */
  World.prototype.queueDir = function (id, dir) {
    const p = this.byId.get(id);
    if (!p || !p.alive || !(dir >= 0 && dir <= 3)) return false;
    if (p.waiting) {
      if (dir === REVERSE[p.dir]) return false;
      p.waiting = false;
      p.queue = dir === p.dir ? [] : [dir];
      return true;
    }
    const last = p.queue.length ? p.queue[p.queue.length - 1] : p.dir;
    if (dir === last || dir === REVERSE[last]) return false;
    if (p.queue.length >= MAX_QUEUE) return false;
    p.queue.push(dir);
    return true;
  };

  /** Bots steer one move at a time, replacing anything buffered. */
  World.prototype.setBotDir = function (id, dir) {
    const p = this.byId.get(id);
    if (!p || !p.alive) return;
    p.queue = [];
    if (dir >= 0 && dir <= 3 && dir !== p.dir && dir !== REVERSE[p.dir]) p.queue.push(dir);
  };

  /** Start every still-waiting snake moving. Returns the ids released. */
  World.prototype.releaseWaiting = function () {
    const ids = [];
    for (const p of this.players) if (p.alive && p.waiting) { p.waiting = false; ids.push(p.id); }
    return ids;
  };
  World.prototype.anyWaiting = function () {
    return this.players.some(function (p) { return p.alive && p.waiting; });
  };

  World.prototype.clearInputs = function (id) {
    const p = this.byId.get(id);
    if (p) p.queue = [];
  };

  World.prototype.alivePlayers = function () { return this.players.filter(function (p) { return p.alive; }); };
  World.prototype.aliveCount = function () { return this.alivePlayers().length; };
  World.prototype.lengthOf = function (p) { return p.alive ? p.body.length : p.finalLength; };
  World.prototype.lengths = function () {
    const out = {};
    for (const p of this.players) out[p.id] = this.lengthOf(p);
    return out;
  };

  /** Freeze every snake in place (no interpolation left to play out). */
  World.prototype.settle = function () {
    for (const p of this.players) { if (p.alive) p.prevBody = p.body.map(copyCell); p.queue = []; p.since = 0; }
  };

  /** True if this snake moves on the next substep (bots plan just before). */
  World.prototype.willMove = function (p) { return !!(p && p.alive && !p.waiting && p.cd <= 1); };

  /** How far (0..1) a snake is through its current move, for smooth drawing. */
  World.prototype.moveAlpha = function (p, subAlpha) {
    if (!p.alive || p.waiting) return 1;
    return Math.max(0, Math.min(1, (p.since + (subAlpha || 0)) / (p.since + p.cd)));
  };

  // ---- Power-up effects (timed by the host in play-time seconds) ----
  World.prototype.startPhantom = function (id) {
    const p = this.byId.get(id);
    if (!p || !p.alive) return;
    p.phantom = 'on';
    p.period = PHANTOM_PERIOD;
    p.cd = Math.min(p.cd, PHANTOM_PERIOD);
  };
  /** Timer ran out: normal speed now; ghosted until the head is in an open cell. */
  World.prototype.endPhantom = function (id) {
    const p = this.byId.get(id);
    if (!p || p.phantom !== 'on') return;
    p.phantom = 'ending';
    this._resync(p);
    if (this.headClear(p)) p.phantom = null;
  };
  /** The grace period is over: solid again wherever the head is. */
  World.prototype.forceSolid = function (id) {
    const p = this.byId.get(id);
    if (!p || !p.phantom) return;
    if (p.phantom === 'on') this._resync(p);
    p.phantom = null;
  };
  World.prototype.setMagnet = function (id, on) {
    const p = this.byId.get(id);
    if (p) p.magnet = !!on && p.alive;
  };
  // Back to normal speed, moving in step with every other normal snake.
  World.prototype._resync = function (p) {
    p.period = SUB;
    p.cd = SUB - (this.sub % SUB) || SUB;
  };
  /** Head is on an open cell: no wall, no other snake, not its own body. */
  World.prototype.headClear = function (p) {
    if (!p.alive || !p.body.length) return true;
    const h = p.body[0], k = this.idx(h.x, h.y);
    if (this.board.wall[k]) return false;
    for (let i = 1; i < p.body.length; i++) if (p.body[i].x === h.x && p.body[i].y === h.y) return false;
    for (const q of this.players) {
      if (q === p || !q.alive) continue;
      for (const c of q.body) if (c.x === h.x && c.y === h.y) return false;
    }
    return true;
  };

  /** One full normal move for everyone (SUB substeps). Returns all events. */
  World.prototype.step = function () {
    const events = [];
    for (let i = 0; i < SUB; i++) Array.prototype.push.apply(events, this.substep());
    return events;
  };

  /** Advance one sub-tick: snakes whose turn it is move one cell. */
  World.prototype.substep = function () {
    const events = [];
    const b = this.board;
    this.sub++;
    this.tick = this.sub;
    const all = this.alivePlayers();
    const movers = [];
    for (const p of all) {
      if (p.waiting) { p.prevBody = p.body.map(copyCell); continue; }
      p.cd--; p.since++;
      if (p.cd <= 0) movers.push(p);
    }
    if (!movers.length) return events;
    const moving = new Set(movers);

    // 1) Every moving snake commits to a next cell.
    for (const p of movers) {
      while (p.queue.length) {
        const d = p.queue.shift();
        if (d !== p.dir && d !== REVERSE[p.dir]) { p.dir = d; break; }
      }
      p.prevBody = p.body.map(copyCell);
      const h = p.body[0];
      p.next = { x: h.x + DIRS[p.dir].x, y: h.y + DIRS[p.dir].y };
      p.offEdge = !this.inBounds(p.next.x, p.next.y);
      p.tailMoves = p.grow === 0;
    }

    // 2) Solid bodies after the move (old head becomes the neck; moving tails
    //    are freed; snakes not moving this sub-tick keep their whole body).
    //    Ghosted snakes are not solid. A cell can hold more than one body.
    const occ = new Map();
    for (const p of all) {
      if (p.phantom) continue;
      const keep = (moving.has(p) && p.tailMoves) ? p.body.length - 1 : p.body.length;
      for (let i = 0; i < keep; i++) {
        const k = this.idx(p.body[i].x, p.body[i].y);
        if (!occ.has(k)) occ.set(k, []);
        occ.get(k).push(p.id);
      }
    }
    const heads = new Map();
    for (const p of movers) {
      if (p.offEdge || p.phantom) continue;
      const k = this.idx(p.next.x, p.next.y);
      if (!heads.has(k)) heads.set(k, []);
      heads.get(k).push(p.id);
    }

    // 3) Judge collisions. A ghosted head only dies at the edge.
    const dying = [];
    for (const p of movers) {
      let cause = null, killer = null;
      if (p.offEdge) cause = 'edge';
      else if (!p.phantom) {
        const k = this.idx(p.next.x, p.next.y);
        if (b.wall[k]) cause = 'wall';
        else if (occ.has(k)) {
          const ids = occ.get(k);
          killer = ids.find(function (id) { return id !== p.id; }) || p.id;
          cause = killer === p.id ? 'self' : 'snake';
        } else if (heads.get(k).length > 1) { cause = 'headon'; killer = heads.get(k).find(function (id) { return id !== p.id; }) || null; }
      }
      if (cause) { p.deathCause = cause; p.killer = (killer && killer !== p.id) ? killer : null; dying.push(p); }
    }

    // 4) Survivors move, then eat.
    let ateApple = false;
    for (const p of movers) {
      if (dying.indexOf(p) >= 0) continue;
      p.body.unshift(p.next);
      if (p.tailMoves) p.body.pop(); else p.grow--;
      p.cd += p.period; p.since = 0;
      if (this._eat(p, this.idx(p.next.x, p.next.y), events)) ateApple = true;
      p.maxLen = Math.max(p.maxLen, p.body.length + p.grow);
    }
    // A fading Phantom turns solid as soon as its head reaches an open cell.
    for (const p of movers) {
      if (p.phantom === 'ending' && dying.indexOf(p) < 0 && this.headClear(p)) {
        p.phantom = null;
        events.push({ type: 'solid', id: p.id });
      }
    }

    // 5) Crashed snakes stay where they were and break up, leaving one golden
    //    apple — on the tail if it's open, else the first open body cell
    //    working toward the head, else the nearest open cell to the tail. It
    //    never lands in a wall, on a snake or on other food.
    const occupiedNow = new Set();
    for (const p of all) {
      if (dying.indexOf(p) >= 0) continue;
      for (const c of p.body) occupiedNow.add(this.idx(c.x, c.y));
    }
    for (const p of dying) {
      p.alive = false;
      p.diedAt = this.tick;
      p.finalLength = p.body.length;
      p.prevBody = p.body.map(copyCell);
      p.queue = [];
      p.phantom = null; p.magnet = false;
      const cells = p.body.map(copyCell);
      let special = null;
      if (this.mode === 'multi') {
        const self = this;
        const open = function (x, y) {
          if (!self.inBounds(x, y)) return false;
          const k = self.idx(x, y);
          return !b.wall[k] && !occupiedNow.has(k) && !self.food.has(k);
        };
        let spot = null;
        for (let i = cells.length - 1; i >= 0 && !spot; i--) if (open(cells[i].x, cells[i].y)) spot = cells[i];
        if (!spot) spot = this._nearestOpen(cells[cells.length - 1], open);
        if (spot) {
          special = { x: spot.x, y: spot.y, kind: 'special', value: SPECIAL_VALUE };
          this.food.set(this.idx(spot.x, spot.y), special);
        }
      }
      events.push({
        type: 'death', id: p.id, color: p.color, cause: p.deathCause, killer: p.killer,
        cells: cells, x: cells[0].x, y: cells[0].y, length: p.finalLength,
        special: special ? { x: special.x, y: special.y, value: special.value } : null,
      });
      p.body = [];
      p.prevBody = [];
    }

    // 6) Magnets pull nearby apples one cell toward the head of each magnet
    //    snake that just moved.
    if (this._pull(movers.filter(function (p) { return p.alive && p.magnet; }), events)) ateApple = true;

    if (ateApple) this.topUpApples();
    return events;
  };

  // Eat whatever is on cell k (if anything). Returns true if it was an apple.
  World.prototype._eat = function (p, k, events) {
    const f = this.food.get(k);
    if (!f) return false;
    this.food.delete(k);
    if (f.kind === 'power') {
      p.powers++;
      events.push({ type: 'power', id: p.id, power: f.power, x: f.x, y: f.y });
      return false;
    }
    p.grow += f.value || 1;
    if (f.kind === 'apple') p.apples++; else p.specials++;
    events.push({ type: 'eat', id: p.id, kind: f.kind, value: f.value || 1, x: f.x, y: f.y, color: f.kind === 'apple' ? '#EF4444' : SPECIAL_COLOR });
    return f.kind === 'apple';
  };

  // Nearest open cell to `from` (rings outward, through walls). Null if none.
  World.prototype._nearestOpen = function (from, open) {
    const b = this.board;
    const seen = new Uint8Array(b.w * b.h);
    const q = [[from.x, from.y]];
    if (this.inBounds(from.x, from.y)) seen[this.idx(from.x, from.y)] = 1;
    for (let i = 0; i < q.length; i++) {
      const x = q[i][0], y = q[i][1];
      if (open(x, y)) return { x: x, y: y };
      for (const d of DIRS) {
        const nx = x + d.x, ny = y + d.y;
        if (!this.inBounds(nx, ny)) continue;
        const k = this.idx(nx, ny);
        if (seen[k]) continue;
        seen[k] = 1; q.push([nx, ny]);
      }
    }
    return null;
  };

  // Magnet pull. Each apple / golden apple in range goes toward the nearest
  // magnet head (a tie between two magnets leaves it put), on that snake's
  // moves only, MAGNET_STEPS cells per move so it can catch a moving snake.
  // Each step closes the sideways gap (across the snake's heading) first, so
  // apples curve in rather than running alongside. It moves into open cells
  // only; reaching the head — or touching the magnet snake's own body — sucks
  // it in (eaten). Never through walls, other snakes or other food. Power-ups
  // are never pulled.
  World.prototype._pull = function (pullers, events) {
    if (!pullers.length) return false;
    const magnets = this.players.filter(function (p) { return p.alive && p.magnet && p.body.length; });
    const owner = new Map();               // cell -> id of the snake whose body is there
    for (const p of this.players) if (p.alive) for (const c of p.body) owner.set(this.idx(c.x, c.y), p.id);
    const items = [];
    this.food.forEach(function (f) { if (f.kind === 'apple' || f.kind === 'special') items.push(f); });
    let ateApple = false;
    for (const f of items) {
      let best = null, bestD = Infinity, tie = false;
      for (const m of magnets) {
        // In range of the head now OR where it was before this move, so an
        // apple at the back edge isn't lost just because the snake moved first.
        const h = m.body[0], ph = (m.prevBody && m.prevBody[0]) || h;
        const d = Math.min(Math.max(Math.abs(h.x - f.x), Math.abs(h.y - f.y)), Math.max(Math.abs(ph.x - f.x), Math.abs(ph.y - f.y)));
        if (d > MAGNET_RANGE) continue;
        if (d < bestD) { bestD = d; best = m; tie = false; } else if (d === bestD) tie = true;
      }
      if (!best || tie || pullers.indexOf(best) < 0) continue;
      const h = best.body[0];
      const horiz = best.dir === 2 || best.dir === 3;   // heading left/right → close dy first
      for (let step = 0; step < MAGNET_STEPS; step++) {
        const gx = h.x - f.x, gy = h.y - f.y;
        if (!gx && !gy) break;
        const sx = [Math.sign(gx), 0], sy = [0, Math.sign(gy)];
        const order = horiz ? (gy ? [sy, sx] : [sx, sy]) : (gx ? [sx, sy] : [sy, sx]);
        let moved = false, eaten = false;
        for (const o of order) {
          if (!o[0] && !o[1]) continue;
          const tx = f.x + o[0], ty = f.y + o[1];
          if (!this.inBounds(tx, ty)) continue;
          const tk = this.idx(tx, ty);
          const who = owner.get(tk);
          if (who === best.id) {
            // Reached the head or the magnet snake's own body: sucked in.
            this.food.delete(this.idx(f.x, f.y));
            f.x = tx; f.y = ty;
            this.food.set(tk, f);
            if (this._eat(best, tk, events)) ateApple = true;
            eaten = true;
            break;
          }
          if (this.board.wall[tk] || who || this.food.has(tk)) continue;
          this.food.delete(this.idx(f.x, f.y));
          f.x = tx; f.y = ty;
          this.food.set(tk, f);
          moved = true;
          break;
        }
        if (eaten || !moved) break;
      }
    }
    return ateApple;
  };

  /** Put a power-up ('magnet' | 'phantom') on a free cell away from heads. */
  World.prototype.spawnPower = function (power) {
    const b = this.board;
    const blocked = new Set();
    const heads = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      for (const c of p.body) blocked.add(this.idx(c.x, c.y));
      heads.push(p.body[0]);
    }
    const far = function (x, y) {
      for (const h of heads) if (Math.abs(h.x - x) + Math.abs(h.y - y) < POWER_SAFE_DIST) return false;
      return true;
    };
    let pick = null;
    for (let tries = 0; tries < 400 && !pick; tries++) {
      const x = Math.floor(this.rng() * b.w), y = Math.floor(this.rng() * b.h);
      if (this.isFree(x, y, blocked) && far(x, y)) pick = [x, y];
    }
    if (!pick) return null;
    const item = { x: pick[0], y: pick[1], kind: 'power', power: power };
    this.food.set(this.idx(pick[0], pick[1]), item);
    return item;
  };
  World.prototype.powerCount = function () {
    let n = 0;
    this.food.forEach(function (f) { if (f.kind === 'power') n++; });
    return n;
  };

  World.prototype.appleCount = function () {
    let n = 0;
    this.food.forEach(function (f) { if (f.kind === 'apple') n++; });
    return n;
  };

  World.prototype.isFree = function (x, y, blocked) {
    const k = this.idx(x, y);
    return !this.board.wall[k] && !this.food.has(k) && !blocked.has(k);
  };

  /** Keep `appleTarget` apples on the board, away from snake heads. */
  World.prototype.topUpApples = function () {
    const b = this.board;
    const blocked = new Set();
    const heads = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      for (const c of p.body) blocked.add(this.idx(c.x, c.y));
      heads.push(p.body[0]);
    }
    const self = this;
    function farFromHeads(x, y) {
      for (const h of heads) {
        if (Math.abs(h.x - x) + Math.abs(h.y - y) < APPLE_SAFE_DIST) return false;
      }
      return true;
    }
    let guard = 0;
    while (this.appleCount() < this.appleTarget && guard++ < 50) {
      let placed = false;
      for (let tries = 0; tries < 300 && !placed; tries++) {
        const x = Math.floor(this.rng() * b.w), y = Math.floor(this.rng() * b.h);
        if (self.isFree(x, y, blocked) && farFromHeads(x, y)) { this.food.set(this.idx(x, y), { x: x, y: y, kind: 'apple' }); placed = true; }
      }
      if (!placed) {
        // Crowded board: take any free cell at all.
        const free = [];
        for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (self.isFree(x, y, blocked)) free.push([x, y]);
        if (!free.length) return;
        const pick = free[Math.floor(this.rng() * free.length)];
        this.food.set(this.idx(pick[0], pick[1]), { x: pick[0], y: pick[1], kind: 'apple' });
      }
    }
  };

  const SPECIAL_COLOR = '#FFD54A';

  function copyCell(c) { return { x: c.x, y: c.y }; }

  global.SnakeParty = {
    World: World,
    DIRS: DIRS,
    REVERSE: REVERSE,
    START_LEN: START_LEN,
    MAX_QUEUE: MAX_QUEUE,
    SPECIAL_VALUE: SPECIAL_VALUE,
    SPECIAL_COLOR: SPECIAL_COLOR,
    SUB: SUB,
    PHANTOM_PERIOD: PHANTOM_PERIOD,
    MAGNET_RANGE: MAGNET_RANGE,
    MAGNET_STEPS: MAGNET_STEPS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
