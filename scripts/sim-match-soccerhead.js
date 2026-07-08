'use strict';
// Headless MATCH simulator for Soccer Head feel analysis.
//
// Loads the real physics engine (public/soccerhead/js/engine.js) with a window
// shim, drives each player with a simple but reasonable AI (position goal-side
// of the ball, chase, jump for high balls, kick when in range, dash to strike),
// plays full 1v1 matches with the real rules (timer + golden-goal), and reports
// aggregate stats so we can judge whether scoring/pace/feel are in a good place.
//
// Usage: node scripts/sim-match-soccerhead.js [games] [matchSeconds]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'soccerhead', 'js', 'engine.js'), 'utf8');
const sandbox = { window: {}, Math: Math };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const HB = sandbox.window.SoccerHead;

const DT = 1 / 120;
const GAMES = Number(process.argv[2] || 20);
const MATCH_SEC = Number(process.argv[3] || 90);
const MAX_SUDDEN_SEC = 60; // safety cap on golden-goal overtime

const f0 = new HB.World({ mode: '1v1' }).field;
const { GROUND_Y, TOP_Y, GOAL_DEPTH } = f0;
const W = HB.W;

function sign(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }

// ---- Simple AI ---------------------------------------------------------------
// Decisions are refreshed every REACT frames to model human reaction latency.
const REACT = 6; // ~50ms
function decide(w, p, opp, state) {
  const b = w.ball;
  const facing = p.facing; // red +1 (attacks right), blue -1 (attacks left)
  const ownGoalX = facing === 1 ? 0 : W;
  const st = state[p.id];

  const dist = Math.abs(b.x - p.x);
  const oppDist = Math.abs(b.x - opp.x);
  const amCloser = dist <= oppDist + 20;
  const ballFwd = facing * (b.x - ownGoalX);   // 0 own goal .. W opp goal
  const ballOnOwnHalf = ballFwd < W * 0.5;
  const commit = amCloser || ballOnOwnHalf;

  let desiredFwd = ballFwd - 44;               // goal-side of the ball
  if (!commit) {
    desiredFwd = Math.min(desiredFwd, W * 0.30); // retreat into our own third to guard the goal
    desiredFwd = Math.max(desiredFwd, W * 0.14);
  }
  desiredFwd = Math.max(12, Math.min(W * 0.78, desiredFwd));
  const desiredX = ownGoalX + facing * desiredFwd + (Math.random() * 2 - 1) * 12; // aim error
  const dx = desiredX - p.x;
  st.left = dx < -10;
  st.right = dx > 10;

  const inFront = facing * (b.x - p.x) > -16;
  const reachable = b.y > p.y - 150;
  st.kick = dist < 82 && inFront && reachable && Math.random() < 0.9; // occasional mistime

  st.jump = b.y < p.y - 120 && dist < 105 && b.vy > -60;

  const ahead = facing * (b.x - p.x);
  const inAtkHalf = ballFwd > W * 0.5;
  st.wantDash = commit && amCloser && inAtkHalf && p.dashCd <= 0 && p.dash <= 0
    && ahead > 55 && ahead < 190 && Math.abs(b.y - p.y) < 130;
}

function applyInputs(w, p, st) {
  w.setInput(p.id, 0, st.left);
  w.setInput(p.id, 1, st.right);
  if (st.kick) w.setInput(p.id, 3, true);
  // Jump: press on a rising edge only (avoid holding -> hop spam handled by
  // engine buffering, but we still gate with a small cooldown).
  if (st.jump && p.grounded && st.jumpCd <= 0) { w.setInput(p.id, 2, true); st.jumpCd = 0.5; }
  else { w.setInput(p.id, 2, false); }
  if (st.wantDash) { w.dash(p.id, p.facing); }
}

// ---- Touch tracking (to classify how goals are scored) ----------------------
function ballTouch(w) {
  const b = w.ball;
  let best = null, bestD = 1e9;
  for (const p of w.players) {
    const cands = [
      { d: Math.hypot(b.x - p.x, b.y - (p.y - f0.HEAD_CY)) - (f0.HEAD_R + b.r), type: b.y < p.y - 60 ? 'header' : 'body' },
      { d: Math.hypot(b.x - p.x, b.y - (p.y - f0.BODY_CY)) - (f0.BODY_R + b.r), type: 'body' },
      { d: Math.hypot(b.x - (p.x + p.facing * 40), b.y - (p.y - 30)) - (30 + b.r), type: 'kick' },
    ];
    for (const c of cands) {
      if (c.d < bestD) { bestD = c.d; best = { team: p.team, type: c.type, dashing: p.dash > 0, kicking: p.kick > 0 }; }
    }
  }
  if (bestD < 6 && best) {
    if (best.dashing) best.type = 'dash';
    else if (best.kicking) best.type = 'kick';
    return best;
  }
  return null;
}

// ---- One match ---------------------------------------------------------------
function playMatch() {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([
    { id: 'r', name: 'R', team: 'red', seat: 0 },
    { id: 'b', name: 'B', team: 'blue', seat: 0 },
  ]);
  w.frozen = false;
  w.kickoff(null);
  const players = { r: w.byId.get('r'), b: w.byId.get('b') };
  const state = { r: freshSt(), b: freshSt() };

  let clockMs = MATCH_SEC * 1000;
  let red = 0, blue = 0;
  let sudden = false, suddenMs = 0;
  const goals = []; // { team, atMs, type }
  let lastTouch = null;
  let kicks = 0, dashes = 0, jumps = 0, contacts = 0;
  let ballOnRedHalf = 0, ballOnBlueHalf = 0;
  let frame = 0;

  const stepsMax = Math.ceil((MATCH_SEC + MAX_SUDDEN_SEC) * 120) + 600;
  for (let i = 0; i < stepsMax; i++) {
    // AI decisions with per-player human-like reaction lag (~70–130ms).
    for (const id of ['r', 'b']) {
      const st = state[id];
      st.reactT = (st.reactT || 0) - DT;
      if (st.reactT <= 0) {
        st.reactT = 0.07 + Math.random() * 0.06;
        decide(w, players[id], players[id === 'r' ? 'b' : 'r'], state);
      }
    }
    for (const id of ['r', 'b']) {
      const st = state[id];
      if (st.jumpCd > 0) st.jumpCd -= DT;
      const wasKickCd = players[id].kickCd, wasDash = players[id].dash, wasDashCd = players[id].dashCd;
      applyInputs(w, players[id], st);
      if (st.wantDash && players[id].dash > 0 && wasDash <= 0) dashes++;
    }
    // Count kick starts / jumps by watching engine edges.
    const preKick = { r: players.r.kick, b: players.b.kick };
    const preAir = { r: players.r.grounded, b: players.b.grounded };

    const scored = w.step(DT);

    for (const id of ['r', 'b']) {
      if (players[id].kick > 0 && preKick[id] <= 0) kicks++;
      if (!players[id].grounded && preAir[id]) jumps++;
    }
    const t = ballTouch(w);
    if (t) { lastTouch = t; contacts++; }
    if (w.ball.x < W / 2) ballOnRedHalf++; else ballOnBlueHalf++;

    if (scored) {
      const type = lastTouch ? lastTouch.type : 'unknown';
      const atMs = sudden ? (MATCH_SEC * 1000 + suddenMs) : (MATCH_SEC * 1000 - clockMs);
      goals.push({ team: scored, atMs, type, byTeam: lastTouch ? lastTouch.team : null });
      if (scored === 'red') red++; else blue++;
      lastTouch = null;
      if (sudden) break; // golden goal ends it
      w.kickoff(scored === 'red' ? 'blue' : 'red');
      // brief settle
      continue;
    }

    if (!sudden) {
      clockMs -= DT * 1000;
      if (clockMs <= 0) {
        if (red === blue) { sudden = true; suddenMs = 0; }
        else break;
      }
    } else {
      suddenMs += DT * 1000;
      if (suddenMs >= MAX_SUDDEN_SEC * 1000) break; // cap
    }
    frame++;
  }

  return {
    red, blue, sudden, goals, kicks, dashes, jumps, contacts,
    possRed: ballOnRedHalf, possBlue: ballOnBlueHalf,
    lengthMs: sudden ? MATCH_SEC * 1000 + suddenMs : MATCH_SEC * 1000,
  };
}
function freshSt() { return { left: false, right: false, kick: false, jump: false, wantDash: false, jumpCd: 0 }; }

// ---- Run the batch ----------------------------------------------------------
const results = [];
for (let g = 0; g < GAMES; g++) results.push(playMatch());

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const totalGoals = sum(results, r => r.red + r.blue);
const redWins = results.filter(r => r.red > r.blue).length;
const blueWins = results.filter(r => r.blue > r.red).length;
const draws = results.filter(r => r.red === r.blue).length;
const suddenGames = results.filter(r => r.sudden).length;
const allGoals = results.flatMap(r => r.goals);
const byType = {};
for (const gl of allGoals) byType[gl.type] = (byType[gl.type] || 0) + 1;

// Time between goals within regulation.
const goalTimes = allGoals.map(g => g.atMs).sort((a, b) => a - b);

function pct(n, d) { return d ? (100 * n / d).toFixed(0) + '%' : '0%'; }

console.log('══════════ Soccer Head — ' + GAMES + ' simulated matches (' + MATCH_SEC + 's each, AI vs AI) ══════════');
console.log('Goals/game (avg):      ' + (totalGoals / GAMES).toFixed(2));
console.log('Final score spread:    ' + results.map(r => r.red + '-' + r.blue).slice(0, 12).join('  ') + (GAMES > 12 ? '  …' : ''));
console.log('Outcome:               red ' + redWins + '  |  blue ' + blueWins + '  |  needed golden-goal ' + suddenGames + '  (draws after OT cap: ' + draws + ')');
console.log('Symmetry (should ~50%):red win ' + pct(redWins, GAMES) + '  /  blue win ' + pct(blueWins, GAMES));
console.log('Avg match length:      ' + (sum(results, r => r.lengthMs) / GAMES / 1000).toFixed(1) + 's');
console.log('Goal types:            ' + Object.entries(byType).map(([k, v]) => k + ' ' + pct(v, allGoals.length)).join('  '));
console.log('Shots (kicks)/game:    ' + (sum(results, r => r.kicks) / GAMES).toFixed(0) +
  '   dashes/game: ' + (sum(results, r => r.dashes) / GAMES).toFixed(1) +
  '   jumps/game: ' + (sum(results, r => r.jumps) / GAMES).toFixed(0));
const possR = sum(results, r => r.possRed), possB = sum(results, r => r.possBlue);
console.log('Ball time by half:     red-half ' + pct(possR, possR + possB) + '  /  blue-half ' + pct(possB, possR + possB));
// Scoreless games?
console.log('Scoreless-at-regulation games (went to OT or 0-0): ' + suddenGames);
console.log('Conversion:            ~' + (totalGoals / Math.max(1, sum(results, r => r.kicks)) * 100).toFixed(1) + '% of kicks lead to a goal (rough)');
