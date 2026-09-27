'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hold'em Poker — CPU player. Rule-based: the Chen formula before the flop,
// a quick Monte-Carlo equity estimate after it, weighed against pot odds.
// Only ever returns an action the view says is legal.
// ─────────────────────────────────────────────────────────────────────────

const { buildDeck, rankValue, suitOf } = require('./deck');
const { bestHand } = require('./evaluator');

// Human-feeling pauses: quick checks and folds, a longer think before betting or a big call.
const BOT_SETTINGS = { thinkMs: 1400, jitterMs: 900, aggressiveExtraMs: 800, bigCallExtraMs: 600 };
const EQUITY_SAMPLES = 160;

/** How long a CPU sits on `choice` before acting. */
function thinkDelay(choice, view, rng) {
  let ms = BOT_SETTINGS.thinkMs + Math.floor(rng() * BOT_SETTINGS.jitterMs);
  if (choice.type === 'raise') ms += BOT_SETTINGS.aggressiveExtraMs;
  else if (choice.type === 'call' && view.callAmount > view.stack * 0.25) ms += BOT_SETTINGS.bigCallExtraMs;
  return ms;
}

/** Bill Chen's preflop hand score (−1 … 20). */
function chenScore(hole) {
  const a = rankValue(hole[0]);
  const b = rankValue(hole[1]);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const base = (v) => (v === 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2);
  let s = base(hi);
  if (a === b) return Math.max(5, s * 2);
  if (suitOf(hole[0]) === suitOf(hole[1])) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) s += 1;
  return Math.ceil(s);
}

/** Share of the pot this hand wins against `opponents` random hands. */
function estimateEquity(hole, board, opponents, rng, samples) {
  const known = new Set(hole.concat(board));
  const rest = buildDeck().filter((c) => !known.has(c));
  const opp = Math.max(1, Math.min(opponents, 4));
  const n = samples || EQUITY_SAMPLES;
  let wins = 0;
  for (let s = 0; s < n; s++) {
    // Partial Fisher-Yates: only as many cards as this sample needs.
    const need = opp * 2 + (5 - board.length);
    const d = rest.slice();
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (d.length - i));
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    const fullBoard = board.concat(d.slice(opp * 2, need));
    const mine = bestHand(hole.concat(fullBoard)).score;
    let best = 0;
    let ties = 0;
    let beaten = false;
    for (let k = 0; k < opp; k++) {
      const theirs = bestHand([d[k * 2], d[k * 2 + 1]].concat(fullBoard)).score;
      if (theirs > mine) { beaten = true; break; }
      if (theirs === mine) ties++;
      if (theirs > best) best = theirs;
    }
    if (!beaten) wins += 1 / (ties + 1);
  }
  return wins / n;
}

/** A raise-to a person could dial in too: Min, All-in, or a small-blind step like the phone slider. */
function clampRaise(view, to) {
  const step = view.smallBlind || 1;
  let amt = Math.round(to / step) * step;
  amt = Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, amt));
  // Close to the whole stack anyway? Just shove.
  if (amt >= view.maxRaiseTo * 0.85) amt = view.maxRaiseTo;
  return amt;
}

function raiseOr(view, to, fallback) {
  if (view.canRaise) return { type: 'raise', amount: clampRaise(view, to) };
  return fallback;
}

function passive(view) {
  return view.canCheck ? { type: 'check' } : { type: 'fold' };
}

function callOrCheck(view) {
  return view.canCheck ? { type: 'check' } : { type: 'call' };
}

// How often a CPU fires with nothing, by number of opponents still in (bluffs work best heads-up).
const BLUFF_RATE = { 1: 0.32, 2: 0.2, 3: 0.12 };
function bluffRate(opponents) { return BLUFF_RATE[Math.min(3, Math.max(1, opponents))]; }

function preflop(view, rng) {
  const chen = chenScore(view.hole);
  const bb = view.bigBlind;
  const stackBB = (view.stack + view.bet) / bb;
  const unopened = view.currentBet <= bb;

  // Short stack: push or fold (with the odd light shove when nobody has raised).
  if (stackBB <= 10) {
    if (chen >= 9 || (chen >= 7 && unopened) || (unopened && chen >= 4 && rng() < 0.2)) {
      return view.canRaise ? { type: 'raise', amount: view.maxRaiseTo } : callOrCheck(view);
    }
    return passive(view);
  }

  if (chen >= 11) {
    const to = unopened ? bb * 3 : view.currentBet * 3;
    return raiseOr(view, to, callOrCheck(view));
  }
  if (chen >= 9) {
    if (unopened) return raiseOr(view, bb * 3, callOrCheck(view));
    if (rng() < 0.25 && view.callAmount <= view.stack * 0.15) return raiseOr(view, view.currentBet * 3, callOrCheck(view));
    if (view.callAmount <= view.stack * 0.25) return callOrCheck(view);
    return passive(view);
  }
  if (chen >= 7) {
    if (unopened && rng() < 0.6) return raiseOr(view, bb * 2.5, callOrCheck(view));
    // A light 3-bet now and then, so a raise isn't a free pass.
    if (!unopened && rng() < 0.12 && view.callAmount <= view.stack * 0.12) {
      return raiseOr(view, view.currentBet * 3, callOrCheck(view));
    }
    if (view.callAmount <= bb * 4 && view.callAmount <= view.stack * 0.12) return callOrCheck(view);
    return passive(view);
  }
  if (chen >= 5) {
    if (unopened && rng() < 0.3) return raiseOr(view, bb * 2.5, callOrCheck(view));
    if (view.callAmount <= bb * 2 && view.callAmount <= view.stack * 0.06) return callOrCheck(view);
    return passive(view);
  }
  // Junk: an occasional steal when nobody has raised yet.
  if (unopened && rng() < 0.1) return raiseOr(view, bb * 2.5, passive(view));
  if (view.callAmount <= bb && view.callAmount <= view.stack * 0.03 && rng() < 0.4) return callOrCheck(view);
  return passive(view);
}

function postflop(view, rng) {
  const equity = estimateEquity(view.hole, view.board, view.opponents, rng);
  const pot = view.pot;
  const bluff = bluffRate(view.opponents);

  if (view.canCheck) {
    if (equity > 0.72) return raiseOr(view, pot * (0.6 + rng() * 0.3), { type: 'check' });
    if (equity > 0.52 && rng() < 0.55) return raiseOr(view, pot * (0.45 + rng() * 0.25), { type: 'check' });
    // Semi-bluff a hand with some outs, or bluff outright when checked to.
    if (equity > 0.3 && rng() < bluff + 0.12) return raiseOr(view, pot * (0.5 + rng() * 0.25), { type: 'check' });
    if (rng() < bluff) return raiseOr(view, pot * (0.5 + rng() * 0.3), { type: 'check' });
    return { type: 'check' };
  }

  const potOdds = view.callAmount / (pot + view.callAmount);
  if (equity > 0.8 && view.canRaise) return raiseOr(view, view.currentBet * 2.5 + pot * 0.3, { type: 'call' });
  if (equity > 0.62 && view.canRaise && rng() < 0.3) return raiseOr(view, view.currentBet * 2.5, { type: 'call' });
  // The odd bluff-raise against a smallish bet, mostly heads-up.
  if (view.canRaise && view.callAmount <= pot * 0.6 && view.callAmount <= view.stack * 0.25 && rng() < bluff * 0.3) {
    return raiseOr(view, view.currentBet * 2.5, { type: 'fold' });
  }
  if (equity >= potOdds + 0.03) return { type: 'call' };
  if (equity >= potOdds - 0.07 && rng() < 0.3) return { type: 'call' };
  return { type: 'fold' };
}

/**
 * Decide one action for the CPU on turn.
 * @param {ReturnType<import('./game').Game['botView']>} view
 * @param {() => number} rng
 * @returns {{ type:'fold'|'check'|'call'|'raise', amount?:number }}
 */
function chooseAction(view, rng) {
  const random = rng || Math.random;
  const a = view.board.length ? postflop(view, random) : preflop(view, random);
  if (a.type === 'fold' && view.canCheck) return { type: 'check' };
  if (a.type === 'check' && !view.canCheck) return { type: 'fold' };
  if (a.type === 'call' && view.canCheck) return { type: 'check' };
  return a;
}

module.exports = {
  BOT_SETTINGS,
  thinkDelay,
  chenScore,
  estimateEquity,
  chooseAction,
};
