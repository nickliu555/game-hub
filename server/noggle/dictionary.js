'use strict';

const fs = require('fs');
const path = require('path');

const { pointsForWord } = require('./scoring');

/**
 * Word validation + board solving backed by the public-domain YAWL word
 * list (~264k words) — a superset of the older ENABLE list that adds modern
 * vocabulary (e.g. "taser", "email", "texted"). Loaded lazily and cached: the
 * flat Set answers "is this a word?" for live submissions, and a prefix trie
 * (built on first solve) powers the board solver used for the host's
 * end-of-game stats.
 */

const WORD_FILE = path.join(__dirname, 'data', 'yawl.txt');

let wordSet = null; // Set<string> of lowercase words
let trieRoot = null; // lazily built for the solver

function loadWords() {
  if (wordSet) return wordSet;
  const raw = fs.readFileSync(WORD_FILE, 'utf8');
  wordSet = new Set();
  for (const line of raw.split('\n')) {
    const w = line.trim().toLowerCase();
    if (w) wordSet.add(w);
  }
  return wordSet;
}

/**
 * @param {string} word already-derived board word (any case)
 * @returns {boolean}
 */
function isWord(word) {
  if (!word) return false;
  return loadWords().has(String(word).toLowerCase());
}

// ---------------- Solver (host final extras) ----------------

function buildTrie() {
  if (trieRoot) return trieRoot;
  const set = loadWords();
  const root = {};
  for (const word of set) {
    let node = root;
    for (const ch of word) {
      node = node[ch] || (node[ch] = {});
    }
    node.$ = true; // end-of-word marker
  }
  trieRoot = root;
  return root;
}

/**
 * Descend the trie by the (possibly multi-character) letters of one tile,
 * e.g. the 'QU' tile advances through 'q' then 'u'. Returns the resulting
 * node, or null if the prefix isn't in the trie (prunes the search).
 */
function descend(node, tile) {
  let n = node;
  for (const ch of tile.toLowerCase()) {
    n = n[ch];
    if (!n) return null;
  }
  return n;
}

/**
 * Solve the board: find every distinct valid word reachable under Boggle
 * adjacency rules with the given minimum length. Returns aggregate stats for
 * the host's final screen — no per-word list (that could be huge on 6x6).
 *
 * @param {string[][]} board
 * @param {number} minLen minimum letter length (Qu = 2)
 * @returns {{ totalWords: number, maxScore: number, bestWord: string, bestPoints: number }}
 */
function boardStats(board, minLen) {
  const root = buildTrie();
  const size = board.length;
  const found = new Set();

  const dfs = (r, c, visited, node, word) => {
    const tile = board[r][c];
    const next = descend(node, tile);
    if (!next) return; // no word has this prefix — prune
    const w = word + tile; // uppercase accumulation
    if (next.$ && w.length >= minLen) found.add(w);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const key = nr * size + nc;
        if (visited.has(key)) continue;
        visited.add(key);
        dfs(nr, nc, visited, next, w);
        visited.delete(key);
      }
    }
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const visited = new Set([r * size + c]);
      dfs(r, c, visited, root, '');
    }
  }

  let maxScore = 0;
  let bestWord = '';
  let bestPoints = 0;
  for (const w of found) {
    const pts = pointsForWord(w.length);
    maxScore += pts;
    // Track the highest-scoring word; break ties by the longer word.
    if (pts > bestPoints || (pts === bestPoints && w.length > bestWord.length)) {
      bestPoints = pts;
      bestWord = w;
    }
  }
  return { totalWords: found.size, maxScore, bestWord, bestPoints };
}

/**
 * Solve the board and return the FULL word list (word -> points) plus totals.
 * Used by solo Practice mode, which validates the player's traced words on the
 * client against this set and can reveal everything at the end. Word length is
 * measured in letters (the 'QU' tile is two).
 *
 * @param {string[][]} board
 * @param {number} minLen minimum letter length (Qu = 2)
 * @returns {{ words: Object<string, number>, totalWords: number, maxScore: number }}
 */
function solveBoardWords(board, minLen) {
  const root = buildTrie();
  const size = board.length;
  const found = new Set();

  const dfs = (r, c, visited, node, word) => {
    const tile = board[r][c];
    const next = descend(node, tile);
    if (!next) return;
    const w = word + tile;
    if (next.$ && w.length >= minLen) found.add(w);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const key = nr * size + nc;
        if (visited.has(key)) continue;
        visited.add(key);
        dfs(nr, nc, visited, next, w);
        visited.delete(key);
      }
    }
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const visited = new Set([r * size + c]);
      dfs(r, c, visited, root, '');
    }
  }

  const words = {};
  let maxScore = 0;
  for (const w of found) {
    const pts = pointsForWord(w.length);
    words[w] = pts;
    maxScore += pts;
  }
  return { words, totalWords: found.size, maxScore };
}

module.exports = { isWord, boardStats, solveBoardWords, loadWords };
