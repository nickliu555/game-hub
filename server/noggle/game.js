'use strict';

const {
  VALID_SIZES,
  MIN_WORD_LEN,
  DEFAULT_TIME_SEC,
  MIN_TIME_SEC,
  MAX_TIME_SEC,
  generateBoard,
} = require('./dice');
const { validatePath } = require('./board');
const { isWord, boardStats, solveBoardWords } = require('./dictionary');
const { pointsForWord } = require('./scoring');

const PHASES = {
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  ROUND: 'ROUND',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const DEFAULT_SIZE = 4;

// Pre-round "Get ready" splash so players aren't yanked straight from the
// lobby onto the board. Mirrors trivia / 24 INTRO timing exactly so players
// hopping between games feel the same pre-round beat.
const INTRO_DURATION_MS = 4000;
const INTRO_GO_HOLD_MS = 1100;

/**
 * Pure state machine for Boggle.
 *
 * One shared NxN board is generated per round (authentic dice shake) and shown
 * identically to the host (spectator) and every player. Players trace connected
 * words (8 directions); each valid, in-dictionary word they haven't already
 * found scores by the official length curve. Everyone keeps their own words —
 * duplicates across players are NOT cancelled. Room-wide scores stay hidden
 * until FINAL; during play the host sees only per-player word COUNTS.
 *
 * The transport layer (./index.js) owns socket events + broadcasting — this
 * module exposes intent-based methods and getters.
 */
class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.boardSize = DEFAULT_SIZE;
    this.minLen = MIN_WORD_LEN[DEFAULT_SIZE];
    this.durationMs = DEFAULT_TIME_SEC[DEFAULT_SIZE] * 1000;
    this.board = null; // string[][] once ROUND starts
    this.roundStartTs = 0;
    this.roundEndsAt = 0;
    this.introStartTs = 0;
    this.introEndsAt = 0;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this._roundTimer = null;
    this._introTimer = null;
    this.onRoundEnd = null; // wired by transport
    this.onIntroEnd = null; // wired by transport
    // Cached board solver stats, computed once when the round ends.
    this._finalStats = null;
    // Cached full solved word list, computed lazily on the host's reveal.
    this._solvedWords = null;
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
    // New players can only join while the host hasn't started yet. Once a
    // round is in progress (or the final screen is up), the join page locks
    // until the host resets — same behaviour as the other games.
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

  start({ boardSize, timeLimitSec } = {}) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    if (this.players.size === 0) return { ok: false, reason: 'no-players' };
    const size = VALID_SIZES.includes(Number(boardSize)) ? Number(boardSize) : DEFAULT_SIZE;
    this.boardSize = size;
    this.minLen = MIN_WORD_LEN[size];
    const secs = Number.isFinite(timeLimitSec)
      ? Math.min(MAX_TIME_SEC, Math.max(MIN_TIME_SEC, Math.round(timeLimitSec)))
      : DEFAULT_TIME_SEC[size];
    this.durationMs = secs * 1000;
    // Board + round timer are deferred to _endIntro() so the "Get ready"
    // countdown is pure leeway and doesn't eat into playable time.
    this._enterIntro();
    return { ok: true };
  }

  _enterIntro() {
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    this.phase = PHASES.INTRO;
    this.introStartTs = Date.now();
    this.introEndsAt = this.introStartTs + INTRO_DURATION_MS;
    this._introTimer = setTimeout(() => {
      this._introTimer = null;
      this._endIntro();
    }, INTRO_DURATION_MS + INTRO_GO_HOLD_MS);
  }

  _endIntro() {
    if (this.phase !== PHASES.INTRO) return;
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    // Shake the tray: ONE board for the whole room this round.
    this.board = generateBoard(this.boardSize);
    this._finalStats = null;
    this._solvedWords = null;
    for (const player of this.players.values()) {
      this._resetPlayerRound(player);
    }
    this.roundStartTs = Date.now();
    this.roundEndsAt = this.roundStartTs + this.durationMs;
    this.phase = PHASES.ROUND;
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

  _resetPlayerRound(player) {
    player.score = 0;
    player.wordCount = 0;
    player.foundWords = [];
    player.foundSet = new Set();
    player.lastScoreAt = 0;
  }

  /**
   * Player submitted a traced path. We re-derive the word from the board
   * (never trusting a client-sent word), enforce adjacency / no-reuse / length,
   * check the dictionary, and reject words the player already found. On success
   * the word's points are added to their private running score.
   *
   * @returns {{ ok:false, reason:string } | { ok:true, accepted:boolean, reason?:string, word?:string, points?:number, score:number, wordCount:number }}
   */
  submitWord({ playerId, path }) {
    if (this.phase !== PHASES.ROUND) return { ok: false, reason: 'round-over' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };

    const res = validatePath(this.board, path);
    if (!res.ok) return { ok: false, reason: res.reason };

    const reject = (reason) => ({
      ok: true, accepted: false, reason,
      word: res.word, score: p.score, wordCount: p.wordCount,
    });

    if (res.letterLen < this.minLen) return reject('too-short');
    const key = res.word.toLowerCase();
    if (p.foundSet.has(key)) return reject('already-found');
    if (!isWord(res.word)) return reject('not-a-word');

    const points = pointsForWord(res.letterLen);
    p.foundSet.add(key);
    p.foundWords.push({ word: res.word, points });
    p.wordCount++;
    p.score += points;
    p.lastScoreAt = Date.now();
    return {
      ok: true, accepted: true,
      word: res.word, points, score: p.score, wordCount: p.wordCount,
    };
  }

  // ---------------- Public payloads ----------------

  getBoardPublic() {
    return {
      size: this.boardSize,
      grid: this.board ? this.board.map((row) => row.slice()) : null,
      minLen: this.minLen,
    };
  }

  getRoundPublic() {
    return {
      phase: this.phase,
      roundEndsAt: this.roundEndsAt,
      serverNow: Date.now(),
      durationMs: this.durationMs,
      board: this.getBoardPublic(),
    };
  }

  getIntroPublic() {
    return {
      endsAt: this.introEndsAt,
      serverNow: Date.now(),
      durationMs: INTRO_DURATION_MS,
      boardSize: this.boardSize,
    };
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
    }));
  }

  /** Per-player live scores for the host during play (shown on the host projection). */
  getWordCounts() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      wordCount: p.wordCount || 0,
      connected: p.connected,
    }));
  }

  getLeaderboard(limit) {
    const arr = Array.from(this.players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score || 0,
        wordCount: p.wordCount || 0,
        lastScoreAt: p.lastScoreAt || 0,
        // Player's longest word (by letter length; Qu counts as 2). Ties go to
        // the earliest-submitted word since foundWords is in submission order
        // and we only replace on a strictly longer word. Null if none found.
        longestWord: longestFoundWord(p),
      }))
      // Highest score first; ties broken by whoever reached that score first
      // (lastScoreAt ascending), then by more words found.
      .sort((a, b) =>
        (b.score - a.score)
        || (a.lastScoreAt - b.lastScoreAt)
        || (b.wordCount - a.wordCount)
      );
    let prevScore = null;
    let prevRank = 0;
    arr.forEach((p, i) => {
      if (p.score === prevScore) {
        p.rank = prevRank;
      } else {
        p.rank = i + 1;
        prevScore = p.score;
        prevRank = p.rank;
      }
    });
    return typeof limit === 'number' ? arr.slice(0, limit) : arr;
  }

  /** Top scorers including ties (same shape as trivia/24). */
  getPodium() {
    const lb = this.getLeaderboard();
    if (lb.length === 0) return [];
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

  /**
   * Board solver stats for the host's FINAL screen (best possible word +
   * total findable words + max score). Computed once and cached, since the
   * board is frozen at round end.
   */
  getFinalStats() {
    if (!this.board) return { totalWords: 0, maxScore: 0, bestWord: '', bestPoints: 0 };
    if (!this._finalStats) {
      this._finalStats = boardStats(this.board, this.minLen);
    }
    return this._finalStats;
  }

  /**
   * Full solved word list (word -> points) for the frozen board, used by the
   * host's "See all words" reveal on the FINAL screen. Computed once and cached
   * since the board doesn't change after the round ends.
   */
  getSolvedWords() {
    if (!this.board) return { words: {}, totalWords: 0, maxScore: 0 };
    if (!this._solvedWords) {
      this._solvedWords = solveBoardWords(this.board, this.minLen);
    }
    return this._solvedWords;
  }

  /** Private end-of-round recap for one player: their own words + score + rank. */
  getPersonalFinal(playerId) {
    const p = this.players.get(playerId);
    if (!p) return { words: [], score: 0, wordCount: 0, rank: null };
    const lb = this.getLeaderboard();
    const me = lb.find((x) => x.id === playerId);
    // Sort a copy of the player's words by points desc, then alphabetically.
    const words = (p.foundWords || [])
      .slice()
      .sort((a, b) => (b.points - a.points) || a.word.localeCompare(b.word));
    return {
      words,
      score: p.score || 0,
      wordCount: p.wordCount || 0,
      rank: me ? me.rank : null,
      total: this.players.size,
    };
  }

  reset() {
    if (this._roundTimer) { clearTimeout(this._roundTimer); this._roundTimer = null; }
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.boardSize = DEFAULT_SIZE;
    this.minLen = MIN_WORD_LEN[DEFAULT_SIZE];
    this.durationMs = DEFAULT_TIME_SEC[DEFAULT_SIZE] * 1000;
    this.board = null;
    this.roundStartTs = 0;
    this.roundEndsAt = 0;
    this.introStartTs = 0;
    this.introEndsAt = 0;
    this._finalStats = null;
    this._solvedWords = null;
  }
}

/**
 * The player's longest found word (by letter length, Qu = 2). foundWords is in
 * submission order and we only replace on a strictly longer word, so ties are
 * resolved in favour of the earliest-submitted word. Returns null if the player
 * found no words.
 */
function longestFoundWord(p) {
  const words = (p && p.foundWords) || [];
  let longest = null;
  for (const w of words) {
    if (longest === null || w.word.length > longest.length) longest = w.word;
  }
  return longest;
}

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId,
    connected: true,
    joinedAt: Date.now(),
    score: 0,
    wordCount: 0,
    // Per-round list of { word, points } this player found.
    foundWords: [],
    // Lowercased word keys for O(1) duplicate rejection.
    foundSet: new Set(),
    // Timestamp of the player's most recent scoring word (leaderboard tiebreak).
    lastScoreAt: 0,
  };
}

module.exports = {
  Game,
  PHASES,
  MAX_NAME_LEN,
  INTRO_DURATION_MS,
};
