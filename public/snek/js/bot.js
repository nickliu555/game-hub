/* Snek — CPU snake brain (runs on the HOST browser; Node-loadable).
 *
 * Each tick, before the world steps, a bot picks one move:
 *   1. Only moves into a free cell (no wall / body / board edge; a tail that
 *      is about to move away counts as free).
 *   2. Scores each candidate by how much room it leaves (a capped flood fill),
 *      so the bot doesn't coil itself into a dead end.
 *   3. Avoids cells another head could also reach next tick (head-ons kill
 *      both), unless that's the only way out.
 *   4. Among the roomy, safe moves, heads for the nearest food by BFS.
 * To play like a person rather than a machine, the bot is deliberately flawed
 * (see SKILL): it sometimes reacts late, plans only a short way ahead, is
 * careless about head-ons, only notices nearby food, and now and then blunders.
 * It also can't whip around: after a turn it has to travel a few cells straight
 * before it turns again, and only sometimes reacts in time to dodge a crash
 * while it's still committed to that straight line.
 */
(function (global) {
  'use strict';

  const SKILL = {
    lazy: 0.35,         // chance per tick to skip planning and just keep going (if the next cell is free)
    lookahead: 0.5,     // fraction of its own length it checks for room (1 = never traps itself)
    headonCare: 0.75,   // chance it bothers avoiding cells another head could reach
    foodSight: 7,       // only chases food within this many steps
    blunder: 0.015,     // chance per tick to take any free move without thinking
    turnGap: 3,         // cells it must travel straight after a turn before turning again
    slip: 0.03,         // chance it reacts too late to a crash right in front of it (and hits it)
    reflex: 0.5,        // chance it spots a crash two cells ahead (or a head cutting in) during that gap; one right in front it always dodges
  };

  function think(world, p) {
    const SP = global.Snek;
    const DIRS = SP.DIRS, REVERSE = SP.REVERSE;
    const b = world.board, W = b.w, H = b.h;
    if (!p.alive || !p.body.length) return p.dir;
    const rng = world.rng;
    // How many cells it has gone straight since its last turn.
    if (p.botLastDir !== p.dir) { p.botLastDir = p.dir; p.botStraight = 0; }
    else p.botStraight = (p.botStraight || 0) + 1;

    // A ghosted (Phantom) bot passes through walls and every snake — only the
    // edges matter. Everyone else can pass through ghosted snakes.
    const ghost = !!p.phantom;
    const blocked = new Uint8Array(W * H);
    if (!ghost) for (let i = 0; i < blocked.length; i++) blocked[i] = b.wall[i];
    const risky = new Uint8Array(W * H);
    for (const q of world.players) {
      if (!q.alive || ghost || q.phantom) continue;
      const keep = (q.grow === 0 && !q.waiting) ? q.body.length - 1 : q.body.length;
      for (let i = 0; i < keep; i++) blocked[q.body[i].y * W + q.body[i].x] = 1;
      if (q.id === p.id || q.waiting) continue;
      const h = q.body[0];
      for (let d = 0; d < 4; d++) {
        if (d === REVERSE[q.dir]) continue;
        const k = cell(h.x + DIRS[d].x, h.y + DIRS[d].y);
        if (k >= 0) risky[k] = 1;
      }
    }
    // Grid index of (x, y), or -1 off the board (the edges are deadly).
    function cell(x, y) { return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x; }

    const head = p.body[0];
    const need = Math.ceil(p.body.length * SKILL.lookahead) + 3;
    const cap = need + 1;

    function room(sx, sy) {
      const seen = new Uint8Array(W * H);
      const q = [sy * W + sx];
      seen[q[0]] = 1;
      let head_ = 0;
      while (head_ < q.length && q.length < cap) {
        const k = q[head_++];
        const x = k % W, y = (k / W) | 0;
        for (let d = 0; d < 4; d++) {
          const n = cell(x + DIRS[d].x, y + DIRS[d].y);
          if (n < 0 || seen[n] || blocked[n]) continue;
          seen[n] = 1; q.push(n);
        }
      }
      return q.length;
    }

    const cands = [];
    for (let d = 0; d < 4; d++) {
      if (d === REVERSE[p.dir]) continue;
      const nx = head.x + DIRS[d].x, ny = head.y + DIRS[d].y;
      const k = cell(nx, ny);
      if (k < 0 || blocked[k]) continue;
      cands.push({ d: d, k: k, room: room(nx, ny), risky: !!risky[k] });
    }
    if (!cands.length) return p.dir;

    // Sometimes it just doesn't react in time to something dead ahead.
    {
      const d = DIRS[p.dir];
      const k1 = cell(head.x + d.x, head.y + d.y);
      if ((k1 < 0 || blocked[k1]) && rng() < SKILL.slip) return p.dir;
    }

    // Still committed to the straight line after its last turn: it only breaks
    // off to avoid a crash (always for one right in front, sometimes for one
    // two cells out), never to chase food or zig-zag.
    if (p.botStraight < SKILL.turnGap) {
      const d = DIRS[p.dir];
      const k1 = cell(head.x + d.x, head.y + d.y), k2 = cell(head.x + 2 * d.x, head.y + 2 * d.y);
      const nextFree = k1 >= 0 && !blocked[k1];
      const thenFree = k2 >= 0 && !blocked[k2];
      if (nextFree && thenFree && !risky[k1]) return p.dir;
      // A crash two cells out (or a head about to cut in) is only sometimes
      // noticed; one right in front always is.
      if (nextFree && rng() >= SKILL.reflex) return p.dir;
    }

    // Lazy / blundering moves still dodge a head that's right in front of it.
    const calm = cands.filter(function (c) { return !c.risky; });
    const ahead = calm.find(function (c) { return c.d === p.dir; });
    if (ahead && rng() < SKILL.lazy) return p.dir;
    if (calm.length && rng() < SKILL.blunder) return calm[Math.floor(rng() * calm.length)].d;
    const minding = rng() < SKILL.headonCare;

    // Nearest food by a turn-aware BFS: a route only counts if the bot can
    // actually drive it — at least turnGap cells straight between turns — so it
    // lines up its approach instead of overshooting and circling the apple.
    // State = (cell, heading, cells gone straight since the last turn, capped).
    const G = Math.max(0, SKILL.turnGap | 0);
    const S = G + 1;
    const stateId = function (k, d, st) { return (k * 4 + d) * S + st; };
    const seenS = new Uint8Array(W * H * 4 * S);
    const qk = [], qd = [], qs = [], qf = [], qn = [];
    const s0 = Math.min(p.botStraight || 0, G);
    let target = -1;
    function push(k, d, st, f, n) {
      const id = stateId(k, d, st);
      if (seenS[id]) return;
      seenS[id] = 1;
      qk.push(k); qd.push(d); qs.push(st); qf.push(f); qn.push(n);
    }
    // First moves: the candidates (any dodge already decided above).
    for (const c of cands) {
      const turning = c.d !== p.dir;
      if (turning && s0 < G) continue;
      push(c.k, c.d, turning ? 0 : Math.min(s0 + 1, G), c.d, 1);
    }
    for (let i = 0; i < qk.length; i++) {
      const k = qk[i];
      if (world.food.has(k)) { target = qf[i]; break; }
      if (qn[i] >= SKILL.foodSight) continue;
      const x = k % W, y = (k / W) | 0, d0 = qd[i], st = qs[i];
      for (let d = 0; d < 4; d++) {
        if (d === REVERSE[d0]) continue;
        const turning = d !== d0;
        if (turning && st < G) continue;
        const n = cell(x + DIRS[d].x, y + DIRS[d].y);
        if (n < 0 || blocked[n]) continue;
        push(n, d, turning ? 0 : Math.min(st + 1, G), qf[i], qn[i] + 1);
      }
    }

    function score(c) {
      let s = Math.min(c.room, need) * 10;
      if (c.room >= need) s += 1000;
      if (minding && !c.risky) s += 500;
      if (c.d === target) s += 200;
      if (c.d === p.dir) s += 5;
      return s + rng() * 3;
    }
    cands.sort(function (a, b2) { return score(b2) - score(a); });
    return cands[0].d;
  }

  global.SnekBot = { think: think, SKILL: SKILL };
})(typeof window !== 'undefined' ? window : globalThis);
