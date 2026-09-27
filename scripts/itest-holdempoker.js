'use strict';

// Headless end-to-end integration test for Hold'em Poker. Spins up an
// in-process server, connects a host plus player sockets, and drives real
// socket traffic — the rules themselves are covered by
// scripts/test-holdempoker-engine.js, so this file is about the WIRE:
// lobby gating, secrecy, turn enforcement, the table waiting on a dropped
// player, reconnection fidelity, pre-actions, emotes, show-cards, and a
// tournament played to the final standings.
//
//   node scripts/itest-holdempoker.js   (or: npm run itest:holdempoker)

const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountHoldemPoker = require('../server/holdempoker');

const app = express();
const server = http.createServer(app);
mountHoldemPoker(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t); }

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/holdempoker';
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
/** Resolve on the first `ev` whose payload passes `pred`. */
function until(sock, ev, pred, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error('timeout waiting for ' + ev)); }, ms || 20000);
    function h(p) { if (!pred(p)) return; clearTimeout(t); sock.off(ev, h); resolve(p); }
    sock.on(ev, h);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Secrecy bookkeeping ----------------
const CARD_RE = /^(2|3|4|5|6|7|8|9|10|J|Q|K|A)[CDHS]$/;
function collectCards(node, out) {
  if (typeof node === 'string') { if (CARD_RE.test(node)) out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((n) => collectCards(n, out)); return out; }
  if (node && typeof node === 'object') Object.keys(node).forEach((k) => collectCards(node[k], out));
  return out;
}
const publicLog = [];
let gameNo = 1;
function watchPublic(sock) {
  ['state:lobby', 'state:table', 'state:handEnd', 'state:final'].forEach((ev) => {
    sock.on(ev, (p) => publicLog.push({ ev, game: gameNo, payload: JSON.parse(JSON.stringify(p || {})) }));
  });
}
// 'game:hand' → { playerId: hole } for the humans, from their private feed.
const knownHoles = {};

// ---------------- Human drivers ----------------
const humans = {};   // name → { sock, pid, me, mode, busy }

function track(name, sock, pid) {
  const h = humans[name] || (humans[name] = { mode: 'stall', busy: false });
  h.sock = sock;
  h.pid = pid;
  sock.on('you:state', (s) => {
    h.me = s;
    if (s.hole && s.hole.length) {
      const k = gameNo + ':' + s.handNumber;
      knownHoles[k] = knownHoles[k] || {};
      knownHoles[k][pid] = s.hole.slice();
    }
    drive(name);
  });
  return h;
}

async function drive(name) {
  const h = humans[name];
  if (h.busy) return;
  h.busy = true;
  try {
    for (;;) {
      const s = h.me;
      if (!s || !s.yourTurn || h.mode === 'stall') break;
      let a;
      if (h.mode === 'shove') a = s.canRaise ? { type: 'raise', amount: s.maxRaiseTo } : (s.canCheck ? { type: 'check' } : { type: 'call' });
      else if (h.mode === 'fold') a = s.canCheck ? { type: 'check' } : { type: 'fold' };
      else if (h.mode === 'raiseMin') a = s.canRaise ? { type: 'raise', amount: s.minRaiseTo } : (s.canCheck ? { type: 'check' } : { type: 'call' });
      else a = s.canCheck ? { type: 'check' } : { type: 'call' };
      const before = s;
      await emit(h.sock, 'player:action', a);
      if (h.me === before) await sleep(50);
      if (h.me === before) break;
    }
  } finally {
    h.busy = false;
  }
}
function setMode(name, mode) { humans[name].mode = mode; drive(name); }

(async () => {
  await new Promise((r) => server.listen(0, r));

  // ═══════════ Lobby ═══════════
  section('Lobby');
  const host = await connect();
  watchPublic(host);
  let lastTable = null;
  host.on('state:table', (s) => { lastTable = s; });
  host.on('state:handEnd', (s) => { lastTable = s; });

  const auth = await emit(host, 'host:auth', {});
  check(auth && auth.ok && auth.capacity === 8, 'host authenticates; capacity is 8');

  for (const name of ['Alice', 'Bob', 'Carol']) {
    const s = await connect();
    const pid = 'pid_' + name;
    const ack = await emit(s, 'player:join', { playerId: pid, name });
    check(ack && ack.ok, name + ' joins');
    track(name, s, pid);
  }
  for (let i = 0; i < 5; i++) await emit(host, 'host:addBot', {});
  const full = await emit(host, 'query:status', {});
  check(full.full === true, 'table reports full at 8');
  const spare = await connect();
  const ninth = await emit(spare, 'player:join', { playerId: 'pid_Eve', name: 'Eve' });
  check(ninth && ninth.reason === 'game-full', 'a 9th player is rejected with game-full');
  spare.close();

  // Trim back to 3 humans + 2 CPUs.
  for (const id of ['bot-3', 'bot-4', 'bot-5']) {
    const k = await emit(host, 'host:kick', { playerId: id });
    check(k && k.ok, 'host removes ' + id + ' in the lobby');
  }
  const notHost = await emit(humans.Alice.sock, 'host:start', {});
  check(notHost && notHost.reason === 'not-host', 'a player cannot start the game');
  const badLevel = await emit(host, 'host:setHandsPerLevel', { handsPerLevel: 4 });
  check(badLevel && badLevel.ok === false, 'blinds-every-4 is not an option');
  const lobbyEvt = once(host, 'state:lobby');
  const goodLevel = await emit(host, 'host:setHandsPerLevel', { handsPerLevel: 3 });
  check(goodLevel && goodLevel.ok && goodLevel.handsPerLevel === 3, 'host sets blinds up every 3 hands');
  const lob = await lobbyEvt;
  check(lob.handsPerLevel === 3 && lob.total === 5 && lob.canStart, 'lobby broadcast reflects 5 seated and ready');

  const reorderEvt = once(host, 'state:lobby');
  await emit(host, 'host:reorder', { playerId: 'pid_Carol', beforeId: 'pid_Alice' });
  const reordered = await reorderEvt;
  check(reordered.players[0].id === 'pid_Carol' && reordered.players[0].seat === 1, 'drag-reorder seats Carol in seat 1');

  const lobbyEmote = once(host, 'host:emote', 3000);
  const lobbyReact = await emit(humans.Bob.sock, 'player:emote', { e: '😀' });
  check(lobbyReact && lobbyReact.ok, 'a player may emote from the lobby');
  const lobbySeen = await lobbyEmote.catch(() => null);
  check(lobbySeen && lobbySeen.id === 'pid_Bob' && lobbySeen.e === '😀', 'the host learns who emoted and which emoji');

  // ═══════════ Start & deal ═══════════
  section('Deal');
  const firstTable = once(host, 'state:table');
  const startAck = await emit(host, 'host:start', {});
  check(startAck && startAck.ok, 'host starts the tournament');
  const t0 = await firstTable;
  check(t0.phase === 'DEAL' && t0.handNumber === 1, 'hand 1 is dealt');
  check(t0.seats.every((s) => s.stack + s.bet === 1500), 'everyone starts with 1,500');
  check(t0.smallBlind === 10 && t0.bigBlind === 20, 'blinds open at 10 / 20');
  check(t0.seats.every((s) => s.cards === null), 'no hole card is public');
  await sleep(200);
  const holes = ['Alice', 'Bob', 'Carol'].map((n) => humans[n].me && humans[n].me.hole);
  check(holes.every((h) => h && h.length === 2), 'every human privately receives two cards');
  check(new Set([].concat.apply([], holes)).size === 6, 'no two players share a card');
  const joinLate = await connect();
  const late = await emit(joinLate, 'player:join', { playerId: 'pid_Late', name: 'Late' });
  check(late && late.reason === 'game-in-progress', 'nobody can join once the cards are out');
  joinLate.close();
  const kickMid = await emit(host, 'host:kick', { playerId: 'pid_Bob' });
  check(kickMid && kickMid.ok === false, 'kicking is lobby-only');

  // ═══════════ Turns ═══════════
  section('Turns');
  const humanTurn = (s) => s.phase === 'BETTING' && s.turnPlayerId && s.turnPlayerId.indexOf('pid_') === 0;
  const onTurn = (lastTable && humanTurn(lastTable)) ? lastTable
    : await until(host, 'state:table', humanTurn, 60000).catch(() => null);
  check(!!onTurn, 'the action reaches a human');
  if (onTurn) {
    const xName = Object.keys(humans).find((n) => humans[n].pid === onTurn.turnPlayerId);
    const others = Object.keys(humans).filter((n) => n !== xName);
    const yName = others[0];
    const zName = others[1];
    await sleep(150);
    const off = await emit(humans[yName].sock, 'player:action', { type: 'call' });
    check(off && off.reason === 'not-your-turn', 'a player off-turn cannot act');
    const x = humans[xName];
    if (x.me.canCheck) {
      const f = await emit(x.sock, 'player:action', { type: 'fold' });
      check(f && f.reason === 'can-check', 'folding is refused when checking is free');
    }
    const badRaise = await emit(x.sock, 'player:action', { type: 'raise', amount: 1 });
    check(badRaise && (badRaise.reason === 'too-little' || badRaise.reason === 'cannot-raise'), 'an under-minimum raise is refused');
    const preOnTurn = await emit(x.sock, 'player:preAction', { type: 'callAny' });
    check(preOnTurn && preOnTurn.reason === 'your-turn', 'a pre-action is refused on your own turn');

    // Z queues Call Any and then goes quiet: the table must still move past them.
    const zPre = await emit(humans[zName].sock, 'player:preAction', { type: 'callAny' });
    check(zPre && zPre.ok && zPre.preAction === 'callAny', zName + ' queues Call Any');

    // ═══════════ Roster lock ═══════════
    section('Disconnect safety');
    const frozenHole = x.me.hole.slice();
    x.sock.close();
    await sleep(2500);
    check(lastTable && lastTable.phase === 'BETTING' && lastTable.turnPlayerId === x.pid,
      'the table waits on the dropped player instead of skipping them');
    check(lastTable && lastTable.waitingOn === xName, 'the host is told who it is waiting for');
    const seatX = lastTable.seats.find((s) => s.playerId === x.pid);
    check(seatX && !seatX.folded && seatX.connected === false, 'the dropped player is neither folded nor removed');

    const x2 = await connect();
    const re = await emit(x2, 'player:reconnect', { playerId: x.pid });
    check(re && re.ok && re.phase === 'BETTING', xName + ' reconnects mid-hand');
    check(re.me && re.me.yourTurn === true, 'it is still their turn — nobody acted for them');
    check(re.me && JSON.stringify(re.me.hole) === JSON.stringify(frozenHole), 'the same two hole cards come back');
    check(re.table && re.table.handNumber === 1, 'the reconnect ack carries the table snapshot');
    x.me = re.me;
    track(xName, x2, x.pid);

    const zSawPre = until(host, 'state:table', (s) => {
      const z = s.seats.find((q) => q.playerId === humans[zName].pid);
      return z && z.lastAction && (z.lastAction.type === 'call' || z.lastAction.type === 'check' || z.lastAction.type === 'allin');
    }, 30000).then(() => true).catch(() => false);
    setMode(xName, 'call');
    setMode(yName, 'call');
    check(await zSawPre, zName + "'s queued Call Any acted for them while they stayed silent");
    setMode(zName, 'call');
  }

  // ═══════════ Hand end & emotes ═══════════
  section('Hand end & emotes');
  const midEmote = once(host, 'host:emote', 3000);
  const midReact = await emit(humans.Carol.sock, 'player:emote', { e: '\u{1F631}' });
  check(midReact && midReact.ok, 'emotes stay open while a hand is live (including the new shocked face)');
  const midSeen = await midEmote.catch(() => null);
  check(midSeen && midSeen.id === 'pid_Carol', 'the host receives the mid-hand emote');

  const he = (lastTable && lastTable.phase === 'HAND_END' && lastTable.handNumber === 1) ? lastTable
    : await once(host, 'state:handEnd', 120000);
  check(he && he.result && he.result.pots.length >= 1, 'hand 1 resolves with a result');
  const paid = he.result.pots.reduce((a, p) => a + p.winners.reduce((b, w) => b + w.amount, 0), 0);
  const potSum = he.result.pots.reduce((a, p) => a + p.amount, 0);
  check(paid === potSum, 'every chip in the pot was paid out');
  check(he.seats.reduce((a, s) => a + s.stack, 0) === 1500 * 5, 'total chips are conserved');

  // Use humans still in the tournament — a busted player is (correctly) refused as 'out'.
  const alive = ['Alice', 'Bob', 'Carol'].filter((n) => {
    const seat = he.seats.find((q) => q.playerId === humans[n].pid);
    return seat && !seat.busted;
  });
  const [first, second] = alive.length >= 2 ? alive : [alive[0], alive[0]];
  if (!first) {
    // Possible when a CPU shove is called by every "call"-mode human and holds up.
    console.log('  – every human busted on hand 1; skipping the between-hands emote checks');
  } else {
  const gotReaction = once(host, 'host:emote', 3000);
  const react1 = await emit(humans[first].sock, 'player:emote', { e: '🎉' });
  check(react1 && react1.ok, 'a player may emote between hands');
  const seen = await gotReaction.catch(() => null);
  check(seen && seen.e === '🎉' && seen.id === humans[first].pid, 'the host receives the emote');
  const react2 = await emit(humans[first].sock, 'player:emote', { e: '😂' });
  check(react2 && react2.reason === 'cooldown' && react2.retryInMs > 0,
    'a second emote inside the cooldown is refused' + (react2 && react2.reason !== 'cooldown' ? ' (got ' + JSON.stringify(react2) + ')' : ''));
  const badIdx = await emit(humans[second].sock, 'player:emote', { e: '⚽' });
  check(badIdx && badIdx.reason === 'bad-emote', 'an emoji outside the set is rejected');
  const muteAck = await emit(host, 'host:setReactionsMuted', { muted: true });
  check(muteAck && muteAck.reactionsMuted === true, 'the host can mute emotes');
  const whileMuted = await emit(humans[second].sock, 'player:emote', { e: '😀' });
  check(whileMuted && (whileMuted.reason === 'muted' || (second === first && whileMuted.reason === 'cooldown')),
    'an emote while muted is refused' + (whileMuted && whileMuted.reason !== 'muted' ? ' (got ' + JSON.stringify(whileMuted) + ')' : ''));
  await emit(host, 'host:setReactionsMuted', { muted: false });
  }

  const deal2 = await until(host, 'state:table', (s) => s.handNumber === 2, 20000).catch(() => null);
  check(!!deal2, 'the next hand deals itself');
  if (deal2) {
    check(deal2.buttonId !== t0.buttonId, 'the button moved on');
    check(deal2.seats.reduce((a, s) => a + s.stack + s.bet, 0) === 1500 * 5, 'chips carried into hand 2');
  }

  // ═══════════ Reset ═══════════
  section('Reset');
  Object.keys(humans).forEach((n) => { humans[n].mode = 'stall'; });
  const resetSeen = once(humans.Alice.sock, 'state:reset', 3000).then(() => true).catch(() => false);
  await emit(host, 'host:reset', {});
  check(await resetSeen, 'players are told the game was reset');
  gameNo++;
  Object.keys(humans).forEach((n) => humans[n].sock.close());
  Object.keys(humans).forEach((n) => delete humans[n]);

  // ═══════════ Heads-up to the finish ═══════════
  section('Show cards');
  for (const name of ['Ann', 'Ben']) {
    const s = await connect();
    const pid = 'pid2_' + name;
    const ack = await emit(s, 'player:join', { playerId: pid, name });
    check(ack && ack.ok, name + ' joins the new game');
    track(name, s, pid);
  }
  const hu = once(host, 'state:table');
  await emit(host, 'host:start', {});
  await hu;
  const huTurn = await until(host, 'state:table', (s) => s.phase === 'BETTING' && !!s.turnPlayerId, 10000);
  const opener = Object.keys(humans).find((n) => humans[n].pid === huTurn.turnPlayerId);
  const closer = Object.keys(humans).find((n) => n !== opener);
  setMode(closer, 'fold');
  setMode(opener, 'raiseMin');
  const foldEnd = await once(host, 'state:handEnd', 15000);
  check(foldEnd.result.type === 'fold' && foldEnd.result.winners[0] === humans[opener].pid, opener + ' wins uncontested');
  check(foldEnd.seats.every((s) => s.cards === null), 'an uncontested winner shows nothing by default');
  await sleep(150);
  check(humans[opener].me.canShow === true && humans[closer].me.canShow === false, 'only the uncontested winner is offered Show cards');
  const cantShow = await emit(humans[closer].sock, 'player:showCards', {});
  check(cantShow && cantShow.reason === 'cannot-show', 'the folder cannot show');
  const shownEvt = once(host, 'state:handEnd', 3000);
  const showAck = await emit(humans[opener].sock, 'player:showCards', {});
  check(showAck && showAck.ok, 'the winner shows their cards');
  const shownState = await shownEvt;
  const openerSeat = shownState.seats.find((s) => s.playerId === humans[opener].pid);
  check(openerSeat && JSON.stringify(openerSeat.cards) === JSON.stringify(humans[opener].me.hole), 'the host sees exactly the shown cards');

  section('Final');
  setMode(opener, 'shove');
  setMode(closer, 'shove');
  const fin = await once(host, 'state:final', 240000).catch(() => null);
  check(!!fin, 'the tournament plays down to a winner');
  if (fin) {
    check(fin.standings.length === 2 && fin.standings[0].place === 1 && fin.standings[1].place === 2, 'final standings rank 1st and 2nd');
    check(fin.standings[0].stack === 3000, 'the winner holds every chip');
    check(!!fin.winnerName, 'the winner is named');
    check(Array.isArray(fin.stats) && fin.stats.length === 2 && fin.stats.every((r) => r.hands === fin.handsPlayed),
      'the final screen carries per-player stats for every hand played');
    check(fin.stats.some((r) => r.handsWon > 0 && r.biggestPot > 0), 'hands won and best pot are recorded');
    const champ = fin.standings[0].playerId === humans.Ann.pid ? humans.Ann : humans.Ben;
    const loser = champ === humans.Ann ? humans.Ben : humans.Ann;
    const endReact = await emit(champ.sock, 'player:emote', { e: '🎉' });
    check(endReact && endReact.reason === 'phase-closed', 'emotes close once the tournament is over');
    const outReact = await emit(loser.sock, 'player:emote', { e: '😭' });
    check(outReact && outReact.reason === 'out', 'a busted player cannot emote');
  }

  // ═══════════ Secrecy ═══════════
  section('Secrecy');
  let leaks = 0;
  let hiddenLeaks = 0;
  for (const rec of publicLog) {
    const p = rec.payload;
    const allowed = new Set(p.board || []);
    (p.seats || []).forEach((s) => (s.cards || []).forEach((c) => allowed.add(c)));
    if (p.result) (p.result.shown || []).forEach((x) => { (x.cards || []).forEach((c) => allowed.add(c)); (x.best || []).forEach((c) => allowed.add(c)); });
    for (const c of collectCards(p, [])) {
      if (!allowed.has(c)) { leaks++; if (leaks <= 3) console.log('      stray card in ' + rec.ev + ': ' + c); }
    }
    // A human's cards may only appear in their own seat, once shown.
    const hand = knownHoles[rec.game + ':' + p.handNumber] || {};
    Object.keys(hand).forEach((pid) => {
      const seat = (p.seats || []).find((s) => s.playerId === pid);
      const shown = seat && seat.cards;
      hand[pid].forEach((c) => {
        const inBoard = (p.board || []).indexOf(c) >= 0;
        if (!shown && !inBoard && collectCards(p, []).indexOf(c) >= 0) hiddenLeaks++;
      });
    });
  }
  check(publicLog.length > 20, 'captured a meaningful number of public broadcasts (' + publicLog.length + ')');
  check(leaks === 0, 'no public broadcast carried a card outside the board or a shown hand');
  check(hiddenLeaks === 0, "no public broadcast exposed a human's unshown hole cards");

  // ═══════════ Done ═══════════
  Object.keys(humans).forEach((n) => humans[n].sock.close());
  host.close();
  server.close();
  console.log('\n' + (failed ? '✗ holdempoker integration: FAILURES above' : '✓ holdempoker integration: all checks passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\n✗ holdempoker integration crashed:', e);
  process.exit(1);
});
