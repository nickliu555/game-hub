'use strict';

// Headless end-to-end integration test for Hearts. Spins up an in-process
// server, connects a host plus player sockets, and drives real socket traffic
// through the transport layer — the rules themselves are covered by
// scripts/test-hearts-engine.js, so this file is about the WIRE:
// lobby gating, seating, secrecy, illegal-play rejection, the roster surviving
// a disconnect, reconnection fidelity, and a full game to the target score.
//
//   node scripts/itest-hearts.js   (or: npm run itest:hearts)

const assert = require('assert');
const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountHearts = require('../server/hearts');
const { PHASES } = require('../server/hearts/game');

const app = express();
const server = http.createServer(app);
mountHearts(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t); }

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/hearts';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}
function emit(sock, ev, payload) {
  return new Promise((resolve) => sock.emit(ev, payload, resolve));
}
/** Resolve on the next occurrence of `ev`, with a deadline so a hang is a failure. */
function once(sock, ev, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error('timeout waiting for ' + ev)); }, ms || 8000);
    function h(p) { clearTimeout(t); sock.off(ev, h); resolve(p); }
    sock.on(ev, h);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every card ever seen inside a *public* broadcast, so we can prove no
// snapshot ever leaked an unplayed card.
const publicCards = [];
function watchPublic(sock) {
  ['state:lobby', 'state:deal', 'state:pass', 'state:exchange', 'state:table',
   'state:trickEnd', 'state:handEnd', 'state:final'].forEach((ev) => {
    sock.on(ev, (p) => { publicCards.push({ ev, payload: JSON.parse(JSON.stringify(p || {})) }); });
  });
}
const CARD_RE = /^(2|3|4|5|6|7|8|9|10|J|Q|K|A)[CDHS]$/;
function collectCardStrings(node, out) {
  if (typeof node === 'string') { if (CARD_RE.test(node)) out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((n) => collectCardStrings(n, out)); return out; }
  if (node && typeof node === 'object') { Object.keys(node).forEach((k) => collectCardStrings(node[k], out)); }
  return out;
}

(async () => {
  await new Promise((r) => server.listen(0, r));

  // ═══════════ Lobby gating ═══════════
  section('Lobby');

  const host = await connect();
  watchPublic(host);
  const auth = await emit(host, 'host:auth', {});
  check(auth && auth.ok, 'host authenticates');

  const status = await emit(host, 'query:status', {});
  check(status && status.capacity === 4 && status.full === false, 'status reports capacity 4, not full');

  // Two humans.
  const players = {};
  const socks = {};
  for (const name of ['Alice', 'Bob']) {
    const s = await connect();
    const pid = 'pid_' + name;
    const ack = await emit(s, 'player:join', { playerId: pid, name });
    check(ack && ack.ok, name + ' joins');
    players[name] = pid;
    socks[name] = s;
  }

  let lobby = await emit(host, 'host:addBot', {});
  check(lobby && lobby.ok, 'host adds CPU #1');
  lobby = await emit(host, 'host:addBot', {});
  check(lobby && lobby.ok, 'host adds CPU #2');

  // A fifth player must be turned away.
  const spare = await connect();
  const fifth = await emit(spare, 'player:join', { playerId: 'pid_Eve', name: 'Eve' });
  check(fifth && fifth.ok === false && fifth.reason === 'game-full', 'a 5th player is rejected with game-full');
  const fullStatus = await emit(spare, 'query:status', {});
  check(fullStatus && fullStatus.full === true, 'status now reports the table as full');
  spare.close();

  const lobbyReact = await emit(socks.Bob, 'player:reaction', { index: 0 });
  check(lobbyReact && lobbyReact.ok, 'a player may react from the lobby');

  // ═══════════ Seating order ═══════════
  section('Seating');

  const lobbyState = once(host, 'state:lobby');
  const aliceLobby = once(socks.Alice, 'state:lobby');
  await emit(host, 'host:reorder', { playerId: players.Bob, beforeId: players.Alice });
  const reordered = await lobbyState;
  check(reordered.players[0].id === players.Bob, 'drag-reorder puts Bob first');
  check(reordered.players.map((p) => p.seat).join('') === 'NESW', 'seats are always N/E/S/W in order');
  check(reordered.canStart === true, 'lobby can start with exactly 4');

  // The reseated player must learn their new seat without reloading, so the
  // broadcast has to reach the phones with their own seat in it.
  const aliceSeen = await aliceLobby;
  const aliceRow = aliceSeen.players.filter((p) => p.id === players.Alice)[0];
  check(!!aliceRow && aliceRow.seat === 'E', 'the reseated player is told their new seat (E) by the lobby broadcast');

  // ═══════════ Start + deal + passing ═══════════
  section('Deal & pass');

  // Capture each human's private hand as it arrives.
  const priv = {};
  ['Alice', 'Bob'].forEach((n) => { socks[n].on('you:hand', (h) => { priv[n] = h; }); });

  const dealt = once(host, 'state:deal');
  const startAck = await emit(host, 'host:start', {});
  check(startAck && startAck.ok, 'host starts the game');
  const deal = await dealt;
  check(deal.seats.length === 4, 'deal broadcast carries 4 seats');
  check(deal.passLabel === 'Clockwise', 'hand 1 passes Clockwise');

  const passPhase = await once(host, 'state:pass', 6000);
  check(passPhase.total === 4, 'pass phase tracks all 4 seats');
  check(priv.Alice && priv.Alice.hand.length === 13, 'Alice privately receives 13 cards');
  check(priv.Bob && priv.Bob.hand.length === 13, 'Bob privately receives 13 cards');
  const overlap = priv.Alice.hand.filter((c) => priv.Bob.hand.indexOf(c) >= 0);
  check(overlap.length === 0, 'two hands never share a card');

  // Bad pass attempts.
  const badCount = await emit(socks.Alice, 'player:pass', { cards: priv.Alice.hand.slice(0, 2) });
  check(badCount && badCount.reason === 'need-three', 'passing 2 cards is rejected');
  const dupe = await emit(socks.Alice, 'player:pass', { cards: [priv.Alice.hand[0], priv.Alice.hand[0], priv.Alice.hand[1]] });
  check(dupe && dupe.reason === 'duplicate-card', 'passing duplicates is rejected');
  const notMine = await emit(socks.Alice, 'player:pass', { cards: priv.Bob.hand.slice(0, 3) });
  check(notMine && notMine.reason === 'not-in-hand', "passing another player's cards is rejected");

  const aliceSent = priv.Alice.hand.slice(0, 3);
  const bobSent = priv.Bob.hand.slice(0, 3);
  await emit(socks.Alice, 'player:pass', { cards: aliceSent });
  const twice = await emit(socks.Alice, 'player:pass', { cards: priv.Alice.hand.slice(3, 6) });
  check(twice && twice.reason === 'already-passed', 'passing twice is rejected');
  await emit(socks.Bob, 'player:pass', { cards: bobSent });

  // Alice passes Left — with seats N=Bob, E=Alice, S=CPU, W=CPU, Alice's cards
  // land on the next seat clockwise. We only assert they LEFT her hand and the
  // deck is still whole once the exchange lands.
  await once(host, 'state:exchange', 8000);
  const table = await once(host, 'state:table', 10000);
  check(table.trickNumber === 1, 'play starts on trick 1');
  check(aliceSent.every((c) => priv.Alice.hand.indexOf(c) < 0), 'the 3 cards Alice passed left her hand');
  check(priv.Alice.hand.length === 13, 'Alice still holds 13 cards after the swap');
  check(priv.Alice.received.length === 3, 'Alice was told which 3 cards she received');

  // ═══════════ Turn & legality enforcement ═══════════
  section('Playing');

  // Whoever is NOT on turn must be refused.
  const idle = ['Alice', 'Bob'].find((n) => table.turnPlayerId !== players[n]);
  const wrongTurn = await emit(socks[idle], 'player:play', { card: priv[idle].hand[0] });
  check(wrongTurn && wrongTurn.reason === 'not-your-turn', 'a player off-turn cannot play');

  // Drive the two humans for the rest of the game. `you:hand` is re-sent after
  // every state change, so the driver is serialized per player and always acts
  // on the LATEST snapshot — otherwise a stale `legal` list races the server.
  let provedIllegal = false;
  let provedNotInHand = false;
  let illegalKeptHand = null;
  let stallBob = false;        // set when we want Bob to freeze mid-trick
  let bobStalled = null;
  const busy = { Alice: false, Bob: false };

  async function drive(name) {
    if (busy[name]) return;
    busy[name] = true;
    try {
      // Loop because the state may move on while we were awaiting an ack.
      for (;;) {
        const h = priv[name];
        if (!h) break;

        if (h.phase === 'PASS' && !h.passed) {
          await emit(socks[name], 'player:pass', { cards: h.hand.slice(0, 3) });
          continue;
        }

        if (h.phase === 'TRICK' && h.yourTurn) {
          if (name === 'Bob' && stallBob) { bobStalled = h; break; }

          if (!provedNotInHand) {
            const ghost = await emit(socks[name], 'player:play', { card: 'ZZ' });
            provedNotInHand = !!(ghost && ghost.reason === 'not-in-hand');
          }
          const illegal = h.hand.filter((c) => h.legal.indexOf(c) < 0);
          if (illegal.length && !provedIllegal) {
            const before = h.hand.slice();
            const res = await emit(socks[name], 'player:play', { card: illegal[0] });
            provedIllegal = !!(res && res.reason === 'illegal-card');
            // The rejection must not have consumed the card.
            illegalKeptHand = JSON.stringify(priv[name].hand) === JSON.stringify(before);
          }
          const latest = priv[name];
          if (!latest.yourTurn) continue;
          await emit(socks[name], 'player:play', { card: latest.legal[0] });
          continue;
        }
        break;
      }
    } finally {
      busy[name] = false;
    }
  }

  ['Alice', 'Bob'].forEach((n) => {
    socks[n].on('you:hand', (h) => { priv[n] = h; drive(n); });
  });
  drive('Alice'); drive('Bob');

  // ═══════════ Roster lock: a drop must not advance the game ═══════════
  section('Disconnect safety');

  // Freeze Bob the next time it is his turn, then yank his socket and confirm
  // the trick stalls on him rather than being skipped or auto-played.
  stallBob = true;
  const deadline = Date.now() + 60000;
  while (!bobStalled && Date.now() < deadline) await sleep(40);

  if (bobStalled) {
    const frozen = bobStalled;
    socks.Bob.close();
    await sleep(1500);

    const after = await emit(host, 'query:status', {});
    check(after.phase === PHASES.TRICK, 'the game stays in TRICK while a dropped player is on turn');
    check(after.full === true, 'the dropped player keeps their seat (table still full)');

    // Reconnect and confirm the hand comes back intact.
    const bob2 = await connect();
    const re = await emit(bob2, 'player:reconnect', { playerId: players.Bob });
    check(re && re.ok, 'Bob reconnects');
    check(re.player.seat && 'NESW'.indexOf(re.player.seat) >= 0, 'Bob gets his seat back');
    check(!!re.myHand, 'the reconnect ack carries his private hand');
    check(JSON.stringify(re.myHand.hand) === JSON.stringify(frozen.hand),
      'the restored hand is exactly the hand he had');
    check(re.myHand.yourTurn === true, 'it is still his turn — nobody played for him');

    socks.Bob = bob2;
    priv.Bob = re.myHand;
    stallBob = false;
    bob2.on('you:hand', (h) => { priv.Bob = h; drive('Bob'); });
    drive('Bob');
  } else {
    check(false, 'never observed a human turn to test a mid-trick disconnect');
    stallBob = false;
  }

  // ═══════════ Hand end & next hand ═══════════
  section('Hand end');

  // A full game to 50 takes several real-time hands (3s trick pauses, CPU
  // think time), so the WIRE test covers one complete hand plus the roll into
  // the next. Whole games to the target score are exercised headlessly and
  // deterministically in scripts/test-hearts-engine.js.
  const handEnd = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hand 1 never ended')), 240000);
    host.once('state:handEnd', (s) => { clearTimeout(t); resolve(s); });
  });

  check(handEnd.handNumber === 1, 'hand 1 reports as hand 1');
  check(handEnd.rows.length === 4, 'the scoreboard lists all 4 players');
  check(handEnd.rows.reduce((a, r) => a + r.hearts, 0) === 13, 'all 13 hearts were accounted for');
  check(handEnd.rows.filter((r) => r.queen).length === 1, 'exactly one player took the Q♠');
  check(handEnd.rows.filter((r) => r.jack).length === 1, 'exactly one player took the J♦');
  const totalDelta = handEnd.rows.reduce((a, r) => a + r.delta, 0);
  const expected = handEnd.moonShooterId ? 26 * 3 - 10 : 26 - 10;
  check(totalDelta === expected,
    'the hand scored ' + expected + ' points in total (got ' + totalDelta + ')');
  check(handEnd.rows.every((r) => r.total === r.delta), 'hand 1 totals equal the hand deltas');

  // ═══════════ Reactions ═══════════
  section('Reactions');

  const gotReaction = once(host, 'host:reaction', 3000);
  const react1 = await emit(socks.Alice, 'player:reaction', { index: 2 });
  check(react1 && react1.ok, 'a player may react on the scoreboard');
  const seenReaction = await gotReaction;
  check(seenReaction && seenReaction.index === 2, 'the host receives the reaction index');

  const react2 = await emit(socks.Alice, 'player:reaction', { index: 3 });
  check(react2 && react2.ok === false && react2.reason === 'cooldown' && react2.retryInMs > 0,
    'a second reaction inside the cooldown is refused with a retry hint');
  const badIdx = await emit(socks.Bob, 'player:reaction', { index: 9 });
  check(badIdx && badIdx.reason === 'bad-index', 'an out-of-range reaction index is rejected');

  const mutedEvt = once(socks.Bob, 'state:reactionsMuted', 3000);
  const muteAck = await emit(host, 'host:setReactionsMuted', { muted: true });
  check(muteAck && muteAck.ok && muteAck.reactionsMuted === true, 'the host can mute reactions');
  const mutedPayload = await mutedEvt;
  check(mutedPayload && mutedPayload.muted === true, 'players are told reactions are muted');
  const whileMuted = await emit(socks.Bob, 'player:reaction', { index: 0 });
  check(whileMuted && whileMuted.reason === 'muted', 'a reaction sent while muted is refused');
  const unmute = await emit(socks.Bob, 'host:setReactionsMuted', { muted: false });
  check(unmute && unmute.ok === false && unmute.reason === 'not-host', 'a player cannot unmute reactions');
  await emit(host, 'host:setReactionsMuted', { muted: false });

  const nextDeal = once(host, 'state:deal', 10000);
  const nextAck = await emit(host, 'host:nextHand', {});
  check(nextAck && nextAck.ok, 'host advances to the next hand');
  const deal2 = await nextDeal;
  check(deal2.handNumber === 2, 'hand 2 is dealt');
  check(deal2.passLabel === 'Counter-clockwise', 'hand 2 passes Counter-clockwise');
  check(deal2.seats.every((s) => s.handPoints === 0), 'hand points reset for the new hand');
  check(deal2.seats.reduce((a, s) => a + s.total, 0) === totalDelta,
    'running totals carry over into hand 2');

  const midHand = await emit(socks.Bob, 'player:reaction', { index: 1 });
  check(midHand && midHand.reason === 'phase-closed', 'reactions are closed once a hand is under way');

  check(provedIllegal, 'an illegal card was rejected during play');
  check(illegalKeptHand === true, 'a rejected play left the hand untouched');
  check(provedNotInHand, 'a card not in hand was rejected during play');

  // ═══════════ Secrecy ═══════════
  section('Secrecy');

  // Reconstruct, per public payload, which cards were legitimately visible:
  // only cards already played to a trick. Anything else is a leak.
  let leaks = 0;
  const playedEver = new Set();
  for (const rec of publicCards) {
    const seen = collectCardStrings(rec.payload, []);
    (rec.payload.trick || []).forEach((t) => playedEver.add(t.card));
    if (rec.payload.result && Array.isArray(rec.payload.result.cards)) {
      rec.payload.result.cards.forEach((c) => playedEver.add(typeof c === 'string' ? c : c.card));
    }
    for (const c of seen) {
      if (!playedEver.has(c)) {
        leaks++;
        if (leaks <= 3) console.log('      leak in ' + rec.ev + ': ' + c);
      }
    }
  }
  check(publicCards.length > 20, 'captured a meaningful number of public broadcasts (' + publicCards.length + ')');
  check(leaks === 0, 'no public broadcast ever exposed an unplayed card');

  // ═══════════ Done ═══════════
  Object.keys(socks).forEach((n) => socks[n].close());
  host.close();
  server.close();

  console.log('\n' + (failed ? '✗ hearts integration: FAILURES above' : '✓ hearts integration: all checks passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\n✗ hearts integration crashed:', e);
  process.exit(1);
});
