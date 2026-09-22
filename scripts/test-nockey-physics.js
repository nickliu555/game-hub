'use strict';
// Headless probe of the Nockey physics engine (public/nockey/js/engine.js).
// Loads the browser IIFE with a minimal window shim and checks it against the
// HaxBall reference numbers.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'nockey', 'js', 'engine.js'), 'utf8');
const sandbox = { window: {}, Math: Math };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const PB = sandbox.window.Nockey;
const PHYS = PB.PHYS;

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
function speed(d) { return Math.hypot(d.vx, d.vy); }

function makeWorld(tier, roster) {
  const w = new PB.World({ tier: tier || 'classic' });
  w.setRoster(roster || [
    { id: 'r', name: 'Red', team: 'red', seat: 0 },
    { id: 'b', name: 'Blue', team: 'blue', seat: 0 },
  ]);
  w.frozen = false;
  return w;
}
// Discs can't be parked off-pitch (the walls push them back), so tests that need
// an empty pitch use a one-player roster.
function soloWorld(tier) {
  return makeWorld(tier, [{ id: 'r', name: 'Red', team: 'red', seat: 0 }]);
}
function emptyWorld(tier) {
  return makeWorld(tier, []);
}
function stepN(w, n) { let g = null; for (let i = 0; i < n; i++) { const r = w.step(); if (r) g = r; } return g; }

console.log('Nockey physics');

// 1. Terminal player speed = a·d/(1−d) = 2.4 u/tick.
(function () {
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = -w.stadium.halfW + 20; p.y = 0; p.vx = 0; p.vy = 0;
  w.ball.x = 0; w.ball.y = -w.stadium.halfH + 20; // out of the run
  w.setInput('r', 1, 0, false);
  stepN(w, 150);
  check('player terminal speed ≈ 2.4 u/tick', Math.abs(speed(p) - 2.4) < 0.01, 'v=' + speed(p).toFixed(4));
})();

// 2. Kick imparts kickStrength along the player→ball normal.
(function () {
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
  w.ball.x = 20; w.ball.y = 0; w.ball.vx = 0; w.ball.vy = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  const expect = PHYS.kickStrength * PHYS.ballInvMass * PHYS.ballDamping;
  check('kick sends the ball at ≈' + PHYS.kickStrength + ' u/tick',
    Math.abs(w.ball.vx - expect) < 0.05, 'vx=' + w.ball.vx.toFixed(3) + ' expect=' + expect.toFixed(3));
  check('kick is at least as strong as HaxBall', PHYS.kickStrength >= 5, 'k=' + PHYS.kickStrength);
})();

// 3. Kick needs a fresh press: holding it does not re-kick.
(function () {
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = 20; w.ball.y = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  const after1 = w.ball.vx;
  w.ball.x = p.x + 20; w.ball.y = p.y; w.ball.vx = 0; w.ball.vy = 0;
  w.step(); // still held
  check('held kick does not re-fire', Math.abs(w.ball.vx) < 0.01, 'vx=' + w.ball.vx.toFixed(3));
  w.setInput('r', 0, 0, false);
  w.setInput('r', 0, 0, true);
  w.ball.x = p.x + 20; w.ball.y = p.y; w.ball.vx = 0; w.ball.vy = 0;
  w.step();
  check('re-press kicks again', w.ball.vx > 4, 'vx=' + w.ball.vx.toFixed(3) + ' (first ' + after1.toFixed(2) + ')');
})();
// 4. Kick range is exactly r_p + r_b + 4 — the reach beyond contact is what
// matters, and it stays 4 whatever the puck radius is.
(function () {
  const reach = PHYS.playerRadius + PHYS.ballRadius + PHYS.kickRange;
  const gap = reach - (PHYS.playerRadius + PHYS.ballRadius);
  check('kick reach is 4 beyond contact', gap === 4, 'reach=' + reach + ' gap=' + gap);
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = reach + 0.5; w.ball.y = 0; w.ball.vx = 0; w.ball.vy = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  check('kick misses just outside reach', Math.abs(w.ball.vx) < 0.01, 'vx=' + w.ball.vx.toFixed(3));
})();

// 5. Ball damping: v after n free ticks = v0 · 0.99^n.
(function () {
  const w = emptyWorld();
  w.ball.x = 0; w.ball.y = 0; w.ball.vx = 2; w.ball.vy = 0;
  const expect = 2 * Math.pow(PHYS.ballDamping, 60);
  stepN(w, 60);
  check('ball damping matches 0.99^n', Math.abs(w.ball.vx - expect) < 1e-6, 'vx=' + w.ball.vx.toFixed(5) + ' expect=' + expect.toFixed(5));
})();

// 6. Board rebound uses the product of the bCoefs (ball 0.5 × ballArea 1).
(function () {
  const w = emptyWorld();
  const S = w.stadium;
  w.ball.x = 0; w.ball.y = -(S.halfH - PHYS.ballRadius - 3); w.ball.vx = 0; w.ball.vy = -2;
  stepN(w, 12);
  check('ball rebounds off the touchline at ≈half speed', w.ball.vy > 0.85 && w.ball.vy < 1.05, 'vy=' + w.ball.vy.toFixed(3));
})();

// 7. Players stay on the pitch; the ball can leave through the goal mouth only.
(function () {
  const w = soloWorld();
  const S = w.stadium;
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = 0; w.ball.y = S.halfH - 20;
  w.setInput('r', -1, 0, false);
  stepN(w, 600);
  check('player is stopped by the goal line', p.x > -S.halfW - 1 && p.x < -S.halfW + PHYS.playerRadius + 1, 'x=' + p.x.toFixed(1));
})();

// 7b. The touchlines hold skaters in just as firmly as the goal lines do, and
// the corner cut stops anyone slipping round the outside of the boards.
(function () {
  const lim = 1;
  ['small', 'classic', 'big', 'huge'].forEach(function (tier) {
    const dirs = [[0, -1], [0, 1], [1, -1], [-1, 1], [1, 1], [-1, -1]];
    let worst = 0;
    let where = '';
    dirs.forEach(function (d) {
      const w = soloWorld(tier);
      const S = w.stadium;
      const p = w.byId.get('r');
      p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
      w.ball.x = 0; w.ball.y = 0;
      w.setInput('r', d[0], d[1], false);
      stepN(w, 900);
      const over = Math.abs(p.y) - (S.halfH - PHYS.playerRadius);
      if (over > worst) { worst = over; where = tier + ' ' + d + ' y=' + p.y.toFixed(1) + '/' + S.halfH; }
    });
    check(tier + ': skaters never cross the touchline', worst < lim, where || 'over=' + worst.toFixed(1));
  });
})();

// 8. Goal only counts between the posts.
(function () {
  const w = emptyWorld();
  const S = w.stadium;
  w.ball.x = -(S.halfW - 30); w.ball.y = 0; w.ball.vx = -4; w.ball.vy = 0;
  const g = stepN(w, 40);
  check('ball in the middle of the mouth is a goal for blue', !!g && g.team === 'blue', 'g=' + JSON.stringify(g));

  const w2 = emptyWorld();
  w2.ball.x = -(S.halfW - 30); w2.ball.y = S.goalHalf + 30; w2.ball.vx = -4; w2.ball.vy = 0;
  const g2 = stepN(w2, 60);
  check('ball wide of the post is not a goal', !g2, 'g=' + JSON.stringify(g2));
})();

// 8b. The goal counts on the crossing tick, then the puck keeps travelling into
// the net for the celebration — without ever scoring a second time.
(function () {
  const w = emptyWorld();
  const S = w.stadium;
  w.ball.x = -(S.halfW - 30); w.ball.y = 0; w.ball.vx = -4; w.ball.vy = 0;
  let g = null;
  for (let i = 0; i < 40 && !g; i++) g = w.step();
  check('goal reported on the crossing tick', !!g && g.team === 'blue', 'g=' + JSON.stringify(g));
  const crossX = w.ball.x;
  check('puck is only just over the line', crossX <= -S.halfW && crossX > -S.halfW - 6, 'x=' + crossX.toFixed(1));

  let deepest = crossX;
  let again = null;
  for (let i = 0; i < 300; i++) {
    const r = w.step();
    if (r) again = r;
    if (w.ball.x < deepest) deepest = w.ball.x;
  }
  check('the same goal is not scored twice', !again && w.blueScore === 1, 'again=' + JSON.stringify(again) + ' blue=' + w.blueScore);
  check('puck carried on into the net', deepest < crossX - 5, 'deepest=' + deepest.toFixed(1) + ' cross=' + crossX.toFixed(1));
  const back = -(S.halfW + S.netDepth);
  check('puck stays inside the net', w.ball.x > back - 1 && w.ball.x < -S.halfW, 'x=' + w.ball.x.toFixed(1) + ' back=' + back);

  w.kickoff('red');
  check('kickoff clears the goal latch', w.goalLocked === false, 'goalLocked=' + w.goalLocked);
})();

// 9. Nothing holds a team back at a face-off — there is no invisible line and
// no seven-second wait, so the defending side can cross the moment play starts.
(function () {
  const w = makeWorld();
  const S = w.stadium;
  w.kickoff('red');
  w.frozen = false;
  const blue = w.byId.get('b');
  blue.x = 40; blue.y = 0;
  w.setInput('b', -1, 0, false);
  stepN(w, 120);
  check('the defending team can cross the centre line at once', blue.x < -1, 'x=' + blue.x.toFixed(1));

  // The centre circle used to be walled off from the defending team too.
  w.kickoff('red');
  const inner = w.byId.get('b');
  inner.x = S.circle * 0.9; inner.y = 0;
  w.setInput('b', -1, 0, false);
  stepN(w, 60);
  const dist = Math.hypot(inner.x - w.ball.x, inner.y - w.ball.y);
  check('the defending team can enter the face-off circle', Math.abs(inner.x) < S.circle,
    'x=' + inner.x.toFixed(1) + ' circle=' + S.circle + ' toPuck=' + dist.toFixed(1));
})();

// 9b. The face-off puck is spotted onto the restarting team's side of centre
// (red defends the left goal, so red restarts on -x). A neutral drop, which
// nobody owns, stays on the centre spot.
(function () {
  const w = makeWorld();
  const S = w.stadium;
  w.kickoff(null);
  check('a neutral drop is dead centre', w.ball.x === 0 && w.ball.y === 0, 'x=' + w.ball.x);

  w.kickoff('red');
  const redX = w.ball.x;
  check('red restart is spotted on red\'s side', redX < 0, 'x=' + redX.toFixed(1));
  w.kickoff('blue');
  check('blue restart mirrors it', Math.abs(w.ball.x + redX) < 1e-9, 'x=' + w.ball.x.toFixed(1));
  check('the puck stays well inside the face-off circle', Math.abs(w.ball.x) < S.circle - PHYS.ballRadius,
    '|x|=' + Math.abs(w.ball.x).toFixed(1) + ' circle=' + S.circle);
  check('interpolation starts from the spot, not the centre', w.ball.px === w.ball.x);
})();

// 9c. A CPU whose team did NOT win the face-off holds a goal-side shape rather
// than losing a race for a puck spotted on the other side of the rink.
(function () {
  const roster = [
    { id: 'r', name: 'Red', team: 'red', seat: 0, isBot: true },
    { id: 'b', name: 'Blue', team: 'blue', seat: 0, isBot: true },
  ];
  function runFaceoff(koTeam) {
    const w = new PB.World({ tier: 'classic' });
    w.setRoster(roster);
    w.kickoff(koTeam);
    w.frozen = false;
    let closest = Infinity;
    // Stop once the puck is played so we only measure face-off behaviour.
    for (let i = 0; i < 240 && w.koUntouched; i++) {
      w.stepBots();
      w.step();
      w.events.length = 0;
      const blue = w.byId.get('b');
      closest = Math.min(closest, Math.hypot(blue.x - w.ball.x, blue.y - w.ball.y));
    }
    return { w: w, closest: closest, blue: w.byId.get('b') };
  }

  const theirs = runFaceoff('red');   // blue did NOT win it -> should sit back
  const ours = runFaceoff('blue');    // blue DID win it -> should attack
  const neutral = runFaceoff(null);   // nobody's puck -> should attack
  const S = theirs.w.stadium;
  check('the CPU stays goal-side when the face-off is not its own', theirs.blue.x > S.halfW * 0.25,
    'x=' + theirs.blue.x.toFixed(1) + ' ownGoal=' + S.halfW);
  check('a neutral drop is nobody\'s face-off, so the CPU races for it',
    neutral.closest < theirs.closest,
    'neutral=' + neutral.closest.toFixed(1) + ' theirs=' + theirs.closest.toFixed(1));
  check('the CPU still goes for a face-off it owns', ours.closest < theirs.closest,
    'own=' + ours.closest.toFixed(1) + ' theirs=' + theirs.closest.toFixed(1));
})();

// 9d. A puck nobody plays is whistled dead after ten seconds, but only once it
// has stopped — a shot still travelling is live hockey.
(function () {
  const w = soloWorld();
  const red = w.byId.get('r');
  // Park the skater in a corner so it can never brush the puck.
  red.x = -w.stadium.halfW * 0.8; red.y = -w.stadium.halfH * 0.8;
  w.kickoff(null);
  red.x = -w.stadium.halfW * 0.8; red.y = -w.stadium.halfH * 0.8;
  check('a fresh face-off starts the dead-puck clock at zero', w.idleTicks === 0);

  const early = stepN(w, 599);
  check('a dead puck survives just under ten seconds', early === null && w.idleTicks === 599,
    'ticks=' + w.idleTicks);
  const late = w.step();
  check('a dead puck is whistled at ten seconds', late !== null && late.idle === true,
    'got=' + JSON.stringify(late));
  check('the whistle rearms the clock', w.idleTicks === 0, 'ticks=' + w.idleTicks);
})();

// 9e. Touching the puck resets the clock; so does a puck that is still moving.
(function () {
  const w = soloWorld();
  const red = w.byId.get('r');
  w.kickoff(null);
  red.x = -w.stadium.halfW * 0.8; red.y = -w.stadium.halfH * 0.8;
  stepN(w, 300);
  check('the clock runs while nobody is near the puck', w.idleTicks === 300, 'ticks=' + w.idleTicks);

  // Skate onto the puck and hit it.
  red.x = w.ball.x - (PHYS.playerRadius + PHYS.ballRadius) - 1; red.y = w.ball.y;
  w.setInput('r', 1, 0, true);
  w.step();
  check('a hit marks the puck as touched', w.ball.touched === true);
  check('a hit resets the dead-puck clock', w.idleTicks === 0, 'ticks=' + w.idleTicks);
  check('a hit also ends the face-off', w.koUntouched === false);

  // A puck still flying does not age toward the whistle.
  w.clearInput('r');
  red.x = -w.stadium.halfW * 0.8; red.y = -w.stadium.halfH * 0.8;
  w.ball.vx = 6; w.ball.vy = 0;
  w.idleTicks = 0;
  stepN(w, 5);
  check('a travelling puck does not age toward the whistle', w.idleTicks === 0,
    'ticks=' + w.idleTicks + ' v=' + speed(w.ball).toFixed(2));
})();

// 9f. Skaters can work the corners: the boards they run into are the rounded
// arcs the rink is drawn with, not a straight chord cutting the corner off.
(function () {
  const w = soloWorld();
  const S = w.stadium;
  const p = w.byId.get('r');
  const cx = S.halfW - S.corner;
  const cy = S.halfH - S.corner;
  w.ball.x = 0; w.ball.y = 0;

  // Skate down the top board and round the corner.
  p.x = 0; p.y = -S.halfH + p.r; p.vx = 0; p.vy = 0;
  w.setInput('r', 1, 0, false);
  stepN(w, 200);
  const gap = S.corner - p.r - Math.hypot(p.x - cx, p.y - -cy);
  check('a skater follows the corner arc instead of stopping at a chord',
    Math.abs(gap) < 1.5 && p.x > cx,
    'x=' + p.x.toFixed(1) + ' y=' + p.y.toFixed(1) + ' gap=' + gap.toFixed(2));

  // Pressing into the corner diagonally must not squeeze them out behind it.
  w.setInput('r', 1, -1, false);
  stepN(w, 200);
  check('a skater cannot be pushed out behind the corner',
    Math.hypot(p.x - cx, p.y - -cy) <= S.corner - p.r + 0.01,
    'd=' + Math.hypot(p.x - cx, p.y - -cy).toFixed(1) + ' max=' + (S.corner - p.r).toFixed(1));

  // The far corner is reachable too, and the whole sheet stays in bounds.
  w.setInput('r', 1, 1, false);
  stepN(w, 300);
  check('the opposite corner is reachable', p.y > cy && p.x > cx,
    'x=' + p.x.toFixed(1) + ' y=' + p.y.toFixed(1));
  check('the skater is still inside the boards',
    Math.abs(p.x) <= S.halfW - p.r + 0.01 && Math.abs(p.y) <= S.halfH - p.r + 0.01,
    'x=' + p.x.toFixed(1) + ' y=' + p.y.toFixed(1));
})();

// 9g. The net grows with the rink so a bigger sheet isn't a relatively smaller
// target, and the posts stay inside the boards.
(function () {
  const tiers = ['small', 'classic', 'big', 'huge'];
  const specs = tiers.map(function (t) { return emptyWorld(t).stadium; });
  let grows = true, fits = true;
  for (let i = 1; i < specs.length; i++) {
    if (!(specs[i].goalHalf > specs[i - 1].goalHalf)) grows = false;
  }
  const shares = specs.map(function (s) { return s.goalHalf / s.halfH; });
  for (let i = 0; i < specs.length; i++) {
    if (specs[i].goalHalf >= specs[i].halfH) fits = false;
  }
  check('every bigger rink gets a bigger net', grows,
    tiers.map(function (t, i) { return t + '=' + specs[i].goalHalf; }).join(' '));
  check('the net stays a steady share of the rink height', Math.max.apply(null, shares) - Math.min.apply(null, shares) < 0.05,
    shares.map(function (s) { return s.toFixed(3); }).join(' '));
  check('the goal mouth fits between the boards', fits);
})();


// 9b. A kick thrown during the goal freeze must not still be flashing at kickoff.
(function () {
  const w = makeWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = 20; w.ball.y = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  check('kicking sets the flash ring', p.kickFlash > 0, 'flash=' + p.kickFlash);
  w.frozen = true;
  stepN(w, 30);
  check('the flash is held while the world is frozen', p.kickFlash > 0, 'flash=' + p.kickFlash);
  w.kickoff('blue');
  check('kickoff clears the flash on every player',
    w.players.every(function (q) { return q.kickFlash === 0; }), 'flash=' + p.kickFlash);
})();

// 10. Pitch tiers.
(function () {
  check('tier for 1v1 is small', PB.pickTier(1) === 'small');
  check('tier for 2v2 is classic', PB.pickTier(2) === 'classic');
  check('tier for 3v3 is big', PB.pickTier(3) === 'big');
  check('tier for 4v4 is huge', PB.pickTier(4) === 'huge');
  let sizesOk = true;
  let spawnsOk = true;
  let prev = 0;
  PB.TIERS.forEach(function (t, i) {
    const S = PB.makeStadium(t);
    if (S.halfW <= prev) sizesOk = false;
    prev = S.halfW;
    const roster = [];
    for (let k = 0; k < i + 1; k++) {
      roster.push({ id: 'r' + k, name: 'R' + k, team: 'red', seat: k });
      roster.push({ id: 'b' + k, name: 'B' + k, team: 'blue', seat: k });
    }
    const w = new PB.World({ tier: t });
    w.setRoster(roster);
    w.players.forEach(function (p) {
      if (Math.abs(p.x) > S.halfW - p.r || Math.abs(p.y) > S.halfH - p.r) spawnsOk = false;
      if (p.team === 'red' && p.x >= 0) spawnsOk = false;
      if (p.team === 'blue' && p.x <= 0) spawnsOk = false;
    });
  });
  check('each tier is bigger than the last', sizesOk);
  check('every tier spawns its full roster in bounds and on its own half', spawnsOk);
})();

// 11. Bots produce legal 8-way input and can score against an empty net.
(function () {
  const w = new PB.World({ tier: 'classic' });
  w.setRoster([{ id: 'bot-1', name: 'CPU', team: 'red', seat: 0, isBot: true }]);
  w.frozen = false;
  w.koActive = false;
  let legal = true;
  let goal = null;
  for (let i = 0; i < 60 * 30 && !goal; i++) {
    w.stepBots();
    const bot = w.byId.get('bot-1');
    if (![-1, 0, 1].includes(bot.inX) || ![-1, 0, 1].includes(bot.inY)) legal = false;
    goal = w.step();
  }
  check('bot input stays on the 8-way grid', legal);
  check('bot scores on an empty net within 30s', !!goal && goal.team === 'red', 'goal=' + JSON.stringify(goal));
})();

function dribbleWorld(offset, assisted) {
  const world = soloWorld('huge');
  const player = world.byId.get('r');
  player.x = -225; player.y = 0;
  world.ball.x = -200; world.ball.y = offset;
  world.setInput('r', 1, 0, false);
  if (!assisted) world._assistDribble = function () {};
  return world;
}

for (const offset of [1, 3, 5]) {
  const assisted = dribbleWorld(offset, true);
  const baseline = dribbleWorld(offset, false);
  stepN(assisted, 180);
  stepN(baseline, 180);
  const player = assisted.byId.get('r');
  const distance = Math.hypot(assisted.ball.x - player.x, assisted.ball.y - player.y);
  check('gentle pushing keeps a slightly off-center ball close: ' + offset, distance < 30, 'distance=' + distance.toFixed(2));
  check('assisted pushing stays slower than running and much slower than kicking: ' + offset,
    speed(assisted.ball) < 2.5 && speed(assisted.ball) < PHYS.kickStrength * 0.4);
  check('close control improves over unassisted contact: ' + offset,
    assisted.ball.x > baseline.ball.x + 20);
}

function motionState(world) {
  return JSON.stringify(world.players.concat([world.ball]).map(function (disc) {
    return [disc.x, disc.y, disc.vx, disc.vy];
  }));
}

const unchangedContactCases = [
  ['aligned pushing gets no extra forward power', function () {}],
  ['kicks are unchanged', function (world) { world.setInput('r', 1, 0, true); }],
  ['fast incoming shots are unchanged', function (world) { world.ball.vx = -6; }],
  ['hard body impacts are unchanged', function (world) { world.byId.get('r').vx = 3; }],
  ['stationary players get no assist', function (world) { world.setInput('r', 0, 0, false); }],
  ['moving away gets no assist', function (world) { world.setInput('r', -1, 0, false); }],
  ['frozen worlds get no assist', function (world) { world.frozen = true; }],
  ['balls outside contact range are not pulled in', function (world) { world.ball.x += 10; }],
  ['contested contact gets no assist', function (world) {
    world.setRoster([
      { id: 'r', name: 'Red', team: 'red', seat: 0 },
      { id: 'b', name: 'Blue', team: 'blue', seat: 0 },
    ]);
    world.koActive = false;
    const red = world.byId.get('r');
    const blue = world.byId.get('b');
    red.x = -224; red.y = 0;
    blue.x = -176; blue.y = 0;
    world.ball.x = -200; world.ball.y = 3;
    world.setInput('r', 1, 0, false);
    world.setInput('b', -1, 0, false);
  }],
];
for (const [name, configure] of unchangedContactCases) {
  const assisted = dribbleWorld(0, true);
  const baseline = dribbleWorld(0, false);
  if (!name.startsWith('aligned')) {
    assisted.ball.x = baseline.ball.x = -201;
    assisted.ball.y = baseline.ball.y = 3;
  }
  configure(assisted);
  configure(baseline);
  assisted.step();
  baseline.step();
  check(name, motionState(assisted) === motionState(baseline));
}

const turning = dribbleWorld(3, true);
stepN(turning, 90);
turning.setInput('r', 1, 1, false);
stepN(turning, 90);
check('a sharp turn does not carry the ball with the player',
  Math.hypot(turning.ball.x - turning.byId.get('r').x, turning.ball.y - turning.byId.get('r').y) > 60);

const shooting = dribbleWorld(3, true);
stepN(shooting, 90);
shooting.setInput('r', 1, 0, true);
shooting.step();
check('a kick releases close control at full power', speed(shooting.ball) > PHYS.kickStrength);

console.log(failures === 0 ? '\nAll physics checks passed.' : '\n' + failures + ' check(s) failed.');
process.exit(failures === 0 ? 0 : 1);
