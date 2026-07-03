'use strict';

const path = require('path');
const fs = require('fs');

// Load the curated question bank. This JSON is generated ONCE (offline) by
// scripts/gen-herdmind-questions.js and then hand-edited by the maintainer.
// At runtime we only read + shuffle it — no LLM calls needed for questions.
//
// Shape: [{ id: string, text: string }, ...]
let RAW = [];
try {
  RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  if (!Array.isArray(RAW)) RAW = [];
} catch (_) {
  RAW = [];
}

// Defensive: keep only well-formed entries and dedupe by text.
const seen = new Set();
const QUESTIONS = [];
for (let i = 0; i < RAW.length; i++) {
  const q = RAW[i];
  const text = q && typeof q.text === 'string' ? q.text.trim() : '';
  if (!text) continue;
  const key = text.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  QUESTIONS.push({ id: q.id != null ? String(q.id) : 'q' + i, text });
}

function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A freshly shuffled copy of the whole bank. Each game gets its own queue and
 * draws without replacement; when the queue is exhausted the game reshuffles.
 */
function buildQueue() {
  return fisherYates(QUESTIONS);
}

function count() {
  return QUESTIONS.length;
}

module.exports = { buildQueue, count };
