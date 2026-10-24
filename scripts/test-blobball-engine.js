'use strict';
// Headless physics checks for the Blob Ball engine (public/blobball/js/engine.js).
const BB = require('../public/blobball/js/engine.js');

let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function world(bots) {
  return new BB.World({
    roster: [{ id: 'a', name: 'A', isBot: !!bots }, { id: 'b', name: 'B', isBot: !!bots }],
    rng: seeded(42),
  });
}
// A live court with the ball parked out of the way (high above the far wall).
function liveCourt() {
  const w = world(false);
  w.setupServe(0);
  w.release();
  return w;
}
function park(w) { Object.assign(w.ball, { x: 980, y: 700, vx: 0, vy: 0 }); w.ballHeld = true; }

// ---- Jumping ----
{
  const w = liveCourt(); park(w);
  const a = w.blobs[0];
  w.setInput('a', 2, true);
  let apex = 0, ticks = 0, landed = false;
  for (let t = 0; t < 60; t++) {
    w.step();
    apex = Math.max(apex, a.y);
    ticks++;
    if (w.events.some((e) => e.t === 'land' && e.seat === 0)) { landed = true; break; }
    w.events.length = 0;
  }
  check('full jump apex matches the original (225)', apex === 225);
  check('full jump lands in ~31 ticks', landed && ticks >= 30 && ticks <= 32);
  check('holding JUMP re-jumps on landing', (() => { w.events.length = 0; w.step(); return a.y > 0; })());
  w.setInput('a', 2, false);
}
{
  const w = liveCourt(); park(w);
  const a = w.blobs[0];
  // Press and release before the engine even ticks: still a (short) hop.
  w.setInput('a', 2, true);
  w.setInput('a', 2, false);
  let apex = 0;
  for (let t = 0; t < 40; t++) { w.step(); apex = Math.max(apex, a.y); }
  check('a quick tap still jumps', apex > 0);
  check('a tap is a short hop (25–50% of a full jump)', apex > 225 * 0.25 && apex < 225 * 0.5);
  check('blob is back on the ground', a.y === 0);
}
{
  // Longer holds jump higher.
  const apexFor = (hold) => {
    const w = liveCourt(); park(w);
    const a = w.blobs[0];
    w.setInput('a', 2, true);
    let apex = 0;
    for (let t = 0; t < 40; t++) {
      if (t === hold) w.setInput('a', 2, false);
      w.step();
      apex = Math.max(apex, a.y);
    }
    return apex;
  };
  const h = [2, 5, 8, 12, 40].map(apexFor);
  check('jump height grows with how long JUMP is held (' + h.join(' < ') + ')', h.every((v, i) => i === 0 || v > h[i - 1]));
}

// ---- Moving + side limits ----
{
  const w = liveCourt(); park(w);
  const a = w.blobs[0], b = w.blobs[1];
  w.setInput('a', 1, true);
  w.step();
  check('blob moves 8 units per tick', a.x === BB.HOME[0] + 8);
  for (let t = 0; t < 100; t++) w.step();
  check('left blob stops at its side of the net (445)', a.x === 445);
  w.setInput('b', 0, true);
  for (let t = 0; t < 100; t++) w.step();
  check('right blob stops at its side of the net (555)', b.x === 555);
  w.setInput('a', 1, false); w.setInput('a', 0, true);
  for (let t = 0; t < 100; t++) w.step();
  check('left blob stops at the wall (50)', a.x === 50);
  w.setInput('a', 0, true); w.setInput('a', 1, true);
  const x0 = a.x; w.step();
  check('left + right together stands still', a.x === x0);
}

// ---- Serve ----
{
  const w = world(false);
  w.setupServe(1);
  check('ball hangs above the server', w.ball.x === BB.HOME[1] && w.ball.y === BB.SERVE_Y);
  w.setInput('a', 1, true);
  for (let t = 0; t < 10; t++) w.step();
  check('serve hold: ball hovers, blobs locked', w.ball.y === BB.SERVE_Y && w.blobs[0].x === BB.HOME[0]);
  w.release();
  w.step();
  check('release: the ball drops and a held button acts at once', w.ball.y < BB.SERVE_Y && w.blobs[0].x === BB.HOME[0] + 8);
}

// ---- Walls, ceiling, net ----
{
  const w = liveCourt();
  Object.assign(w.ball, { x: 25, y: 400, vx: -15, vy: 0 });
  w.step();
  check('left wall bounces the ball back', w.ball.vx > 0 && w.ball.x >= BB.WALL_MIN);
  Object.assign(w.ball, { x: 975, y: 400, vx: 15, vy: 0 });
  w.step();
  check('right wall bounces the ball back', w.ball.vx < 0 && w.ball.x <= BB.WALL_MAX);
  Object.assign(w.ball, { x: 300, y: BB.CEIL - 30, vx: 0, vy: 20 });
  w.step();
  check('ceiling bounces the ball down', w.ball.vy < 0 && w.ball.y <= BB.CEIL - BB.BALL_R);
  Object.assign(w.ball, { x: 497, y: 150, vx: 2, vy: -15 });
  let up = false;
  for (let t = 0; t < 3; t++) { w.step(); if (w.ball.vy > 0) up = true; }
  check('ball dropping onto the net top bounces up', up && w.ball.y >= 130);
  Object.assign(w.ball, { x: 470, y: 60, vx: 12, vy: 5 });
  w.step();
  check('ball hitting the net side bounces back', w.ball.vx < 0 && w.ball.x <= 480);
  check('net hits are reported', w.events.some((e) => e.t === 'net'));
}

// ---- Ball off a blob ----
{
  const w = liveCourt();
  const a = w.blobs[0];
  // Falling just net-side of a still blob's crown: goes up and toward the net.
  Object.assign(w.ball, { x: a.x + 15, y: 160, vx: 0, vy: -10 });
  let hit = null;
  for (let t = 0; t < 10 && !hit; t++) { w.step(); hit = w.events.find((e) => e.t === 'hit'); }
  check('ball bounces off a blob', !!hit && hit.seat === 0);
  check('…up and toward the net', w.ball.vy > 0 && w.ball.vx > 0);
  const still = Math.hypot(w.ball.vx, w.ball.vy);

  // Same contact but the blob is jumping into it: a harder hit (velocity adds on).
  const w2 = liveCourt();
  const a2 = w2.blobs[0];
  w2.setInput('a', 2, true);
  for (let t = 0; t < 3; t++) w2.step();
  Object.assign(w2.ball, { x: a2.x + 15, y: a2.y + 150, vx: 0, vy: -10 });
  let hit2 = null;
  for (let t = 0; t < 10 && !hit2; t++) { w2.step(); hit2 = w2.events.find((e) => e.t === 'hit'); }
  const jumping = Math.hypot(w2.ball.vx, w2.ball.vy);
  check('jumping into the ball hits it harder (' + still.toFixed(1) + ' → ' + jumping.toFixed(1) + ')', !!hit2 && jumping > still);
  check('ball speed stays within the caps', Math.abs(w2.ball.vx) <= BB.MAX_VX && Math.abs(w2.ball.vy) <= BB.MAX_VY);
}

// ---- Scoring + dead ball (a ball already in play: someone has touched it) ----
for (const [x, scorer] of [[750, 0], [250, 1]]) {
  const w = liveCourt();
  w.touched = true;
  Object.assign(w.ball, { x, y: 60, vx: 0, vy: -10 });
  let res = null;
  for (let t = 0; t < 20 && !res; t++) res = w.step();
  check('ball down at x=' + x + ' scores for seat ' + scorer, res && res.point && res.scorerSeat === scorer && res.loserSeat === 1 - scorer);
}
{
  const w = liveCourt();
  w.touched = true;
  Object.assign(w.ball, { x: 750, y: 300, vx: 4, vy: -12 });
  let res = null, points = 0, rose = false, lowest = Infinity;
  w.setInput('a', 1, true);
  for (let t = 0; t < 400; t++) {
    res = w.step();
    if (res) points++;
    if (points) {
      lowest = Math.min(lowest, w.ball.y);
      if (w.ball.vy > 0) rose = true;
    }
  }
  check('a point is reported exactly once', points === 1);
  check('after the point the ball keeps bouncing', rose);
  check('…never sinks into the sand', lowest >= BB.BALL_R);
  check('…and finally settles', w.ball.vy === 0 && w.ball.y === BB.BALL_R);
  const ax = w.blobs[0].x;
  w.step();
  check('blobs ignore input while the ball is dead', w.blobs[0].x === ax);
}

// ---- A whiffed serve (nobody touched it) is re-served, not a point ----
{
  // The server jumps away from the ball and it drops untouched onto the sand.
  for (const seat of [0, 1]) {
    const w = world(false);
    w.setupServe(seat);
    w.release();
    const id = seat === 0 ? 'a' : 'b';
    w.setInput(id, seat === 0 ? 0 : 1, true);   // run away from the ball
    let res = null;
    for (let t = 0; t < 200 && !res; t++) res = w.step();
    check('seat ' + seat + ': an untouched serve that lands is a missed serve, not a point',
      res && res.missedServe === true && !res.point && res.serverSeat === seat);
    check('seat ' + seat + ': the miss is reported as a ground event with miss=true', w.events.some((e) => e.t === 'ground' && e.miss));
    check('seat ' + seat + ': blobs freeze while it bounces', w.blobsLocked && !w.live);
  }
  // Whiffing again and again never scores.
  const w = world(false);
  let misses = 0, points = 0;
  for (let n = 0; n < 6; n++) {
    w.setupServe(0);
    w.release();
    w.setInput('a', 0, true);
    let res = null;
    for (let t = 0; t < 200 && !res; t++) res = w.step();
    if (res && res.missedServe) misses++;
    if (res && res.point) points++;
  }
  check('a server can whiff as many times as it takes (' + misses + ' re-serves, ' + points + ' points)', misses === 6 && points === 0);
  // Touch it, even barely, and it's live: landing on your own side loses the
  // point. Try every way of stepping away under the ball.
  let ruleBroken = 0, ownSideLosses = 0, whiffed = 0;
  for (const dirBtn of [0, 1]) {
    for (let k = 1; k <= 30; k++) {
      const t2 = world(false);
      t2.setupServe(0);
      t2.release();
      let res2 = null;
      for (let t = 0; t < 300 && !res2; t++) {
        t2.setInput('a', dirBtn, t < k);
        res2 = t2.step();
      }
      if (!res2) continue;
      if (t2.touched && !res2.point) ruleBroken++;          // touched ⇒ must count
      if (!t2.touched && !res2.missedServe) ruleBroken++;   // untouched ⇒ re-serve
      if (!t2.touched) whiffed++;
      if (t2.touched && res2.point && res2.scorerSeat === 1) ownSideLosses++;
    }
  }
  check('touched serves always count, untouched ones are always re-served', ruleBroken === 0);

  // Waiting: the ball bounces on the server's head, then they walk away and it
  // falls. The head bounces don't count — it's a re-serve.
  {
    const w = world(false);
    w.setupServe(0);
    w.release();
    let bounces = 0, res = null;
    for (let t = 0; t < 400 && !res; t++) {
      if (bounces >= 3) w.setInput('a', 0, true);   // after 3 head bounces, walk off left
      res = w.step();
      for (const e of w.events) if (e.t === 'hit' && !e.cont) bounces++;
      w.events.length = 0;
    }
    check('ball bounced on the waiting server\'s head (' + bounces + ' bounces)', bounces >= 3);
    check('…then they walked away and it fell: re-serve, not a point', res && res.missedServe === true);
  }
  // Jumping in place forever never counts as a touch (and never lands).
  {
    const w = world(false);
    w.setupServe(1);
    w.release();
    let hits = 0, res = null;
    for (let t = 0; t < 600 && !res; t++) {
      w.setInput('b', 2, t % 40 < 12);
      res = w.step();
      for (const e of w.events) if (e.t === 'hit' && !e.cont) hits++;
      w.events.length = 0;
    }
    check('jumping in place keeps bouncing it (' + hits + ' bounces) without it counting as a touch', hits >= 3 && !w.touched && !res);
  }
  // Once the server has moved, contacts count: wait, then a quick tap that
  // clips the ball off the back of the dome loses the point.
  {
    let lost = 0, tries = 0;
    for (let tap = 1; tap <= 6; tap++) {
      const w = world(false);
      w.setupServe(0);
      w.release();
      let bounces = 0, tapAt = -1, res = null;
      for (let t = 0; t < 400 && !res; t++) {
        if (bounces >= 2 && tapAt < 0 && w.ball.vy > 0) tapAt = t;
        w.setInput('a', 0, tapAt >= 0 && t < tapAt + tap);
        res = w.step();
        for (const e of w.events) if (e.t === 'hit' && !e.cont) bounces++;
        w.events.length = 0;
      }
      if (!res) continue;
      tries++;
      if (res.point && res.scorerSeat === 1 && w.touched) lost++;
    }
    check('after moving, clipping the ball into your own court still loses the point (' + lost + ' / ' + tries + ')', lost > 0);
  }
  check('a serve the server touches into their own court loses the point (' + ownSideLosses + ' cases)', ownSideLosses > 0);
  check('…and a clean whiff never does (' + whiffed + ' cases)', whiffed > 0);
}

// ---- Disconnect clears held input ----
{
  const w = liveCourt(); park(w);
  w.setInput('a', 1, true);
  w.setConnected('a', false);
  const x0 = w.blobs[0].x;
  w.step();
  check('a dropped controller stops its blob (no stuck input)', w.blobs[0].x === x0);
}

// ---- The net is solid: the ball NEVER passes through the post ----
{
  // A crossing of x = 500 is only legal above the post top.
  const through = (px, py, x, y) => {
    if ((px < BB.NET_X) === (x < BB.NET_X)) return false;
    const t = (BB.NET_X - px) / (x - px);
    return py + (y - py) * t < BB.NET_TOP;
  };
  const inPost = (b) => b.x > BB.NET_X - BB.NET_BAND && b.x < BB.NET_X + BB.NET_BAND && b.y < BB.NET_TOP;

  // A fast drop onto the post top just past the centre.
  let w = liveCourt();
  Object.assign(w.ball, { x: 509, y: 152, vx: -15, vy: -22 });
  let px = w.ball.x, py = w.ball.y;
  w.step();
  check('a fast drop onto the post top bounces up, not through', w.ball.vy > 0 && !through(px, py, w.ball.x, w.ball.y) && !inPost(w.ball));

  // A blob pressed against the net shoving the ball sideways into the post.
  w = liveCourt();
  w.setInput('a', 1, true);
  for (let t = 0; t < 40; t++) w.step();
  Object.assign(w.ball, { x: 470, y: 120, vx: 3, vy: 0 });
  let ok = true;
  for (let t = 0; t < 60; t++) {
    px = w.ball.x; py = w.ball.y;
    w.setInput('a', 2, t % 20 < 10);
    w.step();
    if (through(px, py, w.ball.x, w.ball.y) || inPost(w.ball)) ok = false;
  }
  check('a blob shoving the ball into the net never pushes it through', ok);

  // A dead ball rolling along the sand stops at the post.
  w = liveCourt();
  Object.assign(w.ball, { x: 300, y: 26, vx: 12, vy: 0 });
  w.live = false;
  for (let t = 0; t < 120; t++) w.step();
  check('a ball rolling along the sand bounces off the post', w.ball.x < BB.NET_X);

  // Stress: random balls hugging the net, CPUs and a mashing human, ~450k ticks.
  const rng = seeded(9);
  let crossings = 0, inside = 0;
  for (let game = 0; game < 300; game++) {
    const s = new BB.World({ roster: [{ id: 'a', isBot: game % 2 === 0 }, { id: 'b', isBot: true }], rng });
    s.setupServe(game % 2);
    s.release();
    Object.assign(s.ball, { x: 440 + rng() * 120, y: 30 + rng() * 300, vx: (rng() * 2 - 1) * 15, vy: (rng() * 2 - 1) * 22 });
    if (inPost(s.ball)) s.ball.y = BB.NET_TOP + 5;
    s.blobs[0].x = 300 + rng() * 145;
    s.blobs[1].x = 555 + rng() * 145;
    for (let t = 0; t < 1500; t++) {
      if (!s.blobs[0].isBot && t % 7 === 0) {
        s.setInput('a', 0, rng() < 0.3);
        s.setInput('a', 1, rng() < 0.6);
        s.setInput('a', 2, rng() < 0.5);
      }
      s.stepBots();
      px = s.ball.x; py = s.ball.y;
      const r = s.step();
      if (through(px, py, s.ball.x, s.ball.y)) crossings++;
      if (inPost(s.ball)) inside++;
      if (!s.live) { s.setupServe(r ? (r.missedServe ? r.serverSeat : r.loserSeat) : 0); s.release(); }
    }
  }
  check('stress: the ball never crosses below the post top (' + crossings + ')', crossings === 0);

  // Sweep: balls hugging the post faces, both blobs shoved against the net and
  // jumping at different moments. Catches a ball scooped over the top corner
  // and a blob touching the ball through the post (both happened once).
  let sweepCross = 0, sweepInside = 0, throughTouch = 0;
  const N = BB.NET_X, BAND = BB.NET_BAND, TOP = BB.NET_TOP;
  for (let x = 440; x <= 560; x += 4) {
    for (let y = 26; y <= 170; y += 8) {
      for (let vx = -15; vx <= 15; vx += 5) {
        for (let vy = -22; vy <= 22; vy += 11) {
          if (x > N - BAND && x < N + BAND && y < TOP) continue;
          for (const jump of [-1, 0, 5]) {
            const s = liveCourt();
            s.touched = true;
            s.blobs[0].x = BB.LIMITS[0][1];
            s.blobs[1].x = BB.LIMITS[1][0];
            Object.assign(s.ball, { x, y, vx, vy });
            for (let t = 0; t < 25 && s.live; t++) {
              s.setInput('a', 1, true);
              s.setInput('b', 0, true);
              s.setInput('a', 2, jump >= 0 && t >= jump && t < jump + 12);
              s.setInput('b', 2, jump >= 0 && t >= jump + 2 && t < jump + 14);
              px = s.ball.x; py = s.ball.y;
              s.step();
              for (const e of s.events) {
                if (e.t !== 'hit') continue;
                const far = e.seat === 0 ? (v) => v >= N + BAND : (v) => v <= N - BAND;
                if (far(px) && far(s.ball.x) && py < TOP && s.ball.y < TOP) throughTouch++;
              }
              s.events.length = 0;
              if (through(px, py, s.ball.x, s.ball.y)) sweepCross++;
              if (inPost(s.ball)) sweepInside++;
            }
          }
        }
      }
    }
  }
  check('sweep: no ball slips over the post\'s top corner (' + sweepCross + ')', sweepCross === 0);
  check('sweep: no ball ends a tick inside the post (' + sweepInside + ')', sweepInside === 0);
  check('sweep: no blob ever touches the ball through the post (' + throughTouch + ')', throughTouch === 0);
  check('stress: the ball never ends a tick inside the post (' + inside + ')', inside === 0);
}

// ---- One touch = one boing: back-to-back contacts are flagged as continuing ----
{
  const w = world(true);
  let serve = 0, fresh = 0, cont = 0, wrong = 0;
  const last = [-99, -99];
  for (let p = 0; p < 200; p++) {
    w.setupServe(serve);
    w.release();
    last[0] = last[1] = -99;
    let res = null, t = 0;
    while (!res && t < 3000) {
      w.stepBots();
      res = w.step();
      t++;
      for (const e of w.events) {
        if (e.t !== 'hit') continue;
        const close = w.tick - last[e.seat] <= 8;
        if (close !== !!e.cont) wrong++;
        if (e.cont) cont++; else fresh++;
        last[e.seat] = w.tick;
      }
      w.events.length = 0;
    }
    if (res) serve = res.missedServe ? res.serverSeat : res.loserSeat;
  }
  check('a blob carrying the ball for a tick or two happens (' + cont + ' follow-up contacts)', cont > 0);
  check('follow-up contacts are flagged so the boing plays once per touch (' + fresh + ' touches)', wrong === 0 && fresh > 0);
}

// ---- The CPU returns deep serves (it used to jump early and let them pass under) ----
{
  const rng = seeded(3);
  let deep = 0, returned = 0, early = 0;
  for (let off = -45; off <= 45; off += 6) {
    for (let jumpAt = -1; jumpAt <= 14; jumpAt++) {
      const w = new BB.World({ roster: [{ id: 'h' }, { id: 'c', isBot: true }], rng });
      w.setupServe(0);
      w.release();
      const h = w.blobs[0], c = w.blobs[1];
      let t = 0, res = null, crossed = false, back = false, landX = 0;
      while (!res && t < 600) {
        const target = BB.HOME[0] + off;
        w.setInput('h', 0, !crossed && h.x > target + 4);
        w.setInput('h', 1, !crossed && h.x < target - 4);
        w.setInput('h', 2, !crossed && jumpAt >= 0 && t >= jumpAt && t < jumpAt + 12);
        w.stepBots();
        res = w.step();
        t++;
        for (const e of w.events) {
          // Leaping while the ball is still well over 0.3 s away is the old bug.
          if (crossed && e.t === 'jump' && e.seat === 1) {
            const away = (Math.abs(w.ball.x - c.x) - 60) / Math.max(1, Math.abs(w.ball.vx));
            if (away > 16) early++;
          }
        }
        w.events.length = 0;
        if (crossed && w.ball.x < BB.NET_X) { back = true; break; }
        if (!crossed && w.ball.x > BB.NET_X) {
          crossed = true;
          const path = BB.predictPath(w.ball, 200);
          landX = path[path.length - 1].x;
        }
      }
      if (!crossed || landX < 800) continue;
      deep++;
      if (back) returned++;
    }
  }
  check('CPU returns most deep serves (' + returned + ' / ' + deep + ')', deep > 50 && returned / deep >= 0.55);
  check('CPU never leaps while the ball is still far away (' + early + ')', early === 0);
}

// ---- The CPU moves like a thumb on a phone: slower, and hesitates to turn ----
{
  const w = world(true);
  w.setupServe(0);
  w.release();
  w.ballHeld = true;
  const cpu = w.blobs[0];
  w.stepBots();
  cpu.ai.target = 400;
  let started = -1, maxStep = 0;
  for (let t = 0; t < 40; t++) {
    const x0 = cpu.x;
    w._steer(cpu);
    w.step();
    const dx = cpu.x - x0;
    if (dx !== 0 && started < 0) started = t;
    maxStep = Math.max(maxStep, Math.abs(dx));
  }
  check('CPU waits a beat before it starts moving (' + started + ' ticks, min ' + BB.AI_TURN_MIN + ')', started >= BB.AI_TURN_MIN);
  check('CPU moves slower than a player (' + maxStep.toFixed(1) + ' vs ' + BB.MOVE_SPEED + ' per tick)', maxStep > 0 && maxStep < BB.MOVE_SPEED);
  // Reverse: it lets go at once, then hesitates before pushing the other way.
  cpu.ai.target = 60;
  w._steer(cpu);
  w.step();
  const xr = cpu.x;
  check('CPU lets go at once when it changes its mind', cpu.vx === 0);
  w.step();
  check('…and hesitates before moving the other way', cpu.x === xr);
  // Players are untouched.
  const h = liveCourt(); park(h);
  h.setInput('a', 1, true);
  h.step();
  check('players still move at full speed', h.blobs[0].x === BB.HOME[0] + BB.MOVE_SPEED);
}

// ---- CPU vs CPU ----
{
  const w = world(true);
  let serve = 0, pts = 0, hits = 0, stalls = 0, serveFaults = 0, whiffs = 0;
  const wins = [0, 0];
  for (let p = 0; p < 300; p++) {
    w.setupServe(serve);
    w.release();
    let res = null, t = 0, crossed = false;
    const startSide = w.ball.x < BB.NET_X ? 0 : 1;
    while (!res && t < 3000) {
      w.stepBots();
      res = w.step();
      t++;
      for (const e of w.events) if (e.t === 'hit') hits++;
      w.events.length = 0;
      if ((w.ball.x < BB.NET_X ? 0 : 1) !== startSide) crossed = true;
    }
    if (!res) { stalls++; serve = 1 - serve; continue; }
    if (res.missedServe) { whiffs++; continue; }   // same server again
    if (!crossed) serveFaults++;
    pts++;
    wins[res.scorerSeat]++;
    serve = res.loserSeat;
  }
  const avg = hits / Math.max(1, pts);
  check('CPU rallies always end (no endless dribbles)', stalls === 0);
  check('CPU keeps a rally going (avg ' + avg.toFixed(1) + ' hits per point)', avg >= 3);
  check('both sides win points (' + wins.join(' / ') + ')', wins[0] > 60 && wins[1] > 60);
  check('CPU rarely wrecks its own serve (' + (100 * serveFaults / Math.max(1, pts)).toFixed(1) + '%)', serveFaults / Math.max(1, pts) < 0.08);
  check('CPU rarely whiffs its serve completely (' + whiffs + ' re-serves)', whiffs / Math.max(1, pts) < 0.08);
}

// ---- Ball under a blob: never pops up through it ----
{
  const fresh = () => {
    const w = new BB.World({ roster: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rng: seeded(5) });
    w.setupServe(0); w.release();
    return w;
  };
  // Ball centre starts under the blob's base and inside its footprint, then
  // ends the tick above the base still well inside it: it passed through.
  const throughBlob = (b0, b1, p) => b0.y < p.py && Math.abs(b0.x - p.px) < BB.HIT_R / 2
    && b1.y > p.y + BB.BALL_R && Math.abs(b1.x - p.x) < BB.BLOB_R / 2;

  // A blob coming down on a ball floating under its base.
  let w = fresh();
  const a = w.blobs[0];
  Object.assign(a, { x: 250, y: 150, vy: -4 });
  Object.assign(w.ball, { x: 255, y: 80, vx: 0, vy: 0 });
  let popped = false, maxRise = 0;
  for (let t = 0; t < 30 && w.live; t++) {
    const b0 = { x: w.ball.x, y: w.ball.y };
    w.step();
    if (throughBlob(b0, w.ball, a)) popped = true;
    maxRise = Math.max(maxRise, w.ball.y - b0.y);
  }
  check('a blob landing on a ball beneath it doesn\'t pop the ball on top', !popped && maxRise < 30);
  check('…it knocks the ball down into the sand instead', !w.live);

  // A dead ball lying on the sand, a blob falls on it: it squirts out sideways.
  w = fresh();
  w.live = false;
  const b = w.blobs[0];
  Object.assign(b, { x: 250, y: 60, vy: -2 });
  Object.assign(w.ball, { x: 262, y: BB.BALL_R, vx: 0, vy: 0 });
  let maxStep = 0, rose = false;
  for (let t = 0; t < 40; t++) {
    const b0 = { x: w.ball.x, y: w.ball.y };
    w.step();
    maxStep = Math.max(maxStep, Math.hypot(w.ball.x - b0.x, w.ball.y - b0.y));
    if (w.ball.y > b.y + BB.BALL_R && Math.abs(w.ball.x - b.x) < BB.BLOB_R / 2) rose = true;
  }
  check('a blob landing on a ball on the sand squeezes it out sideways', !rose && Math.abs(w.ball.x - b.x) >= BB.HIT_R / 2 - 0.5);
  check('…smoothly, a few units a tick (max ' + maxStep.toFixed(1) + ')', maxStep <= 16);

  // A ball rising into the rim of a hanging blob glances off sideways/down.
  w = fresh();
  const c = w.blobs[0];
  Object.assign(c, { x: 250, y: 200, vy: 0 });
  w.blobsLocked = true;
  Object.assign(w.ball, { x: 250 + 58, y: 150, vx: 0, vy: 12 });
  const hold = c.y;
  let poppedRim = false;
  for (let t = 0; t < 6; t++) {
    const b0 = { x: w.ball.x, y: w.ball.y };
    c.y = hold; c.vy = 0;
    w.step();
    c.y = hold;
    if (w.ball.y > hold + BB.BALL_R && b0.y < hold) poppedRim = true;
  }
  check('a ball hitting the rim from below glances off, never over the top', !poppedRim);

  // Sweep: blobs jumping/falling over low balls from every angle.
  const rng = seeded(31);
  let pops = 0, jumps = 0, cases = 0;
  for (let k = 0; k < 4000; k++) {
    const s = fresh();
    s.live = rng() < 0.5;
    const p = s.blobs[0];
    Object.assign(p, { x: 120 + rng() * 300, y: 40 + rng() * 180, vy: (rng() * 2 - 1) * 20 });
    s.setInput('a', rng() < 0.5 ? 0 : 1, rng() < 0.6);
    Object.assign(s.ball, {
      x: p.x + (rng() * 2 - 1) * 70,
      y: BB.BALL_R + rng() * Math.max(1, p.y - BB.BALL_R),
      vx: (rng() * 2 - 1) * 10, vy: (rng() * 2 - 1) * 12,
    });
    cases++;
    for (let t = 0; t < 40; t++) {
      const b0 = { x: s.ball.x, y: s.ball.y };
      s.step();
      if (throughBlob(b0, s.ball, p)) pops++;
      if (s.ball.y - b0.y > 60) jumps++;
    }
  }
  check('sweep: a ball under a blob never passes up through it (' + pops + ' / ' + cases + ')', pops === 0);
  check('sweep: the ball never jumps upward in one tick (' + jumps + ')', jumps === 0);
}

// ---- Team play (2v2 / 2v1) ----
function teamWorld(bots, three) {
  const roster = [
    { id: 'l0', name: 'L0', seat: 0, slot: 0, isBot: !!bots },
    { id: 'l1', name: 'L1', seat: 0, slot: 1, isBot: !!bots },
    { id: 'r0', name: 'R0', seat: 1, slot: 0, isBot: !!bots },
  ];
  if (!three) roster.push({ id: 'r1', name: 'R1', seat: 1, slot: 1, isBot: !!bots });
  return new BB.World({ roster, teams: true, rng: seeded(7) });
}
{
  const w = teamWorld(false);
  const g = w.geo;
  check('team court is 1.5× wider with the net in the middle', g.W === 1500 && g.NET_X === 750 && g.WALL_MAX === 1485);
  check('team limits keep the 1v1 net gap', g.LIMITS[0][0] === 50 && g.LIMITS[0][1] === 695 && g.LIMITS[1][0] === 805 && g.LIMITS[1][1] === 1450);
  check('four blobs, two a side', w.blobs.length === 4 && w.sideBlobs[0].length === 2 && w.sideBlobs[1].length === 2);
  const one = new BB.World({ roster: [{ id: 'a' }, { id: 'b' }] });
  check('1v1 keeps the original court', one.geo.W === 1000 && one.geo.NET_X === BB.NET_X && one.geo.LIMITS[1][1] === BB.LIMITS[1][1]);

  w.setupServe(0);
  const l0 = w.byId('l0'), l1 = w.byId('l1'), r0 = w.byId('r0'), r1 = w.byId('r1');
  check('first serve: slot 0 serves from the back, teammate up front', w.server() === l0 && l0.x === 220 && l1.x === 540);
  check('the ball hangs over the server', w.ball.x === l0.x && w.ball.y === BB.SERVE_Y);
  check('receivers start back (slot 0) and front (slot 1)', r0.x === 1280 && r1.x === 960);
  w.setupServe(0, true);
  check('a re-serve keeps the same server and spots', w.server() === l0 && l0.x === 220 && l1.x === 540);
  w.setupServe(1);
  check('receivers keep their spots when the other team serves', l0.x === 220 && l1.x === 540);
  check('right team: slot 0 serves first', w.server() === r0 && r0.x === 1280);
  w.setupServe(0);
  check('next left serve passes to the teammate, who swaps to the back', w.server() === l1 && l1.x === 220 && l0.x === 540);
  w.setupServe(0);
  check('and back again', w.server() === l0 && l0.x === 220 && l1.x === 540);
  w.setupServe(1);
  check('right team rotates too', w.server() === r1 && r1.x === 1280 && r0.x === 960);
}
{
  const w = teamWorld(false, true);
  w.setupServe(1);
  const r0 = w.byId('r0');
  check('2v1: the lone blob stands mid-court and serves from there', w.server() === r0 && r0.x === 1125 && w.ball.x === 1125);
  w.setupServe(1);
  check('2v1: the lone blob serves every time', w.server() === r0);
}
{
  // Teammates bump instead of overlapping.
  const w = teamWorld(false);
  w.setupServe(1);
  w.release();
  Object.assign(w.ball, { x: 1400, y: 700, vx: 0, vy: 0 }); w.ballHeld = true;
  const l0 = w.byId('l0'), l1 = w.byId('l1');
  w.setInput('l0', 1, true);
  let minGap = 1e9;
  for (let t = 0; t < 80; t++) { w.step(); minGap = Math.min(minGap, l1.x - l0.x); }
  check('a teammate running into the other can\'t pass through (min gap ' + minGap.toFixed(1) + ')', minGap > 85 && l0.x < l1.x);
  check('…and shoves them toward the net', l1.x > 540 + 20);
  check('nobody leaves their half', l1.x <= w.geo.LIMITS[0][1] && l0.x >= w.geo.LIMITS[0][0]);
  w.setInput('l0', 1, false);
  // Pinned against the net limit: the runner stops, the pair keeps its spacing.
  for (let t = 0; t < 40; t++) w.step();
  check('pinned at the net limit they still don\'t overlap', l1.x - l0.x > 85);

  // One coming down onto the other's head slides off sideways.
  const w2 = teamWorld(false);
  w2.setupServe(1); w2.release();
  Object.assign(w2.ball, { x: 1400, y: 700, vx: 0, vy: 0 }); w2.ballHeld = true;
  const a = w2.byId('l0'), b = w2.byId('l1');
  a.x = a.px = 400; b.x = b.px = 405; a.y = a.py = 160; b.y = b.py = 0;
  let maxJump = 0, prev = b.x - a.x;
  for (let t = 0; t < 60; t++) { w2.step(); const gap = b.x - a.x; maxJump = Math.max(maxJump, Math.abs(gap - prev)); prev = gap; }
  check('a teammate landing on the other slides off', b.x - a.x > 85 && a.y === 0);
  check('…smoothly, no snap (max ' + maxJump.toFixed(1) + '/tick)', maxJump <= 16.01);
  // Opponents never bump (they're on different halves anyway).
  check('blobs on opposite sides are untouched by bumping', w2.byId('r0').x === 1280);
}
{
  // Ball physics on the wide court: walls, net and scoring use the team geometry.
  const w = teamWorld(false);
  w.setupServe(0); w.release();
  Object.assign(w.ball, { x: 1480, y: 400, vx: 15, vy: 0 });
  w.step();
  check('the far wall is at 1485', w.ball.x <= w.geo.WALL_MAX && w.ball.vx < 0);
  Object.assign(w.ball, { x: 720, y: 60, vx: 15, vy: 0, px: 720, py: 60 });
  w.step();
  check('the net post at 750 blocks a low ball', w.ball.x <= 750 - BB.NET_BAND + 0.01 && w.ball.vx < 0);
  // A touched ball landing on the right half scores for the left team.
  const w3 = teamWorld(false);
  w3.setupServe(0); w3.release(); w3.touched = true;
  Object.assign(w3.ball, { x: 1100, y: 40, vx: 0, vy: -10 });
  let res = null;
  for (let t = 0; t < 10 && !res; t++) res = w3.step();
  check('landing on the right half scores for the left team', res && res.point && res.scorerSeat === 0 && res.loserSeat === 1);
  // A teammate touching the serve counts as a touch even if the server never moved.
  const w4 = teamWorld(false);
  w4.setupServe(0); w4.release();
  const front = w4.byId('l1');
  Object.assign(w4.ball, { x: front.x + 5, y: 140, vx: 0, vy: -4 });
  for (let t = 0; t < 4; t++) w4.step();
  check('a teammate\'s touch on the serve counts', w4.touched === true);
  const w5 = teamWorld(false);
  w5.setupServe(0); w5.release();
  for (let t = 0; t < 20; t++) w5.step();
  check('the server bouncing it in place still doesn\'t count', w5.touched === false);
}
{
  // CPU teams: full matches play out without errors, every blob gets touches,
  // and teammates split the work instead of both chasing every ball.
  let points = 0, touches = [0, 0, 0, 0], stuck = 0;
  for (let game = 0; game < 6; game++) {
    const w = teamWorld(true, game % 3 === 2);
    w.rng = seeded(100 + game);
    let seat = game % 2;
    for (let rally = 0; rally < 12; rally++) {
      w.setupServe(seat);
      w.release();
      let res = null, t = 0;
      for (; t < 3000 && !res; t++) {
        w.stepBots();
        res = w.step();
        for (const e of w.events) if (e.t === 'hit' && !e.cont) touches[e.i]++;
        w.events.length = 0;
      }
      if (!res) { stuck++; break; }
      if (res.point) { points++; seat = res.loserSeat; }
    }
  }
  check('CPU team matches keep producing points (' + points + ', stuck ' + stuck + ')', points > 40 && stuck === 0);
  check('every CPU blob plays the ball (' + touches.join(', ') + ')', touches.every((n) => n > 5));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nAll engine checks passed.');
process.exit(failures ? 1 : 0);
