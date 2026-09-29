'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hold'em Poker — server-authoritative No-Limit Texas Hold'em tournament.
//
// Everyone starts with the same stack; the blinds climb every N hands; a
// player is out when their stack hits zero, and the last one holding chips
// wins. Phones only ever receive their OWN hole cards (getPrivate); public
// snapshots carry a player's cards only once they have been shown.
//
// The transport layer (./index.js) owns sockets, broadcasting and the CPU
// think-timers; this class only calls `onChange` when a timer-driven
// transition fires.
//
// Roster rule (AGENTS.md): once the game starts nobody is ever skipped,
// auto-played for, or removed. A dropped phone just means the table waits.
// The only automatic actions are pre-actions the player chose themselves.
// ─────────────────────────────────────────────────────────────────────────

const { makeRng, shuffle, buildDeck } = require('./deck');
const { bestHand } = require('./evaluator');

const PHASES = {
  LOBBY: 'LOBBY',
  DEAL: 'DEAL',
  BETTING: 'BETTING',
  RUNOUT: 'RUNOUT',
  HAND_END: 'HAND_END',
  FINAL: 'FINAL',
};

const STREETS = ['preflop', 'flop', 'turn', 'river'];

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const MAX_NAME_LEN = 20;
const START_STACK = 1500;

const HANDS_PER_LEVEL_OPTIONS = [2, 3, 5, 7];
const DEFAULT_HANDS_PER_LEVEL = 3;

// PokerStars' standard 1,500-chip tournament ladder; past the end it doubles.
const BLIND_LEVELS = [
  [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300],
  [200, 400], [300, 600], [400, 800], [500, 1000], [600, 1200], [800, 1600],
  [1000, 2000], [1500, 3000], [2000, 4000], [3000, 6000], [4000, 8000], [5000, 10000],
];

const DEAL_DURATION_MS = 1800;
// A level-up hand holds the deal while the host shows "Blinds up!", so nobody can act under it.
const LEVEL_UP_DEAL_MS = 3400;
const STREET_PAUSE_MS = 1500;
const RUNOUT_STEP_MS = 1700;
const PREACTION_DELAY_MS = 550;
const FOLD_WIN_MS = 5000;
// Longer, so the table can read every revealed hand and the pot split.
const SHOWDOWN_MS = 10000;
const BUST_EXTRA_MS = 4600;
// With side pots, the host pays one pot at a time: side pots first, the main pot last.
const AWARD_LEAD_MS = 1000;
const POT_AWARD_MS = 3200;

const PRE_ACTIONS = ['checkFold', 'callAny'];

function blindsForLevel(level) {
  if (level < BLIND_LEVELS.length) return { sb: BLIND_LEVELS[level][0], bb: BLIND_LEVELS[level][1] };
  const last = BLIND_LEVELS[BLIND_LEVELS.length - 1];
  const m = Math.pow(2, level - BLIND_LEVELS.length + 1);
  return { sb: last[0] * m, bb: last[1] * m };
}

/** "Two Pair", "One Pair", "Royal Flush"… — the rank of a hand without its specifics. */
function handRankLabel(hand) {
  if (hand.name === 'Royal Flush') return 'Royal Flush';
  return hand.categoryName === 'Pair' ? 'One Pair' : hand.categoryName;
}

function emptyStats() {
  return {
    hands: 0, handsWon: 0, vpip: 0, pfr: 0,
    folds: 0, checks: 0, calls: 0, raises: 0,
    showdowns: 0, showdownsWon: 0, biggestPot: 0,
  };
}

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId: socketId || null,
    isBot: false,
    connected: true,
    order: 0,
    joinedAt: Date.now(),
    stack: 0,
    busted: false,
    place: null,
    bustHand: null,
    stats: emptyStats(),
    // Per hand
    inHand: false,
    startStack: 0,
    hole: [],
    folded: false,
    allIn: false,
    bet: 0,            // chips in front of them this street
    committed: 0,      // chips put in this hand, all streets
    acted: false,
    actedSeq: 0,       // raiseSeq when they last acted — decides if a raise reopened the action
    lastAction: null,  // { type, amount }
    preAction: null,   // 'checkFold' | 'callAny' | null
    shown: false,
    vpipThisHand: false,
    pfrThisHand: false,
  };
}

class Game {
  constructor(seed) {
    this.rng = makeRng(seed || (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    /** @type {Map<string, object>} */
    this.players = new Map();
    this._orderSeq = 0;
    this.handsPerLevel = DEFAULT_HANDS_PER_LEVEL;
    // Tests flip this to step timers by hand with tick().
    this.manualTimers = false;
    this._timers = {};
    this._resetGameState();
    this.onChange = null;
  }

  _resetGameState() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.handNumber = 0;
    this.level = 0;
    this.sb = BLIND_LEVELS[0][0];
    this.bb = BLIND_LEVELS[0][1];
    this.levelUpHand = 0;
    this.buttonId = null;
    this.sbId = null;
    this.bbId = null;
    this.street = null;
    this.deck = [];
    this.board = [];
    this.currentBet = 0;
    this.raiseSeq = 0;
    this.streetAggressorId = null;
    this.turnId = null;
    this.allInRunout = false;
    this.uncalled = [];
    this.result = null;
    this.canShowId = null;
    this.winnerId = null;
    this.lastEvent = null;
    this.lastActed = null;
    this.lastCollect = null;
    this._collectSeq = 0;
    this._eventSeq = 0;
    this.phaseEndsAt = 0;
    this._seq = 0;
  }

  // ─────────────────── Roster ───────────────────

  capacity() { return MAX_PLAYERS; }
  rosterCount() { return this.players.size; }

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  nameIsTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) if (p.name.toLowerCase() === lower) return true;
    return false;
  }

  addPlayer({ playerId, name, socketId }) {
    if (!playerId || typeof playerId !== 'string') return { ok: false, reason: 'bad-player-id' };
    if (this.players.has(playerId)) return this.reconnectPlayer({ playerId, socketId });
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'game-in-progress' };
    if (this.players.size >= MAX_PLAYERS) return { ok: false, reason: 'game-full' };
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const player = makePlayer(playerId, clean, socketId);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= MAX_PLAYERS) return { ok: false, reason: 'game-full' };
    let n = 1;
    while (this.players.has('bot-' + n)) n++;
    let name = 'CPU';
    if (this.nameIsTaken(name)) { let k = 2; while (this.nameIsTaken('CPU ' + k)) k++; name = 'CPU ' + k; }
    const bot = makePlayer('bot-' + n, name, null);
    bot.isBot = true;
    bot.order = this._orderSeq++;
    this.players.set(bot.id, bot);
    return { ok: true, player: bot };
  }

  reconnectPlayer({ playerId, socketId }) {
    const p = this.players.get(playerId);
    if (!p || p.isBot) return { ok: false, reason: 'unknown-player' };
    p.socketId = socketId;
    p.connected = true;
    return { ok: true, player: p };
  }

  markDisconnected(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) { p.connected = false; return p; }
    }
    return null;
  }

  /** Host kick — lobby only. Once the cards are in the air the roster is locked. */
  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    this.seatOrder().forEach((q, i) => { q.order = i; });
    return p;
  }

  /** Roster in seat order, clockwise round the table. */
  seatOrder() {
    return Array.from(this.players.values()).sort((a, b) => a.order - b.order);
  }

  seatOf(playerId) {
    const i = this.seatOrder().findIndex((p) => p.id === playerId);
    return i < 0 ? null : i + 1;
  }

  reorderPlayer(playerId, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const list = this.seatOrder().filter((q) => q.id !== playerId);
    let idx = beforeId ? list.findIndex((q) => q.id === beforeId) : -1;
    if (idx < 0) idx = list.length;
    list.splice(idx, 0, p);
    list.forEach((q, i) => { q.order = i; });
    return { ok: true };
  }

  setHandsPerLevel(value) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const n = Math.round(Number(value));
    if (HANDS_PER_LEVEL_OPTIONS.indexOf(n) < 0) return { ok: false, reason: 'bad-hands-per-level' };
    this.handsPerLevel = n;
    return { ok: true };
  }

  canStart() {
    return this.phase === PHASES.LOBBY && this.players.size >= MIN_PLAYERS;
  }

  // ─────────────────── Timers ───────────────────

  _disarm(key) {
    const t = this._timers[key];
    if (t && !t.manual) clearTimeout(t);
    this._timers[key] = null;
  }

  _clearTimers() {
    for (const key of Object.keys(this._timers)) this._disarm(key);
  }

  /** Arm a transition timer that no-ops if the state moved on underneath it. */
  _arm(key, ms, fn) {
    this._disarm(key);
    const seq = this._seq;
    const run = () => {
      this._timers[key] = null;
      if (seq !== this._seq) return;
      fn();
    };
    if (this.manualTimers) { this._timers[key] = { manual: true, run }; return; }
    const t = setTimeout(run, ms);
    if (t.unref) t.unref();
    this._timers[key] = t;
  }

  /** Test hook (manualTimers): fire one pending timer. False when none is armed. */
  tick() {
    const key = Object.keys(this._timers).find((k) => this._timers[k]);
    if (!key) return false;
    this._timers[key].run();
    return true;
  }

  _emit() { if (this.onChange) this.onChange(); }

  _event(type, extra) {
    this.lastEvent = Object.assign({ type, seq: ++this._eventSeq }, extra || {});
  }

  // ─────────────────── Seating helpers ───────────────────

  alive() { return this.seatOrder().filter((p) => !p.busted); }
  _live() { return this.seatOrder().filter((p) => p.inHand && !p.folded); }

  /** First player clockwise after `id` that satisfies `pred`. */
  _nextFrom(id, pred) {
    const order = this.seatOrder();
    const n = order.length;
    const i = order.findIndex((p) => p.id === id);
    for (let k = 1; k <= n; k++) {
      const q = order[(i + k + n) % n];
      if (pred(q)) return q;
    }
    return null;
  }

  _othersCanAct(p) {
    let n = 0;
    for (const q of this.players.values()) {
      if (q !== p && q.inHand && !q.folded && !q.allIn) n++;
    }
    return n;
  }

  _needsAction(p) {
    if (!p.inHand || p.folded || p.allIn) return false;
    if (p.bet < this.currentBet) return true;
    return !p.acted && this._othersCanAct(p) > 0;
  }

  /** Legal raise-to range for `p`, or null when raising isn't open to them. */
  _raiseLimits(p) {
    const max = p.bet + p.stack;
    if (max <= this.currentBet) return null;
    if (this._othersCanAct(p) === 0) return null;
    // A short all-in doesn't reopen the betting for anyone who already acted.
    if (p.acted && p.actedSeq >= this.raiseSeq) return null;
    return { min: Math.min(max, this.minRaiseTo()), max };
  }

  /** House rule: a raise must at least double the current bet; an opening bet is at least the big blind. */
  minRaiseTo() {
    return this.currentBet > 0 ? this.currentBet * 2 : this.bb;
  }

  _put(p, amount) {
    const a = Math.max(0, Math.min(amount, p.stack));
    p.stack -= a;
    p.bet += a;
    p.committed += a;
    if (p.stack === 0) p.allIn = true;
    return a;
  }

  // ─────────────────── Hand lifecycle ───────────────────

  start() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    for (const p of this.players.values()) {
      p.stack = START_STACK;
      p.busted = false;
      p.place = null;
      p.bustHand = null;
      p.stats = emptyStats();
    }
    this.handNumber = 0;
    this.level = 0;
    this.levelUpHand = 0;
    this.buttonId = null;
    this.winnerId = null;
    this._startHand();
    return { ok: true };
  }

  _startHand() {
    this._seq++;
    this._clearTimers();
    this.handNumber += 1;
    const level = Math.floor((this.handNumber - 1) / this.handsPerLevel);
    if (level !== this.level) { this.level = level; this.levelUpHand = this.handNumber; }
    const blinds = blindsForLevel(this.level);
    this.sb = blinds.sb;
    this.bb = blinds.bb;

    for (const p of this.players.values()) {
      p.inHand = !p.busted;
      p.startStack = p.stack;
      p.hole = [];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
      p.committed = 0;
      p.acted = false;
      p.actedSeq = 0;
      p.lastAction = null;
      p.preAction = null;
      p.shown = false;
      p.vpipThisHand = false;
      p.pfrThisHand = false;
      if (p.inHand) p.stats.hands += 1;
    }

    const alive = this.alive();
    const isAlive = (q) => !q.busted;
    const button = this.buttonId
      ? this._nextFrom(this.buttonId, isAlive)
      : alive[Math.floor(this.rng() * alive.length)];
    this.buttonId = button.id;
    // Heads-up the button posts the small blind and acts first before the flop.
    const sbP = alive.length === 2 ? button : this._nextFrom(button.id, isAlive);
    const bbP = this._nextFrom(sbP.id, isAlive);
    this.sbId = sbP.id;
    this.bbId = bbP.id;

    this.deck = shuffle(buildDeck(), this.rng);
    this.board = [];
    this.street = 'preflop';
    this.result = null;
    this.canShowId = null;
    this.allInRunout = false;
    this.uncalled = [];
    this.turnId = null;

    for (let round = 0; round < 2; round++) {
      let q = sbP;
      for (let k = 0; k < alive.length; k++) {
        q.hole.push(this.deck.pop());
        q = this._nextFrom(q.id, isAlive);
      }
    }

    this._post(sbP, this.sb, 'sb');
    this._post(bbP, this.bb, 'bb');
    this.currentBet = this.bb;
    this.raiseSeq = 1;
    this.streetAggressorId = null;

    this.phase = PHASES.DEAL;
    const levelUp = this.levelUpHand === this.handNumber;
    const dealMs = levelUp ? LEVEL_UP_DEAL_MS : DEAL_DURATION_MS;
    this._event('deal', { levelUp });
    this.phaseEndsAt = Date.now() + dealMs;
    this._arm('deal', dealMs, () => {
      if (this.phase !== PHASES.DEAL) return;
      this.phase = PHASES.BETTING;
      this.phaseEndsAt = 0;
      this._beginStreetAction(this.bbId);
      this._emit();
    });
  }

  _post(p, amount, kind) {
    const a = this._put(p, amount);
    p.lastAction = { type: kind, amount: a };
  }

  _beginStreetAction(afterId) {
    const first = this._nextFrom(afterId, (q) => this._needsAction(q));
    if (!first) { this._endStreet(); return; }
    this._setTurn(first.id);
  }

  _setTurn(id) {
    this._seq++;
    this.turnId = id;
    const p = this.players.get(id);
    if (p && !p.isBot && p.preAction) {
      this._arm('pre', PREACTION_DELAY_MS, () => this._runPreAction(id));
    }
  }

  _runPreAction(id) {
    if (this.phase !== PHASES.BETTING || this.turnId !== id) return;
    const p = this.players.get(id);
    if (!p || !p.preAction) return;
    const pre = p.preAction;
    p.preAction = null;
    const toCall = this.currentBet - p.bet;
    let type = 'check';
    if (toCall > 0) type = pre === 'callAny' ? 'call' : 'fold';
    this.act({ playerId: id, type });
    this._emit();
  }

  /**
   * One betting decision from the player on turn.
   * @param {{ playerId:string, type:'fold'|'check'|'call'|'raise', amount?:number }} a
   *   `amount` is the total the raiser's street bet becomes ("raise to").
   */
  act({ playerId, type, amount }) {
    if (this.phase !== PHASES.BETTING) return { ok: false, reason: 'not-betting' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (this.turnId !== playerId) return { ok: false, reason: 'not-your-turn' };
    const toCall = Math.max(0, this.currentBet - p.bet);

    if (type === 'fold') {
      if (toCall === 0) return { ok: false, reason: 'can-check' };
      p.folded = true;
      p.preAction = null;
      p.lastAction = { type: 'fold' };
    } else if (type === 'check') {
      if (toCall > 0) return { ok: false, reason: 'must-call' };
      p.lastAction = { type: 'check' };
    } else if (type === 'call') {
      if (toCall === 0) return { ok: false, reason: 'nothing-to-call' };
      this._put(p, toCall);
      p.lastAction = { type: p.allIn ? 'allin' : 'call', amount: p.bet };
    } else if (type === 'raise') {
      const lim = this._raiseLimits(p);
      if (!lim) return { ok: false, reason: 'cannot-raise' };
      const to = Math.floor(Number(amount));
      if (!Number.isFinite(to)) return { ok: false, reason: 'bad-amount' };
      if (to > lim.max) return { ok: false, reason: 'too-much', max: lim.max };
      if (to < lim.min) return { ok: false, reason: 'too-little', min: lim.min };
      const opening = this.currentBet === 0;
      // Anything short of the minimum (only possible all-in) is not a full raise and reopens nothing.
      const full = to >= this.minRaiseTo();
      this._put(p, to - p.bet);
      if (full) this.raiseSeq += 1;
      this.currentBet = to;
      this.streetAggressorId = p.id;
      p.lastAction = { type: p.allIn ? 'allin' : (opening ? 'bet' : 'raise'), amount: to };
    } else {
      return { ok: false, reason: 'bad-action' };
    }

    p.acted = true;
    p.actedSeq = this.raiseSeq;
    this._track(p, type);
    this._event(p.lastAction.type, { playerId: p.id, amount: p.lastAction.amount || 0 });
    // Kept apart from lastEvent, which a closing action's street/hand event overwrites at once.
    this.lastActed = { seq: this._eventSeq, playerId: p.id, type: p.lastAction.type, amount: p.lastAction.amount || 0 };
    this._advance(p.id);
    return { ok: true };
  }

  /** Tally one voluntary decision (blinds never count) for the stats table. */
  _track(p, type) {
    const s = p.stats;
    if (type === 'fold') s.folds += 1;
    else if (type === 'check') s.checks += 1;
    else if (type === 'call') s.calls += 1;
    else s.raises += 1;
    if (this.street !== 'preflop' || (type !== 'call' && type !== 'raise')) return;
    if (!p.vpipThisHand) { p.vpipThisHand = true; s.vpip += 1; }
    if (type === 'raise' && !p.pfrThisHand) { p.pfrThisHand = true; s.pfr += 1; }
  }

  _advance(fromId) {
    const live = this._live();
    if (live.length === 1) { this._winUncontested(live[0]); return; }
    const next = this._nextFrom(fromId, (q) => this._needsAction(q));
    if (next) { this._setTurn(next.id); return; }
    this._endStreet();
  }

  /** The part of the biggest bet nobody else matched goes straight back. */
  _returnUncalled() {
    let top = null;
    let topBet = 0;
    let second = 0;
    for (const p of this.seatOrder()) {
      if (!p.inHand) continue;
      if (p.bet > topBet) { second = topBet; topBet = p.bet; top = p; }
      else if (p.bet > second) second = p.bet;
    }
    if (!top || topBet <= second) return;
    const diff = topBet - second;
    top.bet -= diff;
    top.committed -= diff;
    top.stack += diff;
    if (top.stack > 0) top.allIn = false;
    this.uncalled.push({ playerId: top.id, name: top.name, amount: diff });
  }

  _collectBets() {
    const bets = {};
    let any = false;
    for (const p of this.players.values()) {
      if (p.bet > 0) { bets[p.id] = p.bet; any = true; }
      p.bet = 0;
    }
    // The host replays this: each seat's chips slide into the pot.
    if (any) this.lastCollect = { seq: ++this._collectSeq, bets };
  }

  _endStreet() {
    this._seq++;
    this.turnId = null;
    this._returnUncalled();
    this._collectBets();
    const aggressor = this.streetAggressorId;
    this.streetAggressorId = null;
    for (const p of this.players.values()) {
      p.acted = false;
      p.actedSeq = 0;
      p.preAction = null;
    }
    this.currentBet = 0;
    this.raiseSeq = 1;

    // Every way out of a closed betting round (next street, showdown, all-in runout)
    // waits a beat first, so the closing action and the chip sweep can be seen.
    this._event('collect');
    if (this.street === 'river') {
      this._arm('street', STREET_PAUSE_MS, () => {
        if (this.phase !== PHASES.BETTING) return;
        this._showdown(aggressor);
        this._emit();
      });
      return;
    }

    const canAct = this._live().filter((q) => !q.allIn).length;
    if (canAct <= 1) {
      this._arm('street', STREET_PAUSE_MS, () => {
        if (this.phase !== PHASES.BETTING) return;
        this._startRunout();
        this._emit();
      });
      return;
    }

    this._arm('street', STREET_PAUSE_MS, () => {
      if (this.phase !== PHASES.BETTING) return;
      // Closing action stays on the seat through the pause so the table can read it.
      for (const p of this.players.values()) if (!p.folded) p.lastAction = null;
      this._dealStreet();
      this._beginStreetAction(this.buttonId);
      this._emit();
    });
  }

  _dealStreet() {
    const next = STREETS[STREETS.indexOf(this.street) + 1];
    this.deck.pop(); // burn
    const n = next === 'flop' ? 3 : 1;
    for (let i = 0; i < n; i++) this.board.push(this.deck.pop());
    this.street = next;
    this._event('street', { street: next });
  }

  /** Betting is over but cards remain: flip every live hand, then deal it out. */
  _startRunout() {
    this.phase = PHASES.RUNOUT;
    this.allInRunout = true;
    this.turnId = null;
    for (const p of this._live()) p.shown = true;
    this._event('runout');
    const step = () => {
      if (this.phase !== PHASES.RUNOUT) return;
      if (this.street === 'river') { this._showdown(null); this._emit(); return; }
      this._dealStreet();
      this._arm('runout', RUNOUT_STEP_MS, step);
      this._emit();
    };
    this._arm('runout', RUNOUT_STEP_MS, step);
  }

  /**
   * Split the hand's chips into the main pot and side pots. Each pot holds one
   * contribution level: an all-in player can only win, from each opponent, what
   * they themselves put in. Folded chips stay in, but folders can't win them.
   * @param {boolean} collectedOnly  exclude the bets still in front of players
   */
  _buildPots(collectedOnly) {
    const contrib = this.seatOrder()
      .filter((p) => p.inHand)
      .map((p) => ({ p, left: collectedOnly ? p.committed - p.bet : p.committed }))
      .filter((c) => c.left > 0);
    const pots = [];
    for (;;) {
      const rem = contrib.filter((c) => c.left > 0);
      if (!rem.length) break;
      const liveRem = rem.filter((c) => !c.p.folded);
      if (!liveRem.length) {
        let dead = 0;
        rem.forEach((c) => { dead += c.left; c.left = 0; });
        if (pots.length) pots[pots.length - 1].amount += dead;
        else pots.push({ amount: dead, eligible: this._live().map((p) => p.id) });
        break;
      }
      const level = Math.min.apply(null, liveRem.map((c) => c.left));
      let amount = 0;
      rem.forEach((c) => { const t = Math.min(c.left, level); amount += t; c.left -= t; });
      const eligible = liveRem.map((c) => c.p.id);
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.length === eligible.length && prev.eligible.every((id, i) => id === eligible[i])) {
        prev.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    }
    return pots;
  }

  /** Everyone else folded: the last player standing takes it all, unseen. */
  _winUncontested(winner) {
    this._seq++;
    this.turnId = null;
    this._returnUncalled();
    this._collectBets();
    let total = 0;
    for (const p of this.players.values()) if (p.inHand) total += p.committed;
    winner.stack += total;
    this.result = {
      type: 'fold',
      winners: [winner.id],
      pots: [{ amount: total, winners: [{ playerId: winner.id, name: winner.name, amount: total }], handName: null }],
      shown: [],
      mucked: [],
      uncalled: this.uncalled.slice(),
    };
    this.canShowId = winner.isBot ? null : winner.id;
    this._enterHandEnd(FOLD_WIN_MS);
  }

  _showdown(aggressorId) {
    this._seq++;
    this.turnId = null;
    this._returnUncalled();
    this._collectBets();

    const live = this._live();
    const hands = {};
    live.forEach((p) => { hands[p.id] = bestHand(p.hole.concat(this.board)); });
    const pots = this._buildPots(false);
    const order = this.seatOrder();
    const clockwiseFromButton = (ids) => {
      const bi = order.findIndex((p) => p.id === this.buttonId);
      const rank = (id) => {
        const i = order.findIndex((p) => p.id === id);
        return (i - bi - 1 + order.length) % order.length;
      };
      return ids.slice().sort((a, b) => rank(a) - rank(b));
    };

    const potResults = pots.map((pot) => {
      const best = Math.max.apply(null, pot.eligible.map((id) => hands[id].score));
      // The odd chip goes to the first winner left of the button.
      const winners = clockwiseFromButton(pot.eligible.filter((id) => hands[id].score === best));
      const share = Math.floor(pot.amount / winners.length);
      let extra = pot.amount - share * winners.length;
      const rows = winners.map((id) => {
        const amt = share + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
        const p = this.players.get(id);
        p.stack += amt;
        return { playerId: id, name: p.name, amount: amt };
      });
      return {
        amount: pot.amount,
        eligible: pot.eligible.slice(),
        winners: rows,
        handName: pot.eligible.length > 1 ? hands[winners[0]].name : null,
        // Just the rank ("Two Pair"), for the table's result banner.
        handRank: pot.eligible.length > 1 ? handRankLabel(hands[winners[0]]) : null,
      };
    });

    // Who turns their cards over. With no betting left everyone does;
    // otherwise PokerStars' auto-muck: the last river aggressor (or the first
    // live seat left of the button) shows, and each seat after only shows if it
    // can still win or tie a pot it is in.
    const shownIds = [];
    const allShow = this.allInRunout || live.filter((q) => !q.allIn).length <= 1;
    const first = (aggressorId && live.some((p) => p.id === aggressorId))
      ? this.players.get(aggressorId)
      : this._nextFrom(this.buttonId, (q) => q.inHand && !q.folded);
    const sequence = [];
    let cur = first;
    for (let k = 0; k < live.length; k++) {
      sequence.push(cur);
      cur = this._nextFrom(cur.id, (q) => q.inHand && !q.folded);
    }
    sequence.forEach((p, i) => {
      let show = allShow || i === 0;
      if (!show) {
        show = pots.some((pot) => {
          if (pot.eligible.indexOf(p.id) < 0) return false;
          const shownHere = pot.eligible.filter((id) => shownIds.indexOf(id) >= 0);
          if (!shownHere.length) return true;
          const bestShown = Math.max.apply(null, shownHere.map((id) => hands[id].score));
          return hands[p.id].score >= bestShown;
        });
      }
      if (show) shownIds.push(p.id);
    });
    live.forEach((p) => { p.shown = shownIds.indexOf(p.id) >= 0; });

    const winnerIds = [];
    potResults.forEach((pr) => pr.winners.forEach((w) => { if (winnerIds.indexOf(w.playerId) < 0) winnerIds.push(w.playerId); }));

    this.result = {
      type: 'showdown',
      winners: winnerIds,
      pots: potResults,
      shown: shownIds.map((id) => {
        const p = this.players.get(id);
        return { playerId: id, name: p.name, cards: p.hole.slice(), handName: hands[id].name, best: hands[id].cards.slice() };
      }),
      mucked: live.filter((p) => shownIds.indexOf(p.id) < 0).map((p) => p.id),
      uncalled: this.uncalled.slice(),
    };
    this.canShowId = null;
    const extraPots = potResults.length - 1;
    if (extraPots > 0) {
      this.result.awardFrom = Date.now() + AWARD_LEAD_MS;
      this.result.awardMs = POT_AWARD_MS;
    }
    this._enterHandEnd(SHOWDOWN_MS + Math.max(0, extraPots) * POT_AWARD_MS);
  }

  _enterHandEnd(ms) {
    this.phase = PHASES.HAND_END;
    this.turnId = null;

    const wonThisHand = {};
    this.result.pots.forEach((pot) => pot.winners.forEach((w) => {
      wonThisHand[w.playerId] = (wonThisHand[w.playerId] || 0) + w.amount;
    }));
    for (const p of this.players.values()) {
      if (!p.inHand) continue;
      const won = wonThisHand[p.id] || 0;
      if (won) {
        p.stats.handsWon += 1;
        p.stats.biggestPot = Math.max(p.stats.biggestPot, won);
      }
      if (this.result.type === 'showdown' && !p.folded) {
        p.stats.showdowns += 1;
        if (won) p.stats.showdownsWon += 1;
      }
    }

    const busted = this.seatOrder().filter((p) => p.inHand && p.stack === 0 && !p.busted);
    const survivors = this.seatOrder().filter((p) => !p.busted && p.stack > 0);
    // Busting on the same hand: the bigger starting stack finishes higher.
    busted.forEach((p) => {
      const above = busted.filter((q) => q.startStack > p.startStack).length;
      p.place = survivors.length + 1 + above;
      p.busted = true;
      p.bustHand = this.handNumber;
    });
    this.result.busted = busted
      .slice()
      .sort((a, b) => a.place - b.place)
      .map((p) => ({ playerId: p.id, name: p.name, place: p.place }));

    const gameOver = survivors.length <= 1;
    this.result.gameOver = gameOver;
    if (gameOver && survivors[0]) {
      survivors[0].place = 1;
      this.winnerId = survivors[0].id;
    }
    this._event('handEnd', { resultType: this.result.type, busted: busted.length });

    // A knockout plays once the showdown pause is over, then the next hand waits for it.
    this.result.knockoutAt = busted.length ? Date.now() + ms : null;
    const dur = ms + (busted.length ? BUST_EXTRA_MS : 0);
    this.phaseEndsAt = Date.now() + dur;
    this._arm('handEnd', dur, () => {
      if (this.phase !== PHASES.HAND_END) return;
      if (gameOver) this._enterFinal();
      else this._startHand();
      this._emit();
    });
  }

  _enterFinal() {
    this._seq++;
    this._clearTimers();
    this.phase = PHASES.FINAL;
    this.turnId = null;
    this.phaseEndsAt = 0;
  }

  /** The uncontested winner may flip their cards for the table. */
  showCards(playerId) {
    if (this.phase !== PHASES.HAND_END) return { ok: false, reason: 'not-hand-end' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (this.canShowId !== playerId) return { ok: false, reason: 'cannot-show' };
    if (p.shown) return { ok: false, reason: 'already-shown' };
    p.shown = true;
    const cards = p.hole.concat(this.board);
    this.result.shown.push({
      playerId: p.id,
      name: p.name,
      cards: p.hole.slice(),
      handName: cards.length >= 5 ? bestHand(cards).name : null,
      best: cards.length >= 5 ? bestHand(cards).cards : [],
    });
    this._event('show', { playerId: p.id });
    return { ok: true };
  }

  setPreAction(playerId, type) {
    if (this.phase !== PHASES.BETTING && this.phase !== PHASES.DEAL) return { ok: false, reason: 'not-betting' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (!p.inHand || p.folded || p.allIn) return { ok: false, reason: 'not-in-hand' };
    if (this.turnId === playerId) return { ok: false, reason: 'your-turn' };
    if (type !== null && PRE_ACTIONS.indexOf(type) < 0) return { ok: false, reason: 'bad-pre-action' };
    p.preAction = type;
    return { ok: true, preAction: p.preAction };
  }

  pendingBots() {
    if (this.phase !== PHASES.BETTING || !this.turnId) return null;
    const p = this.players.get(this.turnId);
    return p && p.isBot ? { players: [p] } : null;
  }

  _totalPot() {
    let n = 0;
    for (const p of this.players.values()) if (p.inHand) n += p.committed;
    return n;
  }

  /** Everything a CPU may know: its own cards plus the public table. */
  botView(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const lim = this._raiseLimits(p);
    const toCall = Math.max(0, this.currentBet - p.bet);
    return {
      hole: p.hole.slice(),
      board: this.board.slice(),
      street: this.street,
      stack: p.stack,
      bet: p.bet,
      toCall,
      callAmount: Math.min(toCall, p.stack),
      currentBet: this.currentBet,
      canCheck: toCall === 0,
      canRaise: !!lim,
      minRaiseTo: lim ? lim.min : 0,
      maxRaiseTo: lim ? lim.max : 0,
      pot: this._totalPot(),
      smallBlind: this.sb,
      bigBlind: this.bb,
      opponents: this._live().length - 1,
    };
  }

  reset() {
    this.players.clear();
    this._orderSeq = 0;
    this._resetGameState();
    this.handsPerLevel = DEFAULT_HANDS_PER_LEVEL;
  }

  // ─────────────────── Public snapshots (never an unshown hole card) ───────────────────

  getLobbyPublic() {
    const order = this.seatOrder();
    return {
      phase: this.phase,
      players: order.map((p, i) => ({
        id: p.id,
        name: p.name,
        seat: i + 1,
        isBot: !!p.isBot,
        connected: p.isBot ? true : !!p.connected,
      })),
      total: order.length,
      capacity: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      canStart: this.canStart(),
      handsPerLevel: this.handsPerLevel,
      handsPerLevelOptions: HANDS_PER_LEVEL_OPTIONS,
      startStack: START_STACK,
      startBlinds: { sb: BLIND_LEVELS[0][0], bb: BLIND_LEVELS[0][1] },
    };
  }

  _seatsPublic() {
    return this.seatOrder().map((p, i) => ({
      playerId: p.id,
      name: p.name,
      seat: i + 1,
      isBot: !!p.isBot,
      connected: p.isBot ? true : !!p.connected,
      stack: p.stack,
      bet: p.bet,
      inHand: p.inHand,
      folded: p.folded,
      allIn: p.allIn,
      busted: p.busted,
      place: p.place,
      lastAction: p.lastAction ? Object.assign({}, p.lastAction) : null,
      hasCards: p.inHand && !p.folded && p.hole.length === 2,
      cards: p.shown ? p.hole.slice() : null,
    }));
  }

  _statsPublic() {
    const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
    return this.seatOrder().map((p, i) => {
      const s = p.stats;
      const decisions = s.folds + s.checks + s.calls + s.raises;
      return {
        playerId: p.id,
        name: p.name,
        seat: i + 1,
        isBot: !!p.isBot,
        stack: p.stack,
        busted: p.busted,
        place: p.place,
        bustHand: p.bustHand,
        hands: s.hands,
        handsWon: s.handsWon,
        wonPct: pct(s.handsWon, s.hands),
        vpip: pct(s.vpip, s.hands),
        pfr: pct(s.pfr, s.hands),
        foldPct: pct(s.folds, decisions),
        checkPct: pct(s.checks, decisions),
        callPct: pct(s.calls, decisions),
        raisePct: pct(s.raises, decisions),
        showdowns: s.showdowns,
        showdownsWon: s.showdownsWon,
        biggestPot: s.biggestPot,
      };
    });
  }

  _tableMeta() {
    const turn = this.turnId ? this.players.get(this.turnId) : null;
    const next = blindsForLevel(this.level + 1);
    const played = this.handNumber ? (this.handNumber - 1) % this.handsPerLevel : 0;
    const collected = this._buildPots(true);
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      level: this.level + 1,
      smallBlind: this.sb,
      bigBlind: this.bb,
      nextSmallBlind: next.sb,
      nextBigBlind: next.bb,
      handsToNextLevel: this.handsPerLevel - played,
      handsPerLevel: this.handsPerLevel,
      levelUp: this.levelUpHand === this.handNumber,
      street: this.street,
      board: this.board.slice(),
      pots: collected.map((pot) => ({ amount: pot.amount, eligibleCount: pot.eligible.length })),
      potTotal: collected.reduce((a, pot) => a + pot.amount, 0),
      totalPot: this._totalPot(),
      currentBet: this.currentBet,
      turnPlayerId: turn ? turn.id : null,
      turnIsBot: !!(turn && turn.isBot),
      waitingOn: turn && !turn.isBot && !turn.connected ? turn.name : null,
      buttonId: this.buttonId,
      sbId: this.sbId,
      bbId: this.bbId,
      aliveCount: this.alive().length,
      playerCount: this.players.size,
      startStack: START_STACK,
      seats: this._seatsPublic(),
      stats: this._statsPublic(),
      lastEvent: this.lastEvent ? Object.assign({}, this.lastEvent) : null,
      lastActed: this.lastActed ? Object.assign({}, this.lastActed) : null,
      lastCollect: this.lastCollect ? { seq: this.lastCollect.seq, bets: Object.assign({}, this.lastCollect.bets) } : null,
      serverNow: Date.now(),
    };
  }

  getTablePublic() {
    return Object.assign(this._tableMeta(), { endsAt: this.phaseEndsAt });
  }

  getHandEndPublic() {
    return Object.assign(this._tableMeta(), {
      result: this.result ? JSON.parse(JSON.stringify(this.result)) : null,
      gameOver: !!(this.result && this.result.gameOver),
      endsAt: this.phaseEndsAt,
    });
  }

  getFinalPublic() {
    const order = this.seatOrder();
    const standings = order
      .map((p, i) => ({
        playerId: p.id,
        name: p.name,
        seat: i + 1,
        isBot: !!p.isBot,
        place: p.place || 1,
        bustHand: p.bustHand,
        stack: p.stack,
      }))
      .sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
    const w = this.winnerId ? this.players.get(this.winnerId) : null;
    return {
      standings,
      winnerId: this.winnerId,
      winnerName: w ? w.name : null,
      handsPlayed: this.handNumber,
      startStack: START_STACK,
      stats: this._statsPublic(),
    };
  }

  // ─────────────────── Private snapshot ───────────────────

  /**
   * THE ONLY accessor that exposes hole cards. Must go to a single socket —
   * never broadcast, and never to the host screen.
   */
  getPrivate(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const yourTurn = this.phase === PHASES.BETTING && this.turnId === p.id;
    const toCall = p.inHand && !p.folded ? Math.max(0, this.currentBet - p.bet) : 0;
    const lim = yourTurn ? this._raiseLimits(p) : null;
    const turn = this.turnId ? this.players.get(this.turnId) : null;
    let won = 0;
    if (this.phase === PHASES.HAND_END && this.result) {
      this.result.pots.forEach((pot) => pot.winners.forEach((w) => { if (w.playerId === p.id) won += w.amount; }));
    }
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      seat: this.seatOf(p.id),
      hole: p.hole.slice(),
      stack: p.stack,
      bet: p.bet,
      inHand: p.inHand,
      folded: p.folded,
      allIn: p.allIn,
      busted: p.busted,
      place: p.place,
      yourTurn,
      toCall,
      callAmount: Math.min(toCall, p.stack),
      canCheck: yourTurn && toCall === 0,
      canRaise: !!lim,
      minRaiseTo: lim ? lim.min : 0,
      maxRaiseTo: lim ? lim.max : 0,
      currentBet: this.currentBet,
      pot: this._totalPot(),
      smallBlind: this.sb,
      bigBlind: this.bb,
      preAction: p.preAction,
      turnName: turn ? turn.name : null,
      turnSeat: turn ? this.seatOf(turn.id) : null,
      canShow: this.phase === PHASES.HAND_END && this.canShowId === p.id && !p.shown,
      shown: p.shown,
      won,
      // Everything coming back to a winner: the pots they won plus, on a fold win, their own unmatched bet.
      collected: won ? won + (this.result && this.result.type === 'fold' ? this.uncalled.filter((u) => u.playerId === p.id).reduce((a, u) => a + u.amount, 0) : 0) : 0,
      street: this.street,
    };
  }
}

module.exports = {
  Game,
  PHASES,
  STREETS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MAX_NAME_LEN,
  START_STACK,
  BLIND_LEVELS,
  HANDS_PER_LEVEL_OPTIONS,
  DEFAULT_HANDS_PER_LEVEL,
  DEAL_DURATION_MS,
  LEVEL_UP_DEAL_MS,
  STREET_PAUSE_MS,
  RUNOUT_STEP_MS,
  FOLD_WIN_MS,
  SHOWDOWN_MS,
  BUST_EXTRA_MS,
  AWARD_LEAD_MS,
  POT_AWARD_MS,
  blindsForLevel,
};
