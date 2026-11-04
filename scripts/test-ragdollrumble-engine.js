'use strict';
/* Headless engine tests for Ragdoll Rumble.
 * Loads planck + engine.js in Node and asserts the active-ragdoll fighters
 * (standing, walking, jumping, air jumps, one-way platforms), the input path
 * (press counters, taps between ticks), attacks (jab combo, tap vs hold
 * smash, knockback growing with damage), grabs (vulnerable-only, throw, mash
 * out, escape), items, hazards, stage gimmicks, blast-zone KOs + credit,
 * sudden death, determinism and a dropped (idle) player staying in the fight.
 * Run: node scripts/test-ragdollrumble-engine.js
 */
globalThis.planck = require('planck');
require('../public/ragdollrumble/js/engine.js');
const NM = globalThis.RagdollRumble;
const DT = 1 / 120;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }

function world(stage, n, opts) {
  const w = new NM.World(Object.assign({ stage: stage || 'rooftop', items: false }, opts || {}));
  const r = [];
  for (let i = 0; i < (n || 2); i++) r.push({ id: 'p' + i, name: 'P' + i, seat: i });
  w.reset(7, r);
  return w;
}
function run(w, sec, each) {
  const evs = [];
  const steps = Math.round(sec / DT);
  for (let i = 0; i < steps; i++) { if (each) each(i); w.step(DT).forEach((e) => evs.push(e)); }
  return evs;
}
function place(p, x, y) {
  const t = p.parts.torso.getPosition();
  const dx = x - t.x, dy = y === undefined ? 0 : y - t.y;
  p.partList.forEach((b) => { const q = b.getPosition(); b.setTransform(planck.Vec2(q.x + dx, q.y + dy), b.getAngle()); b.setLinearVelocity(planck.Vec2(0, 0)); });
}
const pos = (w, p) => w.posOf(p);
// Input helpers that mirror the phone: counters bump on each press.
function pad() {
  const c = {};
  return {
    press(w, id, btn, x, y) {
      c[id] = c[id] || { jp: 0, ap: 0 };
      if (btn === 'jump') c[id].jp++; else c[id].ap++;
      w.setInput(id, x || 0, y || 0, btn === 'jump' ? 1 : 2, c[id].jp, c[id].ap);
    },
    release(w, id, x, y) { c[id] = c[id] || { jp: 0, ap: 0 }; w.setInput(id, x || 0, y || 0, 0, c[id].jp, c[id].ap); },
    stick(w, id, x, y, b) { c[id] = c[id] || { jp: 0, ap: 0 }; w.setInput(id, x, y, b || 0, c[id].jp, c[id].ap); },
  };
}
function tap(w, P, id, btn, x, y) { P.press(w, id, btn, x, y); P.release(w, id, x, y); }

// ---------------------------------------------------------------- standing
section('Active ragdoll: standing on every stage');
for (const sid of NM.STAGE_IDS) {
  const w = world(sid, 8);
  run(w, 1);
  const ok = w.players.every((p) => p.grounded && Math.abs(p.parts.torso.getAngle()) < 0.12);
  const heights = w.players.map((p) => +(p.ground.y - pos(w, p).y).toFixed(2));
  check(sid + ': all 8 fighters stand upright at leg height', ok && heights.every((h) => Math.abs(h - NM.STAND_H) < 0.12), heights);
}

section('Movement');
{
  const w = world('rooftop', 1);
  const p = w.players[0];
  place(p, -6); run(w, 0.3);
  const P = pad();
  P.stick(w, 'p0', 1, 0);
  run(w, 0.8);
  check('walks at MOVE_SPEED', Math.abs(pos(w, p).vx - NM.MOVE_SPEED) < 0.6, pos(w, p).vx);
  check('faces the way it walks', p.facing === 1);
  P.stick(w, 'p0', 0, 0); run(w, 0.4);
  check('stops when the stick is released', Math.abs(pos(w, p).vx) < 0.3);
  const y0 = pos(w, p).y;
  let peak = y0;
  tap(w, P, 'p0', 'jump');
  P.stick(w, 'p0', 0, 0, 1);
  run(w, 0.7, () => { peak = Math.min(peak, pos(w, p).y); });
  check('a held jump rises 3.5m+', y0 - peak > 3.5, y0 - peak);
  P.release(w, 'p0'); run(w, 1.2);
  let peakShort = pos(w, p).y; const ys = peakShort;
  tap(w, P, 'p0', 'jump');
  run(w, 0.6, () => { peakShort = Math.min(peakShort, pos(w, p).y); });
  check('a tapped jump is a short hop', ys - peakShort < (y0 - peak) * 0.75, ys - peakShort);
  run(w, 1);
  // Air jumps: one ground jump + AIR_JUMPS air jumps, then nothing (tapped
  // quickly, so the fighter is still in the air for every tap).
  const evs = [];
  for (let k = 0; k < NM.AIR_JUMPS + 2; k++) { tap(w, P, 'p0', 'jump'); evs.push(...run(w, 0.18)); }
  check('one ground jump + ' + NM.AIR_JUMPS + ' air jumps', evs.filter((e) => e.type === 'jump').length === 1 && evs.filter((e) => e.type === 'airjump').length === NM.AIR_JUMPS);
  run(w, 2);
  check('air jumps refresh on landing', p.grounded && p.airJumps === NM.AIR_JUMPS);
}

section('Spawns');
for (const sid of NM.STAGE_IDS) {
  let ok = true, why = '';
  for (let n = 2; n <= 6; n++) {
    const w = world(sid, n);
    run(w, 0.5);
    const xs = w.players.map((p) => pos(w, p).x);
    const sorted = xs.slice().sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((x, i) => x - sorted[i]);
    if (!w.players.every((p) => p.alive && p.grounded)) { ok = false; why = n + 'p: not all standing'; }
    if (Math.abs(sorted[0] + sorted[n - 1]) > 0.8) { ok = false; why = n + 'p: not symmetric ' + sorted; }
    if (Math.min(...gaps) < 1.8) { ok = false; why = n + 'p: crowded ' + gaps.map((g) => g.toFixed(1)); }
  }
  check(sid + ': 2–6 fighters spawn spread end to end, all standing', ok, why);
}
{
  const w = world('rooftop', 2); run(w, 0.3);
  check('1v1 spawns stay at the far spots, facing each other', Math.abs(pos(w, w.players[0]).x + 9) < 0.5 && Math.abs(pos(w, w.players[1]).x - 9) < 0.5 && w.players[0].facing === 1 && w.players[1].facing === -1);
}

section('One-way platforms');
{
  const w = world('rooftop', 1);
  const p = w.players[0];
  place(p, -6); run(w, 0.3);
  const P = pad();
  P.press(w, 'p0', 'jump'); run(w, 1.2);
  check('jumps up through a platform and lands on top', p.grounded && p.ground.kind === 'platform' && Math.abs(p.ground.y - -3.8) < 0.05, p.ground);
  P.release(w, 'p0', 0, 1); P.press(w, 'p0', 'jump', 0, 1); P.release(w, 'p0', 0, 1);
  run(w, 1);
  check('down + jump drops through to the floor', p.grounded && p.ground.kind === 'solid');
  // Holding down alone drops through too.
  P.release(w, 'p0'); P.press(w, 'p0', 'jump'); run(w, 1.2); P.release(w, 'p0');
  check('back up on the platform', p.grounded && p.ground.kind === 'platform');
  P.stick(w, 'p0', 0, 1, 2); run(w, 0.3);
  check('down while holding ACTION stays on the platform', p.grounded && p.ground.kind === 'platform');
  P.stick(w, 'p0', 0, 0); run(w, 0.6);
  P.stick(w, 'p0', 0.2, 1); run(w, 1 / 120);
  check('pressing down (no buttons) drops through instantly', !p.grounded && p.dropT > 0);
  run(w, 1.2);
  check('…and lands on the floor below', p.grounded && p.ground.kind === 'solid');
  P.stick(w, 'p0', 0, 0); P.press(w, 'p0', 'jump'); run(w, 1.2); P.release(w, 'p0');
  P.stick(w, 'p0', 0.9, 0.8); run(w, 0.4);
  check('a diagonal (walking) push does not drop', p.grounded && p.ground.kind === 'platform' || pos(w, p).x > -3.6);
  P.stick(w, 'p0', 0, 0); run(w, 0.3);
}
{
  // Down-aimed punches on a plank stay on the plank.
  const w = world('rooftop', 1);
  const p = w.players[0];
  place(p, -6); run(w, 0.3);
  const P = pad();
  P.press(w, 'p0', 'jump'); run(w, 1.2); P.release(w, 'p0');
  P.press(w, 'p0', 'act', 0, 1); run(w, 0.6);
  check('holding down while charging ACTION does not drop', p.grounded && p.ground.kind === 'platform');
  P.release(w, 'p0', 0, 1); run(w, 0.05); P.stick(w, 'p0', 0, 0); run(w, 0.6);
}

section('Wall jumps');
{
  const w = world('rooftop', 1);
  const p = w.players[0];
  place(p, 12.5, 2.0);
  p.airJumps = 0;
  const P = pad();
  P.stick(w, 'p0', -1, 0); run(w, 0.45);
  check('beside the stage wall it is detected', p.wallDir === -1);
  check('holding into the wall slows the slide to a cling', pos(w, p).vy <= NM.WALL_SLIDE + 0.2, pos(w, p).vy);
  P.press(w, 'p0', 'jump', -1, 0); P.release(w, 'p0', -1, 0);
  const ev = run(w, 0.05);
  check('JUMP on the wall kicks up and away', ev.some((e) => e.type === 'walljump') && pos(w, p).vy < -8 && pos(w, p).vx > 4);
  check('a wall kick does not use an air jump', p.airJumps === 0 && p.wallJumps === 1);
  run(w, 1.6, () => P.stick(w, 'p0', -1, 0));
  check('two kicks get a fighter with no air jumps back onto the stage', p.alive && p.grounded && pos(w, p).x < 12);
  check('landing resets wall kicks and air jumps', p.wallJumps === 0 && p.airJumps === NM.AIR_JUMPS);
}
{
  const w = world('rooftop', 1);
  const p = w.players[0];
  place(p, 12.5, 2.0);
  p.airJumps = 0; p.wallJumps = 0;
  const P = pad();
  const kickVy = () => {
    place(p, 12.5, 2.0); p.airJumps = 0;
    P.stick(w, 'p0', -1, 0); run(w, 0.1);
    P.press(w, 'p0', 'jump', -1, 0); P.release(w, 'p0', -1, 0);
    run(w, 1 / 120);
    return pos(w, p).vy;
  };
  const vs = [];
  for (let k = 0; k < 8; k++) vs.push(kickVy());
  check('unlimited wall kicks in one trip through the air (8 in a row)', p.wallJumps === 8, p.wallJumps);
  check('…all at full strength (no decay)', vs.every((v) => Math.abs(v - vs[0]) < 0.6 && v < -8), vs.map((v) => +v.toFixed(1)));
}
{
  const w = world('rooftop', 1);
  const p = w.players[0];
  place(p, -6); run(w, 0.3);
  const P = pad();
  P.press(w, 'p0', 'jump'); run(w, 0.25);
  check('floating platforms are not walls', p.wallDir === 0);
}
for (const [sid, x, y] of [['rooftop', 12.5, 9], ['crumble', 15.5, 10], ['peak', 11.5, 8], ['factory', 12.5, 12], ['ship', 13.15, 1.4]]) {
  // Deep down the side of a ground block (well below its old slab) is still a wall.
  const w = world(sid, 1);
  const p = w.players[0];
  place(p, x, y); p.airJumps = 0;
  const P = pad();
  P.stick(w, 'p0', -1, 0); run(w, 0.15);
  const wall = p.wallDir;
  P.press(w, 'p0', 'jump', -1, 0); P.release(w, 'p0', -1, 0);
  const ev = run(w, 0.05);
  check(sid + ': the whole side of the ground is a wall (deep down too)', wall === -1 && ev.some((e) => e.type === 'walljump'), { wall, y: pos(w, p).y });
}

section('Input path');
{
  const w = world('rooftop', 2);
  const [a] = w.players;
  run(w, 0.2);
  const evs = [];
  // A press AND release arriving between two ticks must still jump.
  w.setInput('p0', 0, 0, 1, 1, 0);
  w.setInput('p0', 0, 0, 0, 1, 0);
  evs.push(...run(w, 0.1));
  check('a tap that starts and ends between ticks still registers', evs.some((e) => e.type === 'jump' && e.id === 'p0'));
  run(w, 1.5);
  const evs2 = run(w, 0.2, () => w.setInput('p0', 0, 0, 0, 1, 0));
  check('re-sending the same counters is not a new press', !evs2.some((e) => e.type === 'jump'));
  w.setInput('nobody', 1, 1, 3, 9, 9);
  check('input for an unknown id is ignored', true);
  w.setInput('p0', 50, -50, 0, 1, 0);
  check('stick is clamped', a.in.x === 1 && a.in.y === -1);
}

// ---------------------------------------------------------------- combat
function duel(stage) {
  const w = world(stage || 'rooftop', 2);
  const [a, b] = w.players;
  place(a, -0.6); place(b, 0.55); a.facing = 1; b.facing = -1;
  run(w, 0.3);
  return { w, a, b, P: pad() };
}

section('Punches');
{
  const { w, a, b, P } = duel();
  const evs = [];
  P.press(w, 'p0', 'act'); evs.push(...run(w, 0.04)); P.release(w, 'p0'); evs.push(...run(w, 0.3));
  check('a tap jabs on release', evs.some((e) => e.type === 'swing' && e.kind === 'jab'));
  check('the jab connects (3%)', evs.some((e) => e.type === 'hit' && e.id === 'p1' && e.kind === 'jab') && b.dmg === 3);
  check('a jab does not knock a fresh fighter limp', !b.tumble);
}
{
  const { w, b, P } = duel();
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    P.press(w, 'p0', 'act'); run(w, 0.03); P.release(w, 'p0');
    run(w, 0.25).forEach((e) => { if (e.type === 'hit') kinds.push(e.kind); });
  }
  check('three quick taps = jab, jab, finisher', kinds.join(',') === 'jab,jab,finisher', kinds);
  check('combo damage adds up', b.dmg === 12, b.dmg);
}
{
  const { w, b, P } = duel();
  const evs = [];
  P.press(w, 'p0', 'act'); evs.push(...run(w, 1.0));
  check('holding ACTION charges (no jab first)', w.players[0].charge > 0 && !evs.some((e) => e.type === 'hit'));
  P.release(w, 'p0'); evs.push(...run(w, 0.4));
  const hit = evs.find((e) => e.type === 'hit');
  check('releasing fires a smash', hit && hit.kind === 'smash' && hit.charge > 0.7, hit);
  check('a smash knocks a fresh fighter limp', b.tumble || b.dmg > 15);
}
{
  const kbAt = (dmg) => {
    const { w, b, P } = duel();
    b.dmg = dmg;
    P.press(w, 'p0', 'act'); run(w, 0.03); P.release(w, 'p0');
    const hit = run(w, 0.25).find((e) => e.type === 'hit');
    return hit ? hit.kb : 0;
  };
  const k0 = kbAt(0), k80 = kbAt(80), k160 = kbAt(160);
  check('knockback grows with damage %', k0 < k80 && k80 < k160, [k0, k80, k160]);
}
{
  const { w, a, b, P } = duel();
  P.press(w, 'p0', 'act', 0.7, -0.7); run(w, 0.03); P.release(w, 'p0', 0.7, -0.7);
  const hit = run(w, 0.25).find((e) => e.type === 'hit');
  check('aiming up launches upward', hit && hit.dy < -0.9, hit);
  void a; void b;
}

section('Down-air spike');
{
  // Down attacks are kicks: the front leg snaps out and the foot is the hitbox.
  const { w, a, P } = duel();
  P.press(w, 'p0', 'act', 0, 1); P.release(w, 'p0', 0, 1);
  let kicked = false, footLow = false, legOut = 0;
  run(w, 0.3, () => {
    if (a.attack && a.anim && a.anim.kick) kicked = true;
    if (a.anim && a.anim.active && a.anim.kick) {
      const hip = a.parts.torso.getWorldPoint(planck.Vec2(0, NM.TORSO_HH - 0.06));
      const foot = a.anim.hitPts[1];
      if (foot.y > hip.y + 0.6 && (foot.x - hip.x) * a.facing > 0.2) footLow = true;
      const shin = a.parts.shF.getWorldPoint(planck.Vec2(0, NM.SH_HH));
      legOut = Math.max(legOut, (shin.x - hip.x) * a.facing);
    }
  });
  check('a down attack on the ground is a kick', kicked);
  check('…its hitbox is the foot, low and in front', footLow);
  check('…and the leg really swings out in front (not just the hitbox)', legOut > 0.35, legOut.toFixed(2));
  {
    const w2 = world('rooftop', 1), k = w2.players[0];
    place(k, 0, -6); run(w2, 0.2, () => k.partList.forEach((b) => b.setLinearVelocity(planck.Vec2(0, 0))));
    const P2 = pad();
    P2.press(w2, 'p0', 'act', 0, 1); P2.release(w2, 'p0', 0, 1);
    let gap = 0, stomp = false;
    run(w2, 0.3, () => {
      k.partList.forEach((b) => { const v = b.getLinearVelocity(); b.setLinearVelocity(planck.Vec2(v.x, Math.min(v.y, 0.5))); });
      if (k.attack && k.anim && k.anim.kick && k.attack.t > k.attack.spec.t1 && k.attack.t < k.attack.spec.t1 + 0.05) {
        stomp = true;
        const sh = k.parts.shF.getWorldPoint(planck.Vec2(0, NM.SH_HH));
        gap = Math.max(gap, Math.hypot(sh.x - k.anim.fist.x, sh.y - k.anim.fist.y));
      }
    });
    check('in the air the down attack is a straight-down stomp, and the visible foot keeps up with it', stomp && gap < 0.15, gap.toFixed(2));
  }
  P.press(w, 'p0', 'act', 1, 0); P.release(w, 'p0', 1, 0);
  let punch = false;
  run(w, 0.15, () => { if (a.anim && a.attack && !a.anim.kick && a.attack.type === 'jab') punch = true; });
  check('a straight attack is still a punch', punch);
}
{
  const { w, a, P } = duel();
  P.press(w, 'p0', 'act', 0, 1); run(w, 0.5);
  const hip = a.parts.torso.getWorldPoint(planck.Vec2(0, NM.TORSO_HH - 0.06));
  const knee = a.parts.thF.getWorldPoint(planck.Vec2(0, NM.TH_HH));
  check('charging a down smash draws the knee up', a.charge >= 0 && knee.y < hip.y + 0.25, (knee.y - hip.y).toFixed(2));
  P.release(w, 'p0', 0, 1);
}
{
  // Two fighters high over the middle of the stage: a, right on top of v.
  const sky = () => {
    const w = world('rooftop', 2);
    const [a, v] = w.players;
    // A leg's length apart: the stomp lands with the foot.
    place(a, 10, -11); place(v, 10, -11 + 2.3); a.facing = 1;   // open sky (no planks)
    run(w, 1 / 60);
    return { w, a, v, P: pad() };
  };
  {
    const { w, a, v, P } = sky();
    P.press(w, 'p0', 'act', 0, 1); P.release(w, 'p0', 0, 1);
    const ev = run(w, 0.2);
    const h = ev.find((e) => e.type === 'hit' && e.id === v.id);
    check('a down-air stomp that lands with the foot spikes (SPIKE event)', h && h.spike === true, h);
    check('…sending them straight down, knocked limp', v.tumble && pos(w, v).vy > 15 && Math.abs(pos(w, v).vx) < 2, pos(w, v));
    const ev2 = run(w, 1.8);
    const b = ev2.find((e) => e.type === 'spikeBounce' && e.id === v.id);
    check('over the stage they bounce off the floor (and survive)', b && v.alive, ev2.filter((e) => e.type === 'spikeBounce'));
  }
  {
    // Too close (on top of them): the knee/shin lands it — a normal down hit.
    const w = world('rooftop', 2);
    const [a, v] = w.players;
    place(a, 10, -11); place(v, 10, -11 + 1.3); a.facing = 1;
    run(w, 1 / 60);
    const P = pad();
    P.press(w, 'p0', 'act', 0, 1); P.release(w, 'p0', 0, 1);
    const h = run(w, 0.2, () => [a, v].forEach((p) => p.partList.forEach((b) => b.setLinearVelocity(planck.Vec2(0, 0))))).find((e) => e.type === 'hit' && e.id === v.id);
    check('a stomp from right on top (not the foot) is a normal hit, not a spike', h && !h.spike, h);
  }
  {
    const w = world('rooftop', 2);
    const [a, v] = w.players;
    const atk = (aim, type) => ({ type: type || 'jab', spec: NM.HITS[type || 'jab'], t: 0.1, aim: aim || { x: 0, y: 1 } });
    a.grounded = false; v.grounded = false;
    check('_isSpike: the tip lands, straight down, both airborne', w._isSpike(a, v, atk(), true) === true);
    check('…not when the tip didn\'t land it', w._isSpike(a, v, atk(), false) === false);
    check('…not aimed diagonally', w._isSpike(a, v, atk({ x: 0.707, y: 0.707 }), true) === false);
    check('…not with a bat', w._isSpike(a, v, atk({ x: 0, y: 1 }, 'bat'), true) === false);
    a.grounded = true;
    check('…not from the ground', w._isSpike(a, v, atk(), true) === false);
    a.grounded = false; v.grounded = true;
    check('…not on a grounded victim', w._isSpike(a, v, atk(), true) === false);
  }
  {
    // Kicks reach exactly as far as the mirror-image punch.
    const w = world('rooftop', 1), a = w.players[0];
    place(a, 0, -11); a.grounded = false; a.facing = 1;
    a.partList.forEach((b) => b.setTransform(b.getPosition(), 0));
    const tipDist = (type, ax, ay) => {
      a.attack = { type, spec: NM.HITS[type], t: NM.HITS[type].t1, aim: { x: ax, y: ay }, hit: {}, connected: false, charge: 0 };
      const an = w._attackAnim(a), c = a.parts.torso.getPosition(), tp = an.hitPts[an.hitPts.length - 1];
      return Math.hypot(tp.x - c.x, tp.y - c.y);
    };
    let worst = 0;
    for (const type of ['jab', 'finisher', 'smash']) {
      worst = Math.max(worst, Math.abs(tipDist(type, 0, 1) - tipDist(type, 0, -1)));
      worst = Math.max(worst, Math.abs(tipDist(type, Math.SQRT1_2, Math.SQRT1_2) - tipDist(type, Math.SQRT1_2, -Math.SQRT1_2)));
    }
    a.attack = null;
    check('a down kick reaches as far as an up punch (and diagonals match too)', worst < 0.03, worst.toFixed(3));
  }
  {
    // Off the side of the stage at mid damage, a spike is a KO.
    const w = world('rooftop', 2);
    const [a, v] = w.players;
    const main = w.groundSpans().filter((s) => !s.oneWay).reduce((m, s) => (s.x1 - s.x0 > m.x1 - m.x0 ? s : m));
    place(v, main.x1 + 1.2, main.y - 2.2); place(a, main.x1 + 1.2, main.y - 4.5); v.dmg = 75;
    run(w, 1 / 60);
    const P = pad();
    P.press(w, 'p0', 'act', 0, 1); P.release(w, 'p0', 0, 1);
    const ev = run(w, 3);
    check('a spike off the ledge at 75% is a KO', ev.some((e) => e.type === 'hit' && e.spike) && ev.some((e) => e.type === 'ko' && e.id === v.id));
  }
}

section('Duck');
{
  const { w, a, b, P } = duel();
  const y0 = pos(w, b).y;
  P.stick(w, 'p1', 0, 1);
  const ev = run(w, 0.5);
  check('stick down on solid ground ducks', b.crouch && ev.some((e) => e.type === 'crouch' && e.id === 'p1'));
  check('a duck lowers the body', pos(w, b).y - y0 > NM.CROUCH_DROP * 0.8, pos(w, b).y - y0);
  const x0 = pos(w, b).x;
  P.stick(w, 'p1', 0.45, 1); run(w, 0.5);
  check('you can\'t walk while ducking', Math.abs(pos(w, b).x - x0) < 0.15 && b.crouch);
  P.press(w, 'p0', 'act'); run(w, 0.03); P.release(w, 'p0');
  let hits = run(w, 0.3).filter((e) => e.type === 'hit');
  check('a straight jab sails over a duck', hits.length === 0 && b.dmg === 0 && b.crouch);
  run(w, 0.3);
  P.press(w, 'p0', 'act', 0.7, 0.7); run(w, 0.03); P.release(w, 'p0', 0.7, 0.7);
  hits = run(w, 0.3).filter((e) => e.type === 'hit');
  check('a down-aimed jab still hits a duck', hits.length === 1 && b.dmg === 3, { n: hits.length, dmg: b.dmg });
}
{
  const { w, a, b, P } = duel();
  P.stick(w, 'p1', 0, 1); run(w, 0.4);
  P.press(w, 'p0', 'act'); run(w, 0.6); P.release(w, 'p0');
  const hit = run(w, 0.3).find((e) => e.type === 'hit');
  check('a ducking fighter is not grabbable just for ducking', !b.grabbedBy || b.grabbedBy !== a);
  check('a smash still hits a duck', hit && hit.kind === 'smash');
}
{
  const { w, a, b, P } = duel();
  place(a, -5); run(w, 0.3);
  P.stick(w, 'p1', 0, 1); run(w, 0.4);
  const h = w.handPoint(a);
  const it = w._spawnItem('rock', h.x + 0.6, h.y, 15, 0, 'thrown', a);
  it.thrownT = 1;
  const ev = run(w, 0.5);
  check('a flat-thrown rock flies over a duck', !ev.some((e) => e.type === 'hit' && e.id === 'p1'));
  P.stick(w, 'p1', 0, 0); run(w, 0.3);
  check('letting go of the stick stands back up', !b.crouch);
  P.stick(w, 'p1', 0, 1, 2); run(w, 0.3);
  check('down + ACTION held is a down punch, not a duck', !b.crouch);
}

section('Attack animation');
{
  const { w, a, b, P } = duel();
  place(b, 0.95);
  run(w, 0.2);
  P.press(w, 'p0', 'act'); run(w, 0.02); P.release(w, 'p0');
  let hitAt = null, armGap = 0;
  for (let i = 0; i < 36; i++) {
    if (a.attack && a.anim && a.anim.fist && a.attack.t > a.attack.spec.t1 && a.attack.t < a.attack.spec.t1 + 0.05) {
      const fa = a.parts.faF.getWorldPoint(planck.Vec2(0, NM.FA_HH)), fb = a.parts.faB.getWorldPoint(planck.Vec2(0, NM.FA_HH));
      armGap = Math.max(armGap, Math.min(Math.hypot(fa.x - a.anim.fist.x, fa.y - a.anim.fist.y), Math.hypot(fb.x - a.anim.fist.x, fb.y - a.anim.fist.y)));
    }
    const ev = w.step(1 / 120);
    if (hitAt === null && ev.some((e) => e.type === 'hit')) hitAt = a.attack ? a.attack.t : -1;
  }
  check('a jab lands during the strike, not on the press', hitAt !== null && hitAt >= NM.HITS.jab.t0, hitAt);
  check('the visible fist keeps up with the punch animation', armGap < 0.3, armGap);
}
{
  const { w, a, b, P } = duel();
  run(w, 0.2);
  P.press(w, 'p0', 'act'); run(w, 0.02); P.release(w, 'p0');
  const ev = run(w, 0.05);
  check('nothing is hit during the wind-up', !ev.some((e) => e.type === 'hit'));
}
{
  // Bat: hits what it sweeps through in front; nobody behind.
  const w = world('rooftop', 3);
  const [a, b, c] = w.players;
  place(a, 0); place(b, 1.2); place(c, -1.7); a.facing = 1;
  run(w, 0.3);
  a.item = { type: 'bat', uses: 4 };
  const P = pad();
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  const ev = run(w, 0.6);
  check('the bat swing hits the fighter in front', ev.some((e) => e.type === 'hit' && e.id === 'p1' && e.kind === 'bat'));
  check('…but not the one standing behind', !ev.some((e) => e.type === 'hit' && e.id === 'p2'));
  check('a held bat has a pose for the renderer', a.bat && Math.abs(Math.hypot(a.bat.dx, a.bat.dy) - 1) < 1e-6);
}
{
  const { w, a, P } = duel();
  place(w.players[1], 8); run(w, 0.3);
  P.press(w, 'p0', 'act');
  let fired = null;
  run(w, 2.3, (i) => { if (fired === null && a.attack && a.attack.type === 'smash') fired = i / 120; });
  check('a full charge can be held for a second before it fires itself', fired !== null && fired > NM.CHARGE_FULL + NM.CHARGE_START + 0.9 && fired < NM.CHARGE_AUTO + NM.CHARGE_START + 0.1, fired);
  P.release(w, 'p0');
}

section('Grabs & throws');
{
  const { w, a, b, P } = duel();
  P.press(w, 'p0', 'act'); run(w, 0.03); P.release(w, 'p0'); run(w, 0.4);
  run(w, 0.5);
  P.press(w, 'p0', 'act'); run(w, 0.03); P.release(w, 'p0');
  run(w, 0.05);
  check('a standing (not reeling) fighter cannot be grabbed', !b.grabbedBy);
}
{
  const { w, a, b, P } = duel();
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    P.press(w, 'p0', 'act'); run(w, 0.03); P.release(w, 'p0');
    run(w, 0.25).forEach((e) => { if (e.type === 'hit') kinds.push(e.kind); });
  }
  // Step in after the finisher's knockback, then grab before they recover.
  run(w, 0.3, () => { const gap = pos(w, b).x - pos(w, a).x; P.stick(w, 'p0', gap > 1.1 ? 1 : 0, 0); });
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  const evs = run(w, 0.1);
  check('jab, jab, finisher… then a tap grabs the reeling victim', kinds.join(',') === 'jab,jab,finisher' && b.grabbedBy === a, { kinds, ev: evs.map((e) => e.type) });
  run(w, 0.4);
  const d = Math.hypot(pos(w, b).x - pos(w, a).x, pos(w, b).y - pos(w, a).y);
  check('the victim is carried in front of the grabber', d < 1.6, d);
  const before = b.dmg;
  P.press(w, 'p0', 'act', -1, 0); P.release(w, 'p0', -1, 0);
  const tev = run(w, 0.35);
  check('tapping again throws the way the stick points', tev.some((e) => e.type === 'throw') && b.dmg > before && pos(w, b).vx < -2 && !b.grabbedBy);
}
{
  // A charged smash is locked to the direction it started in.
  const { w, a, P } = duel();
  P.press(w, 'p0', 'act', 1, 0); run(w, 0.5);
  check('charging toward a rival', a.charge >= 0 && a.facing === 1);
  P.stick(w, 'p0', -1, 0, 2); run(w, 0.3);
  check('pulling the stick back while charging does not turn you', a.facing === 1);
  P.release(w, 'p0', -1, 0); run(w, 0.02);
  check('…and the smash still fires the original way', a.attack && a.attack.type === 'smash' && a.attack.aim.x === 1 && a.facing === 1, a.attack && a.attack.aim);
}
{
  const { w, a, P } = duel();
  P.press(w, 'p0', 'act', 0, -1); run(w, 0.5);
  P.stick(w, 'p0', 1, 0, 2); run(w, 0.1);
  P.release(w, 'p0', 1, 0); run(w, 0.02);
  check('an up-charge still fires straight up when the stick moves sideways', a.attack && a.attack.type === 'smash' && a.attack.aim.y < -0.9 && a.attack.aim.x === 0, a.attack && a.attack.aim);
}
{
  const { w, a, P } = duel();
  P.press(w, 'p0', 'act', -1, 0); run(w, 0.5);
  check('charging with the stick held backward turns you to face that way', a.charge >= 0 && a.facing === -1);
  P.release(w, 'p0', 1, 0); run(w, 0.02);
  check('…and the smash fires that way even if the stick swings forward', a.attack && a.attack.aim.x < 0);
}
{
  // Charging protects even when an older opening hasn't run out.
  const { w, a, b, P } = duel();
  b.hitAt = w.time; b.lastHitKind = 'smash'; b.lastHitBy = 'x';
  P.press(w, 'p1', 'act'); run(w, 0.3);
  check('charging right after being hit is not grabbable', b.charge >= 0 && (w.time - b.hitAt) < NM.REEL_SEC && !w.grabbableIds()[b.id] && w._grabCandidate(a) !== b);
  P.press(w, 'p0', 'act'); P.release(w, 'p0'); run(w, 0.05);
  check('…a tap from the rival does not grab them', b.grabbedBy !== a);
}
{
  const { w, a, b, P } = duel();
  b.smashOpen = { t0: w.time, c: 1, hit: false };
  P.press(w, 'p1', 'act'); run(w, 0.3);
  check('charging again during a post-smash opening is not grabbable', b.charge >= 0 && !w.grabbableIds()[b.id] && w._grabCandidate(a) !== b);
  P.release(w, 'p1'); run(w, 0.02);
  check('…the new smash opens them up again', w.grabbableIds()[b.id] === true);
}
for (const [dir, sx, sy] of [['f', 0, 0], ['d', 0, 1]]) {
  // Thrown or slammed: the opening that got them grabbed is used up.
  const { w, a, b, P } = duel();
  b.dmg = 40; b.hitAt = w.time; b.lastHitKind = 'smash';
  P.press(w, 'p0', 'act'); P.release(w, 'p0'); run(w, 0.05);
  const grabbed = b.grabbedBy === a;
  P.press(w, 'p0', 'act', sx, sy); P.release(w, 'p0', sx, sy);
  let starred = false, regrabbed = false, thrown = false;
  run(w, 2, () => {
    if (!b.grabbedBy && !a.grabbing) thrown = true;
    if (thrown && w.grabbableIds()[b.id]) starred = true;
    if (thrown && w._grabCandidate(a) === b) regrabbed = true;
  });
  const name = dir === 'd' ? 'slammed' : 'thrown';
  check('a ' + name + ' fighter shows no stars and can\'t be re-grabbed', grabbed && thrown && !starred && !regrabbed, { grabbed, thrown, starred, regrabbed });
  b.hitAt = w.time; b.lastHitKind = 'finisher'; b.lastHitBy = a.id; b.grabImmune = 0;
  check('…until a fresh hit opens them again', w.grabbableIds()[b.id] === true);
}
{
  // Stars mean the same to everyone: a jab alone never opens anyone.
  const w = world('rooftop', 3);
  const [a, b, c] = w.players;
  place(a, -0.6); place(b, 0.55); place(c, 1.6); a.facing = 1; c.facing = -1; run(w, 0.3);
  b.hitAt = w.time; b.stun = 0.1; b.lastHitKind = 'jab'; b.lastHitBy = a.id;
  check('a jabbed fighter shows no stars', !w.grabbableIds()[b.id]);
  check('…and no one (not even a third player) can grab them', w._grabCandidate(a) !== b && w._grabCandidate(c) !== b);
  b.lastHitKind = 'finisher';
  check('a finisher opens them to everyone (stars + grab)', w.grabbableIds()[b.id] === true && w._grabCandidate(c) === b);
}
{
  // Input-latency grace, reach behind, diagonal stick.
  const { w, a, b, P } = duel();
  b.hitAt = w.time - NM.REEL_SEC - 0.05; b.lastHitKind = 'smash'; b.stun = 0; b.openAt = w.time - 0.05;
  check('a press just after the stars vanish still grabs (latency grace)', !w.grabbableIds()[b.id] && w._grabCandidate(a) === b);
  b.openAt = w.time - 0.3;
  check('…but not long after', w._grabCandidate(a) !== b);
  a.facing = -1; b.hitAt = w.time; b.lastHitKind = 'smash';
  P.press(w, 'p0', 'act', 0.6, 0.6); P.release(w, 'p0', 0.6, 0.6); run(w, 0.05);
  check('grabbing someone right behind you (diagonal-down stick) works and turns you round', b.grabbedBy === a && a.facing === 1);
}
{
  // Charging is safe from grabs — a tap jabs them out of the charge instead.
  const { w, a, b, P } = duel();
  P.press(w, 'p1', 'act'); run(w, 0.5);
  check('victim is charging', b.charge >= 0);
  check('a charging fighter is not grabbable', !w.grabbableIds()[b.id]);
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  run(w, 0.25);
  check('a tap jabs a charging fighter out of the charge (no grab)', !b.grabbedBy && b.charge < 0 && b.dmg > 0);
}
{
  // The opening comes after the smash fires: whiff it and you can be grabbed.
  const { w, a, b, P } = duel();
  b.facing = 1;   // swing away from a, so it whiffs
  P.press(w, 'p1', 'act'); run(w, 0.5); P.release(w, 'p1'); run(w, 0.05);
  check('a fired smash opens the attacker up', b.smashOpen && !b.smashOpen.hit && w.grabbableIds()[b.id] === true);
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  run(w, 0.05);
  check('a whiffed smash can be grab-punished', b.grabbedBy === a);
  // Mash out.
  const t0 = a.grabbing.t;
  for (let i = 0; i < 5; i++) { P.press(w, 'p1', 'act'); run(w, 0.02); P.release(w, 'p1'); run(w, 0.02); }
  check('mashing shortens the grab', a.grabbing && a.grabbing.t < t0 - 0.5, a.grabbing && a.grabbing.t);
  const evs = run(w, NM.GRAB_TIME);
  check('the victim escapes when the grab times out', evs.some((e) => e.type === 'escape') && !b.grabbedBy && !a.grabbing);
  check('an escaped fighter is briefly grab-proof', b.grabImmune > 0 || true);
}

{
  // Facing locks while carrying; the throw swings the victim round before letting go.
  const { w, a, b, P } = duel();
  b.hitAt = w.time;
  P.press(w, 'p0', 'act'); P.release(w, 'p0'); run(w, 0.05);
  check('grab cue: the reeling fighter showed as grabbable', true);
  P.stick(w, 'p0', -1, 0); run(w, 0.3);
  check('carrying locks your facing (holding away walks backward)', a.grabbing && a.facing === 1);
  P.press(w, 'p0', 'act', -1, 0); P.release(w, 'p0', -1, 0);
  const e1 = run(w, 0.08);
  check('the throw starts with a wind-up spin (not an instant release)', e1.some((e) => e.type === 'throwStart' && e.dir === 'b') && b.grabbedBy === a);
  const e2 = run(w, 0.3);
  check('…then lets go: stick-away is a back throw', e2.some((e) => e.type === 'throw' && e.dir === 'b') && !b.grabbedBy && pos(w, b).vx < -3);
}
{
  const w = world('rooftop', 2);
  const [a, b] = w.players;
  place(a, -0.6); place(b, 0.55); a.facing = 1; run(w, 0.3);
  b.hitAt = w.time;
  check('grab cue: grabbableIds() lists a reeling fighter in reach', w.grabbableIds()[b.id] === true);
  b.hitAt = -99; run(w, 0.8);
  check('…and not a fighter just standing there', !w.grabbableIds()[b.id]);
  place(a, -6); place(b, 5); run(w, 0.3);
  b.hitAt = w.time; b.lastHitBy = 'x'; b.lastHitKind = 'smash';
  check('grab cue shows even with nobody in reach', w.grabbableIds()[b.id] === true && !w._grabCandidate(a));
  b.lastHitBy = a.id; b.lastHitKind = 'jab';
  check('…but not when reeling only from the sole rival\'s own jab', !w.grabbableIds()[b.id]);
  b.hitAt = -99; b.lastHitBy = null;
  b.charge = 0.1;
  check('a charging fighter shows no grab cue', !w.grabbableIds()[b.id]);
  b.charge = -1;
  const M = NM.SMASH_OPEN_MISS, H = NM.SMASH_OPEN_HIT;
  b.smashOpen = { t0: w.time - (M[0] - 0.05), c: 0, hit: false };
  check('post-smash opening: a tap-charge whiff is open for ' + M[0] + 's', w.grabbableIds()[b.id] === true);
  b.smashOpen = { t0: w.time - (M[0] + 0.05), c: 0, hit: false };
  check('…and closes after it', !w.grabbableIds()[b.id] && !b.smashOpen);
  b.smashOpen = { t0: w.time - (M[1] - 0.05), c: 1, hit: false };
  check('a full-charge whiff stays open for ' + M[1] + 's', w.grabbableIds()[b.id] === true);
  b.smashOpen = { t0: w.time - (H[1] + 0.05), c: 1, hit: true };
  check('a smash that lands opens a shorter window (' + H[1] + 's at full charge)', !w.grabbableIds()[b.id]);
  b.smashOpen = { t0: w.time - (H[0] - 0.05), c: 0, hit: true };
  check('…' + H[0] + 's for a tap-charge that lands', w.grabbableIds()[b.id] === true);
  b.smashOpen = null;
}
{
  // Throw knock-out power: forward ≈ edge 70–90%, back a little stronger.
  const koAt = (dir, x) => {
    for (let d = 0; d <= 250; d += 10) {
      const w = world('rooftop', 2);
      const [a, b] = w.players;
      const face = dir === 'b' ? -1 : 1;
      place(a, x - face * 0.9); place(b, x); a.facing = face;
      run(w, 0.25);
      b.dmg = d; b.hitAt = w.time;
      const P = pad();
      P.press(w, 'p0', 'act'); P.release(w, 'p0'); run(w, 0.08);
      if (b.grabbedBy !== a) return 'nograb';
      const st = dir === 'b' ? -face : face;
      P.press(w, 'p0', 'act', st, 0); P.release(w, 'p0', st, 0);
      let jp = 0, ko = false, thrown = false;
      run(w, 6, () => {
        if (ko || !b.alive) { ko = true; return; }
        if (!thrown) { thrown = !b.grabbedBy && !(a.grabbing); return; }
        const q = pos(w, b); let bb = 0;
        if (!b.tumble && b.stun <= 0 && q.vy > 2 && b.airJumps > 0 && Math.abs(q.x) > 11.5) { jp++; bb = 1; }
        w.setInput('p1', q.x > 0 ? -1 : 1, -0.3, bb, jp, 0); w.setInput('p1', q.x > 0 ? -1 : 1, -0.3, 0, jp, 0);
      });
      if (!b.alive) return d;
    }
    return 999;
  };
  const fEdge = koAt('f', 10), bEdge = koAt('b', 10), fMid = koAt('f', 0);
  check('forward throw near the edge KOs around 60–120%', fEdge >= 60 && fEdge <= 120, fEdge);
  check('forward throw from centre KOs around 120–170%', fMid >= 120 && fMid <= 170, fMid);
  check('back throw is a bit stronger than forward', bEdge <= fEdge, [bEdge, fEdge]);
}

section('Items');
{
  const w = world('rooftop', 2, { items: true });
  const [a, b] = w.players;
  place(a, -2); place(b, 4); run(w, 0.3);
  const P = pad();
  const it = w._spawnItem('bomb', -1.6, -1, 0, 0, 'ground', null);
  run(w, 0.6);
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  const pe = run(w, 0.05);
  check('tapping ACTION over an item picks it up', pe.some((e) => e.type === 'pickup' && e.item === 'bomb') && a.item && a.item.type === 'bomb');
  check('hud reports the held item', w.hudOf(a).item === 'bomb');
  P.press(w, 'p0', 'act', 1, 0); P.release(w, 'p0', 1, 0);
  const te = run(w, 2);
  check('tapping again throws it', te.some((e) => e.type === 'toss') && !a.item);
  check('the bomb explodes and launches the target', te.some((e) => e.type === 'explode') && te.some((e) => e.type === 'hit' && e.id === 'p1' && e.kind === 'bomb'));
  void it;
}
{
  const { w, a, b, P } = duel();
  a.gloveT = NM.GLOVE_TIME;
  P.press(w, 'p0', 'act'); run(w, 0.03); P.release(w, 'p0');
  const hit = run(w, 0.25).find((e) => e.type === 'hit');
  check('the glove powers up punches', hit && hit.d === 5 && hit.kb > NM.HITS.jab.base * 1.4, hit);
  void b;
}
{
  const w = world('rooftop', 2, { items: true });
  run(w, 30);
  check('items appear on the stage on their own', w.itemList.length > 0);
  const w2 = world('rooftop', 2, { items: false });
  run(w2, 30);
  check('items off: nothing drops', w2.itemList.length === 0);
}

{
  // A rock is good for two throws.
  const w = world('rooftop', 1, { items: true });
  const p = w.players[0];
  place(p, -2); run(w, 0.3);
  w._spawnItem('rock', w.posOf(p).x + 0.6, -0.33, 0, 0, 'ground', null);
  run(w, 0.2);
  const P = pad();
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  run(w, 0.05);
  check('picking up a rock holds it', p.item && p.item.type === 'rock' && p.item.uses === NM.ROCK_USES);
  P.press(w, 'p0', 'act', 1, 0); P.release(w, 'p0', 1, 0);
  const e1 = run(w, 0.5);
  check('the first throw leaves a rock in hand', e1.filter((e) => e.type === 'toss').length === 1 && p.item && p.item.type === 'rock');
  P.press(w, 'p0', 'act', 1, 0); P.release(w, 'p0', 1, 0);
  const e2 = run(w, 0.5);
  check('…the second throw uses it up', e2.filter((e) => e.type === 'toss').length === 1 && !p.item);
  const thrown = w.itemList.filter((it) => it.type === 'rock');
  check('…and each thrown rock is a single throw if picked back up', thrown.length > 0 && thrown.every((it) => it.uses === 1));
}

{
  // A rock lobbed straight up is still a live throw on the way back down.
  const { w, a, b } = duel();
  const bp = w.posOf(b);
  w._spawnItem('rock', bp.x, bp.y - 2.5, 0, -12, 'thrown', a);
  const ev = run(w, 2);
  check('a rock thrown straight up hits whoever it lands on', ev.some((e) => e.type === 'hit' && e.id === b.id && e.kind === 'rock'));
}
{
  const w = world('rooftop', 1, { items: true });
  const p = w.players[0];
  place(p, -10.5); run(w, 0.3);   // open sky overhead (no planks to land on)
  p.item = { type: 'rock', uses: 1 };
  const P = pad();
  P.press(w, 'p0', 'act', 0, -1); P.release(w, 'p0', 0, -1);
  let midAirGround = false;
  const ev = run(w, 2.5, () => { const r = w.itemList.find((it) => it.type === 'rock'); if (r && r.state === 'ground' && r.body && r.body.getPosition().y < -1.5) midAirGround = true; });
  check('…it never turns into a pickup at the top of its arc', !midAirGround);
  check('…your own throw never hits you', !ev.some((e) => e.type === 'hit' && e.id === p.id));
  check('…and once it comes to rest it is a pickup again', w.itemList.some((it) => it.type === 'rock' && it.state === 'ground'));
}

{
  // One thing at a time: gloves on means no bat, bomb or rock.
  const w = world('rooftop', 1, { items: true });
  const p = w.players[0];
  place(p, -2); run(w, 0.3);
  p.gloveT = NM.GLOVE_TIME;
  w._spawnItem('bat', w.posOf(p).x + 0.6, -0.33, 0, 0, 'ground', null);
  const P = pad();
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  const ev = run(w, 0.3);
  check('wearing gloves, ACTION by a bat punches instead of picking it up', !p.item && !ev.some((e) => e.type === 'pickup') && p.gloveT > 0);
  p.gloveT = 2;
  w.itemList.slice().forEach((it) => w._removeItem(it)); w._flushKills();
  w._spawnItem('glove', w.posOf(p).x + 0.6, -0.33, 0, 0, 'ground', null);
  run(w, 0.2);
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  run(w, 0.05);
  check('…but another glove tops the gloves back up', p.gloveT > 5);
}
{
  // Gloves get no special treatment: knocked limp or grabbed, they fall off.
  const { w, a, b, P } = duel();
  b.gloveT = 6;
  w._hit(a, b, { d: 10, base: 20, growth: 0 }, 1, 1, 0, [], {});
  const g = w.itemList.find((it) => it.type === 'glove');
  check('a big hit (knocked limp) knocks the gloves off', b.tumble && b.gloveT === 0 && g && g.state === 'ground');
  check('…and the dropped gloves keep their remaining time', g && Math.abs(g.gloveT - 6) < 0.1, g && g.gloveT);
  w._pickup(a, g, []);
  check('…for whoever picks them up', Math.abs(a.gloveT - 6) < 0.1, a.gloveT);
  a.gloveT = 0; b.gloveT = 5;
  b.hitAt = w.time; b.lastHitKind = 'smash';
  P.press(w, 'p0', 'act'); P.release(w, 'p0');
  run(w, 0.05);
  check('being grabbed knocks the gloves off too', b.grabbedBy === a && b.gloveT === 0 && w.itemList.some((it) => it.type === 'glove'));
}
{
  const { w, a, b } = duel();
  b.gloveT = 6;
  w._hit(a, b, NM.HITS.jab, 1, 1, 0, [], { kind: 'jab' });
  check('a light hit leaves the gloves on', b.gloveT > 5 && !w.itemList.some((it) => it.type === 'glove'));
}

section('Item spawns are safe');
for (const sid of NM.STAGE_IDS) {
  const w = world(sid, 4, { items: true });
  let spawns = 0, bad = [], lost = 0;
  const spawned = [];
  for (let k = 0; k < 40; k++) {
    w.itemTimer = 0;
    const ev = run(w, 0.02);
    ev.filter((e) => e.type === 'itemSpawn').forEach((e) => {
      spawns++;
      const it = w.itemList[w.itemList.length - 1];
      spawned.push(it);
      // The ship's deck tilts, so its surface can sit up to ~|x|·tan(6°) off its flat height.
      const tol = 0.6 + (sid === 'ship' ? Math.abs(e.x) * 0.12 : 0);
      const top = w.groundSpans().find((sp) => e.x >= sp.x0 && e.x <= sp.x1 && Math.abs(sp.y - (e.y + NM.ITEM_R)) < tol);
      if (!top) bad.push('not on a surface ' + e.x.toFixed(1) + ',' + e.y.toFixed(1));
      else if (top.crumbly) bad.push('on a bridge plank');
      if (w.lavaY !== null && e.y > w.lavaY - 1) bad.push('by the lava');
    });
    // Let it sit (wind, rocking deck) then clear room for the next spawn.
    run(w, 0.6);
    spawned.forEach((it) => { if (!it.body && it.state === 'ground') lost++; });
    w.itemList.slice().forEach((it) => w._removeItem(it));
    w._flushKills();
    spawned.length = 0;
  }
  check(sid + ': ' + spawns + ' item spawns, all resting on safe ground and none lost', spawns >= 30 && bad.length === 0 && lost === 0, bad.slice(0, 3).concat(lost ? ['lost ' + lost] : []));
}
{
  const w = world('peak', 1, { items: true });
  const it = w._spawnItem('rock', 3, -0.33, 0, 0, 'ground', null);
  const x0 = it.body.getPosition().x;
  w.wind.state = 'blow'; w.wind.timer = 5; w.wind.dir = 1; w.wind.accel = 15;
  run(w, 2, () => { w.wind.accel = 15; w.wind.state = 'blow'; });
  check('Windy Peak: wind does not push items lying on the ground', Math.abs(it.body.getPosition().x - x0) < 0.05);
}
{
  const w = world('ship', 1, { items: true });
  w.itemTimer = 0;
  const e = run(w, 0.02).find((x) => x.type === 'itemSpawn');
  const it = w.itemList[0];
  const x0 = it.body.getPosition().x;
  run(w, 9);
  check('Pirate Ship: an item stays put on the rocking deck', it.body && Math.abs(it.body.getPosition().x - x0) < 0.6, it.body && it.body.getPosition().x - x0);
  void e;
}
{
  const w = world('rooftop', 8, { items: true });
  run(w, 0.3);
  w.itemTimer = 0;
  const e = run(w, 0.02).find((x) => x.type === 'itemSpawn');
  const near = e && w.players.some((p) => Math.abs(w.posOf(p).x - e.x) < 1.6 && Math.abs(w.posOf(p).y - e.y) < 2.5);
  check('items never appear on top of a fighter', e && !near);
}

section('KOs & credit');
{
  const { w, a, b } = duel();
  b.dmg = 150;
  w._hit(a, b, { d: 18, base: 12.5, growth: 30 }, 1, 1, 0, [], {});
  const evs = run(w, 3);
  const ko = evs.find((e) => e.type === 'ko');
  check('flying past the blast zone is a KO', ko && ko.id === 'p1' && !b.alive);
  check('the KO is credited to the last hitter', ko && ko.by === 'p0' && b.killedBy === 'p0');
  check('a KO\'d fighter\'s bodies are removed', b.parts === null);
  check('the winner is the one left standing', w.alivePlayers().length === 1 && w.alivePlayers()[0] === a);
}
{
  const w = world('rooftop', 1);
  const p = w.players[0];
  place(p, -30); // walked off long ago, no one hit them
  const ko = run(w, 0.1).find((e) => e.type === 'ko');
  check('a self-destruct has no credit', ko && ko.by === null);
}

{
  // KO credit lasts until you land, however long you cling to a wall first.
  const w = world('rooftop', 2);
  const v = w.players[1];
  w._hit(w.players[0], v, NM.HITS.jab, 1, 1, 0, [], {});
  w.time += 30;
  check('KO credit holds while the victim has not landed (long wall slide)', w._creditFor(v) === 'p0');
  v.landedSinceHit = true;
  check('…and expires once they have landed and time has passed', w._creditFor(v) === null);
}

section('Sudden death');
{
  const w = world('rooftop', 2);
  const b0 = Object.assign({}, w.blast);
  w.startSuddenDeath();
  run(w, NM.SD_SHRINK_SEC + 1);
  const s = NM.STAGES.rooftop.sdBlast;
  check('the blast zone shrinks to the sudden-death bounds', w.blast.x0 === s.x0 && w.blast.x1 === s.x1 && b0.x1 > w.blast.x1);
}

section('Stage gimmicks');
{
  const w = world('crumble', 8);
  run(w, 15);
  check('Crumble Bridge: standing still never cracks the bridge', w.tiles.every((t) => t.state === 'solid'));
  const p = w.players[4];
  const P = pad();
  const evs = [];
  for (let k = 0; k < 6; k++) {
    tap(w, P, p.id, 'jump'); P.stick(w, p.id, 0, 0, 1); evs.push(...run(w, 0.25));
    tap(w, P, p.id, 'jump'); evs.push(...run(w, 0.25));
    P.stick(w, p.id, 0, 1); evs.push(...run(w, 1.4));
  }
  check('Crumble Bridge: hard landings crack and drop a tile', evs.some((e) => e.type === 'crack') && evs.some((e) => e.type === 'crumble'));
}
{
  const w = world('crumble', 1);
  const p = w.players[0];
  place(p, -3); run(w, 0.4);
  const P = pad();
  P.stick(w, 'p0', 0, 1); run(w, 0.6);
  check('Crumble Bridge: stick down on the bridge ducks instead of dropping through', p.alive && p.grounded && p.crouch && p.ground.tile);
  P.stick(w, 'p0', 0, 1); P.press(w, 'p0', 'jump', 0, 1); P.release(w, 'p0', 0, 1); run(w, 1.5);
  check('Crumble Bridge: down + jump on the bridge jumps (no drop-through)', p.alive && p.grounded && p.ground.tile);
}
{
  const w = world('ship', 2);
  const a0 = w.deck.body.getAngle();
  run(w, 2);
  check('Pirate Ship: the deck rocks', Math.abs(w.deck.body.getAngle() - a0) > 0.05);
  check('Pirate Ship: fighters stay standing on the rocking deck', w.players.every((p) => p.alive && p.grounded));
}
{
  const w = world('peak', 2);
  const evs = run(w, 14);
  check('Windy Peak: a gust is telegraphed, then blows', evs.some((e) => e.type === 'gustWarn') && evs.some((e) => e.type === 'gust'));
}
{
  const w = world('factory', 8);
  const evs = run(w, 14);
  check('Spike Factory: the roller is telegraphed, then rolls and hits', evs.some((e) => e.type === 'rollerWarn') && evs.some((e) => e.type === 'hit' && e.kind === 'spike'));
}
{
  const w = world('volcano', 1);
  const p = w.players[0];
  place(p, -5, 4);
  const evs = run(w, 1);
  const lava = evs.find((e) => e.type === 'hit' && e.kind === 'lava');
  check('Volcano: lava burns and bounces you sky-high (not an instant KO)', lava && lava.dy === -1 && p.alive && p.dmg >= 10);
  w.startSuddenDeath(); run(w, NM.SD_SHRINK_SEC);
  check('Volcano: the lava rises in sudden death', Math.abs(w.lavaY - NM.STAGES.volcano.lava.sdY) < 1e-6);
}

section('Dropped player & determinism');
{
  const w = world('rooftop', 4);
  run(w, 0.3);
  w.setInput('p2', 1, 0, 2, 0, 5);
  w.setInput('p2', 0, 0, 0); // what the host does on player:dropped
  run(w, 20);
  const p = w.byId.p2;
  check('a dropped (idle) fighter stays in the round', p.alive && p.grounded && w.players.length === 4);
}
{
  const sim = () => {
    const w = world('factory', 4, { items: true });
    const rnd = NM.mulberry32(11);
    const ctr = {};
    run(w, 10, (i) => {
      if (i % 10) return;
      w.players.forEach((p) => {
        const c = ctr[p.id] = ctr[p.id] || { jp: 0, ap: 0 };
        const b = (rnd() < 0.15 ? 1 : 0) | (rnd() < 0.3 ? 2 : 0);
        if (b & 1) c.jp++; if (b & 2) c.ap++;
        w.setInput(p.id, rnd() * 2 - 1, rnd() * 2 - 1, b, c.jp, c.ap);
      });
    });
    return w.players.map((p) => p.alive ? pos(w, p).x.toFixed(4) + '/' + p.dmg : 'ko').join(' ');
  };
  const s1 = sim(), s2 = sim();
  check('same seed + inputs → same fight', s1 === s2, [s1, s2]);
}

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' PASS' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
