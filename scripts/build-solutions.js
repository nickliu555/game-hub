#!/usr/bin/env node
'use strict';

/**
 * build-solutions.js
 *
 * Reads server/twentyfour/_solutions-source.txt (raw "key": "value" lines
 * pasted by the user) and writes a flat array of solution expressions to
 * public/twentyfour/data/solutions.json indexed identically to puzzles.json.
 *
 * Also copies puzzles.json to public/twentyfour/data/puzzles.json so the
 * client can fetch both as static assets without needing a dedicated route.
 *
 * Runtime contract for practice mode:
 *   solutions[puzzle.id] === expression-string-or-null
 *   solutions.length === puzzles.length
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'server', 'twentyfour', '_solutions-source.txt');
const PUZZLES_PATH = path.join(ROOT, 'server', 'twentyfour', 'puzzles.json');
const OUT_DIR = path.join(ROOT, 'public', 'twentyfour', 'data');
const OUT_SOLUTIONS = path.join(OUT_DIR, 'solutions.json');
const OUT_PUZZLES = path.join(OUT_DIR, 'puzzles.json');

function sortedKey(nums) {
  return nums.slice().sort(function (a, b) { return a - b; }).join(' ');
}

function parseSource(text) {
  // Permissive line-by-line regex: matches  "key": "value"  ignoring
  // leading whitespace, trailing comma, surrounding braces, or anything
  // weird in between. Comment lines starting with # are ignored.
  const map = new Map();
  const lines = text.split(/\r?\n/);
  const re = /"([^"]+)"\s*:\s*"([^"]*)"/;
  let parsed = 0;
  let skipped = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = line.match(re);
    if (!m) { skipped++; continue; }
    const rawKey = m[1].trim();
    const expr = m[2];
    // Normalize the key: parse numbers, sort ascending, rejoin. This way
    // the source file doesn't have to be perfectly sorted to look up.
    const nums = rawKey.split(/\s+/).map(function (x) { return parseInt(x, 10); });
    if (nums.length !== 4 || nums.some(function (n) { return !Number.isFinite(n); })) {
      skipped++;
      continue;
    }
    map.set(sortedKey(nums), expr);
    parsed++;
  }
  return { map, parsed, skipped };
}

function main() {
  if (!fs.existsSync(SOURCE_PATH)) {
    console.error('[build-solutions] source file not found:', SOURCE_PATH);
    process.exit(1);
  }
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const { map, parsed, skipped } = parseSource(source);

  const puzzles = JSON.parse(fs.readFileSync(PUZZLES_PATH, 'utf8'));

  const solutions = new Array(puzzles.length);
  const missing = [];
  for (let i = 0; i < puzzles.length; i++) {
    const key = sortedKey(puzzles[i]);
    const expr = map.get(key);
    if (expr) {
      solutions[i] = expr;
    } else {
      solutions[i] = null;
      missing.push({ id: i, numbers: puzzles[i] });
    }
  }

  // Ensure output directory exists.
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Write solutions.json as a compact JSON array (no pretty-printing — it's
  // a generated asset that the client just fetches).
  fs.writeFileSync(OUT_SOLUTIONS, JSON.stringify(solutions));
  // Mirror puzzles.json into the same dir so the client fetches both from
  // /twentyfour/data/. Source of truth stays in server/twentyfour/.
  fs.writeFileSync(OUT_PUZZLES, JSON.stringify(puzzles));

  // ---------------- Report ----------------
  const total = puzzles.length;
  const covered = total - missing.length;
  const pct = ((covered / total) * 100).toFixed(1);
  console.log('');
  console.log('[build-solutions] Source: ' + path.relative(ROOT, SOURCE_PATH));
  console.log('  Parsed lines:  ' + parsed + (skipped ? '  (skipped ' + skipped + ' unparseable lines)' : ''));
  console.log('  Unique keys:   ' + map.size);
  console.log('');
  console.log('[build-solutions] Puzzles: ' + total);
  console.log('  Covered:       ' + covered + ' / ' + total + ' (' + pct + '%)');
  console.log('  Missing:       ' + missing.length);
  if (missing.length > 0 && missing.length <= 8) {
    for (const m of missing) {
      console.log('    #' + m.id + ': [' + m.numbers.join(', ') + ']');
    }
  } else if (missing.length > 0) {
    console.log('  First 5 missing:');
    for (const m of missing.slice(0, 5)) {
      console.log('    #' + m.id + ': [' + m.numbers.join(', ') + ']');
    }
    console.log('    … and ' + (missing.length - 5) + ' more.');
  }
  console.log('');
  console.log('[build-solutions] Wrote:');
  console.log('  ' + path.relative(ROOT, OUT_SOLUTIONS));
  console.log('  ' + path.relative(ROOT, OUT_PUZZLES));
}

main();
