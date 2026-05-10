'use strict';

const { nanoid } = require('nanoid');

// The Trivia API (https://the-trivia-api.com) — modern OTDB replacement with
// cleaner writing, no session-token exhaustion, and a stable category set.
const API_BASE = 'https://the-trivia-api.com/v2';

class TriviaApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TriviaApiError';
    this.code = code || 'unknown';
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- Categories ----------------
// The Trivia API has a fixed category set (slugs). Display names are
// hand-mapped so the UI shows nice labels like "Film & TV".
const CATEGORY_MAP = [
  { id: 'general_knowledge',     name: 'General Knowledge' },
  { id: 'music',                 name: 'Music' },
  { id: 'film_and_tv',           name: 'Film & TV' },
  { id: 'arts_and_literature',   name: 'Arts & Literature' },
  { id: 'history',               name: 'History' },
  { id: 'geography',             name: 'Geography' },
  { id: 'science',               name: 'Science' },
  { id: 'society_and_culture',   name: 'Society & Culture' },
  { id: 'sport_and_leisure',     name: 'Sport & Leisure' },
  { id: 'food_and_drink',        name: 'Food & Drink' },
];
const VALID_CATEGORY_SLUGS = new Set(CATEGORY_MAP.map((c) => c.id));
const CATEGORY_SLUG_TO_NAME = Object.fromEntries(CATEGORY_MAP.map((c) => [c.id, c.name]));

async function fetchCategories() {
  // Static — no network call needed. Async signature kept for compatibility.
  return CATEGORY_MAP.slice();
}

function prettifyCategory(slug) {
  if (!slug) return '';
  if (CATEGORY_SLUG_TO_NAME[slug]) return CATEGORY_SLUG_TO_NAME[slug];
  // Fallback: convert "some_slug_here" -> "Some Slug Here".
  return String(slug).split('_').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

// ---------------- Questions ----------------
/**
 * Fetch `amount` multiple-choice questions from The Trivia API.
 * Retries with backoff on transient errors. Throws TriviaApiError on final
 * failure.
 *
 * @param {Object} opts
 * @param {number} opts.amount         1..50
 * @param {string|null} opts.category  category slug (e.g. "music"), or null for any
 * @param {string|null} opts.difficulty 'easy'|'medium'|'hard' or null
 * @param {number} opts.timeLimitSec   per-question time limit (stamped on each q)
 */
async function fetchQuestions({ amount, category, difficulty, timeLimitSec }) {
  const n = Math.max(1, Math.min(50, Number(amount) || 10));
  const tLim = Math.max(5, Math.min(120, Number(timeLimitSec) || 20));
  const attempts = 3;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const params = new URLSearchParams({
        limit: String(n),
        // Force exactly four-choice text questions (no true/false, no images).
        types: 'text_choice',
      });
      if (category && VALID_CATEGORY_SLUGS.has(String(category))) {
        params.set('categories', String(category));
      }
      if (difficulty && ['easy', 'medium', 'hard'].includes(difficulty)) {
        params.set('difficulties', difficulty);
      }
      const url = `${API_BASE}/questions?${params.toString()}`;
      const r = await fetch(url);
      if (r.status === 429) throw new TriviaApiError('rate-limited', 'rate-limited');
      if (!r.ok) throw new TriviaApiError('http-' + r.status, 'http');
      const data = await r.json();

      if (!Array.isArray(data)) {
        throw new TriviaApiError('bad-response', 'bad-response');
      }
      if (data.length === 0) {
        throw new TriviaApiError('not-enough-questions', 'no-results');
      }
      if (data.length < n) {
        // Got fewer than requested — treat as failure so the host knows.
        throw new TriviaApiError('not-enough-questions', 'no-results');
      }

      return data.map((row) => {
        const correct = String(row.correctAnswer || '').trim();
        const incorrect = (Array.isArray(row.incorrectAnswers) ? row.incorrectAnswers : [])
          .map((s) => String(s || '').trim())
          .filter(Boolean);
        const all = shuffle([correct, ...incorrect]);
        const promptText = (row.question && typeof row.question === 'object')
          ? String(row.question.text || '')
          : String(row.question || '');
        return {
          id: nanoid(8),
          prompt: promptText,
          choices: all,
          correctIndex: all.indexOf(correct),
          timeLimitSec: tLim,
          category: prettifyCategory(row.category || ''),
          difficulty: row.difficulty || '',
        };
      });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const isRateLimited = e && (e.code === 'rate-limited' || e.code === 'http');
        await sleep(isRateLimited ? 2500 : 400);
      }
    }
  }

  // Final failure — translate code to a friendly message.
  const code = (lastErr && lastErr.code) || 'unknown';
  const friendlyByCode = {
    'no-results': 'Not enough questions for that category/difficulty. Try a different combination.',
    'rate-limited': 'Too many requests to the trivia service — please wait a few seconds and try again.',
  };
  const message = friendlyByCode[code] || 'Could not reach the trivia service. Please check your connection and try again.';
  throw new TriviaApiError(message, code);
}

module.exports = {
  fetchQuestions,
  fetchCategories,
  TriviaApiError,
  // No-op kept for backwards compatibility with index.js. The Trivia API
  // doesn't use session tokens, so there's nothing to prewarm.
  prewarmToken: function () { /* no-op */ },
};
