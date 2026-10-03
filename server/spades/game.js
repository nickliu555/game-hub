'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Spades — server-authoritative state machine.
//
// Everything that matters is decided here: the teams, the deal, the bidding
// order, what each player may play, who takes a trick and how a hand scores.
// Phones only ever receive their OWN hand (see getPrivateHand — the one
// accessor that exposes cards), and only once they have chosen to look at it
// (a hand stays face down until then so Blind Nil is a real choice). The host
// screen never sees a hand at all.
//
// The transport layer (./index.js) owns sockets, broadcasting and the CPU
// think-timers; this class only calls the `on*` hooks when time-based
// transitions fire.
//
// Roster rule (AGENTS.md): once the game starts nobody is ever skipped,
// auto-played for, or removed. A dropped phone just means the table waits.
// ─────────────────────────────────────────────────────────────────────────

const {
  suitOf,
  isSpade,
  makeRng,
  deal,
  legalPlays,
  trickWinnerIndex,
  scoreTeam,
} = require('./deck');

const PHASES = {
  LOBBY: 'LOBBY',
  DEAL: 'DEAL',
  BID: 'BID',
  TRICK: 'TRICK',
  TRICK_END: 'TRICK_END',
  HAND_END: 'HAND_END',
  FINAL: 'FINAL',
};

// Partners sit across from each other: Red holds North/South, Blue East/West.
const SEATS = ['N', 'E', 'S', 'W'];
const TEAMS = ['red', 'blue'];
const TEAM_SEATS = { red: ['N', 'S'], blue: ['E', 'W'] };
const TEAM_LABEL = { red: 'Red', blue: 'Blue' };
const PLAYER_COUNT = 4;
const PER_TEAM = 2;
const TRICKS_PER_HAND = 13;
const MAX_BID = 13;
const MAX_NAME_LEN = 20;

const TARGET_SCORES = [200, 300, 400, 500];
const DEFAULT_TARGET = 500;
// A team that sinks this low loses on the spot.
const LOSING_SCORE = -200;

const DEAL_DURATION_MS = 2600;
const TRICK_END_DURATION_MS = 3000;
const AUTO_ADVANCE_MS = 20000;

function otherTeam(team) { return team === 'red' ? 'blue' : 'red'; }

function makePlayer(id, name, socketId, team) {
  return {
    id,
    name,
    socketId: socketId || null,
    isBot: false,
    connected: true,
    team: team === 'blue' ? 'blue' : 'red',
    order: 0,          // position within the team: 0 → N/E, 1 → S/W
    joinedAt: Date.now(),
    hand: [],
    revealed: false,   // has looked at this hand (forfeits Blind Nil)
    bid: null,         // null until they bid; 0 means nil
    nil: false,
    blind: false,
    tricks: 0,
    voids: {},         // suits they have publicly shown they cannot follow
  };
}

class Game {
  constructor(seed) {
    this.rng = makeRng(seed || (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    /** @type {Map<string, object>} */
    this.players = new Map();
    this._orderSeq = 0;

    this.targetScore = DEFAULT_TARGET;
    this.autoAdvance = true;

    this._resetGameState();

    // Time-based transitions. The transport layer supplies these.
    this.onDealEnd = null;
    this.onTrickEnd = null;
    this.onAutoAdvance = null;
  }

  _resetGameState() {
    this.phase = PHASES.LOBBY;
    this.handIndex = 0;
    this.firstDealer = 0;
    this.trickNumber = 0;          // 1..13 within the current hand
    this.trick = [];               // [{ playerId, card }] in play order
    this.turnIndex = 0;            // index into seatOrder() while playing
    this.bidTurn = 0;              // index into seatOrder() while bidding
    this.spadesBroken = false;
    this.played = [];              // every card played this hand, for the CPUs
    this.lastTrick = null;
    this.lastHand = null;
    this.teams = { red: { score: 0, bags: 0 }, blue: { score: 0, bags: 0 } };
    this.winnerTeam = null;
    this.endReason = null;
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

  teamMembers(team) {
    return Array.from(this.players.values())
      .filter((p) => p.team === team)
      .sort((a, b) => a.order - b.order);
  }

  teamCount(team) { return this.teamMembers(team).length; }

  /** The team a newcomer lands on: the emptier one, Red on a tie. */
  _openTeam(preferred) {
    if (preferred && TEAMS.indexOf(preferred) >= 0 && this.teamCount(preferred) < PER_TEAM) return preferred;
    const red = this.teamCount('red');
    const blue = this.teamCount('blue');
    const team = red <= blue ? 'red' : 'blue';
    return this.teamCount(team) < PER_TEAM ? team : null;
  }

  _appendToTeam(p, team) {
    p.team = team;
    const members = this.teamMembers(team).filter((q) => q.id !== p.id);
    p.order = members.length ? members[members.length - 1].order + 1 : 0;
    this._renumber(team);
  }

  _renumber(team) {
    this.teamMembers(team).forEach((p, i) => { p.order = i; });
  }

  addPlayer({ playerId, name, socketId }) {
    if (!playerId || typeof playerId !== 'string') return { ok: false, reason: 'bad-player-id' };
    if (this.players.has(playerId)) return this.reconnectPlayer({ playerId, socketId });
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'game-in-progress' };
    if (this.players.size >= PLAYER_COUNT) return { ok: false, reason: 'game-full' };
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const team = this._openTeam();
    if (!team) return { ok: false, reason: 'game-full' };
    const player = makePlayer(playerId, clean, socketId, team);
    this.players.set(playerId, player);
    this._appendToTeam(player, team);
    return { ok: true, player };
  }

  /** Fill an open seat with a CPU — on the requested team when it has room. */
  addBot(team) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= PLAYER_COUNT) return { ok: false, reason: 'game-full' };
    if (team && TEAMS.indexOf(team) >= 0 && this.teamCount(team) >= PER_TEAM) {
      return { ok: false, reason: 'team-full' };
    }
    const chosen = this._openTeam(team);
    if (!chosen) return { ok: false, reason: 'game-full' };
    let n = 1;
    while (this.players.has('bot-' + n)) n++;
    let name = 'CPU';
    if (this.nameIsTaken(name)) { let k = 2; while (this.nameIsTaken('CPU ' + k)) k++; name = 'CPU ' + k; }
    const bot = makePlayer('bot-' + n, name, null, chosen);
    bot.isBot = true;
    this.players.set(bot.id, bot);
    this._appendToTeam(bot, chosen);
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
    this._renumber(p.team);
    return p;
  }

  /**
   * Drag-and-drop from the host lobby: move a player to `team`, landing just
   * before `beforeId` (or at the end). A team holds at most two, so dropping
   * onto a full team swaps places with whoever was dropped on — or that team's
   * last player when the drop wasn't onto anyone.
   */
  assignTeam(playerId, team, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (TEAMS.indexOf(team) < 0) return { ok: false, reason: 'bad-team' };

    const from = p.team;
    if (from !== team && this.teamCount(team) >= PER_TEAM) {
      const members = this.teamMembers(team);
      const target = members.find((q) => q.id === beforeId) || members[members.length - 1];
      // Swap seats outright, so each lands exactly where the other was.
      const pOrder = p.order;
      p.team = team; p.order = target.order;
      target.team = from; target.order = pOrder;
      this._renumber(team);
      this._renumber(from);
      return { ok: true, swappedWith: target.id };
    }

    const list = this.teamMembers(team).filter((q) => q.id !== playerId);
    let idx = beforeId ? list.findIndex((q) => q.id === beforeId) : -1;
    if (idx < 0) idx = list.length;
    list.splice(idx, 0, p);
    p.team = team;
    list.forEach((q, i) => { q.order = i; });
    if (from !== team) this._renumber(from);
    return { ok: true };
  }

  /** Seat letter for a player, from their team and place within it. */
  seatOf(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const i = this.teamMembers(p.team).indexOf(p);
    return i < 0 ? null : TEAM_SEATS[p.team][i] || null;
  }

  /**
   * The four players in seat order — index 0 = North, then clockwise E, S, W.
   * Only complete once the table is full; in the lobby a missing seat is
   * simply skipped.
   */
  seatOrder() {
    const red = this.teamMembers('red');
    const blue = this.teamMembers('blue');
    return [red[0], blue[0], red[1], blue[1]].filter(Boolean);
  }

  partnerOf(p) {
    return this.teamMembers(p.team).find((q) => q.id !== p.id) || null;
  }

  // ─────────────────── Lobby config ───────────────────

  setTargetScore(value) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const n = Math.round(Number(value));
    if (TARGET_SCORES.indexOf(n) < 0) return { ok: false, reason: 'bad-target' };
    this.targetScore = n;
    return { ok: true };
  }

  setAutoAdvance(on) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    this.autoAdvance = !!on;
    return { ok: true };
  }

  canStart() {
    return this.phase === PHASES.LOBBY
      && this.teamCount('red') === PER_TEAM
      && this.teamCount('blue') === PER_TEAM;
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
    this.teams = { red: { score: 0, bags: 0 }, blue: { score: 0, bags: 0 } };
    this.handIndex = 0;
    this.firstDealer = Math.floor(this.rng() * PLAYER_COUNT);
    this.winnerTeam = null;
    this.endReason = null;
    this._enterDeal();
    return { ok: true };
  }

  /** The deal passes one seat clockwise every hand. */
  dealerIndex() { return (this.firstDealer + this.handIndex) % PLAYER_COUNT; }

  _enterDeal() {
    this._seq++;
    this._clearTimers();
    this.phase = PHASES.DEAL;
    this.trick = [];
    this.trickNumber = 0;
    this.spadesBroken = false;
    this.played = [];
    this.lastTrick = null;
    this.lastHand = null;

    const hands = deal(this.rng);
    this.seatOrder().forEach((p, i) => {
      p.hand = hands[i];
      p.voids = {};
      p.tricks = 0;
      p.bid = null;
      p.nil = false;
      p.blind = false;
      // A CPU never needs the option of a blind bid kept open.
      p.revealed = !!p.isBot;
    });

    this.phaseEndsAt = Date.now() + DEAL_DURATION_MS;
    this._arm('deal', DEAL_DURATION_MS, () => {
      if (this.phase !== PHASES.DEAL) return;
      this._enterBid();
      if (this.onDealEnd) this.onDealEnd();
    });
  }

  _enterBid() {
    this._seq++;
    this.phase = PHASES.BID;
    this.phaseEndsAt = 0;
    // The player on the dealer's left bids first.
    this.bidTurn = (this.dealerIndex() + 1) % PLAYER_COUNT;
  }

  currentBidder() {
    if (this.phase !== PHASES.BID) return null;
    return this.seatOrder()[this.bidTurn] || null;
  }

  bidsIn() {
    let n = 0;
    for (const p of this.players.values()) if (p.bid !== null) n++;
    return n;
  }

  /** Turn a phone's hand face up. Forfeits the option of bidding Blind Nil. */
  reveal(playerId) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (this.phase === PHASES.LOBBY || this.phase === PHASES.FINAL) return { ok: false, reason: 'no-hand' };
    if (p.revealed) return { ok: true, already: true };
    p.revealed = true;
    return { ok: true };
  }

  /**
   * Lock in a bid. `bid` is 0–13 where 0 is Nil; `blind` asks for Blind Nil,
   * which is only on the table while the hand is still face down.
   */
  submitBid({ playerId, bid, blind }) {
    if (this.phase !== PHASES.BID) return { ok: false, reason: 'not-bidding' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const current = this.currentBidder();
    if (!current || current.id !== playerId) return { ok: false, reason: 'not-your-turn' };
    if (p.bid !== null) return { ok: false, reason: 'already-bid' };

    if (blind) {
      if (p.revealed && !p.isBot) return { ok: false, reason: 'already-looked' };
      p.bid = 0; p.nil = true; p.blind = true;
    } else {
      const n = Number(bid);
      if (!Number.isInteger(n) || n < 0 || n > MAX_BID) return { ok: false, reason: 'bad-bid' };
      if (!p.revealed) return { ok: false, reason: 'not-looked' };
      p.bid = n; p.nil = n === 0; p.blind = false;
    }
    p.revealed = true;

    if (this.bidsIn() === PLAYER_COUNT) this._enterTrick();
    else this.bidTurn = (this.bidTurn + 1) % PLAYER_COUNT;
    return { ok: true, bid: p.bid, nil: p.nil, blind: p.blind };
  }

  _enterTrick() {
    this._seq++;
    this.phase = PHASES.TRICK;
    this.phaseEndsAt = 0;
    this.trick = [];
    this.trickNumber += 1;
    if (this.trickNumber === 1) {
      for (const p of this.players.values()) p.revealed = true;
      // The player on the dealer's left leads the first trick too.
      this.turnIndex = (this.dealerIndex() + 1) % PLAYER_COUNT;
    }
  }

  currentPlayer() {
    const order = this.seatOrder();
    return order[this.turnIndex % order.length] || null;
  }

  legalFor(playerId) {
    const p = this.players.get(playerId);
    if (!p) return [];
    if (this.phase !== PHASES.TRICK) return [];
    const current = this.currentPlayer();
    if (!current || current.id !== playerId) return [];
    return legalPlays({
      hand: p.hand,
      trick: this.trick.map((t) => t.card),
      spadesBroken: this.spadesBroken,
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
    this.played.push(card);
    // Failing to follow is public at the table, so it is fair game for the CPUs.
    const led = suitOf(this.trick[0].card);
    if (this.trick.length > 1 && suitOf(card) !== led) p.voids[led] = true;

    const brokeSpades = isSpade(card) && !this.spadesBroken;
    if (brokeSpades) this.spadesBroken = true;

    if (this.trick.length === PLAYER_COUNT) this._endTrick();
    else this.turnIndex = (this.turnIndex + 1) % PLAYER_COUNT;
    return { ok: true, card, brokeSpades };
  }

  _endTrick() {
    this._seq++;
    this.phase = PHASES.TRICK_END;

    const cards = this.trick.map((t) => t.card);
    const winnerIdx = trickWinnerIndex(cards);
    const winner = this.players.get(this.trick[winnerIdx].playerId);
    winner.tricks += 1;

    this.lastTrick = {
      number: this.trickNumber,
      cards: this.trick.map((t) => ({ playerId: t.playerId, card: t.card })),
      winnerId: winner.id,
      winnerName: winner.name,
      winnerTeam: winner.team,
      // A nil bidder taking a trick is the moment the table will want to see.
      bustedNil: winner.nil && winner.tricks === 1,
    };
    this.turnIndex = this.seatOrder().findIndex((p) => p.id === winner.id);

    this.phaseEndsAt = Date.now() + TRICK_END_DURATION_MS;
    this._arm('trickEnd', TRICK_END_DURATION_MS, () => {
      if (this.phase !== PHASES.TRICK_END) return;
      if (this.trickNumber >= TRICKS_PER_HAND) this._enterHandEnd();
      else this._enterTrick();
      if (this.onTrickEnd) this.onTrickEnd();
    });
  }

  _scoreHand() {
    const rows = {};
    for (const team of TEAMS) {
      const members = this.teamMembers(team);
      const res = scoreTeam({
        players: members.map((p) => ({ bid: p.bid || 0, nil: p.nil, blind: p.blind, tricks: p.tricks })),
        bags: this.teams[team].bags,
      });
      this.teams[team].score += res.delta;
      this.teams[team].bags = res.bags;
      rows[team] = Object.assign(res, {
        team,
        label: TEAM_LABEL[team],
        total: this.teams[team].score,
        players: members.map((p, i) => ({
          playerId: p.id,
          name: p.name,
          seat: TEAM_SEATS[team][i],
          isBot: !!p.isBot,
          bid: p.bid,
          nil: p.nil,
          blind: p.blind,
          tricks: p.tricks,
          nilMade: p.nil ? res.nils[i].made : null,
          nilPoints: res.nils[i].points,
        })),
      });
    }
    return rows;
  }

  /** The winner, or null when nobody has finished it (or the finish is a dead heat). */
  _decideWinner() {
    const red = this.teams.red.score;
    const blue = this.teams.blue.score;
    const sunk = red <= LOSING_SCORE || blue <= LOSING_SCORE;
    const reached = red >= this.targetScore || blue >= this.targetScore;
    if (!sunk && !reached) return null;
    // An exact tie at the line plays on — someone has to come out ahead.
    if (red === blue) return null;
    return {
      team: red > blue ? 'red' : 'blue',
      reason: reached ? 'target' : 'floor',
    };
  }

  _enterHandEnd() {
    this._seq++;
    this.phase = PHASES.HAND_END;
    this.trick = [];

    const rows = this._scoreHand();
    const result = this._decideWinner();
    this.lastHand = {
      handNumber: this.handIndex + 1,
      teams: rows,
      gameOver: !!result,
      winnerTeam: result ? result.team : null,
      reason: result ? result.reason : null,
    };

    if (result) {
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
    this.winnerTeam = this.lastHand ? this.lastHand.winnerTeam : null;
    this.endReason = this.lastHand ? this.lastHand.reason : null;
  }

  /**
   * Which CPU owes the table an action right now. The transport polls this
   * after every state change and re-arms its think-timers, so a timer can
   * never survive the turn it was armed for.
   */
  pendingBots() {
    if (this.phase === PHASES.BID) {
      const b = this.currentBidder();
      if (b && b.isBot) return { phase: PHASES.BID, players: [b] };
    }
    if (this.phase === PHASES.TRICK) {
      const current = this.currentPlayer();
      if (current && current.isBot) return { phase: PHASES.TRICK, players: [current] };
    }
    return null;
  }

  /**
   * Everything a CPU is allowed to know: its own cards plus the public record
   * of the hand — the bids, the tricks taken, what has been played and who has
   * shown out of which suit.
   */
  botView(playerId) {
    const order = this.seatOrder();
    const seatIndex = order.findIndex((p) => p.id === playerId);
    if (seatIndex < 0) return null;
    const p = order[seatIndex];
    return {
      seatIndex,
      hand: p.hand.slice(),
      legal: this.legalFor(playerId),
      trick: this.trick.map((t) => t.card),
      trickLeadSeat: this.trick.length
        ? order.findIndex((o) => o.id === this.trick[0].playerId)
        : seatIndex,
      spadesBroken: this.spadesBroken,
      trickNumber: this.trickNumber,
      played: this.played.slice(),
      seats: order.map((o) => ({
        bid: o.bid,
        nil: o.nil,
        blind: o.blind,
        tricks: o.tricks,
        team: o.team,
        voids: Object.assign({}, o.voids),
      })),
      score: {
        mine: this.teams[p.team].score,
        theirs: this.teams[otherTeam(p.team)].score,
        bags: this.teams[p.team].bags,
      },
      targetScore: this.targetScore,
    };
  }

  reset() {
    this._clearTimers();
    this.players.clear();
    this._orderSeq = 0;
    this._resetGameState();
    this.targetScore = DEFAULT_TARGET;
    this.autoAdvance = true;
  }

  // ─────────────────── Public snapshots (never contain a hand) ───────────────────

  _lobbyPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      team: p.team,
      seat: this.seatOf(p.id),
      isBot: !!p.isBot,
      connected: p.isBot ? true : !!p.connected,
    };
  }

  getLobbyPublic() {
    const red = this.teamMembers('red').map((p) => this._lobbyPlayer(p));
    const blue = this.teamMembers('blue').map((p) => this._lobbyPlayer(p));
    return {
      phase: this.phase,
      teams: { red, blue },
      players: red.concat(blue),
      total: this.players.size,
      capacity: PLAYER_COUNT,
      perTeam: PER_TEAM,
      canStart: this.canStart(),
      targetScore: this.targetScore,
      autoAdvance: this.autoAdvance,
    };
  }

  _seatsPublic() {
    return this.seatOrder().map((p, i) => ({
      playerId: p.id,
      name: p.name,
      seat: SEATS[i],
      team: p.team,
      isBot: !!p.isBot,
      connected: p.isBot ? true : !!p.connected,
      bid: p.bid,
      nil: p.nil,
      blind: p.blind,
      tricks: p.tricks,
      cardsLeft: p.hand.length,
    }));
  }

  _teamsPublic() {
    const out = {};
    for (const team of TEAMS) {
      const members = this.teamMembers(team);
      let bid = 0;
      let tricks = 0;
      let allBid = true;
      for (const p of members) {
        if (p.bid === null) allBid = false;
        else if (!p.nil) bid += p.bid;
        tricks += p.tricks;
      }
      out[team] = {
        team,
        label: TEAM_LABEL[team],
        score: this.teams[team].score,
        bags: this.teams[team].bags,
        bid,
        allBid,
        tricks,
        names: members.map((p) => p.name),
      };
    }
    return out;
  }

  _handMeta() {
    return {
      handNumber: this.handIndex + 1,
      targetScore: this.targetScore,
      losingScore: LOSING_SCORE,
      seats: this._seatsPublic(),
      teams: this._teamsPublic(),
      serverNow: Date.now(),
    };
  }

  getDealPublic() {
    return Object.assign(this._handMeta(), { endsAt: this.phaseEndsAt });
  }

  getBidPublic() {
    const b = this.currentBidder();
    return Object.assign(this._handMeta(), {
      bidTurnPlayerId: b ? b.id : null,
      bidTurnIsBot: !!(b && b.isBot),
      waitingOn: b && !b.isBot && !b.connected ? b.name : null,
      bidsIn: this.bidsIn(),
      total: PLAYER_COUNT,
    });
  }

  getTablePublic() {
    const current = this.phase === PHASES.TRICK ? this.currentPlayer() : null;
    const waitingOn = current && !current.isBot && !current.connected ? current.name : null;
    return Object.assign(this._handMeta(), {
      trickNumber: Math.max(1, this.trickNumber),
      tricksPerHand: TRICKS_PER_HAND,
      trick: this.trick.map((t) => ({ playerId: t.playerId, card: t.card })),
      leadSuit: this.trick.length ? suitOf(this.trick[0].card) : null,
      turnPlayerId: current ? current.id : null,
      turnIsBot: !!(current && current.isBot),
      waitingOn,
      spadesBroken: this.spadesBroken,
      lastTrick: this.lastTrick,
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
    const h = this.lastHand || { handNumber: this.handIndex + 1, teams: null, gameOver: false };
    return Object.assign(this._handMeta(), {
      handNumber: h.handNumber,
      results: h.teams,
      gameOver: h.gameOver,
      winnerTeam: h.winnerTeam || null,
      reason: h.reason || null,
      autoAdvance: this.autoAdvance && !h.gameOver,
      endsAt: this.phaseEndsAt,
    });
  }

  getFinalPublic() {
    const standings = TEAMS.map((team) => ({
      team,
      label: TEAM_LABEL[team],
      score: this.teams[team].score,
      bags: this.teams[team].bags,
      players: this.teamMembers(team).map((p, i) => ({
        playerId: p.id,
        name: p.name,
        seat: TEAM_SEATS[team][i],
        isBot: !!p.isBot,
      })),
    })).sort((a, b) => b.score - a.score);
    const winners = this.winnerTeam ? this.teamMembers(this.winnerTeam) : [];
    return {
      standings,
      winnerTeam: this.winnerTeam,
      winnerLabel: this.winnerTeam ? TEAM_LABEL[this.winnerTeam] : null,
      winnerIds: winners.map((p) => p.id),
      winnerNames: winners.map((p) => p.name),
      reason: this.endReason,
      targetScore: this.targetScore,
      losingScore: LOSING_SCORE,
      handsPlayed: this.handIndex + 1,
    };
  }

  // ─────────────────── Private snapshot ───────────────────

  /**
   * THE ONLY accessor that exposes cards. Must be delivered to a single socket
   * — never broadcast, and never sent to the host screen. A hand that is still
   * face down is withheld, so the phone genuinely can't peek before choosing
   * whether to bid Blind Nil.
   */
  getPrivateHand(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const order = this.seatOrder();
    const isTurn = this.phase === PHASES.TRICK && this.currentPlayer() === p;
    const cur = this.phase === PHASES.TRICK ? this.currentPlayer() : null;
    const bidder = this.currentBidder();
    const isBidTurn = !!bidder && bidder.id === p.id;
    const partner = this.partnerOf(p);
    const teams = this._teamsPublic();
    const mine = teams[p.team];
    const theirs = teams[otherTeam(p.team)];
    return {
      phase: this.phase,
      team: p.team,
      seat: this.seatOf(p.id),
      partner: partner ? { name: partner.name, seat: this.seatOf(partner.id) } : null,
      revealed: p.revealed,
      hand: p.revealed ? p.hand.slice() : [],
      cardCount: p.hand.length,
      legal: isTurn ? this.legalFor(playerId) : [],
      yourTurn: isTurn,
      turnName: cur ? cur.name : null,
      turnSeat: cur ? SEATS[order.indexOf(cur)] || null : null,
      yourBidTurn: isBidTurn,
      canBlindNil: isBidTurn && !p.revealed,
      bidTurnName: bidder ? bidder.name : null,
      bidTurnSeat: bidder ? SEATS[order.indexOf(bidder)] || null : null,
      bid: p.bid,
      nil: p.nil,
      blind: p.blind,
      tricks: p.tricks,
      seats: this._seatsPublic(),
      teamBid: mine.bid,
      teamTricks: mine.tricks,
      teamScore: mine.score,
      teamBags: mine.bags,
      oppScore: theirs.score,
      spadesBroken: this.spadesBroken,
      trickNumber: Math.max(1, this.trickNumber),
      handNumber: this.handIndex + 1,
      targetScore: this.targetScore,
    };
  }
}

module.exports = {
  Game,
  PHASES,
  SEATS,
  TEAMS,
  TEAM_SEATS,
  TEAM_LABEL,
  PLAYER_COUNT,
  PER_TEAM,
  TRICKS_PER_HAND,
  MAX_BID,
  TARGET_SCORES,
  DEFAULT_TARGET,
  LOSING_SCORE,
  DEAL_DURATION_MS,
  TRICK_END_DURATION_MS,
  AUTO_ADVANCE_MS,
  MAX_NAME_LEN,
  otherTeam,
};
