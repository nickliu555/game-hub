'use strict';

// Spawn N fake players that join the lobby of one (or all) of the hub games.
// Players only JOIN the lobby — they don't play. Connections stay open until
// you press Ctrl+C, so the host lobby page keeps showing the chips.
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

const { io } = require('socket.io-client');
const crypto = require('crypto');

const GAMES = ['empire', 'trivia', 'twentyfour'];

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
const stats = {}; // game -> { joined, failed }
for (const g of targets) stats[g] = { joined: 0, failed: 0 };

console.log(`Spawning ${COUNT} player(s) into: ${targets.join(', ')}  (server: ${URL})`);
console.log('Players will stay in the lobby until you press Ctrl+C.\n');

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
    .map((g) => `${g}: ${stats[g].joined} joined, ${stats[g].failed} failed`)
    .join('  |  ');
  process.stdout.write(`  ... ${summary}. Ctrl+C to disconnect.\r`);
}, 2000);
