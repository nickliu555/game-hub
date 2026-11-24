'use strict';

// Headless end-to-end test for Egyptian Ratscrew. Spins up an in-process
// server, connects a host plus player sockets, and drives real socket traffic.
// The rules themselves are covered by scripts/test-ratscrew-engine.js; this
// file is about the WIRE: lobby gating, secrecy, turn and lock enforcement,
// slaps (good / late / bad), the table waiting on a dropped player,
// reconnection, reactions (seat bubbles mid-game), CPUs, the finish and the Hub reset.
// Decks are stacked through the game handle mountRatscrew returns.
//
//   node scripts/itest-ratscrew.js   (or: npm run itest:ratscrew)

const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountRatscrew = require('../server/ratscrew');
const { SLAP_CLAIM_MS, END_MS } = require('../server/ratscrew/game');

const app = express();
const server = http.createServer(app);
const { game } = mountRatscrew(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failed = true; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t); }

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/ratscrew';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}
function emit(sock, ev, payload) {
  return new Promise((resolve) => sock.emit(ev, payload, resolve));
}
function until(sock, ev, pred, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error('timeout waiting for ' + ev)); }, ms || 8000);
    function h(p) { if (pred && !pred(p)) return; clearTimeout(t); sock.off(ev, h); resolve(p); }
    sock.on(ev, h);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasEvent = (type, extra) => (s) => (s.events || []).some((e) => e.type === type && Object.keys(extra || {}).every((k) => e[k] === extra[k]));

// Every card code in a public payload must already have been played face up.
const CARD_RE = /^(2|3|4|5|6|7|8|9|10|J|Q|K|A)[CDHS]$/;
function collectCards(node, out) {
  if (typeof node === 'string') { if (CARD_RE.test(node)) out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((n) => collectCards(n, out)); return out; }
  if (node && typeof node === 'object') Object.keys(node).forEach((k) => collectCards(node[k], out));
  return out;
}
const leaks = [];
function watchSecrecy(sock) {
  sock.on('state:table', (s) => {
    const played = new Set((s.events || []).filter((e) => e.type === 'play').map((e) => e.card));
    collectCards(s, []).forEach((c) => { if (!played.has(c)) leaks.push(c); });
  });
}

/** Stack the decks and hand the turn over, with the play lock lifted. */
function rig(decks, turnId) {
  Object.keys(decks).forEach((id) => { game.players.get(id).deck = decks[id].slice(); });
  game.pile = [];
  game.challenge = null;
  game.claim = null;
  game.turnId = turnId;
  game.nextPlayAt = 0;
  game.players.forEach((p) => { p.lastSlapAt = 0; });
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  const host = await connect();
  const a = await connect();
  const b = await connect();
  [host, a, b].forEach(watchSecrecy);

  section('Lobby');
  let res = await emit(a, 'player:join', { playerId: 'pa', name: 'Alice' });
  check(!res.ok && res.reason === 'host-absent', 'cannot join before the host arrives');
  res = await emit(host, 'host:auth', {});
  check(res.ok && res.phase === 'LOBBY' && res.lobby.flush === true, 'host authenticates; Flush defaults on');
  res = await emit(a, 'player:join', { playerId: 'pa', name: 'Alice' });
  check(res.ok, 'Alice joins');
  res = await emit(b, 'player:join', { playerId: 'pb', name: 'alice' });
  check(!res.ok && res.reason === 'name-taken', 'names are unique, case-insensitively');
  const lobbySeen = until(host, 'state:lobby', (l) => l.total === 2);
  res = await emit(b, 'player:join', { playerId: 'pb', name: 'Bob' });
  check(res.ok && (await lobbySeen).players.map((p) => p.name).join() === 'Alice,Bob', 'Bob joins; the host sees both');
  res = await emit(a, 'host:setFlush', { flush: false });
  check(!res.ok && res.reason === 'not-host', 'only the host can change settings');
  res = await emit(host, 'host:setFlush', { flush: false });
  check(res.ok && res.flush === false, 'host turns Flush off');
  await emit(host, 'host:setFlush', { flush: true });
  res = await emit(host, 'host:addBot', {});
  check(res.ok && game.players.has('bot-1'), 'host adds a CPU');
  res = await emit(host, 'host:kick', { playerId: 'bot-1' });
  check(res.ok && !game.players.has('bot-1'), 'and removes it in the lobby');
  res = await emit(a, 'player:emote', { e: '🔥' });
  check(res.ok, 'reactions are open in the lobby');

  section('Start + turn enforcement');
  const firstTable = until(a, 'state:table', hasEvent('deal'));
  res = await emit(host, 'host:start', {});
  check(res.ok, 'host deals');
  const t0 = await firstTable;
  check(t0.phase === 'PLAYING' && t0.seats.every((s) => s.count === 26) && t0.turnPlayerId === 'pa', 'the phone gets the table: 26 each, Alice opens');
  res = await emit(a, 'player:play', {});
  check(!res.ok && res.reason === 'too-soon', 'nobody plays during the deal');
  res = await emit(b, 'player:play', {});
  check(!res.ok && res.reason === 'not-your-turn', 'out of turn is refused');
  const bubble = until(host, 'host:emote', (p) => p.id === 'pa' && p.kind === 'bubble', 2000);
  res = await emit(a, 'player:emote', { e: '🔥' });
  check(res.ok && res.kind === 'bubble' && !!(await bubble), 'mid-game reactions reach the host as seat bubbles');
  res = await emit(a, 'player:emote', { e: '😂' });
  check(!res.ok && res.reason === 'cooldown', 'with a short cooldown between them');
  res = await emit(a, 'player:slap', {});
  check(!res.ok && res.reason === 'empty', 'slapping an empty pile is ignored');

  section('Plays and the 2 s lock');
  rig({ pa: ['9C', '2D', '3D', '4D'], pb: ['9H', '5S', '6S', '7S'] }, 'pa');
  const played = until(host, 'state:table', hasEvent('play', { card: '9C', playerId: 'pa' }));
  res = await emit(a, 'player:play', {});
  check(res.ok, 'Alice flips her top card');
  const t1 = await played;
  check(t1.pile.join() === '9C' && t1.turnPlayerId === 'pb' && t1.nextPlayAt - t1.serverNow > 1500, 'the host sees it on the pile, Bob is next, locked ~2s');
  res = await emit(b, 'player:play', {});
  check(!res.ok && res.reason === 'too-soon', 'Bob must wait out the lock');

  section('Slaps');
  game.nextPlayAt = 0;
  await emit(b, 'player:play', {});
  const slapSeen = until(host, 'state:table', hasEvent('slap', { playerId: 'pa', pattern: 'double' }));
  res = await emit(a, 'player:slap', {});
  check(res.ok && res.result === 'good' && res.pattern === 'double' && res.count === 2, 'Alice slaps the Double first');
  res = await emit(b, 'player:slap', {});
  check(res.ok && res.result === 'late' && res.byId === 'pa', "Bob's slap is just late, no penalty");
  const t2 = await slapSeen;
  check(t2.claim && t2.claim.byId === 'pa' && t2.turnPlayerId === null, 'the host shows the pile held for Alice');
  const collected = await until(host, 'state:table', hasEvent('collect', { playerId: 'pa' }), SLAP_CLAIM_MS + 2000);
  const alice = collected.seats.find((s) => s.playerId === 'pa');
  check(alice.count === 5 && collected.pileCount === 0 && collected.turnPlayerId === 'pa', 'after the call, Alice collects and leads');
  check(game.players.get('pb').deck.length === 3, "Bob kept his cards");

  game.nextPlayAt = 0;
  await emit(a, 'player:play', {});
  const burnSeen = until(host, 'state:table', hasEvent('burn', { playerId: 'pb' }));
  res = await emit(b, 'player:slap', {});
  check(res.ok && res.result === 'bad' && res.burned === 2 && res.toId === 'pa', "a slap on a lone card is bad: Bob pays 2 to Alice, whose card it was");
  const t3 = await burnSeen;
  check(t3.seats.find((s) => s.playerId === 'pb').count === 1 && t3.seats.find((s) => s.playerId === 'pa').count === 6 && t3.pileCount === 1, 'the host sees the cards move; the pile is untouched');
  res = await emit(b, 'player:slap', {});
  check(res.ok && res.result === 'late' && res.good === false, 'a second slap on that card is ignored');
  res = await emit(a, 'player:slap', {});
  check(res.ok && res.result === 'late' && res.byId === 'pb' && game.players.get('pa').deck.length === 6, "and so is anyone else's — no extra penalty");

  section('A dropped phone: the table waits');
  rig({ pa: ['4C', '5C', '6C'], pb: ['7H', '8H', '9H'] }, 'pa');
  game.nextPlayAt = 0;
  await emit(a, 'player:play', {});
  const waiting = until(host, 'state:table', (s) => s.waitingOn === 'Bob');
  b.disconnect();
  const tw = await waiting;
  check(tw.turnPlayerId === 'pb' && tw.seats.find((s) => s.playerId === 'pb').connected === false, 'Bob drops on his turn: the host shows the wait');
  await sleep(3000);
  check(game.turnId === 'pb' && game.players.get('pb').deck.length === 3 && !game.players.get('pb').out, 'nobody plays for him, nothing is taken away');
  const b2 = await connect();
  watchSecrecy(b2);
  res = await emit(b2, 'player:reconnect', { playerId: 'pb' });
  check(res.ok && res.phase === 'PLAYING' && res.table && res.table.turnPlayerId === 'pb' && !res.table.waitingOn, 'Bob reconnects with the full table, still his turn');
  res = await emit(b2, 'player:play', {});
  check(res.ok, 'and plays on');

  section('CPU');
  {
    // A CPU in a live game (added straight to the engine; the lobby is long gone).
    const bot = { id: 'bot-x', name: 'CPU', socketId: null, isBot: true, connected: true, order: 99, deck: [], out: false, place: null, outAfter: 0, lastSlapAt: 0, stats: { played: 0, goodSlaps: 0, badSlaps: 0, burned: 0, piles: 0, cardsWon: 0, peak: 0 } };
    game.players.set(bot.id, bot);
    const realRng = game.rng;
    game.rng = () => 0.5;   // never "misses"
    rig({ pa: ['2C', '3C'], pb: ['4H', '5H'], 'bot-x': ['2S', 'KD', '6D'] }, 'pb');
    game.pile = ['2D'];
    const botPlayed = until(host, 'state:table', hasEvent('play', { playerId: 'bot-x' }), 5000);
    await emit(b2, 'player:play', {});   // 4H → the CPU is next
    const tb = await botPlayed;
    check(tb.pile.slice(-1)[0] === '2S', 'the CPU plays its turn once the lock lifts');
    const botSlap = await until(host, 'state:table', hasEvent('slap', { playerId: 'bot-x' }), 5000);
    check(botSlap.claim && botSlap.claim.byId === 'bot-x' && botSlap.claim.pattern === 'sandwich', 'the CPU slaps a Sandwich (2D · 4H · 2S)');
    await until(host, 'state:table', hasEvent('collect', { playerId: 'bot-x' }), SLAP_CLAIM_MS + 2000);
    game.rng = realRng;
    game.players.delete('bot-x');
  }

  section('The finish');
  rig({ pa: ['3H'], pb: ['4S', '5S', '6S'] }, 'pa');
  const winSeen = until(host, 'state:table', hasEvent('win', { playerId: 'pb' }));
  const finalA = until(a, 'state:final', null, END_MS + 3000);
  await emit(a, 'player:play', {});
  const tf = await winSeen;
  check(tf.ending && tf.winnerId === 'pb' && tf.seats.find((s) => s.playerId === 'pa').out, 'Alice plays her last card: out, Bob wins');
  const fin = await finalA;
  check(fin.winnerId === 'pb' && fin.standings[0].playerId === 'pb' && fin.standings[1].place === 2, 'everyone gets the final standings');
  res = await emit(a, 'player:emote', { e: '🎉' });
  const hostEmote = until(host, 'host:emote', null, 2000).catch(() => null);
  check(res.ok, 'reactions reopen on the final screen');
  res = await emit(b2, 'player:emote', { e: '😎' });
  check(!!(await hostEmote), 'and reach the host');

  section('Rematch');
  const reTable = until(a, 'state:table', hasEvent('deal'));
  res = await emit(host, 'host:rematch', {});
  const tr = await reTable;
  check(res.ok && tr.seats.every((s) => s.count === 26 && !s.out) && tr.turnPlayerId === 'pb', 'same seats, a fresh deal, the opener moves on');

  section('Host → Hub');
  const resetA = until(a, 'state:reset');
  const absentA = until(a, 'state:hostPresence', (p) => p.present === false);
  res = await emit(host, 'host:leave', {});
  await resetA;
  await absentA;
  check(res.ok && game.players.size === 0 && game.phase === 'LOBBY' && game.flush === true, 'reset to defaults; phones are sent back with the host away');
  const c = await connect();
  res = await emit(c, 'player:join', { playerId: 'pc', name: 'Cara' });
  check(!res.ok && res.reason === 'host-absent', 'joining is locked until the host returns');

  section('Secrecy');
  check(leaks.length === 0, 'no face-down card ever reached a client' + (leaks.length ? ' (leaked: ' + leaks.slice(0, 5).join(',') + ')' : ''));

  [host, a, b2, c].forEach((s) => s.disconnect());
  server.close();
  console.log(failed ? '\nFAILED' : '\nAll integration checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
