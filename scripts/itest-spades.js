'use strict';

// Headless end-to-end integration test for Spades. Spins up an in-process
// server, connects a host plus player sockets, and drives real socket traffic
// through the transport layer — the rules themselves are covered by
// scripts/test-spades-engine.js, so this file is about the WIRE:
// team lobby gating, hand secrecy (including face-down hands), bidding,
// illegal-play rejection, the roster surviving a disconnect, reconnection
// fidelity, scoring of a full hand and the roll into the next.
//
//   node scripts/itest-spades.js   (or: npm run itest:spades)

const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountSpades = require('../server/spades');
const { PHASES } = require('../server/spades/game');
const { scoreTeam } = require('../server/spades/deck');

const app = express();
const server = http.createServer(app);
mountSpades(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t); }

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/spades';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}
function emit(sock, ev, payload) {
  return new Promise((resolve) => sock.emit(ev, payload, resolve));
}
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
const publicEvents = [];
function watchPublic(sock) {
  ['state:lobby', 'state:deal', 'state:bid', 'state:table', 'state:trickEnd',
   'state:handEnd', 'state:final', 'state:bidPlaced'].forEach((ev) => {
    sock.on(ev, (p) => { publicEvents.push({ ev, payload: JSON.parse(JSON.stringify(p || {})) }); });
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
  section('Lobby & teams');

  const host = await connect();
  watchPublic(host);
  const auth = await emit(host, 'host:auth', {});
  check(auth && auth.ok, 'host authenticates');

  const players = {};
  const socks = {};
  const joinAcks = {};
  for (const name of ['Alice', 'Bob']) {
    const s = await connect();
    const pid = 'pid_' + name;
    const ack = await emit(s, 'player:join', { playerId: pid, name });
    check(ack && ack.ok, name + ' joins');
    players[name] = pid;
    socks[name] = s;
    joinAcks[name] = ack;
  }
  check(joinAcks.Alice.player.team === 'red' && joinAcks.Bob.player.team === 'blue',
    'newcomers alternate teams (Alice → Red, Bob → Blue)');

  const redBot = await emit(host, 'host:addBot', { team: 'red' });
  check(redBot && redBot.ok, 'host adds a CPU to Team Red');
  const redFull = await emit(host, 'host:addBot', { team: 'red' });
  check(redFull && redFull.reason === 'team-full', 'adding a CPU to a full team is refused');

  const lobbyBefore = once(host, 'state:lobby');
  await emit(host, 'host:setTargetScore', { targetScore: 200 });
  const l3 = await lobbyBefore;
  check(l3.canStart === false, 'cannot start at 2 v 1');
  const early = await emit(host, 'host:start', {});
  check(early && early.ok === false, 'host:start is refused at 2 v 1');
  check(l3.targetScore === 200, 'target score can be set to 200');
  const badTarget = await emit(host, 'host:setTargetScore', { targetScore: 250 });
  check(badTarget && badTarget.ok === false, 'a target outside 200/300/400/500 is refused');

  const blueBot = await emit(host, 'host:addBot', { team: 'blue' });
  check(blueBot && blueBot.ok, 'host adds a CPU to Team Blue');

  const spare = await connect();
  const fifth = await emit(spare, 'player:join', { playerId: 'pid_Eve', name: 'Eve' });
  check(fifth && fifth.ok === false && fifth.reason === 'game-full', 'a 5th player is rejected with game-full');
  const fullStatus = await emit(spare, 'query:status', {});
  check(fullStatus && fullStatus.full === true, 'status reports the table as full');
  spare.close();

  const lobbyReact = await emit(socks.Bob, 'player:emote', { e: '😀' });
  check(lobbyReact && lobbyReact.ok && lobbyReact.kind === 'float', 'a lobby emote floats');

  // Dropping Alice onto the full Blue team swaps her with Bob.
  const swapped = once(host, 'state:lobby');
  const aliceLobby = once(socks.Alice, 'state:lobby');
  const swapAck = await emit(host, 'host:assign', { playerId: players.Alice, team: 'blue', beforeId: players.Bob });
  check(swapAck && swapAck.ok && swapAck.swappedWith === players.Bob, 'dragging onto a full team swaps the two players');
  const ls = await swapped;
  check(ls.teams.red.length === 2 && ls.teams.blue.length === 2, 'both teams stay at two');
  check(ls.canStart === true, 'lobby can start at exactly 2 v 2');
  check(ls.teams.red.map((p) => p.seat).join('') === 'NS' && ls.teams.blue.map((p) => p.seat).join('') === 'EW',
    'Red sits N/S, Blue sits E/W');
  const aliceSeen = (await aliceLobby).players.find((p) => p.id === players.Alice);
  check(aliceSeen && aliceSeen.team === 'blue' && aliceSeen.seat === 'E', 'Alice is told her new team and seat (Blue, E)');
  const playerAssign = await emit(socks.Bob, 'host:assign', { playerId: players.Bob, team: 'blue' });
  check(playerAssign && playerAssign.reason === 'not-host', 'a player cannot move teams');

  // ═══════════ Start + deal ═══════════
  section('Deal & face-down hands');

  const priv = {};
  ['Alice', 'Bob'].forEach((n) => { socks[n].on('you:hand', (h) => { priv[n] = h; }); });

  const dealt = once(host, 'state:deal');
  const startAck = await emit(host, 'host:start', {});
  check(startAck && startAck.ok, 'host starts the game');
  const deal = await dealt;
  check(deal.seats.length === 4 && deal.seats.every((s) => s.bid === null), 'deal broadcast carries 4 seats, nobody has bid');
  check(deal.seats.every((s) => !('isDealer' in s)) && !('dealerSeat' in deal), 'no dealer is shown on any screen');
  const kick = await emit(host, 'host:kick', { playerId: players.Alice });
  check(kick && kick.ok === false, 'kicking is refused once the game has started');

  const bidPhase = await once(host, 'state:bid', 6000);
  await sleep(150);
  const order = ['N', 'E', 'S', 'W'];
  const firstSeat = bidPhase.seats.find((s) => s.playerId === bidPhase.bidTurnPlayerId);
  const firstBidder = firstSeat && firstSeat.seat;
  check(!!firstBidder, 'bidding opens with a named first bidder');
  check(priv.Alice && priv.Alice.cardCount === 13 && priv.Alice.hand.length === 0,
    'Alice\'s 13 cards are withheld while face down');
  check(priv.Bob && priv.Bob.revealed === false, 'Bob\'s hand starts face down too');

  // Reveal Alice now: she forfeits Blind Nil but sees her hand.
  const revealed = once(socks.Alice, 'you:hand');
  const rv = await emit(socks.Alice, 'player:reveal', {});
  check(rv && rv.ok, 'Alice turns her cards over');
  const aHand = await revealed;
  check(aHand.hand.length === 13 && aHand.revealed === true, 'the reveal delivers her 13 cards');
  check(aHand.canBlindNil === false, 'having looked, Blind Nil is no longer offered');

  // ═══════════ Bidding ═══════════
  section('Bidding');

  let provedWrongTurn = false;
  let provedNotLooked = false;
  let provedAlreadyLooked = false;
  let bobBlind = false;
  let bidBusy = { Alice: false, Bob: false };
  const bidsPlaced = [];
  host.on('state:bidPlaced', (b) => bidsPlaced.push(b));

  async function driveBid(name) {
    if (bidBusy[name]) return;
    bidBusy[name] = true;
    try {
      for (;;) {
        const h = priv[name];
        if (!h || h.phase !== 'BID') break;
        if (!h.yourBidTurn) {
          if (!provedWrongTurn && h.bid === null) {
            const r = await emit(socks[name], 'player:bid', { bid: 2 });
            provedWrongTurn = !!(r && (r.reason === 'not-your-turn' || r.reason === 'not-looked'));
          }
          break;
        }
        if (h.bid !== null) break;
        if (name === 'Bob' && !h.revealed) {
          if (!provedNotLooked) {
            const r = await emit(socks.Bob, 'player:bid', { bid: 3 });
            provedNotLooked = !!(r && r.reason === 'not-looked');
          }
          const r = await emit(socks.Bob, 'player:bid', { blind: true });
          bobBlind = !!(r && r.ok && r.blind && r.nil);
          continue;
        }
        if (name === 'Alice' && !provedAlreadyLooked) {
          const r = await emit(socks.Alice, 'player:bid', { blind: true });
          provedAlreadyLooked = !!(r && r.reason === 'already-looked');
        }
        const bad = await emit(socks[name], 'player:bid', { bid: 14 });
        if (!bad || bad.reason !== 'bad-bid') check(false, 'a bid of 14 is refused');
        const latest = priv[name];
        if (!latest.yourBidTurn) continue;
        if (!latest.revealed) { await emit(socks[name], 'player:reveal', {}); continue; }
        await emit(socks[name], 'player:bid', { bid: 3 });
      }
    } finally {
      bidBusy[name] = false;
    }
  }

  ['Alice', 'Bob'].forEach((n) => {
    socks[n].on('you:hand', (h) => { priv[n] = h; driveBid(n); });
  });
  driveBid('Alice'); driveBid('Bob');

  const firstTable = await once(host, 'state:table', 30000);
  check(firstTable.trickNumber === 1, 'play starts on trick 1 once all four have bid');
  check(firstTable.seats.every((s) => s.bid !== null), 'every seat has a bid on the table');
  check(bidsPlaced.length === 4, 'the host heard all four bids (state:bidPlaced)');
  check(provedWrongTurn, 'a player cannot bid out of turn');
  check(provedNotLooked, 'a normal bid needs the cards turned over first');
  check(provedAlreadyLooked, 'Blind Nil is refused once the cards have been seen');
  check(bobBlind, 'Bob bids Blind Nil while still face down');
  const bobSeat = firstTable.seats.find((s) => s.playerId === players.Bob);
  check(bobSeat && bobSeat.nil && bobSeat.blind, 'the table shows Bob\'s Blind Nil');
  const leader = firstTable.seats.find((s) => s.seat === firstBidder);
  check(firstTable.turnPlayerId === leader.playerId, 'the first bidder also leads trick 1');
  await sleep(150);
  check(priv.Bob.hand.length === 13 && priv.Bob.revealed, 'once play starts, the blind bidder sees his hand');

  // ═══════════ Playing ═══════════
  section('Playing');

  let provedIllegal = false;
  let provedNotInHand = false;
  let provedOffTurn = false;
  let stallBob = false;
  let bobStalled = null;
  const busy = { Alice: false, Bob: false };

  async function drive(name) {
    if (busy[name]) return;
    busy[name] = true;
    try {
      for (;;) {
        const h = priv[name];
        if (!h) break;
        if (h.phase === 'BID') {
          busy[name] = false;
          await driveBid(name);
          busy[name] = true;
          break;
        }
        if (h.phase === 'TRICK' && !h.yourTurn && !provedOffTurn && h.hand.length) {
          const r = await emit(socks[name], 'player:play', { card: h.hand[0] });
          provedOffTurn = !!(r && r.reason === 'not-your-turn');
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
            const res = await emit(socks[name], 'player:play', { card: illegal[0] });
            provedIllegal = !!(res && res.reason === 'illegal-card');
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
    socks[n].removeAllListeners('you:hand');
    socks[n].on('you:hand', (h) => { priv[n] = h; drive(n); });
  });
  drive('Alice'); drive('Bob');

  // ═══════════ Roster lock ═══════════
  section('Disconnect safety');

  stallBob = true;
  const deadline = Date.now() + 60000;
  while (!bobStalled && Date.now() < deadline) await sleep(40);

  if (bobStalled) {
    const frozen = bobStalled;
    const tableWait = once(host, 'state:table', 4000);
    socks.Bob.close();
    const waiting = await tableWait.catch(() => null);
    check(waiting && waiting.waitingOn === 'Bob', 'the host is told the table is waiting on Bob');
    await sleep(1200);

    const after = await emit(host, 'query:status', {});
    check(after.phase === PHASES.TRICK, 'the game stays in TRICK while a dropped player is on turn');
    check(after.full === true, 'the dropped player keeps their seat');

    const bob2 = await connect();
    const re = await emit(bob2, 'player:reconnect', { playerId: players.Bob });
    check(re && re.ok, 'Bob reconnects');
    check(re.player.team === 'red', 'Bob is still on Team Red');
    check(!!re.myHand && JSON.stringify(re.myHand.hand) === JSON.stringify(frozen.hand),
      'the restored hand is exactly the hand he had');
    check(re.myHand.yourTurn === true, 'it is still his turn — nobody played for him');
    check(re.myHand.nil && re.myHand.blind, 'his Blind Nil bid survived the reconnect');
    check(!!re.table && re.table.trickNumber === frozen.trickNumber, 'the reconnect ack carries the live table');

    socks.Bob = bob2;
    priv.Bob = re.myHand;
    stallBob = false;
    bob2.on('you:hand', (h) => { priv.Bob = h; drive('Bob'); });
    drive('Bob');
  } else {
    check(false, 'never observed a human turn to test a mid-trick disconnect');
    stallBob = false;
  }

  // ═══════════ Hand end ═══════════
  section('Hand end');

  const handEnd = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hand 1 never ended')), 240000);
    host.once('state:handEnd', (s) => { clearTimeout(t); resolve(s); });
  });
  check(provedOffTurn, 'a player off-turn cannot play');
  check(provedNotInHand, 'a card not in hand is rejected');
  if (provedIllegal) check(true, 'an illegal card is rejected');
  else console.log('  · (no human ever held an illegal card this hand — rule covered by the engine test)');

  const r = handEnd.results;
  check(handEnd.handNumber === 1 && r && r.red && r.blue, 'hand 1 reports both teams');
  const totalTricks = r.red.players.concat(r.blue.players).reduce((a, p) => a + p.tricks, 0);
  check(totalTricks === 13, 'all 13 tricks were accounted for');
  for (const t of ['red', 'blue']) {
    const expected = scoreTeam({ players: r[t].players.map((p) => ({ bid: p.bid, nil: p.nil, blind: p.blind, tricks: p.tricks })), bags: 0 });
    check(r[t].delta === expected.delta && r[t].total === expected.delta,
      'Team ' + t + ' scored ' + expected.delta + ' (got ' + r[t].delta + ')');
  }
  const bobRow = r.red.players.find((p) => p.playerId === players.Bob);
  check(bobRow && bobRow.blind && Math.abs(bobRow.nilPoints) === 200, 'Bob\'s Blind Nil was worth ±200');

  // Secrecy: no public broadcast ever carried a card that wasn't already on the table.
  const playedSoFar = new Set();
  let leaked = null;
  for (const e of publicEvents) {
    const p = e.payload;
    if (p.trick) p.trick.forEach((t) => playedSoFar.add(t.card));
    if (p.lastTrick && p.lastTrick.cards) p.lastTrick.cards.forEach((t) => playedSoFar.add(t.card));
    const seen = collectCardStrings(p, []);
    const bad = seen.find((c) => !playedSoFar.has(c));
    if (bad) { leaked = e.ev + ':' + bad; break; }
  }
  check(!leaked, 'no public broadcast ever revealed an unplayed card' + (leaked ? ' (' + leaked + ')' : ''));

  // ═══════════ Emotes ═══════════
  section('Emotes');

  const gotEmote = once(host, 'host:emote', 3000);
  const emote1 = await emit(socks.Alice, 'player:emote', { e: '🎉' });
  check(emote1 && emote1.ok && emote1.kind === 'float', 'an emote on the scoreboard floats');
  const seenEmote = await gotEmote;
  check(seenEmote && seenEmote.id === players.Alice, 'the host receives who sent it');
  const emote2 = await emit(socks.Alice, 'player:emote', { e: '😂' });
  check(emote2 && emote2.reason === 'cooldown', 'a second float inside the cooldown is refused');
  const badEmote = await emit(socks.Bob, 'player:emote', { e: '⚽' });
  check(badEmote && badEmote.reason === 'bad-emote', 'an emoji outside the set is rejected');
  await emit(host, 'host:setReactionsMuted', { muted: true });
  const whileMuted = await emit(socks.Bob, 'player:emote', { e: '😀' });
  check(whileMuted && whileMuted.reason === 'muted', 'an emote sent while muted is refused');
  await emit(host, 'host:setReactionsMuted', { muted: false });

  // ═══════════ Next hand ═══════════
  section('Next hand');

  ['Alice', 'Bob'].forEach((n) => { socks[n].removeAllListeners('you:hand'); socks[n].on('you:hand', (h) => { priv[n] = h; }); });
  const nextDeal = once(host, 'state:deal', 10000);
  const nextAck = await emit(host, 'host:nextHand', {});
  check(nextAck && nextAck.ok, 'host advances to the next hand');
  const deal2 = await nextDeal;
  check(deal2.handNumber === 2, 'hand 2 is dealt');
  check(deal2.seats.every((s) => s.bid === null && s.tricks === 0), 'bids and tricks reset for the new hand');
  check(deal2.teams.red.score === r.red.total && deal2.teams.blue.score === r.blue.total, 'team scores carry into hand 2');

  const bid2 = await once(host, 'state:bid', 6000);
  const first2 = bid2.seats.find((s) => s.playerId === bid2.bidTurnPlayerId);
  check(first2 && first2.seat === order[(order.indexOf(firstBidder) + 1) % 4], 'the first bidder moves one seat clockwise');
  await sleep(200);
  const bubble = await emit(socks.Bob, 'player:emote', { e: '😎' });
  check(bubble && bubble.ok && bubble.kind === 'bubble', 'an emote during bidding is a seat bubble');

  // A face-down hand stays face down across a reconnect.
  socks.Bob.close();
  await sleep(300);
  const bob3 = await connect();
  const re3 = await emit(bob3, 'player:reconnect', { playerId: players.Bob });
  check(re3 && re3.ok && re3.phase === 'BID' && !!re3.bid, 'reconnecting mid-bid returns the bidding snapshot');
  check(re3.myHand && re3.myHand.revealed === false && re3.myHand.hand.length === 0,
    'a face-down hand stays withheld after a reconnect');
  socks.Bob = bob3;

  // ═══════════ Reset ═══════════
  section('Reset');
  const resetEvt = once(socks.Alice, 'state:reset', 3000);
  const resetAck = await emit(host, 'host:reset', {});
  check(resetAck && resetAck.ok, 'host resets');
  await resetEvt;
  check(true, 'players are told the game was reset');
  const after = await emit(host, 'query:status', {});
  check(after.phase === PHASES.LOBBY && after.full === false, 'the table is back to an empty lobby');

  host.close();
  Object.values(socks).forEach((s) => s.close());
  server.close();
  console.log(failed ? '\nFAILED' : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
