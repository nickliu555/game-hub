'use strict';

const { buildQueue } = require('./puzzles');
const { replay } = require('./solver');

const PHASES = {
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  ROUND: 'ROUND',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const SKIP_LOCKOUT_MS = 20 * 1000;
const DEFAULT_DURATION_MIN = 2;
// Pre-round "Get ready" splash so players aren't yanked straight from the
// lobby into puzzle #1. Mirrors trivia's INTRO phase exactly so players
// hopping between games feel the same pre-round beat.
const INTRO_DURATION_MS = 4000;
const INTRO_GO_HOLD_MS = 1100;

function fisherYates(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pure state machine for the "24" math game.
 *
 * Self-paced per-player puzzle queue. Round runs for a fixed duration; each
 * player gets +1 for every puzzle they solve. Ties are allowed (no
 * tiebreaker). Skipping a puzzle requires the player to have been on it for
 * at least SKIP_LOCKOUT_MS (server-authoritative).
 *
 * The transport layer (./index.js) is responsible for socket events,
 * broadcasting, and the per-player `puzzle:next` emission — this module just
 * exposes intent-based methods and getters.
 */
class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.difficulty = 'any';
    this.durationMs = DEFAULT_DURATION_MIN * 60 * 1000;
    this.roundStartTs = 0;
    this.roundEndsAt = 0;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this._roundTimer = null;
    this._introTimer = null;
    this.introStartTs = 0;
    this.introEndsAt = 0;
    this.onRoundEnd = null; // callback wired by the transport layer
    this.onIntroEnd = null; // callback wired by the transport layer
    // ONE shared, freshly-shuffled puzzle sequence for the active round.
    // Every player advances through this same list at their own pace, so
    // puzzle #N is the same puzzle for everyone (fair scoring).
    this.sharedQueue = [];
  }

  // ---------------- Names / players ----------------

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  nameIsTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  addPlayer({ playerId, name, socketId }) {
    if (!playerId || typeof playerId !== 'string') {
      return { ok: false, reason: 'bad-player-id' };
    }
    if (this.players.has(playerId)) {
      return this.reconnectPlayer({ playerId, socketId });
    }
    // New players can only join while the host hasn't started a round yet.
    // Once a round is in progress (or the final screen is up), the QR/join
    // page locks until reset.
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, reason: 'round-in-progress' };
    }
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) {
      return { ok: false, reason: 'name-taken', name: clean };
    }
    const player = makePlayer(playerId, clean, socketId);
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  reconnectPlayer({ playerId, socketId }) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    p.socketId = socketId;
    p.connected = true;
    return { ok: true, player: p };
  }

  markDisconnected(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) {
        p.connected = false;
        return p;
      }
    }
    return null;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  // ---------------- Round control ----------------

  start({ difficulty, durationMin } = {}) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    if (this.players.size === 0) return { ok: false, reason: 'no-players' };
    const diff = ['easy', 'medium', 'hard', 'any'].includes(difficulty)
      ? difficulty
      : 'any';
    const mins = Number.isFinite(durationMin) && durationMin > 0
      ? durationMin
      : DEFAULT_DURATION_MIN;
    this.difficulty = diff;
    this.durationMs = Math.round(mins * 60 * 1000);
    // Settings are locked in NOW, but the round timer + queue + puzzle
    // serves are deferred until _endIntro() so the "Get ready" countdown
    // is pure leeway and doesn't eat into playable time.
    this._enterIntro();
    return { ok: true };
  }

  _enterIntro() {
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    this.phase = PHASES.INTRO;
    this.introStartTs = Date.now();
    this.introEndsAt = this.introStartTs + INTRO_DURATION_MS;
    // Hold a beat past the visible countdown so clients can show "Go!"
    // before puzzles materialise.
    this._introTimer = setTimeout(() => {
      this._introTimer = null;
      this._endIntro();
    }, INTRO_DURATION_MS + INTRO_GO_HOLD_MS);
  }

  _endIntro() {
    if (this.phase !== PHASES.INTRO) return;
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    this.roundStartTs = Date.now();
    this.roundEndsAt = this.roundStartTs + this.durationMs;
    this.phase = PHASES.ROUND;
    // ONE shared shuffled queue for the whole round so every player faces
    // the same puzzles in the same order. They just advance through it at
    // their own pace.
    this.sharedQueue = buildQueue(this.difficulty);
    // Wipe per-round state on every player and serve them puzzle #1.
    for (const player of this.players.values()) {
      this._initQueue(player);
      this._serveNext(player);
    }
    this._armRoundTimer();
    if (typeof this.onIntroEnd === 'function') {
      try { this.onIntroEnd(); } catch (_) {}
    }
  }

  _armRoundTimer() {
    if (this._roundTimer) clearTimeout(this._roundTimer);
    const ms = Math.max(0, this.roundEndsAt - Date.now());
    this._roundTimer = setTimeout(() => {
      this._roundTimer = null;
      this._endRound();
    }, ms + 50);
  }

  _endRound() {
    if (this.phase !== PHASES.ROUND) return;
    this.phase = PHASES.FINAL;
    if (typeof this.onRoundEnd === 'function') {
      try { this.onRoundEnd(); } catch (_) {}
    }
  }

  _initQueue(player) {
    player.score = 0;
    player.solvedCount = 0;
    player.skippedCount = 0;
    player.cursor = -1;
    player.currentPuzzleId = null;
    player.currentNumbers = null;
    player.currentServedAt = 0;
    player.done = false;
  }

  /**
   * Move this player to the next puzzle in the SHARED queue. If they walk
   * past the end (the pool has 454+ puzzles per difficulty, so reaching
   * this is a real flex) we mark them `done` and return null — they stay
   * locked on a "you solved them all" screen until the round timer fires.
   * Mutates player.* state and returns the public puzzle payload (or null
   * if the round is over or the player has exhausted the queue).
   */
  _serveNext(player) {
    if (this.phase !== PHASES.ROUND) return null;
    player.cursor++;
    if (player.cursor >= this.sharedQueue.length) {
      player.done = true;
      player.cursor = this.sharedQueue.length; // pin so puzzleNumber stays sane
      player.currentPuzzleId = null;
      player.currentNumbers = null;
      player.currentServedAt = 0;
      return null;
    }
    const puzzle = this.sharedQueue[player.cursor];
    // Shuffle the on-screen order of the 4 numbers per player so the same
    // puzzle doesn't look pixel-identical on two adjacent screens. The math
    // is unchanged — it's the same 4 numbers, same target, same difficulty.
    player.currentNumbers = fisherYates(puzzle.numbers.slice());
    player.currentPuzzleId = puzzle.id;
    player.currentServedAt = Date.now();
    return this.getPuzzlePayloadFor(player.id);
  }

  /**
   * Player submitted a sequence of combine steps. We replay the steps with
   * exact rational arithmetic; if the final tile equals 24 they get +1 and
   * advance. If the steps don't reach 24, we tell the client "wrong" so it
   * can show the shake/toast and re-render the puzzle from scratch (the
   * server doesn't change cursor; same puzzle remains current).
   */
  submitSolve({ playerId, puzzleId, steps }) {
    if (this.phase !== PHASES.ROUND) return { ok: false, reason: 'round-over' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (p.currentPuzzleId !== puzzleId) return { ok: false, reason: 'stale-puzzle' };
    const res = replay(p.currentNumbers, steps);
    if (!res.ok) return { ok: false, reason: res.reason };
    if (!res.reached24) {
      // Valid combines, but didn't reach 24. Don't advance; let the client
      // shake + auto-reset. We deliberately do NOT penalize.
      return { ok: true, accepted: false };
    }
    p.score++;
    p.solvedCount++;
    const next = this._serveNext(p);
    return { ok: true, accepted: true, score: p.score, next, done: !!p.done };
  }

  requestSkip({ playerId, puzzleId }) {
    if (this.phase !== PHASES.ROUND) return { ok: false, reason: 'round-over' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (p.currentPuzzleId !== puzzleId) return { ok: false, reason: 'stale-puzzle' };
    const elapsed = Date.now() - p.currentServedAt;
    if (elapsed < SKIP_LOCKOUT_MS) {
      return { ok: false, reason: 'too-early', msRemaining: SKIP_LOCKOUT_MS - elapsed };
    }
    p.skippedCount++;
    const next = this._serveNext(p);
    return { ok: true, next, done: !!p.done };
  }

  // ---------------- Views / serialization ----------------

  getRoundPublic() {
    return {
      phase: this.phase,
      roundEndsAt: this.roundEndsAt,
      serverNow: Date.now(),
      durationMs: this.durationMs,
      difficulty: this.difficulty,
    };
  }

  getIntroPublic() {
    return {
      endsAt: this.introEndsAt,
      serverNow: Date.now(),
      durationMs: INTRO_DURATION_MS,
      difficulty: this.difficulty,
    };
  }

  getLeaderboard(limit) {
    const arr = Array.from(this.players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        solvedCount: p.solvedCount,
        skippedCount: p.skippedCount,
      }))
      // Sort: highest score first, then fewer skips wins the tie.
      .sort((a, b) => (b.score - a.score) || (a.skippedCount - b.skippedCount));
    // Assign competition-style ranks so true ties share a rank (1, 1, 3).
    let prevScore = null;
    let prevSkips = null;
    let prevRank = 0;
    arr.forEach((p, i) => {
      if (p.score === prevScore && p.skippedCount === prevSkips) {
        p.rank = prevRank;
      } else {
        p.rank = i + 1;
        prevScore = p.score;
        prevSkips = p.skippedCount;
        prevRank = p.rank;
      }
    });
    return typeof limit === 'number' ? arr.slice(0, limit) : arr;
  }

  /**
   * Podium = the top scorers, including ties. If 3 people are tied for 1st,
   * the podium has 3 entries all at rank 1 and the silver/bronze slots are
   * empty. Otherwise we take top-3 by rank (ties at any tier are bundled).
   */
  getPodium() {
    const lb = this.getLeaderboard();
    if (lb.length === 0) return [];
    // Group by rank, then take groups until we have at least 3 entries OR
    // we've covered all ranks 1..3.
    const podium = [];
    let i = 0;
    while (i < lb.length && podium.length < 3) {
      const tierRank = lb[i].rank;
      if (tierRank > 3) break;
      while (i < lb.length && lb[i].rank === tierRank) {
        podium.push(lb[i]);
        i++;
      }
    }
    return podium;
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score || 0,
    }));
  }

  getPuzzlePayloadFor(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.currentPuzzleId == null) return null;
    if (!p.currentNumbers) return null;
    return {
      puzzleId: p.currentPuzzleId,
      numbers: p.currentNumbers.slice(),
      servedAt: p.currentServedAt,
      skipEligibleAt: p.currentServedAt + SKIP_LOCKOUT_MS,
      serverNow: Date.now(),
      puzzleNumber: (p.solvedCount + p.skippedCount) + 1, // human-friendly counter
    };
  }

  reset() {
    if (this._roundTimer) { clearTimeout(this._roundTimer); this._roundTimer = null; }
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.difficulty = 'any';
    this.durationMs = DEFAULT_DURATION_MIN * 60 * 1000;
    this.roundStartTs = 0;
    this.roundEndsAt = 0;
    this.introStartTs = 0;
    this.introEndsAt = 0;
    this.sharedQueue = [];
  }
}

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId,
    connected: true,
    joinedAt: Date.now(),
    score: 0,
    solvedCount: 0,
    skippedCount: 0,
    // Per-round cursor into Game.sharedQueue
    cursor: -1,
    currentPuzzleId: null,
    currentNumbers: null,
    currentServedAt: 0,
    // True once this player has walked past the end of the shared queue
    // (i.e. solved/skipped every puzzle in the round). Locks them out of
    // further puzzle serves until the round ends.
    done: false,
  };
}

module.exports = {
  Game,
  PHASES,
  MAX_NAME_LEN,
  SKIP_LOCKOUT_MS,
  DEFAULT_DURATION_MIN,
};
