'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hearts — server-authoritative state machine.
//
// Everything that matters is decided here: the deal, what each player is
// allowed to play, who takes a trick, and how a hand scores. Phones only ever
// receive their OWN hand (see getPrivateHand — the one accessor that exposes
// cards) and a `legal` list they may not exceed; the host screen never sees a
// hand at all.
//
// The transport layer (./index.js) owns sockets, broadcasting and the CPU
// think-timers; this class only calls the `on*` hooks when time-based
// transitions fire.
//
// Roster rule (AGENTS.md): once the game starts nobody is ever skipped,
// auto-played for, or removed. A dropped phone just means the table waits.
// ─────────────────────────────────────────────────────────────────────────

const {
  QUEEN_OF_SPADES,
  JACK_OF_DIAMONDS,
  TWO_OF_CLUBS,
  HEARTS_TOTAL,
  JACK_POINTS,
  suitOf,
  isHeart,
  pointsOf,
  makeRng,
  deal,
  sortHand,
  legalPlays,
  trickWinnerIndex,
} = require('./deck');

const PHASES = {
  LOBBY: 'LOBBY',
  DEAL: 'DEAL',
  PASS: 'PASS',
  EXCHANGE: 'EXCHANGE',
  TRICK: 'TRICK',
  TRICK_END: 'TRICK_END',
  HAND_END: 'HAND_END',
  FINAL: 'FINAL',
};

const SEATS = ['N', 'E', 'S', 'W'];
const PLAYER_COUNT = 4;
const TRICKS_PER_HAND = 13;
const MAX_NAME_LEN = 20;

// Pass rotation, by hand index. The 4th hand is a "hold" hand — no passing.
const PASS_DIRECTIONS = ['left', 'right', 'across', 'hold'];
// Seats run N → E → S → W, so a +1 offset is one seat clockwise round the table;
// "left"/"right" are only the internal keys because they read as the player's own
// left and right, which nobody can agree on.
const PASS_LABEL = { left: 'Clockwise', right: 'Counter-clockwise', across: 'Across', hold: 'Hold' };
const PASS_ARROW = { left: '↻', right: '↺', across: '↑', hold: '—' };
// Seat offset applied to the passer's index to find the receiver.
const PASS_OFFSET = { left: 1, right: 3, across: 2, hold: 0 };

const TARGET_SCORES = [50, 75, 100];
const DEFAULT_TARGET = 100;

const DEAL_DURATION_MS = 2600;
// Long enough to actually read the three cards you were handed.
const EXCHANGE_DURATION_MS = 7000;
const TRICK_END_DURATION_MS = 3000;
const AUTO_ADVANCE_MS = 12000;

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId: socketId || null,
    isBot: false,
    connected: true,
    order: 0,
    joinedAt: Date.now(),
    total: 0,          // running score across the whole game
    handPoints: 0,     // points taken in the current hand
    lastDelta: 0,      // what the last completed hand cost them
    hand: [],
    taken: [],         // cards captured in won tricks this hand
    pass: [],          // the 3 cards they selected to pass
    received: [],      // the 3 cards they got back, for the EXCHANGE highlight
    receivedFrom: null, // { name, seat } of whoever sent them
    passed: false,
  };
}

class Game {
  constructor(seed) {
    this.rng = makeRng(seed || (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    /** @type {Map<string, object>} */
    this.players = new Map();
    this._orderSeq = 0;

    this.targetScore = DEFAULT_TARGET;
    this.botDifficulty = 'normal';
    this.autoAdvance = false;

    this._resetGameState();

    // Time-based transitions. The transport layer supplies these.
    this.onDealEnd = null;
    this.onExchangeEnd = null;
    this.onTrickEnd = null;
    this.onAutoAdvance = null;
  }

  _resetGameState() {
    this.phase = PHASES.LOBBY;
    this.handIndex = 0;            // 0-based; drives the pass direction
    this.trickNumber = 0;          // 1..13 within the current hand
    this.trick = [];               // [{ playerId, card }] in play order
    this.turnIndex = 0;            // index into seatOrder()
    this.heartsBroken = false;
    this.lastTrick = null;         // { cards, winnerId, points } during TRICK_END
    this.lastHand = null;          // per-player deltas during HAND_END
    this.moonShooterId = null;
    this.winnerIds = [];
    this.phaseEndsAt = 0;
    this._timers = {};
    this._seq = 0;                 // bumped on every transition; invalidates stale timers
  }

  // ─────────────────── Roster ───────────────────

  capacity() { return PLAYER_COUNT; }
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
    if (this.players.size >= PLAYER_COUNT) return { ok: false, reason: 'game-full' };
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const player = makePlayer(playerId, clean, socketId);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  /** Fill an empty seat with a CPU so fewer than 4 humans can still play. */
  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= PLAYER_COUNT) return { ok: false, reason: 'game-full' };
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

  /** Host kick — lobby only. Once a hand is dealt the roster is locked. */
  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    this._renumber();
    return p;
  }

  _renumber() {
    this.seatOrder().forEach((p, i) => { p.order = i; });
  }

  /** Roster in seat order: index 0 = North, then clockwise E, S, W. */
  seatOrder() {
    return Array.from(this.players.values()).sort((a, b) => a.order - b.order);
  }

  seatOf(playerId) {
    const order = this.seatOrder();
    const i = order.findIndex((p) => p.id === playerId);
    return i < 0 ? null : SEATS[i];
  }

  /** Drag-and-drop seat assignment from the host lobby. */
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

  // ─────────────────── Lobby config ───────────────────

  setTargetScore(value) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const n = Math.round(Number(value));
    if (TARGET_SCORES.indexOf(n) < 0) return { ok: false, reason: 'bad-target' };
    this.targetScore = n;
    return { ok: true };
  }

  setBotDifficulty(level) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (['easy', 'normal', 'hard'].indexOf(level) < 0) return { ok: false, reason: 'bad-difficulty' };
    this.botDifficulty = level;
    return { ok: true };
  }

  setAutoAdvance(on) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    this.autoAdvance = !!on;
    return { ok: true };
  }

  canStart() {
    return this.phase === PHASES.LOBBY && this.players.size === PLAYER_COUNT;
  }

  // ─────────────────── Timers ───────────────────

  _clearTimers() {
    for (const key of Object.keys(this._timers)) {
      if (this._timers[key]) clearTimeout(this._timers[key]);
      this._timers[key] = null;
    }
  }

  /** Arm a transition timer that no-ops if the phase moved on underneath it. */
  _arm(key, ms, fn) {
    if (this._timers[key]) clearTimeout(this._timers[key]);
    const seq = this._seq;
    this._timers[key] = setTimeout(() => {
      this._timers[key] = null;
      if (seq !== this._seq) return;
      fn();
    }, ms);
    if (this._timers[key].unref) this._timers[key].unref();
  }

  // ─────────────────── Hand lifecycle ───────────────────

  start() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    for (const p of this.players.values()) {
      p.total = 0;
      p.lastDelta = 0;
    }
    this.handIndex = 0;
    this.winnerIds = [];
    this._enterDeal();
    return { ok: true };
  }

  passDirection() { return PASS_DIRECTIONS[this.handIndex % PASS_DIRECTIONS.length]; }

  _enterDeal() {
    this._seq++;
    this._clearTimers();
    this.phase = PHASES.DEAL;
    this.trick = [];
    this.trickNumber = 0;
    this.heartsBroken = false;
    this.moonShooterId = null;
    this.lastTrick = null;
    this.lastHand = null;

    const hands = deal(this.rng);
    this.seatOrder().forEach((p, i) => {
      p.hand = hands[i];
      p.taken = [];
      p.handPoints = 0;
      p.pass = [];
      p.received = [];
      p.receivedFrom = null;
      p.passed = false;
    });

    this.phaseEndsAt = Date.now() + DEAL_DURATION_MS;
    this._arm('deal', DEAL_DURATION_MS, () => {
      if (this.phase !== PHASES.DEAL) return;
      if (this.passDirection() === 'hold') this._enterTrick();
      else this._enterPass();
      if (this.onDealEnd) this.onDealEnd();
    });
  }

  _enterPass() {
    this._seq++;
    this.phase = PHASES.PASS;
    this.phaseEndsAt = 0;
  }

  /**
   * Lock in a player's 3 cards. The exchange only happens once all four are in,
   * so nobody can infer anything from the order people passed.
   */
  submitPass({ playerId, cards }) {
    if (this.phase !== PHASES.PASS) return { ok: false, reason: 'not-passing' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (p.passed) return { ok: false, reason: 'already-passed' };
    if (!Array.isArray(cards) || cards.length !== 3) return { ok: false, reason: 'need-three' };
    const unique = new Set(cards);
    if (unique.size !== 3) return { ok: false, reason: 'duplicate-card' };
    for (const c of cards) if (p.hand.indexOf(c) < 0) return { ok: false, reason: 'not-in-hand' };

    p.pass = cards.slice();
    p.passed = true;

    if (this.passedCount() === PLAYER_COUNT) this._enterExchange();
    return { ok: true };
  }

  passedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.passed) n++;
    return n;
  }

  _enterExchange() {
    this._seq++;
    this.phase = PHASES.EXCHANGE;

    const order = this.seatOrder();
    const offset = PASS_OFFSET[this.passDirection()];
    const outgoing = order.map((p) => p.pass.slice());
    order.forEach((p, i) => {
      for (const c of outgoing[i]) p.hand.splice(p.hand.indexOf(c), 1);
    });
    order.forEach((p, i) => {
      const from = (i - offset + PLAYER_COUNT) % PLAYER_COUNT;
      p.received = outgoing[from].slice();
      p.receivedFrom = { name: order[from].name, seat: SEATS[from] };
      p.hand = sortHand(p.hand.concat(p.received));
    });

    this.phaseEndsAt = Date.now() + EXCHANGE_DURATION_MS;
    this._arm('exchange', EXCHANGE_DURATION_MS, () => {
      if (this.phase !== PHASES.EXCHANGE) return;
      this._enterTrick();
      if (this.onExchangeEnd) this.onExchangeEnd();
    });
  }

  _enterTrick() {
    this._seq++;
    this.phase = PHASES.TRICK;
    this.phaseEndsAt = 0;
    this.trick = [];
    this.trickNumber += 1;
    if (this.trickNumber === 1) {
      const order = this.seatOrder();
      this.turnIndex = order.findIndex((p) => p.hand.indexOf(TWO_OF_CLUBS) >= 0);
      if (this.turnIndex < 0) this.turnIndex = 0;
    }
  }

  currentPlayer() {
    const order = this.seatOrder();
    return order[this.turnIndex % order.length] || null;
  }

  isFirstTrick() { return this.trickNumber === 1; }

  legalFor(playerId) {
    const p = this.players.get(playerId);
    if (!p) return [];
    if (this.phase !== PHASES.TRICK) return [];
    const current = this.currentPlayer();
    if (!current || current.id !== playerId) return [];
    return legalPlays({
      hand: p.hand,
      trick: this.trick.map((t) => t.card),
      heartsBroken: this.heartsBroken,
      isFirstTrick: this.isFirstTrick(),
    });
  }

  playCard({ playerId, card }) {
    if (this.phase !== PHASES.TRICK) return { ok: false, reason: 'not-playing' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const current = this.currentPlayer();
    if (!current || current.id !== playerId) return { ok: false, reason: 'not-your-turn' };
    if (typeof card !== 'string' || p.hand.indexOf(card) < 0) return { ok: false, reason: 'not-in-hand' };
    if (this.legalFor(playerId).indexOf(card) < 0) return { ok: false, reason: 'illegal-card' };

    p.hand.splice(p.hand.indexOf(card), 1);
    this.trick.push({ playerId, card });

    const brokeHearts = isHeart(card) && !this.heartsBroken;
    if (brokeHearts) this.heartsBroken = true;

    if (this.trick.length === PLAYER_COUNT) this._endTrick();
    else this.turnIndex = (this.turnIndex + 1) % PLAYER_COUNT;
    return { ok: true, card, brokeHearts };
  }

  _endTrick() {
    this._seq++;
    this.phase = PHASES.TRICK_END;

    const cards = this.trick.map((t) => t.card);
    const winnerIdx = trickWinnerIndex(cards);
    const winner = this.players.get(this.trick[winnerIdx].playerId);
    let points = 0;
    for (const c of cards) {
      winner.taken.push(c);
      points += pointsOf(c);
    }
    winner.handPoints += points;

    this.lastTrick = {
      number: this.trickNumber,
      cards: this.trick.map((t) => ({ playerId: t.playerId, card: t.card })),
      winnerId: winner.id,
      winnerName: winner.name,
      points,
    };
    // The winner leads the next trick.
    this.turnIndex = this.seatOrder().findIndex((p) => p.id === winner.id);

    this.phaseEndsAt = Date.now() + TRICK_END_DURATION_MS;
    this._arm('trickEnd', TRICK_END_DURATION_MS, () => {
      if (this.phase !== PHASES.TRICK_END) return;
      if (this.trickNumber >= TRICKS_PER_HAND) this._enterHandEnd();
      else this._enterTrick();
      if (this.onTrickEnd) this.onTrickEnd();
    });
  }

  /**
   * Score the hand.
   *  • hearts (1 each) + Q♠ (13) always total 26;
   *  • shooting the moon (all 13 hearts AND the Queen) zeroes the shooter's
   *    share and gives every other player the full 26;
   *  • J♦ is −10 for whoever captured it, independent of the moon.
   */
  _scoreHand() {
    const order = this.seatOrder();
    const shooter = order.find((p) => {
      let hearts = 0;
      let queen = false;
      for (const c of p.taken) {
        if (isHeart(c)) hearts++;
        else if (c === QUEEN_OF_SPADES) queen = true;
      }
      return hearts === 13 && queen;
    }) || null;

    this.moonShooterId = shooter ? shooter.id : null;

    const rows = order.map((p) => {
      let base;
      if (shooter) base = p.id === shooter.id ? 0 : HEARTS_TOTAL;
      else {
        base = 0;
        for (const c of p.taken) if (isHeart(c) || c === QUEEN_OF_SPADES) base += pointsOf(c);
      }
      const jack = p.taken.indexOf(JACK_OF_DIAMONDS) >= 0 ? JACK_POINTS : 0;
      const delta = base + jack;
      p.lastDelta = delta;
      p.total += delta;
      return {
        playerId: p.id,
        name: p.name,
        seat: SEATS[order.indexOf(p)],
        hearts: p.taken.filter(isHeart).length,
        queen: p.taken.indexOf(QUEEN_OF_SPADES) >= 0,
        jack: jack !== 0,
        delta,
        total: p.total,
        shotMoon: !!shooter && p.id === shooter.id,
      };
    });
    return rows;
  }

  _enterHandEnd() {
    this._seq++;
    this.phase = PHASES.HAND_END;
    this.trick = [];

    const rows = this._scoreHand();
    const gameOver = rows.some((r) => r.total >= this.targetScore);
    this.lastHand = {
      handNumber: this.handIndex + 1,
      rows,
      moonShooterId: this.moonShooterId,
      gameOver,
    };

    if (gameOver) {
      this.phaseEndsAt = 0;
      return;
    }
    if (this.autoAdvance) {
      this.phaseEndsAt = Date.now() + AUTO_ADVANCE_MS;
      this._arm('autoAdvance', AUTO_ADVANCE_MS, () => {
        if (this.phase !== PHASES.HAND_END) return;
        this.nextHand();
        if (this.onAutoAdvance) this.onAutoAdvance();
      });
    } else {
      this.phaseEndsAt = 0;
    }
  }

  /** Host "Next hand" (or the auto-advance timer). */
  nextHand() {
    if (this.phase !== PHASES.HAND_END) return { ok: false, reason: 'not-hand-end' };
    if (this.lastHand && this.lastHand.gameOver) {
      this._enterFinal();
      return { ok: true, phase: this.phase };
    }
    this.handIndex += 1;
    this._enterDeal();
    return { ok: true, phase: this.phase };
  }

  _enterFinal() {
    this._seq++;
    this._clearTimers();
    this.phase = PHASES.FINAL;
    this.phaseEndsAt = 0;
    const totals = this.seatOrder().map((p) => p.total);
    const best = Math.min.apply(null, totals);
    this.winnerIds = this.seatOrder().filter((p) => p.total === best).map((p) => p.id);
  }

  /**
   * Which CPUs owe the table an action right now. The transport polls this
   * after every state change and re-arms its think-timers, so a timer can
   * never survive the turn it was armed for.
   */
  pendingBots() {
    if (this.phase === PHASES.PASS) {
      const players = this.seatOrder().filter((p) => p.isBot && !p.passed);
      return players.length ? { phase: PHASES.PASS, players } : null;
    }
    if (this.phase === PHASES.TRICK) {
      const current = this.currentPlayer();
      if (current && current.isBot) return { phase: PHASES.TRICK, players: [current] };
    }
    return null;
  }

  /** Cards visible to everyone this hand — the bots' "memory". */
  seenCards() {
    const seen = [];
    for (const p of this.players.values()) for (const c of p.taken) seen.push(c);
    for (const t of this.trick) seen.push(t.card);
    return seen;
  }

  reset() {
    this._clearTimers();
    this.players.clear();
    this._orderSeq = 0;
    this._resetGameState();
    this.targetScore = DEFAULT_TARGET;
    this.botDifficulty = 'normal';
    this.autoAdvance = false;
  }

  // ─────────────────── Public snapshots (never contain a hand) ───────────────────

  getLobbyPublic() {
    const order = this.seatOrder();
    return {
      phase: this.phase,
      players: order.map((p, i) => ({
        id: p.id,
        name: p.name,
        seat: SEATS[i],
        isBot: !!p.isBot,
        connected: p.isBot ? true : !!p.connected,
      })),
      total: order.length,
      capacity: PLAYER_COUNT,
      canStart: this.canStart(),
      targetScore: this.targetScore,
      botDifficulty: this.botDifficulty,
      autoAdvance: this.autoAdvance,
    };
  }

  _seatsPublic() {
    return this.seatOrder().map((p, i) => ({
      playerId: p.id,
      name: p.name,
      seat: SEATS[i],
      isBot: !!p.isBot,
      connected: p.isBot ? true : !!p.connected,
      handPoints: p.handPoints,
      total: p.total,
      cardsLeft: p.hand.length,
    }));
  }

  _handMeta() {
    const dir = this.passDirection();
    return {
      handNumber: this.handIndex + 1,
      passDirection: dir,
      passLabel: PASS_LABEL[dir],
      passArrow: PASS_ARROW[dir],
      targetScore: this.targetScore,
      seats: this._seatsPublic(),
      serverNow: Date.now(),
    };
  }

  getDealPublic() {
    return Object.assign(this._handMeta(), { endsAt: this.phaseEndsAt });
  }

  /** Progress only — never which cards anybody chose. */
  getPassPublic() {
    const meta = this._handMeta();
    const order = this.seatOrder();
    meta.seats.forEach((s, i) => { s.hasPassed = !!order[i].passed; });
    return Object.assign(meta, {
      passed: this.passedCount(),
      total: PLAYER_COUNT,
      waiting: order.filter((p) => !p.passed).map((p) => p.name),
    });
  }

  getExchangePublic() {
    return Object.assign(this._handMeta(), { endsAt: this.phaseEndsAt });
  }

  getTablePublic() {
    const current = this.currentPlayer();
    const waitingOn = current && !current.isBot && !current.connected ? current.name : null;
    return Object.assign(this._handMeta(), {
      trickNumber: Math.max(1, this.trickNumber),
      tricksPerHand: TRICKS_PER_HAND,
      trick: this.trick.map((t) => ({ playerId: t.playerId, card: t.card })),
      leadSuit: this.trick.length ? suitOf(this.trick[0].card) : null,
      turnPlayerId: current ? current.id : null,
      turnIsBot: !!(current && current.isBot),
      waitingOn,
      heartsBroken: this.heartsBroken,
    });
  }

  getTrickEndPublic() {
    return Object.assign(this.getTablePublic(), {
      result: this.lastTrick,
      endsAt: this.phaseEndsAt,
      lastTrickOfHand: this.trickNumber >= TRICKS_PER_HAND,
    });
  }

  getHandEndPublic() {
    const h = this.lastHand || { handNumber: this.handIndex + 1, rows: [], gameOver: false };
    return Object.assign(this._handMeta(), {
      handNumber: h.handNumber,
      rows: h.rows,
      moonShooterId: h.moonShooterId || null,
      moonShooterName: h.moonShooterId ? (this.players.get(h.moonShooterId) || {}).name : null,
      gameOver: h.gameOver,
      autoAdvance: this.autoAdvance && !h.gameOver,
      endsAt: this.phaseEndsAt,
    });
  }

  getFinalPublic() {
    const order = this.seatOrder();
    const standings = order
      .map((p, i) => ({ playerId: p.id, name: p.name, seat: SEATS[i], total: p.total, isBot: !!p.isBot }))
      .sort((a, b) => a.total - b.total || a.name.localeCompare(b.name));
    let rank = 0;
    let prev = null;
    standings.forEach((s, i) => {
      if (prev === null || s.total !== prev) { rank = i + 1; prev = s.total; }
      s.rank = rank;
    });
    return {
      standings,
      winnerIds: this.winnerIds.slice(),
      winnerNames: this.winnerIds.map((id) => (this.players.get(id) || {}).name).filter(Boolean),
      targetScore: this.targetScore,
      handsPlayed: this.handIndex + 1,
    };
  }

  // ─────────────────── Private snapshot ───────────────────

  /**
   * THE ONLY accessor that exposes cards. Must be delivered to a single socket
   * — never broadcast, and never sent to the host screen.
   */
  getPrivateHand(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const isTurn = this.phase === PHASES.TRICK && this.currentPlayer() === p;
    const cur = this.phase === PHASES.TRICK ? this.currentPlayer() : null;
    return {
      phase: this.phase,
      hand: p.hand.slice(),
      legal: isTurn ? this.legalFor(playerId) : [],
      yourTurn: isTurn,
      turnName: cur ? cur.name : null,
      turnSeat: cur ? SEATS[this.seatOrder().indexOf(cur)] || null : null,
      reason: isTurn ? this._legalReason(p) : null,
      passDirection: this.passDirection(),
      passLabel: PASS_LABEL[this.passDirection()],
      passArrow: PASS_ARROW[this.passDirection()],
      passTo: this._passTargetFor(p),
      passed: p.passed,
      myPass: p.pass.slice(),
      received: p.received.slice(),
      receivedFrom: p.receivedFrom ? Object.assign({}, p.receivedFrom) : null,
      handPoints: p.handPoints,
      total: p.total,
      heartsBroken: this.heartsBroken,
      trickNumber: Math.max(1, this.trickNumber),
      handNumber: this.handIndex + 1,
      targetScore: this.targetScore,
    };
  }

  /** Who this player's three cards go to — null on a hold hand. */
  _passTargetFor(p) {
    const offset = PASS_OFFSET[this.passDirection()];
    const order = this.seatOrder();
    const i = order.indexOf(p);
    if (!offset || i < 0) return null;
    const to = (i + offset) % PLAYER_COUNT;
    return { name: order[to].name, seat: SEATS[to] };
  }

  /** One short line explaining why some cards are greyed out. */
  _legalReason(p) {
    const legal = this.legalFor(p.id);
    if (legal.length >= p.hand.length) return null;
    if (this.trick.length === 0) {
      if (this.isFirstTrick()) return 'The 2♣ always leads the first trick.';
      return 'Hearts have not been broken yet.';
    }
    const suit = suitOf(this.trick[0].card);
    const SYM = { C: '♣', D: '♦', H: '♥', S: '♠' };
    return 'You must follow ' + SYM[suit] + '.';
  }
}

module.exports = {
  Game,
  PHASES,
  SEATS,
  PLAYER_COUNT,
  TRICKS_PER_HAND,
  TARGET_SCORES,
  DEFAULT_TARGET,
  PASS_DIRECTIONS,
  PASS_LABEL,
  PASS_ARROW,
  PASS_OFFSET,
  DEAL_DURATION_MS,
  EXCHANGE_DURATION_MS,
  TRICK_END_DURATION_MS,
  AUTO_ADVANCE_MS,
  MAX_NAME_LEN,
};
