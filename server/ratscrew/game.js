'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Egyptian Ratscrew — server-authoritative rules engine.
//
// The whole deck is dealt out face down. In turn, players flip the top card
// of their deck onto a shared pile. Slap the pile on a Double, a Sandwich or
// (optionally) a Flush to take it; slap wrongly and you pay 2 cards to the
// player whose card you slapped. A face card (J/Q/K/A) challenges the next player to
// answer with a face card of their own in 1/2/3/4 tries, or the challenger
// takes the pile. Run out of cards and you're out; the last player holding
// cards wins.
//
// Every card stays on the pile for at least PLAY_LOCK_MS before the next can
// be played, so everyone gets a look and a chance to slap. Nobody's deck is
// ever sent to a client — not even its owner's: the decks are face down.
//
// The transport layer (./index.js) owns sockets, broadcasting and the CPU
// timers; this class only calls `onChange` when a timer-driven transition fires.
//
// Roster rule (AGENTS.md): once the game starts nobody is ever skipped,
// auto-played for, or removed. A dropped phone just means the table waits.
// Only the rules of the game itself (no cards left) put a player out.
// ─────────────────────────────────────────────────────────────────────────

const { makeRng, shuffle, buildDeck, rankOf, suitOf } = require('./deck');

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const MAX_NAME_LEN = 20;

// How many tries the next player gets to answer each face card.
const CHANCES = { J: 1, Q: 2, K: 3, A: 4 };

// Every card sits on the pile at least this long before the next one may follow.
const PLAY_LOCK_MS = 2000;
// The host deals the deck out round the table before the first card.
const DEAL_MS = 2600;
// A good slap: the hand lands, the call shows, then the pile slides to the slapper.
const SLAP_CLAIM_MS = 1800;
// A pile won by a challenge waits as long as any card, so it can still be slapped.
const CHALLENGE_CLAIM_MS = PLAY_LOCK_MS;
// After a pile is collected it takes a moment to slide over before its owner leads.
const AFTER_COLLECT_MS = 900;
// Taps closer together than this are one slap — a bounced finger must not burn 4.
const SLAP_COOLDOWN_MS = 600;
// The winner's moment on the table before the final standings.
const END_MS = 5000;

const EVENT_LOG = 40;

/** Which slap the top of the face-up pile makes, or null. */
function slapPattern(pile, opts) {
  const n = pile.length;
  if (n >= 2 && rankOf(pile[n - 1]) === rankOf(pile[n - 2])) return 'double';
  if (n >= 3 && rankOf(pile[n - 1]) === rankOf(pile[n - 3])) return 'sandwich';
  if (opts && opts.flush && n >= 3) {
    const s = suitOf(pile[n - 1]);
    if (suitOf(pile[n - 2]) === s && suitOf(pile[n - 3]) === s) return 'flush';
  }
  return null;
}

function emptyStats() {
  return { played: 0, goodSlaps: 0, badSlaps: 0, burned: 0, piles: 0, cardsWon: 0, peak: 0 };
}

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId: socketId || null,
    isBot: false,
    connected: true,
    order: 0,
    deck: [],          // index 0 is the top card
    out: false,
    place: null,
    outAfter: 0,       // cards played on the table when they went out
    lastSlapAt: 0,
    stats: emptyStats(),
  };
}

class Game {
  constructor(seed) {
    this.rng = makeRng(seed || (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    /** @type {Map<string, object>} */
    this.players = new Map();
    this._orderSeq = 0;
    this.flush = true;
    this.startOffset = 0;
    // Tests flip this to step timers by hand with tick().
    this.manualTimers = false;
    this._timers = {};
    // Monotonic for the whole server life, so a client never mistakes a new event for a replay.
    this._eventSeq = 0;
    this._seq = 0;
    this._resetGameState();
    this.onChange = null;
  }

  _resetGameState() {
    this._clearTimers();
    this._seq++;
    this.phase = PHASES.LOBBY;
    this.pile = [];        // face-up, in play order (last = top)
    this.pileBy = [];      // who played each pile card
    this.pileSeq = 0;      // bumps whenever the face-up pile changes
    this.turnId = null;
    this.challenge = null; // { byId, rank, left, total }
    this.claim = null;     // { byId, reason: 'slap' | 'challenge' | 'runout', pattern, until }
    this.slapOn = null;    // { pileSeq, byId, good }: the first slap on the current top card
    this.nextPlayAt = 0;
    this.events = [];
    this.cardsPlayed = 0;
    this.ending = false;
    this.winnerId = null;
    this.startedAt = 0;
    this.endedAt = 0;
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

  /** Host kick — lobby only. Once the cards are dealt the roster is locked. */
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

  setFlush(value) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (typeof value !== 'boolean') return { ok: false, reason: 'bad-value' };
    this.flush = value;
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

  /** Arm a transition timer that no-ops if the game was reset underneath it. */
  _arm(key, ms, fn) {
    this._disarm(key);
    const seq = this._seq;
    const run = () => {
      this._timers[key] = null;
      if (seq !== this._seq) return;
      fn();
      if (this.onChange) this.onChange();
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

  _event(type, extra) {
    const ev = Object.assign({ seq: ++this._eventSeq, type, at: Date.now() }, extra || {});
    this.events.push(ev);
    if (this.events.length > EVENT_LOG) this.events.splice(0, this.events.length - EVENT_LOG);
    return ev;
  }

  // ─────────────────── Helpers ───────────────────

  alive() { return this.seatOrder().filter((p) => !p.out); }

  /** First player clockwise after `id` who still has cards to play. */
  _nextWithCards(id) {
    const order = this.seatOrder();
    const n = order.length;
    const i = order.findIndex((p) => p.id === id);
    for (let k = 1; k <= n; k++) {
      const q = order[(i + k + n) % n];
      if (!q.out && q.deck.length > 0) return q.id;
    }
    return null;
  }

  /** A player on 0 cards stays in while the pile may still come to them. */
  _protected(id) {
    return !!((this.challenge && this.challenge.byId === id) || (this.claim && this.claim.byId === id));
  }

  _trackPeak(p) {
    if (p.deck.length > p.stats.peak) p.stats.peak = p.deck.length;
  }

  pileCount() { return this.pile.length; }

  currentPattern() { return slapPattern(this.pile, { flush: this.flush }); }

  /** The first slap on the card now on top, if anyone has slapped it. */
  slappedNow() {
    return this.slapOn && this.slapOn.pileSeq === this.pileSeq ? this.slapOn : null;
  }

  /** Slaps count right now: one per card — after the first, good or bad, the next card reopens them. */
  slapOpen() {
    return this.phase === PHASES.PLAYING && !this.ending && this.pile.length > 0 &&
      !(this.claim && this.claim.reason === 'slap') && !this.slappedNow();
  }

  // ─────────────────── Game lifecycle ───────────────────

  start() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    const order = this.seatOrder();
    const n = order.length;
    for (const p of order) {
      p.deck = [];
      p.out = false;
      p.place = null;
      p.outAfter = 0;
      p.lastSlapAt = 0;
      p.stats = emptyStats();
    }
    // Deal one at a time from the opener round the table, so the opener (and the
    // seats after them) take the odd cards.
    const starter = this.startOffset % n;
    this.startOffset++;
    shuffle(buildDeck(), this.rng).forEach((card, i) => { order[(starter + i) % n].deck.push(card); });
    order.forEach((p) => this._trackPeak(p));

    this._seq++;
    this.phase = PHASES.PLAYING;
    this.pile = [];
    this.pileBy = [];
    this.pileSeq++;
    this.challenge = null;
    this.claim = null;
    this.slapOn = null;
    this.ending = false;
    this.winnerId = null;
    this.cardsPlayed = 0;
    this.turnId = order[starter].id;
    this.startedAt = Date.now();
    this.endedAt = 0;
    this.nextPlayAt = this.startedAt + DEAL_MS;
    this._event('deal', { starterId: this.turnId });
    return { ok: true };
  }

  /** Play again from the final standings: same seats, same settings, a fresh deal. */
  rematch() {
    if (this.phase !== PHASES.FINAL) return { ok: false, reason: 'not-final' };
    if (this.players.size < MIN_PLAYERS) return { ok: false, reason: 'cannot-start' };
    this._resetGameState();
    return this.start();
  }

  reset() {
    this.players.clear();
    this._orderSeq = 0;
    this.startOffset = 0;
    this.flush = true;
    this._resetGameState();
  }

  // ─────────────────── Moves ───────────────────

  /** Flip the top card of `playerId`'s deck onto the pile. */
  play(playerId) {
    if (this.phase !== PHASES.PLAYING) return { ok: false, reason: 'not-playing' };
    if (this.ending) return { ok: false, reason: 'game-over' };
    const p = this.players.get(playerId);
    if (!p || p.out) return { ok: false, reason: 'out' };
    if (this.claim) return { ok: false, reason: 'pile-claimed' };
    if (this.turnId !== playerId) return { ok: false, reason: 'not-your-turn' };
    const now = Date.now();
    if (now < this.nextPlayAt) return { ok: false, reason: 'too-soon', retryInMs: this.nextPlayAt - now };
    if (!p.deck.length) return { ok: false, reason: 'no-cards' };

    const card = p.deck.shift();
    this.pile.push(card);
    this.pileBy.push(playerId);
    this.pileSeq++;
    this.cardsPlayed++;
    p.stats.played++;
    this.nextPlayAt = now + PLAY_LOCK_MS;

    const rank = rankOf(card);
    const chances = CHANCES[rank];
    const ev = { playerId, card, count: p.deck.length };
    if (chances) {
      this.challenge = { byId: playerId, rank, left: chances, total: chances };
      this.turnId = this._nextWithCards(playerId);
      ev.challenge = { rank, total: chances };
      this._event('play', ev);
    } else if (this.challenge) {
      this.challenge.left--;
      ev.left = this.challenge.left;
      this._event('play', ev);
      if (this.challenge.left <= 0) this._claim(this.challenge.byId, 'challenge');
    } else {
      this.turnId = this._nextWithCards(playerId);
      this._event('play', ev);
    }
    this._checkOuts();
    return { ok: true, card };
  }

  /**
   * Slap the pile. Good → the slapper takes it; bad → they pay 2 cards to whoever
   * played the card they slapped (their own card → the next player along).
   * Only the first slap on each card counts: any later one, from anyone, is simply
   * too late (no penalty) until the next card is played.
   */
  slap(playerId) {
    if (this.phase !== PHASES.PLAYING) return { ok: false, reason: 'not-playing' };
    if (this.ending) return { ok: false, reason: 'game-over' };
    const p = this.players.get(playerId);
    if (!p || p.out) return { ok: false, reason: 'out' };
    if (!p.deck.length) return { ok: false, reason: 'no-cards' };
    if (!this.pile.length) return { ok: false, reason: 'empty' };
    const first = this.slappedNow();
    if (first) return { ok: true, result: 'late', byId: first.byId, good: first.good };
    if (this.claim && this.claim.reason === 'slap') {
      return { ok: true, result: 'late', byId: this.claim.byId, good: true };
    }
    const now = Date.now();
    if (now - p.lastSlapAt < SLAP_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
    p.lastSlapAt = now;

    const pattern = this.currentPattern();
    this.slapOn = { pileSeq: this.pileSeq, byId: playerId, good: !!pattern };
    if (pattern) {
      p.stats.goodSlaps++;
      const count = this.pileCount();
      this._event('slap', { playerId, pattern, count });
      this._claim(playerId, 'slap', pattern);
      return { ok: true, result: 'good', pattern, count };
    }

    const to = this.players.get(this._burnReceiver(playerId));
    const n = Math.min(2, p.deck.length);
    const cards = p.deck.splice(0, n);
    to.deck.push(...cards);
    this._trackPeak(to);
    p.stats.badSlaps++;
    p.stats.burned += n;
    this._event('burn', { playerId, burned: n, count: p.deck.length, toId: to.id, toCount: to.deck.length });
    this._checkOuts();
    return { ok: true, result: 'bad', burned: n, toId: to.id };
  }

  /**
   * Who a bad slap pays: whoever played the slapped card — unless that's the slapper
   * or they're out, then the next player along who is still in.
   */
  _burnReceiver(slapperId) {
    const ownerId = this.pileBy[this.pileBy.length - 1];
    const owner = ownerId && this.players.get(ownerId);
    if (owner && ownerId !== slapperId && !owner.out) return ownerId;
    const order = this.seatOrder();
    const n = order.length;
    const i = order.findIndex((q) => q.id === slapperId);
    for (let k = 1; k < n; k++) {
      const q = order[(i + k) % n];
      if (!q.out) return q.id;
    }
    return slapperId;
  }

  /** The pile is spoken for: it goes to `byId` once the claim's window closes. */
  _claim(byId, reason, pattern) {
    const ms = reason === 'slap' ? SLAP_CLAIM_MS : CHALLENGE_CLAIM_MS;
    const now = Date.now();
    this.claim = { byId, reason, pattern: pattern || null, until: now + ms };
    this.challenge = null;
    this.turnId = null;
    this._event('claim', { playerId: byId, reason, pattern: pattern || null, until: now + ms });
    this._arm('claim', ms, () => this._collect());
  }

  _collect() {
    const c = this.claim;
    if (!c) return;
    const w = this.players.get(c.byId);
    const cards = this.pile.slice();
    w.deck.push(...cards);
    w.stats.piles++;
    w.stats.cardsWon += cards.length;
    this._trackPeak(w);
    this.pile = [];
    this.pileBy = [];
    this.pileSeq++;
    this.claim = null;
    this.challenge = null;
    this.turnId = w.id;
    this.nextPlayAt = Date.now() + AFTER_COLLECT_MS;
    this._event('collect', { playerId: w.id, count: cards.length, reason: c.reason, total: w.deck.length });
    this._checkOuts();
  }

  /** Anyone on 0 cards whom the pile can't come back to is out. */
  _checkOuts() {
    if (this.ending) return;
    for (const p of this.seatOrder()) {
      if (p.out || p.deck.length > 0 || this._protected(p.id)) continue;
      p.place = this.alive().length;
      p.out = true;
      p.outAfter = this.cardsPlayed;
      this._event('out', { playerId: p.id, place: p.place });
      if (this.turnId === p.id) {
        // Out of cards mid-challenge: the challenge is lost, as if the tries ran out.
        if (this.challenge) this._claim(this.challenge.byId, 'runout');
        else this.turnId = this._nextWithCards(p.id);
      }
    }
    if (this.alive().length <= 1) this._finish();
  }

  _finish() {
    if (this.ending) return;
    this.ending = true;
    this._disarm('claim');
    const left = this.alive();
    const w = left[0] || null;
    this.challenge = null;
    this.claim = null;
    this.turnId = null;
    if (w) {
      w.place = 1;
      this.winnerId = w.id;
      const cards = this.pile.slice();
      if (cards.length) {
        w.deck.push(...cards);
        w.stats.cardsWon += cards.length;
        this._trackPeak(w);
        this.pile = [];
        this.pileBy = [];
        this.pileSeq++;
        this._event('collect', { playerId: w.id, count: cards.length, reason: 'win', total: w.deck.length });
      }
      this._event('win', { playerId: w.id });
    }
    this.endedAt = Date.now();
    this._arm('end', END_MS, () => { this.phase = PHASES.FINAL; });
  }

  // ─────────────────── CPU hooks ───────────────────

  /** The CPU on turn and when it may play, or null. */
  botTurn() {
    if (this.phase !== PHASES.PLAYING || this.ending || this.claim) return null;
    const p = this.turnId ? this.players.get(this.turnId) : null;
    if (!p || !p.isBot) return null;
    return { id: p.id, at: this.nextPlayAt };
  }

  /** CPUs that could slap right now. */
  botSlappers() {
    return this.seatOrder().filter((p) => p.isBot && !p.out && p.deck.length > 0);
  }

  // ─────────────────── Public snapshots ───────────────────

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
      flush: this.flush,
    };
  }

  _statsPublic() {
    return this.seatOrder().map((p, i) => Object.assign({
      playerId: p.id,
      name: p.name,
      seat: i + 1,
      isBot: !!p.isBot,
      count: p.deck.length,
      out: p.out,
      place: p.place,
      outAfter: p.outAfter,
    }, p.stats));
  }

  getTablePublic() {
    const turn = this.turnId ? this.players.get(this.turnId) : null;
    return {
      phase: this.phase,
      flush: this.flush,
      seats: this.seatOrder().map((p, i) => ({
        playerId: p.id,
        name: p.name,
        seat: i + 1,
        isBot: !!p.isBot,
        connected: p.isBot ? true : !!p.connected,
        count: p.deck.length,
        out: p.out,
        place: p.place,
      })),
      turnPlayerId: turn ? turn.id : null,
      waitingOn: turn && !turn.isBot && !turn.connected ? turn.name : null,
      pile: this.pile.slice(-3),
      pileCount: this.pileCount(),
      pileSeq: this.pileSeq,
      challenge: this.challenge ? Object.assign({}, this.challenge) : null,
      slapped: this.slappedNow() ? { byId: this.slapOn.byId, good: this.slapOn.good } : null,
      claim: this.claim ? Object.assign({}, this.claim) : null,
      nextPlayAt: this.nextPlayAt,
      playLockMs: PLAY_LOCK_MS,
      cardsPlayed: this.cardsPlayed,
      ending: this.ending,
      winnerId: this.winnerId,
      aliveCount: this.alive().length,
      events: this.events.map((e) => Object.assign({}, e)),
      serverNow: Date.now(),
    };
  }

  getFinalPublic() {
    const stats = this._statsPublic().sort((a, b) => (a.place || 99) - (b.place || 99) || a.name.localeCompare(b.name));
    const w = this.winnerId ? this.players.get(this.winnerId) : null;
    return {
      standings: stats,
      winnerId: this.winnerId,
      winnerName: w ? w.name : null,
      cardsPlayed: this.cardsPlayed,
      durationMs: Math.max(0, (this.endedAt || Date.now()) - this.startedAt),
      flush: this.flush,
    };
  }
}

module.exports = {
  Game,
  PHASES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MAX_NAME_LEN,
  CHANCES,
  PLAY_LOCK_MS,
  DEAL_MS,
  SLAP_CLAIM_MS,
  CHALLENGE_CLAIM_MS,
  AFTER_COLLECT_MS,
  SLAP_COOLDOWN_MS,
  END_MS,
  slapPattern,
};
