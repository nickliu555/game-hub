'use strict';

// Spawn N fake players that join the lobby of one (or all) of the hub games.
// For TRIVIA the players can also auto-answer each question (see below), so
// you can load-test the full play loop, not just the lobby. For empire and
// twentyfour the players still only JOIN. Connections stay open until you
// press Ctrl+C, so the host lobby/play pages keep showing the chips.
//
// IMPORTANT: a host must already be on the game's host page, otherwise the
// server rejects joins with "host-absent" (trivia/twentyfour) or
// "Host has left the game." (empire).
//
// Usage:
//   node scripts/sim-players.js                 # 10 players into ALL games
//   node scripts/sim-players.js trivia 25       # 25 players into trivia
//   node scripts/sim-players.js twentyfour 40   # 40 players into 24
//   node scripts/sim-players.js empire 15       # 15 players into empire
//   node scripts/sim-players.js all 20          # 20 players into each game
//
//   GAME=trivia COUNT=30 URL=http://192.168.1.10:3000 node scripts/sim-players.js
//
// Args / env:
//   game  (arg 1 / GAME):  empire | trivia | twentyfour | all   (default: all)
//   count (arg 2 / COUNT): number of players per game            (default: 10)
//   URL   (env):           server base URL              (default: http://localhost:3000)
//
// Trivia auto-answer (env, ignored by empire/twentyfour):
//   ANSWER:         A | B | C | D | random | off    (default: random)
//                  - A/B/C/D  → every player always picks that choice
//                  - random   → each player picks a random choice per question
//                  - off/none → players join but never answer (lobby only)
//   ANSWER_MIN_MS:  earliest a player may answer after choices appear (default: 500)
//   ANSWER_MAX_MS:  latest a player may answer after choices appear  (default: 2500)
//                  (MAX_ANSWER_DELAY_MS is accepted as an alias for ANSWER_MAX_MS.)
//   Each player rolls a uniformly-random delay in [ANSWER_MIN_MS, ANSWER_MAX_MS]
//   before submitting, so answers arrive spread across that time span. The
//   delay is clamped to the question's own timer so nobody answers too late.
//
//   Examples:
//     ANSWER=random ANSWER_MIN_MS=1000 ANSWER_MAX_MS=8000 node scripts/sim-players.js trivia 50
//     ANSWER=A node scripts/sim-players.js trivia 30
//     ANSWER=off node scripts/sim-players.js trivia 30   # lobby only

const { io } = require('socket.io-client');
const crypto = require('crypto');

const GAMES = ['empire', 'trivia', 'twentyfour', 'herdmind'];

// ---- Parse args ----------------------------------------------------------
const rawGame = (process.argv[2] || process.env.GAME || 'all').toLowerCase();
const COUNT = parseInt(process.argv[3] || process.env.COUNT || '10', 10);
const URL = (process.env.URL || 'http://localhost:3000').replace(/\/+$/, '');

if (rawGame !== 'all' && !GAMES.includes(rawGame)) {
  console.error(`Unknown game "${rawGame}". Use one of: ${GAMES.join(', ')}, all`);
  process.exit(1);
}
if (!Number.isInteger(COUNT) || COUNT < 1) {
  console.error(`Invalid count "${process.argv[3] || process.env.COUNT}". Must be a positive integer.`);
  process.exit(1);
}

const targets = rawGame === 'all' ? GAMES.slice() : [rawGame];

// ---- Trivia auto-answer config -------------------------------------------
// ANSWER picks the choice strategy; ANSWER_MIN_MS..ANSWER_MAX_MS is the time
// span across which players submit (each rolls a random delay in that range).
const ANSWER_MODE = (process.env.ANSWER || 'RANDOM').toUpperCase();
const ANSWER_ENABLED = !['OFF', 'NONE', 'NO', '0', 'FALSE'].includes(ANSWER_MODE);
const ANSWER_MIN_MS = Math.max(0, parseInt(process.env.ANSWER_MIN_MS || '500', 10) || 0);
const ANSWER_MAX_MS = Math.max(
  ANSWER_MIN_MS,
  parseInt(process.env.ANSWER_MAX_MS || process.env.MAX_ANSWER_DELAY_MS || '2500', 10) || ANSWER_MIN_MS
);

// Map the ANSWER setting → a choice index (0=A, 1=B, 2=C, 3=D). 'random'
// (and any unrecognized value) re-rolls per question so the distribution
// across players/questions is spread out.
function chooseAnswerIndex() {
  const idx = { A: 0, B: 1, C: 2, D: 3 }[ANSWER_MODE];
  return typeof idx === 'number' ? idx : Math.floor(Math.random() * 4);
}

// ---- Herd Mind auto-answer config -------------------------------------------
// HERD=clump  → most players pick from a small shared pool so herds form
//              (with the occasional unique answer → Pink Cow action).
// HERD=spread → each player picks a random distinct-ish word.
const HERD_MODE = (process.env.HERD || 'CLUMP').toUpperCase();
const HERD_CLUMP_POOL = ['dog', 'cat', 'pizza', 'blue', 'apple'];
function herdAnswer() {
  if (HERD_MODE === 'SPREAD') return WORDS[Math.floor(Math.random() * WORDS.length)];
  if (Math.random() < 0.82) return HERD_CLUMP_POOL[Math.floor(Math.random() * HERD_CLUMP_POOL.length)];
  return 'oddone' + Math.floor(Math.random() * 100000);
}

// ---- Name / word generators ----------------------------------------------
const FIRST = [
  'Avery', 'Bea', 'Casey', 'Dev', 'Eli', 'Finn', 'Gigi', 'Hana',
  'Indy', 'Jules', 'Kai', 'Luna', 'Mira', 'Niko', 'Omar', 'Pia',
  'Quinn', 'Remy', 'Sage', 'Tess', 'Uma', 'Vik', 'Wren', 'Xio',
  'Yuna', 'Zane',
];

// Unique display name per (game, index). The game prefix keeps names distinct
// across games so concurrent runs never collide in any single lobby.
function uniqueName(game, i) {
  const first = FIRST[i % FIRST.length];
  const suffix = String.fromCharCode(65 + Math.floor(i / FIRST.length)); // A, B, C...
  return `${first} ${suffix}.`;
}

// Empire rejects words that are duplicates OR conceptually "too similar"
// (same root/variant/concept, judged by an LLM). So we draw from a large pool
// of distinct, unrelated nouns — no shared roots, plurals, or same-concept
// pairs — and give each player a different one. On the rare conceptual
// collision the submitter just grabs the next unused word and retries.
const WORDS = [
  'tractor', 'banjo', 'cactus', 'dolphin', 'ember', 'falcon', 'glacier', 'harbor',
  'igloo', 'jaguar', 'satchel', 'lantern', 'meadow', 'nebula', 'octopus', 'pyramid',
  'quartz', 'raccoon', 'saddle', 'thunder', 'umbrella', 'volcano', 'walrus', 'xylophone',
  'yogurt', 'zeppelin', 'anchor', 'bamboo', 'compass', 'domino', 'eagle', 'feather',
  'granite', 'hammock', 'helmet', 'jellyfish', 'kayak', 'trophy', 'mango', 'noodle',
  'orchid', 'penguin', 'quokka', 'rocket', 'sapphire', 'tornado', 'unicorn', 'violin',
  'waffle', 'yacht', 'acorn', 'blizzard', 'canyon', 'dragon', 'eclipse', 'firefly',
  'gondola', 'hedgehog', 'island', 'jasmine', 'koala', 'lagoon', 'magnet', 'narwhal',
  'obelisk', 'pelican', 'quiver', 'rhino', 'sunflower', 'tulip', 'urchin', 'puzzle',
  'whistle', 'zebra', 'almond', 'cradle', 'cello', 'dune', 'engine', 'fountain',
  'galaxy', 'mosaic', 'iris', 'jungle', 'kiwi', 'ladder', 'wrench', 'nutmeg',
  'otter', 'pebble', 'quill', 'sandal', 'sponge', 'teapot', 'ukulele', 'vinyl',
  'willow', 'yarn', 'apron', 'bison', 'comet', 'daisy', 'elm', 'ferry',
  'gecko', 'hazel', 'inkwell', 'jackal', 'kelp', 'lemur', 'moth', 'nest',
  'oasis', 'piano', 'driftwood', 'reef', 'saffron', 'thistle', 'undertow', 'velvet',
  'wombat', 'yam', 'apricot', 'beaver', 'clover', 'dewdrop', 'echo', 'fjord',
  'goblet', 'hyacinth', 'mitten', 'juniper', 'kestrel', 'lily', 'marble', 'newt',
  'onyx', 'parsley', 'quince', 'raven', 'sequoia', 'tundra', 'urn', 'vulture',
  'walnut', 'yeti', 'amber', 'basil', 'cobra', 'dagger', 'ermine', 'fennel',
  'ginger', 'heron', 'ivy', 'jade', 'kennel', 'lobster', 'mimosa', 'nutshell',
];

// Fisher–Yates shuffle so each run assigns words in a fresh random order.
const shuffledWords = WORDS.slice();
for (let k = shuffledWords.length - 1; k > 0; k--) {
  const j = Math.floor(Math.random() * (k + 1));
  [shuffledWords[k], shuffledWords[j]] = [shuffledWords[j], shuffledWords[k]];
}

// Hand out the next unused word. Each call advances a shared cursor, so
// retries (after a conceptual collision) naturally get a fresh word. If we
// run past the pool, pair two distinct pool words to extend the supply.
let wordCursor = 0;
function nextWord(game) {
  const i = wordCursor++;
  if (i < shuffledWords.length) return shuffledWords[i];
  const a = shuffledWords[i % shuffledWords.length];
  const b = shuffledWords[(i * 7 + 3) % shuffledWords.length];
  return a === b ? `${a} ${game}` : `${a} ${b}`;
}

// ---- Trackers ------------------------------------------------------------
const sockets = [];
const stats = {}; // game -> { joined, failed, answered }
for (const g of targets) stats[g] = { joined: 0, failed: 0, answered: 0 };

console.log(`Spawning ${COUNT} player(s) into: ${targets.join(', ')}  (server: ${URL})`);
if (targets.includes('trivia')) {
  if (ANSWER_ENABLED) {
    console.log(`Trivia auto-answer: mode=${ANSWER_MODE}, delay span=${ANSWER_MIN_MS}-${ANSWER_MAX_MS}ms after choices appear.`);
  } else {
    console.log('Trivia auto-answer: OFF (players join the lobby only).');
  }
}
console.log('Players will stay connected until you press Ctrl+C.\n');

// Print a one-time hint when connections look like the server isn't running.
let printedServerDownHint = false;
function hintIfServerDown(err) {
  if (printedServerDownHint) return;
  const msg = (err && err.message) || '';
  if (/websocket error|xhr poll error|ECONNREFUSED|connect/i.test(msg)) {
    printedServerDownHint = true;
    console.warn(`\n  ⚠️  Can't reach ${URL}. Is the server running? Start it with "npm start" (and open the game's host page), then re-run this script.\n`);
  }
}

// ---- Socket.IO games (trivia, twentyfour) --------------------------------
function joinSocketGame(game) {
  for (let i = 0; i < COUNT; i++) {
    const pid = crypto.randomUUID();
    const name = uniqueName(game, i);
    // Default transports (polling -> websocket upgrade) are more forgiving
    // than websocket-only, which fails outright if the upgrade is blocked.
    const s = io(`${URL}/${game}`, { reconnection: false });

    s.on('connect', () => {
      s.emit('player:join', { playerId: pid, name }, (res) => {
        if (res && res.ok) {
          stats[game].joined++;
          process.stdout.write(`+ [${game}] ${name.padEnd(12)} joined  (${stats[game].joined}/${COUNT})\n`);
        } else {
          stats[game].failed++;
          console.warn(`x [${game}] ${name} failed:`, (res && res.reason) || 'unknown');
        }
      });
    });

    s.on('connect_error', (err) => {
      stats[game].failed++;
      console.warn(`x [${game}] ${name} connect_error:`, err.message);
      hintIfServerDown(err);
    });

    // Trivia auto-answer: when choices appear (state:question), each player
    // waits a random delay inside [ANSWER_MIN_MS, ANSWER_MAX_MS] — clamped to
    // the question's own timer — then submits its chosen answer. The
    // `answered` set guards against double-submitting if state:question is
    // re-broadcast (e.g. on a late host reconnect).
    if (game === 'trivia' && ANSWER_ENABLED) {
      const answered = new Set();
      s.on('state:question', (q) => {
        if (!q || !q.id || answered.has(q.id)) return;
        answered.add(q.id);
        // Clamp the chosen delay to the remaining question window so the
        // answer lands before the timer expires (leave a 250ms safety buffer).
        let maxDelay = ANSWER_MAX_MS;
        if (typeof q.endsAt === 'number' && typeof q.serverNow === 'number') {
          const windowMs = q.endsAt - q.serverNow - 250;
          if (windowMs > 0) maxDelay = Math.min(maxDelay, windowMs);
        }
        const lo = Math.min(ANSWER_MIN_MS, maxDelay);
        const delay = lo + Math.floor(Math.random() * Math.max(0, maxDelay - lo));
        setTimeout(() => {
          const choiceIndex = chooseAnswerIndex();
          s.emit('player:answer', { questionId: q.id, choiceIndex }, (res) => {
            if (res && res.ok) stats[game].answered++;
          });
        }, delay);
      });
    }

    // Herd Mind: type a short answer when a question opens (clump/spread).
    if (game === 'herdmind' && ANSWER_ENABLED) {
      const answered = new Set();
      s.on('state:question', (q) => {
        if (!q || !q.id || answered.has(q.id)) return;
        answered.add(q.id);
        let maxDelay = ANSWER_MAX_MS;
        if (typeof q.endsAt === 'number' && typeof q.serverNow === 'number') {
          const windowMs = q.endsAt - q.serverNow - 250;
          if (windowMs > 0) maxDelay = Math.min(maxDelay, windowMs);
        }
        const lo = Math.min(ANSWER_MIN_MS, maxDelay);
        const delay = lo + Math.floor(Math.random() * Math.max(0, maxDelay - lo));
        setTimeout(() => {
          s.emit('player:answer', { questionId: q.id, answer: herdAnswer() }, (res) => {
            if (res && res.ok) stats[game].answered++;
          });
        }, delay);
      });
    }

    sockets.push(s);
  }
}

// ---- HTTP game (empire) --------------------------------------------------
// Empire submissions go through an Express rate limiter (10 / minute / IP).
// Since every sim player shares this machine's IP, we pace submissions and
// retry on HTTP 429 with backoff so the lobby fills up reliably (just slowly
// for large counts).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function joinEmpireGame(game) {
  for (let i = 0; i < COUNT; i++) {
    const name = uniqueName(game, i);
    let word = nextWord(game);

    let rateRetries = 0;
    let wordRetries = 0;
    // Retry on rate-limit (429, same word) and on word rejection (grab a
    // fresh word). Anything else resolves on the first try.
    while (true) {
      try {
        const res = await fetch(`${URL}/api/empire/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ player: name, word, skipCategoryCheck: true }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.ok) {
          stats[game].joined++;
          process.stdout.write(`+ [${game}] ${name.padEnd(12)} joined  (${stats[game].joined}/${COUNT})\n`);
          break;
        }

        if (res.status === 429 && rateRetries < 30) {
          // Rate limited — wait for the window to free up, then retry.
          rateRetries++;
          const waitMs = 6500 + Math.floor(Math.random() * 1500);
          process.stdout.write(`  … [${game}] ${name} rate-limited, retrying in ${(waitMs / 1000).toFixed(1)}s\n`);
          await sleep(waitMs);
          continue;
        }

        // Word taken or too similar — grab a fresh word and try again.
        if (/not available/i.test(data.error || '') && wordRetries < 10) {
          wordRetries++;
          word = nextWord(game);
          continue;
        }

        stats[game].failed++;
        console.warn(`x [${game}] ${name} failed:`, data.error || `HTTP ${res.status}`);
        break;
      } catch (err) {
        stats[game].failed++;
        console.warn(`x [${game}] ${name} request error:`, err.message);
        break;
      }
    }
  }
}

// ---- Kick everything off --------------------------------------------------
(async () => {
  for (const game of targets) {
    if (game === 'empire') {
      await joinEmpireGame(game);
    } else {
      joinSocketGame(game);
    }
  }
})();

// ---- Shutdown ------------------------------------------------------------
function shutdown() {
  console.log(`\nDisconnecting ${sockets.length} socket(s) ...`);
  for (const s of sockets) {
    try { s.disconnect(); } catch (_) { /* ignore */ }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---- Heartbeat -----------------------------------------------------------
setInterval(() => {
  const summary = targets
    .map((g) => {
      const base = `${g}: ${stats[g].joined} joined, ${stats[g].failed} failed`;
      return ((g === 'trivia' || g === 'herdmind') && ANSWER_ENABLED)
        ? `${base}, ${stats[g].answered} answered`
        : base;
    })
    .join('  |  ');
  process.stdout.write(`  ... ${summary}. Ctrl+C to disconnect.\r`);
}, 2000);
