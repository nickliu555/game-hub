'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Liar's Dice — server-authoritative Perudo-style bluffing game.
//
// Everyone rolls their dice in secret, then takes turns bidding on how many
// dice of a face are on the whole table (1s are wild). The next player
// raises, calls BS on the bid, or calls "Spot On" (exactly right). The loser
// of a challenge loses a die; a correct Spot On wins one back. Out of dice,
// out of the game — the last player holding dice wins.
//
// Phones only ever receive their OWN dice (getPrivate); public snapshots
// carry everyone's dice only during the reveal after a challenge.
//
// The transport layer (./index.js) owns sockets, broadcasting and the CPU
// think-timers; this class only calls `onChange` when a timer-driven
// transition fires.
//
// Roster rule (AGENTS.md): once the game starts nobody is ever skipped,
// auto-played for, or removed. A dropped phone just means the table waits.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  ROLL: 'ROLL',
  BIDDING: 'BIDDING',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const MAX_NAME_LEN = 20;

const START_DICE_OPTIONS = [3, 4, 5, 6];
const DEFAULT_START_DICE = 5;

// The phones tumble for ~1.5s and land die by die; bidding opens once they've settled.
const ROLL_MS = 2700;
// "<name> calls BS!" holds the table before the first cup lifts.
// After a bid the host shows it in a big pop-up; the next player can't act until it has gone.
// Must match ANNOUNCE_MS in public/liarsdice/js/host.js.
const BID_ANNOUNCE_MS = 3000;
const REVEAL_INTRO_MS = 3100;
const REVEAL_STEP_MS = 1300;
// After the last seat is shown, a beat before the verdict lands.
const VERDICT_GAP_MS = 900;
// The verdict stays up 7s after the die is lost or won (which lands 1.3s after the verdict).
const VERDICT_HOLD_MS = 8300;
// A knockout plays after the verdict, so the round waits for it.
const KO_EXTRA_MS = 3200;

function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Does a die count toward a bid on `face`? 1s are wild for every other face. */
function dieMatches(d, face) {
  return d === face || (face !== 1 && d === 1);
}

function countFace(dice, face) {
  let n = 0;
  for (const d of dice) if (dieMatches(d, face)) n++;
  return n;
}

/**
 * The smallest legal quantity for a bid on `face` after `prev` (null = opening
 * bid), or null when no bid on that face is possible. Perudo rules:
 *   - opening: any quantity of any face, 1s included
 *   - on another face: more dice, or the same number of a higher face
 *   - switching to 1s: at least half the current quantity, rounded up
 *   - raising 1s: more 1s
 *   - switching off 1s: at least double the 1s, plus one
 */
function minQtyFor(prev, face, totalDice) {
  let min;
  if (!prev) {
    min = 1;
  } else if (prev.face === 1) {
    min = face === 1 ? prev.qty + 1 : prev.qty * 2 + 1;
  } else if (face === 1) {
    min = Math.ceil(prev.qty / 2);
  } else {
    min = face > prev.face ? prev.qty : prev.qty + 1;
  }
  if (min > totalDice) return null;
  return Math.max(1, min);
}

function emptyStats() {
  return {
    rounds: 0, bids: 0,
    bsCalls: 0, bsRight: 0,
    spotCalls: 0, spotRight: 0,
    caught: 0, diceLost: 0, diceWon: 0,
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
    dice: [],
    diceCount: 0,
    busted: false,
    place: null,
    outRound: null,
    lastAction: null,   // { type:'bid', qty, face } | { type:'bs' } | { type:'spot' }
    stats: emptyStats(),
  };
}

class Game {
  constructor(seed) {
    this.rng = makeRng(seed || (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    /** @type {Map<string, object>} */
    this.players = new Map();
    this._orderSeq = 0;
    this.startDice = DEFAULT_START_DICE;
    // Tests flip this to step timers by hand with tick().
    this.manualTimers = false;
    this._timers = {};
    this._resetGameState();
    this.onChange = null;
  }

  _resetGameState() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.round = 0;
    this.turnId = null;
    this.turnLocked = false;
    this.turnOpensAt = 0;
    this.openerId = null;
    this.nextOpenerId = null;
    this.currentBid = null;   // { qty, face, playerId }
    this.bids = [];
    this.reveal = null;
    this.winnerId = null;
    this.lastEvent = null;
    this.lastActed = null;
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

  /** Host kick — lobby only. Once the dice are rolling the roster is locked. */
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

  setStartDice(value) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const n = Math.round(Number(value));
    if (START_DICE_OPTIONS.indexOf(n) < 0) return { ok: false, reason: 'bad-start-dice' };
    this.startDice = n;
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

  totalDice() {
    let n = 0;
    for (const p of this.players.values()) if (!p.busted) n += p.diceCount;
    return n;
  }

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

  minQty(face) { return minQtyFor(this.currentBid, face, this.totalDice()); }

  /** { 1: min|null, … 6: min|null } — the cheapest legal bid on each face right now. */
  legalBids() {
    const out = {};
    for (let f = 1; f <= 6; f++) out[f] = this.minQty(f);
    return out;
  }

  // ─────────────────── Round lifecycle ───────────────────

  start() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    for (const p of this.players.values()) {
      p.diceCount = this.startDice;
      p.dice = [];
      p.busted = false;
      p.place = null;
      p.outRound = null;
      p.lastAction = null;
      p.stats = emptyStats();
    }
    this.round = 0;
    this.winnerId = null;
    const alive = this.alive();
    this.nextOpenerId = alive[Math.floor(this.rng() * alive.length)].id;
    this._startRound();
    return { ok: true };
  }

  _rollDie() { return 1 + Math.floor(this.rng() * 6); }

  _startRound() {
    this._seq++;
    this._clearTimers();
    this.round += 1;
    this.reveal = null;
    this.currentBid = null;
    this.bids = [];
    this.lastActed = null;
    for (const p of this.players.values()) {
      p.lastAction = null;
      if (p.busted) { p.dice = []; continue; }
      p.dice = [];
      for (let i = 0; i < p.diceCount; i++) p.dice.push(this._rollDie());
      p.stats.rounds += 1;
    }
    // The player who lost the die opens; if that knocked them out, the next seat clockwise does.
    let opener = this.players.get(this.nextOpenerId);
    if (!opener || opener.busted) opener = this._nextFrom(this.nextOpenerId, (q) => !q.busted);
    this.openerId = opener.id;

    this.phase = PHASES.ROLL;
    this.turnId = null;
    this.phaseEndsAt = Date.now() + ROLL_MS;
    this._event('roll', { round: this.round });
    this._arm('roll', ROLL_MS, () => {
      if (this.phase !== PHASES.ROLL) return;
      this.phase = PHASES.BIDDING;
      this.phaseEndsAt = 0;
      this._setTurn(this.openerId);
      this._emit();
    });
  }

  _setTurn(id) {
    this.turnId = id;
    this.turnLocked = false;
    this.turnOpensAt = 0;
    const p = this.players.get(id);
    // A seat's last call stays beside it until the action comes back round to them.
    if (p) p.lastAction = null;
  }

  /**
   * One decision from the player on turn.
   * @param {{ playerId:string, type:'bid'|'bs'|'spot', qty?:number, face?:number }} a
   */
  act({ playerId, type, qty, face }) {
    if (this.phase !== PHASES.BIDDING) return { ok: false, reason: 'not-bidding' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (this.turnId !== playerId) return { ok: false, reason: 'not-your-turn' };
    if (this.turnLocked) return { ok: false, reason: 'not-yet' };

    if (type === 'bid') {
      const f = Number(face);
      const q = Number(qty);
      if (!Number.isInteger(f) || f < 1 || f > 6) return { ok: false, reason: 'bad-face' };
      if (!Number.isInteger(q) || q < 1) return { ok: false, reason: 'bad-qty' };
      const total = this.totalDice();
      if (q > total) return { ok: false, reason: 'too-high', max: total };
      const min = this.minQty(f);
      if (min === null) return { ok: false, reason: 'no-legal-bid' };
      if (q < min) return { ok: false, reason: 'too-low', min };
      this.currentBid = { qty: q, face: f, playerId: p.id };
      this.bids.push({ qty: q, face: f, playerId: p.id });
      p.lastAction = { type: 'bid', qty: q, face: f };
      p.stats.bids += 1;
      this.lastActed = { seq: ++this._eventSeq, playerId: p.id, type: 'bid', qty: q, face: f };
      const next = this._nextFrom(p.id, (x) => !x.busted);
      this._setTurn(next.id);
      // The turn passes at once (the seat lights up) but stays locked until the bid's pop-up is gone.
      this.turnLocked = true;
      this.turnOpensAt = Date.now() + BID_ANNOUNCE_MS;
      this._arm('turnOpen', BID_ANNOUNCE_MS, () => {
        if (this.phase !== PHASES.BIDDING) return;
        this.turnLocked = false;
        this.turnOpensAt = 0;
        this._emit();
      });
      return { ok: true };
    }

    if (type === 'bs' || type === 'spot') {
      if (!this.currentBid) return { ok: false, reason: 'no-bid' };
      p.lastAction = { type };
      this.lastActed = { seq: ++this._eventSeq, playerId: p.id, type };
      this._startReveal(p, type);
      return { ok: true };
    }

    return { ok: false, reason: 'bad-action' };
  }

  _startReveal(caller, type) {
    this._seq++;
    this._clearTimers();
    const bid = this.currentBid;
    const bidder = this.players.get(bid.playerId);
    const alive = this.alive();

    // The cups lift one at a time, starting with whoever made the call and going clockwise.
    const order = [caller.id];
    let cur = caller;
    for (let k = 1; k < alive.length; k++) {
      cur = this._nextFrom(cur.id, (q) => !q.busted);
      order.push(cur.id);
    }
    const dice = {};
    let count = 0;
    alive.forEach((q) => {
      dice[q.id] = q.dice.slice();
      count += countFace(q.dice, bid.face);
    });

    const bidTrue = count >= bid.qty;
    const exact = count === bid.qty;
    let correct;
    let loserId = null;
    let gainerId = null;
    const delta = {};
    if (type === 'bs') {
      correct = !bidTrue;
      loserId = correct ? bidder.id : caller.id;
      caller.stats.bsCalls += 1;
      if (correct) { caller.stats.bsRight += 1; bidder.stats.caught += 1; }
    } else {
      correct = exact;
      caller.stats.spotCalls += 1;
      if (correct) {
        caller.stats.spotRight += 1;
        gainerId = caller.id;
      } else {
        loserId = caller.id;
      }
    }
    if (loserId) delta[loserId] = -1;
    // A correct Spot On wins a die back, never past the starting count.
    const capped = !!gainerId && this.players.get(gainerId).diceCount >= this.startDice;
    if (gainerId && !capped) delta[gainerId] = 1;

    const knockedOut = loserId && this.players.get(loserId).diceCount <= 1 ? [loserId] : [];
    const aliveAfter = alive.length - knockedOut.length;
    const gameOver = aliveAfter <= 1;

    // Next round opens with whoever lost the die, or the Spot On caller who won one.
    this.nextOpenerId = loserId || caller.id;

    const now = Date.now();
    const startAt = now + REVEAL_INTRO_MS;
    const verdictAt = startAt + order.length * REVEAL_STEP_MS + VERDICT_GAP_MS;
    const endAt = verdictAt + VERDICT_HOLD_MS + (knockedOut.length ? KO_EXTRA_MS : 0);

    const nameOf = (id) => (id ? this.players.get(id).name : null);
    this.reveal = {
      type,
      callerId: caller.id,
      callerName: caller.name,
      bid: { qty: bid.qty, face: bid.face, playerId: bidder.id, name: bidder.name },
      order,
      dice,
      count,
      bidTrue,
      exact,
      correct,
      loserId,
      loserName: nameOf(loserId),
      gainerId,
      gainerName: nameOf(gainerId),
      capped,
      delta,
      knockedOut,
      gameOver,
      startAt,
      stepMs: REVEAL_STEP_MS,
      verdictAt,
      endAt,
    };

    this.phase = PHASES.REVEAL;
    this.turnId = null;
    this.turnLocked = false;
    this.turnOpensAt = 0;
    this.phaseEndsAt = endAt;
    this._event('reveal', { callType: type, callerId: caller.id });
    this._arm('reveal', endAt - now, () => {
      if (this.phase !== PHASES.REVEAL) return;
      this._applyReveal();
      if (this.reveal.gameOver) this._enterFinal();
      else this._startRound();
      this._emit();
    });
  }

  _applyReveal() {
    const r = this.reveal;
    const aliveBefore = this.alive().length;
    Object.keys(r.delta).forEach((id) => {
      const p = this.players.get(id);
      p.diceCount = Math.max(0, Math.min(this.startDice, p.diceCount + r.delta[id]));
      if (r.delta[id] < 0) p.stats.diceLost += 1;
      else p.stats.diceWon += 1;
    });
    r.knockedOut.forEach((id) => {
      const p = this.players.get(id);
      p.busted = true;
      p.diceCount = 0;
      p.place = aliveBefore;
      p.outRound = this.round;
    });
    const survivors = this.alive();
    if (survivors.length <= 1 && survivors[0]) {
      survivors[0].place = 1;
      this.winnerId = survivors[0].id;
    }
  }

  _enterFinal() {
    this._seq++;
    this._clearTimers();
    this.phase = PHASES.FINAL;
    this.turnId = null;
    this.phaseEndsAt = 0;
  }

  pendingBots() {
    if (this.phase !== PHASES.BIDDING || !this.turnId || this.turnLocked) return null;
    const p = this.players.get(this.turnId);
    return p && p.isBot ? { players: [p] } : null;
  }

  /** Everything a CPU may know: its own dice plus the public table. */
  botView(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    return {
      dice: p.dice.slice(),
      diceCount: p.diceCount,
      startDice: this.startDice,
      totalDice: this.totalDice(),
      players: this.alive().length,
      currentBid: this.currentBid ? Object.assign({}, this.currentBid) : null,
      legal: this.legalBids(),
      bids: this.bids.map((b) => Object.assign({}, b)),
    };
  }

  reset() {
    this.players.clear();
    this._orderSeq = 0;
    this._resetGameState();
    this.startDice = DEFAULT_START_DICE;
  }

  // ─────────────────── Public snapshots (never an unrevealed die) ───────────────────

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
      startDice: this.startDice,
      startDiceOptions: START_DICE_OPTIONS,
    };
  }

  _seatsPublic() {
    return this.seatOrder().map((p, i) => ({
      playerId: p.id,
      name: p.name,
      seat: i + 1,
      isBot: !!p.isBot,
      connected: p.isBot ? true : !!p.connected,
      diceCount: p.diceCount,
      busted: p.busted,
      place: p.place,
      lastAction: p.lastAction ? Object.assign({}, p.lastAction) : null,
    }));
  }

  _statsPublic() {
    return this.seatOrder().map((p, i) => {
      const s = p.stats;
      return {
        playerId: p.id,
        name: p.name,
        seat: i + 1,
        isBot: !!p.isBot,
        diceCount: p.diceCount,
        busted: p.busted,
        place: p.place,
        outRound: p.outRound,
        rounds: s.rounds,
        bids: s.bids,
        bsCalls: s.bsCalls,
        bsRight: s.bsRight,
        spotCalls: s.spotCalls,
        spotRight: s.spotRight,
        caught: s.caught,
        diceLost: s.diceLost,
        diceWon: s.diceWon,
      };
    });
  }

  _bidPublic() {
    const b = this.currentBid;
    if (!b) return null;
    const p = this.players.get(b.playerId);
    return { qty: b.qty, face: b.face, playerId: b.playerId, name: p ? p.name : '', seat: this.seatOf(b.playerId) };
  }

  _revealPublic() {
    return this.reveal ? JSON.parse(JSON.stringify(this.reveal)) : null;
  }

  getTablePublic() {
    const turn = this.turnId ? this.players.get(this.turnId) : null;
    const opener = this.openerId ? this.players.get(this.openerId) : null;
    return {
      phase: this.phase,
      round: this.round,
      startDice: this.startDice,
      totalDice: this.totalDice(),
      aliveCount: this.alive().length,
      playerCount: this.players.size,
      turnPlayerId: turn ? turn.id : null,
      turnLocked: this.turnLocked,
      turnOpensAt: this.turnOpensAt,
      turnIsBot: !!(turn && turn.isBot),
      waitingOn: turn && !turn.isBot && !turn.connected ? turn.name : null,
      openerId: opener ? opener.id : null,
      openerName: opener ? opener.name : null,
      currentBid: this._bidPublic(),
      bidCount: this.bids.length,
      seats: this._seatsPublic(),
      stats: this._statsPublic(),
      lastEvent: this.lastEvent ? Object.assign({}, this.lastEvent) : null,
      lastActed: this.lastActed ? Object.assign({}, this.lastActed) : null,
      reveal: this.phase === PHASES.REVEAL ? this._revealPublic() : null,
      endsAt: this.phaseEndsAt,
      serverNow: Date.now(),
    };
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
        outRound: p.outRound,
        diceCount: p.diceCount,
      }))
      .sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
    const w = this.winnerId ? this.players.get(this.winnerId) : null;
    return {
      standings,
      winnerId: this.winnerId,
      winnerName: w ? w.name : null,
      rounds: this.round,
      startDice: this.startDice,
      stats: this._statsPublic(),
    };
  }

  // ─────────────────── Private snapshot ───────────────────

  /**
   * THE ONLY accessor that exposes a player's dice outside a reveal. Must go
   * to a single socket — never broadcast, and never to the host screen.
   */
  getPrivate(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const upNext = this.phase === PHASES.BIDDING && this.turnId === p.id;
    const yourTurn = upNext && !this.turnLocked;
    const turn = this.turnId ? this.players.get(this.turnId) : null;
    const opener = this.openerId ? this.players.get(this.openerId) : null;
    const legal = yourTurn ? this.legalBids() : null;
    let reveal = null;
    if (this.phase === PHASES.REVEAL && this.reveal) {
      const r = this.reveal;
      reveal = {
        type: r.type,
        callerId: r.callerId,
        callerName: r.callerName,
        callerSeat: this.seatOf(r.callerId),
        bid: Object.assign({ seat: this.seatOf(r.bid.playerId) }, r.bid),
        count: r.count,
        correct: r.correct,
        loserId: r.loserId,
        loserName: r.loserName,
        loserSeat: r.loserId ? this.seatOf(r.loserId) : null,
        gainerId: r.gainerId,
        gainerName: r.gainerName,
        capped: r.capped,
        myDelta: r.delta[p.id] || 0,
        knockedOut: r.knockedOut.indexOf(p.id) >= 0,
        gameOver: r.gameOver,
        verdictAt: r.verdictAt,
        endAt: r.endAt,
      };
    }
    return {
      phase: this.phase,
      round: this.round,
      seat: this.seatOf(p.id),
      dice: p.dice.slice(),
      diceCount: p.diceCount,
      startDice: this.startDice,
      totalDice: this.totalDice(),
      busted: p.busted,
      place: p.place,
      yourTurn,
      upNext,
      turnOpensAt: upNext ? this.turnOpensAt : 0,
      legal,
      canBid: !!legal && Object.keys(legal).some((f) => legal[f] !== null),
      canCall: yourTurn && !!this.currentBid,
      currentBid: this._bidPublic(),
      turnName: turn ? turn.name : null,
      turnSeat: turn ? this.seatOf(turn.id) : null,
      openerName: opener ? opener.name : null,
      openerSeat: opener ? this.seatOf(opener.id) : null,
      rollEndsAt: this.phase === PHASES.ROLL ? this.phaseEndsAt : 0,
      reveal,
      serverNow: Date.now(),
    };
  }
}

module.exports = {
  Game,
  PHASES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MAX_NAME_LEN,
  START_DICE_OPTIONS,
  DEFAULT_START_DICE,
  ROLL_MS,
  BID_ANNOUNCE_MS,
  REVEAL_INTRO_MS,
  REVEAL_STEP_MS,
  VERDICT_GAP_MS,
  VERDICT_HOLD_MS,
  KO_EXTRA_MS,
  minQtyFor,
  countFace,
  dieMatches,
};
