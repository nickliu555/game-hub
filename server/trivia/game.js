'use strict';

const { calculatePoints } = require('./scoring');

const PHASES = {
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  PROMPT: 'PROMPT',
  QUESTION: 'QUESTION',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const INTRO_DURATION_MS = 4000;
const INTRO_GO_HOLD_MS = 1100;
const PROMPT_DURATION_MS = 3000;
// Extra time tacked onto the prompt phase before the very last question, so
// the host page has room to show a "🏆 Final Question!" splash before the
// question itself becomes readable. The regular prompt countdown still runs
// after the splash fades.
const FINAL_PROMPT_EXTRA_MS = 5050;

/**
 * Single-room trivia game state machine. Same flow & API as the wedding
 * quiz original, with one key difference: questions are loaded *after*
 * construction via setQuestions(), because the host fetches them from
 * Open Trivia DB at the moment they click Start.
 */
class Game {
  constructor() {
    this.questions = [];
    this.phase = PHASES.LOBBY;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this.currentIndex = -1;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this._questionTimer = null;
    this._phaseTimer = null;
    this.onQuestionTimeout = null;
    this.onIntroEnd = null;
    this.onPromptEnd = null;
  }

  /** Replace the question list. Called by the transport layer right before start(). */
  setQuestions(list) {
    this.questions = Array.isArray(list) ? list : [];
  }

  // ---------------- Lobby / players ----------------

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

  dedupeName(name) {
    if (!this.nameIsTaken(name)) return name;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${name} (${i})`.slice(0, MAX_NAME_LEN);
      if (!this.nameIsTaken(candidate)) return candidate;
    }
    return name;
  }

  addPlayer({ playerId, name, socketId }) {
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, reason: 'lobby-closed' };
    }
    if (!playerId || typeof playerId !== 'string') {
      return { ok: false, reason: 'bad-player-id' };
    }
    if (this.players.has(playerId)) {
      return this.reconnectPlayer({ playerId, socketId });
    }
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) {
      return { ok: false, reason: 'name-taken', name: clean };
    }
    const player = {
      id: playerId,
      name: clean,
      socketId,
      score: 0,
      answers: [],
      lastScoringAnswerTs: 0,
      joinedAt: Date.now(),
      connected: true,
    };
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

  // ---------------- Game progression ----------------

  start() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    if (!this.questions || this.questions.length === 0) return { ok: false, reason: 'no-questions' };
    this.currentIndex = -1;
    return this._enterIntro();
  }

  advance() {
    if (this.phase === PHASES.FINAL) return { ok: false, reason: 'final' };
    if (this.phase === PHASES.LOBBY) return { ok: false, reason: 'not-started' };
    if (this.phase === PHASES.INTRO) {
      this._endIntro();
      return { ok: true, phase: PHASES.PROMPT };
    }
    if (this.phase === PHASES.PROMPT) {
      this._endPrompt();
      return { ok: true, phase: PHASES.QUESTION };
    }
    if (this.phase === PHASES.QUESTION) {
      this._endQuestion('host');
      return { ok: true, phase: PHASES.REVEAL };
    }
    const nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.questions.length) {
      this.phase = PHASES.FINAL;
      this._clearTimers();
      return { ok: true, phase: PHASES.FINAL };
    }
    return this._enterPrompt(nextIndex);
  }

  _enterIntro() {
    this._clearTimers();
    this.phase = PHASES.INTRO;
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + INTRO_DURATION_MS;
    this._phaseTimer = setTimeout(() => {
      this._phaseTimer = null;
      this._endIntro();
    }, INTRO_DURATION_MS + INTRO_GO_HOLD_MS);
    return { ok: true, phase: PHASES.INTRO };
  }

  _endIntro() {
    if (this.phase !== PHASES.INTRO) return;
    this._clearTimers();
    this._enterPrompt(0);
    if (typeof this.onIntroEnd === 'function') {
      try { this.onIntroEnd(); } catch (_) {}
    }
  }

  _enterPrompt(index) {
    this._clearTimers();
    this.currentIndex = index;
    this.phase = PHASES.PROMPT;
    this.currentStartTs = Date.now();
    const isLast = index === this.questions.length - 1;
    const duration = PROMPT_DURATION_MS + (isLast ? FINAL_PROMPT_EXTRA_MS : 0);
    this.currentEndsAt = this.currentStartTs + duration;
    this._phaseTimer = setTimeout(() => {
      this._phaseTimer = null;
      this._endPrompt();
    }, duration + 50);
    return { ok: true, phase: PHASES.PROMPT };
  }

  _endPrompt() {
    if (this.phase !== PHASES.PROMPT) return;
    this._clearTimers();
    this._enterQuestion();
    if (typeof this.onPromptEnd === 'function') {
      try { this.onPromptEnd(); } catch (_) {}
    }
  }

  _enterQuestion() {
    this._clearTimers();
    this.phase = PHASES.QUESTION;
    const q = this.questions[this.currentIndex];
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + q.timeLimitSec * 1000;
    this._questionTimer = setTimeout(() => {
      this._questionTimer = null;
      this._endQuestion('timeout');
    }, q.timeLimitSec * 1000 + 100);
    return { ok: true, phase: PHASES.QUESTION, question: q };
  }

  _clearTimers() {
    if (this._questionTimer) { clearTimeout(this._questionTimer); this._questionTimer = null; }
    if (this._phaseTimer) { clearTimeout(this._phaseTimer); this._phaseTimer = null; }
  }

  _endQuestion(reason) {
    if (this.phase !== PHASES.QUESTION) return;
    this._clearTimers();
    this.phase = PHASES.REVEAL;
    this.lastEndReason = reason || 'host';
    if (typeof this.onQuestionTimeout === 'function') {
      try { this.onQuestionTimeout(); } catch (_) {}
    }
  }

  submitAnswer({ playerId, questionId, choiceIndex }) {
    if (this.phase !== PHASES.QUESTION) return { ok: false, reason: 'not-accepting-answers' };
    const q = this.questions[this.currentIndex];
    if (!q || q.id !== questionId) return { ok: false, reason: 'wrong-question' };
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3) {
      return { ok: false, reason: 'bad-choice' };
    }
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (p.answers.some((a) => a.questionId === questionId)) {
      return { ok: false, reason: 'already-answered' };
    }
    const now = Date.now();
    const responseMs = now - this.currentStartTs;
    const timeLimitMs = q.timeLimitSec * 1000;
    if (responseMs > timeLimitMs) return { ok: false, reason: 'too-late' };
    const wasCorrect = choiceIndex === q.correctIndex;
    const points = calculatePoints(wasCorrect, responseMs, timeLimitMs);
    p.answers.push({ questionId, choiceIndex, responseMs, points, wasCorrect, ts: now });
    p.score += points;
    if (points > 0) p.lastScoringAnswerTs = now;
    const totalActive = Array.from(this.players.values()).length;
    const answered = Array.from(this.players.values()).filter((pp) =>
      pp.answers.some((a) => a.questionId === questionId)
    ).length;
    if (totalActive > 0 && answered >= totalActive) {
      this._endQuestion('all-answered');
    }
    return { ok: true, player: p, pointsEarned: points, wasCorrect };
  }

  // ---------------- Views / serialization ----------------

  getCurrentQuestion() {
    if (this.currentIndex < 0 || this.currentIndex >= this.questions.length) return null;
    return this.questions[this.currentIndex];
  }

  getQuestionPublic() {
    const q = this.getCurrentQuestion();
    if (!q) return null;
    return {
      id: q.id,
      index: this.currentIndex,
      total: this.questions.length,
      prompt: q.prompt,
      category: q.category,
      difficulty: q.difficulty,
      choices: q.choices,
      timeLimitSec: q.timeLimitSec,
      serverStartTs: this.currentStartTs,
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
    };
  }

  getIntroPublic() {
    return {
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      totalQuestions: this.questions.length,
      durationMs: INTRO_DURATION_MS,
    };
  }

  getPromptPublic() {
    const q = this.getCurrentQuestion();
    if (!q) return null;
    const isLast = this.currentIndex === this.questions.length - 1;
    return {
      id: q.id,
      index: this.currentIndex,
      total: this.questions.length,
      prompt: q.prompt,
      category: q.category,
      difficulty: q.difficulty,
      choices: q.choices,
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      durationMs: PROMPT_DURATION_MS + (isLast ? FINAL_PROMPT_EXTRA_MS : 0),
      timeLimitSec: q.timeLimitSec,
      isLastQuestion: isLast,
    };
  }

  getAnswerDistribution() {
    const q = this.getCurrentQuestion();
    if (!q) return [0, 0, 0, 0];
    const dist = [0, 0, 0, 0];
    for (const p of this.players.values()) {
      const a = p.answers.find((x) => x.questionId === q.id);
      if (a) dist[a.choiceIndex]++;
    }
    return dist;
  }

  getLeaderboard(limit) {
    // Sort by score desc. Tiebreak by name (case-insensitive) so the
    // display order among tied players is deterministic and fair — NOT
    // biased by join order or who happened to answer earliest. The
    // alphabetical sort is PURELY cosmetic: every player with the same
    // score gets the SAME rank below; alphabetical only decides which
    // name appears above the other when scores tie.
    const sorted = Array.from(this.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    // Standard competition ranking ("1224"): every player with the same
    // score gets the same rank; the next distinct score skips ahead by
    // the size of the tie group. e.g. scores [1000, 900, 900, 800] yield
    // ranks [1, 2, 2, 4]. Replaces the old timestamp-tiebreaker logic
    // where ties were silently broken by who answered first.
    const ranked = [];
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const rank = (i > 0 && sorted[i - 1].score === p.score)
        ? ranked[i - 1].rank
        : i + 1;
      ranked.push({ rank, id: p.id, name: p.name, score: p.score });
    }
    return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
  }

  // Buckets players into up to 3 podium GROUPS by DISTINCT rank — not by
  // player count. Returns: [{ rank, score, players: [{id, name}, ...] }].
  // With ties this can yield fewer than 3 groups (e.g. 5 players tied for
  // 1st returns a single group of 5; no silver/bronze). Used by the host's
  // final podium so medals follow rank, and tied players share a card.
  getPodiumGroups() {
    const full = this.getLeaderboard();
    if (full.length === 0) return [];
    const groups = [];
    for (const row of full) {
      const last = groups[groups.length - 1];
      if (last && last.rank === row.rank) {
        last.players.push({ id: row.id, name: row.name });
      } else {
        if (groups.length >= 3) break;
        groups.push({
          rank: row.rank,
          score: row.score,
          players: [{ id: row.id, name: row.name }],
        });
      }
    }
    return groups;
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
    }));
  }

  // Points this player needs to overtake the next-higher SCORE on the
  // leaderboard. Returns null when they're in first place (or tied for the
  // top score with nobody above them). `leaderboard` is optional — pass a
  // pre-computed one to avoid re-sorting.
  getPointsToNextPlace(playerId, leaderboard) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const lb = Array.isArray(leaderboard) ? leaderboard : this.getLeaderboard();
    const idx = lb.findIndex((e) => e.id === playerId);
    if (idx <= 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      if (lb[i].score > p.score) {
        return (lb[i].score - p.score) + 1;
      }
    }
    return null;
  }

  getPlayerResult(playerId) {
    const p = this.players.get(playerId);
    const q = this.getCurrentQuestion();
    if (!p || !q) return null;
    const a = p.answers.find((x) => x.questionId === q.id);
    const lb = this.getLeaderboard();
    // Use the competition rank stored on the leaderboard row, NOT the
    // array index — with ties the index is just alphabetical position.
    const idx = lb.findIndex((e) => e.id === playerId);
    const rank = idx >= 0 ? lb[idx].rank : (lb.length || 1);
    // True when at least one other player shares this rank. The client
    // uses this to show "You are tied at #N" instead of "You are #N".
    const tied = lb.filter((e) => e.rank === rank).length > 1;
    return {
      questionId: q.id,
      answered: !!a,
      wasCorrect: a ? a.wasCorrect : false,
      pointsEarned: a ? a.points : 0,
      totalScore: p.score,
      rank,
      tied,
      totalPlayers: lb.length,
      pointsToNextPlace: this.getPointsToNextPlace(playerId, lb),
      isLastQuestion: this.currentIndex === this.questions.length - 1,
    };
  }

  answeredCount() {
    const q = this.getCurrentQuestion();
    if (!q) return 0;
    let n = 0;
    for (const p of this.players.values()) {
      if (p.answers.some((a) => a.questionId === q.id)) n++;
    }
    return n;
  }

  reset() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.questions = [];
    this.currentIndex = -1;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
  }
}

module.exports = { Game, PHASES, MAX_NAME_LEN, INTRO_DURATION_MS, PROMPT_DURATION_MS };
