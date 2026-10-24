'use strict';

// Headless end-to-end integration test for Liar's Dice. Spins up an
// in-process server, connects a host plus player sockets, and drives real
// socket traffic — the rules themselves are covered by
// scripts/test-liarsdice-engine.js, so this file is about the WIRE:
// lobby gating, dice secrecy, turn enforcement, the table waiting on a
// dropped player, reconnection fidelity, the timed reveal, emote gating,
// a game played to the final standings and a rematch from there.
//
//   node scripts/itest-liarsdice.js   (or: npm run itest:liarsdice)

const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountLiarsDice = require('../server/liarsdice');

const app = express();
const server = http.createServer(app);
mountLiarsDice(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t); }

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/liarsdice';
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

// Every public broadcast, to prove no unrevealed die ever leaves the server.
const publicLog = [];
function watchPublic(sock) {
  ['state:lobby', 'state:table', 'state:final'].forEach((ev) => {
    sock.on(ev, (p) => publicLog.push({ ev, payload: JSON.parse(JSON.stringify(p || {})) }));
  });
}

const humans = {};   // name → { sock, pid, me }
function track(name, sock, pid) {
  const h = humans[name] || (humans[name] = {});
  h.sock = sock;
  h.pid = pid;
  sock.on('you:state', (s) => { h.me = s; });
  return h;
}
const byPid = (pid) => Object.keys(humans).find((n) => humans[n].pid === pid);

(async () => {
  await new Promise((r) => server.listen(0, r));

  // ═══════════ Lobby ═══════════
  section('Lobby');
  const host = await connect();
  watchPublic(host);
  let lastTable = null;
  host.on('state:table', (s) => { lastTable = s; });

  const early = await connect();
  const noHost = await emit(early, 'player:join', { playerId: 'pid_Early', name: 'Early' });
  check(noHost && noHost.reason === 'host-absent', 'nobody can join before the host is here');
  early.close();

  const auth = await emit(host, 'host:auth', {});
  check(auth && auth.ok && auth.capacity === 8, 'host authenticates; capacity is 8');

  for (const name of ['Alice', 'Bob', 'Carol']) {
    const s = await connect();
    const pid = 'pid_' + name;
    const ack = await emit(s, 'player:join', { playerId: pid, name });
    check(ack && ack.ok, name + ' joins');
    track(name, s, pid);
  }
  const dupe = await connect();
  const taken = await emit(dupe, 'player:join', { playerId: 'pid_Dupe', name: 'alice' });
  check(taken && taken.reason === 'name-taken', 'a duplicate name is refused');
  dupe.close();

  for (let i = 0; i < 5; i++) await emit(host, 'host:addBot', {});
  const full = await emit(host, 'query:status', {});
  check(full.full === true, 'table reports full at 8');
  const spare = await connect();
  const ninth = await emit(spare, 'player:join', { playerId: 'pid_Eve', name: 'Eve' });
  check(ninth && ninth.reason === 'game-full', 'a 9th player is rejected with game-full');
  spare.close();
  for (const id of ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5']) {
    const k = await emit(host, 'host:kick', { playerId: id });
    check(k && k.ok, 'host removes ' + id + ' in the lobby');
  }

  const notHost = await emit(humans.Alice.sock, 'host:start', {});
  check(notHost && notHost.reason === 'not-host', 'a player cannot start the game');
  const badDice = await emit(host, 'host:setStartDice', { startDice: 7 });
  check(badDice && badDice.ok === false, '7 dice each is not an option');
  const lobbyEvt = once(host, 'state:lobby');
  const goodDice = await emit(host, 'host:setStartDice', { startDice: 3 });
  check(goodDice && goodDice.ok && goodDice.startDice === 3, 'host sets 3 dice each');
  const lob = await lobbyEvt;
  check(lob.startDice === 3 && lob.total === 3 && lob.canStart, 'lobby broadcast reflects 3 seated, 3 dice each');

  const reorderEvt = once(host, 'state:lobby');
  await emit(host, 'host:reorder', { playerId: 'pid_Carol', beforeId: 'pid_Alice' });
  const reordered = await reorderEvt;
  check(reordered.players.map((p) => p.id).join(',') === 'pid_Carol,pid_Alice,pid_Bob', 'drag-reorder seats Carol in seat 1');

  const lobbyEmote = once(host, 'host:emote', 3000);
  const lobbyReact = await emit(humans.Bob.sock, 'player:emote', { e: '😀' });
  check(lobbyReact && lobbyReact.ok && lobbyReact.kind === 'float', 'a lobby emote floats');
  const seenFloat = await lobbyEmote.catch(() => null);
  check(seenFloat && seenFloat.id === 'pid_Bob' && seenFloat.kind === 'float', 'the host receives the floating lobby emote');

  // ═══════════ Roll ═══════════
  section('Roll');
  const firstTable = once(host, 'state:table');
  const startAck = await emit(host, 'host:start', {});
  check(startAck && startAck.ok, 'host starts the game');
  const t0 = await firstTable;
  check(t0.phase === 'ROLL' && t0.round === 1, 'round 1 opens with the roll');
  check(t0.seats.every((s) => s.diceCount === 3) && t0.totalDice === 9, 'everyone has 3 dice, 9 in play');
  check(t0.seats.every((s) => !('dice' in s)) && t0.reveal === null, 'no die is public during the roll');
  check(!!t0.openerId && t0.endsAt > t0.serverNow, 'an opener is named and the roll has an end time');
  await sleep(150);
  check(['Alice', 'Bob', 'Carol'].every((n) => humans[n].me && humans[n].me.dice.length === 3 && humans[n].me.dice.every((d) => d >= 1 && d <= 6)),
    'every phone privately receives its own 3 dice');
  const rollAct = await emit(humans.Alice.sock, 'player:action', { type: 'bid', qty: 1, face: 2 });
  check(rollAct && rollAct.reason === 'not-bidding', 'nobody can bid while the dice are still rolling');
  const rollSeen = once(host, 'host:emote', 3000);
  const rollEmote = await emit(humans.Alice.sock, 'player:emote', { e: '👍' });
  check(rollEmote && rollEmote.ok && rollEmote.kind === 'bubble', 'a reaction while the dice roll is a seat bubble');
  const rollBubble = await rollSeen.catch(() => null);
  check(rollBubble && rollBubble.kind === 'bubble' && rollBubble.id === 'pid_Alice', 'the host receives the mid-match bubble');
  const lateSock = await connect();
  const late = await emit(lateSock, 'player:join', { playerId: 'pid_Late', name: 'Late' });
  check(late && late.reason === 'game-in-progress', 'nobody can join once the game starts');
  lateSock.close();
  const kickMid = await emit(host, 'host:kick', { playerId: 'pid_Bob' });
  check(kickMid && kickMid.ok === false, 'kicking is lobby-only');

  // ═══════════ Bidding ═══════════
  section('Bidding');
  const bidding = lastTable && lastTable.phase === 'BIDDING' ? lastTable
    : await until(host, 'state:table', (s) => s.phase === 'BIDDING', 6000);
  check(bidding.turnPlayerId === t0.openerId, 'the opener is first to bid');
  const order = bidding.seats.map((s) => s.playerId);
  const xName = byPid(bidding.turnPlayerId);
  const x = humans[xName];
  const yName = byPid(order[(order.indexOf(x.pid) + 1) % 3]);
  const y = humans[yName];
  const zName = byPid(order[(order.indexOf(x.pid) + 2) % 3]);
  const z = humans[zName];
  await sleep(100);
  check(x.me.yourTurn && x.me.legal && x.me.legal[1] === 1 && x.me.legal[2] === 1 && !x.me.canCall,
    'the opener is offered any face (1s included), and nothing to call yet');
  const off = await emit(y.sock, 'player:action', { type: 'bid', qty: 1, face: 3 });
  check(off && off.reason === 'not-your-turn', 'a player off-turn cannot act');
  const tooMany = await emit(x.sock, 'player:action', { type: 'bid', qty: 10, face: 4 });
  check(tooMany && tooMany.reason === 'too-high', 'a bid above the dice on the table is refused');
  const callFirst = await emit(x.sock, 'player:action', { type: 'bs' });
  check(callFirst && callFirst.reason === 'no-bid', 'BS cannot be called before a bid');

  const bidSeen = until(host, 'state:table', (s) => s.lastActed && s.lastActed.type === 'bid' && s.lastActed.playerId === x.pid, 3000);
  const b1 = await emit(x.sock, 'player:action', { type: 'bid', qty: 2, face: 4 });
  check(b1 && b1.ok, xName + ' opens with two 4s');
  const afterBid = await bidSeen;
  check(afterBid.currentBid && afterBid.currentBid.qty === 2 && afterBid.currentBid.face === 4 && afterBid.currentBid.name === xName,
    'the host sees the current bid and who made it');
  check(afterBid.turnPlayerId === y.pid, 'the turn moves clockwise');
  const xSeat = afterBid.seats.find((s) => s.playerId === x.pid);
  check(xSeat.lastAction && xSeat.lastAction.type === 'bid' && xSeat.lastAction.qty === 2, "the bid stays beside the bidder's seat");
  check(afterBid.turnLocked === true && afterBid.turnOpensAt > afterBid.serverNow, "the next turn is locked while the bid's pop-up shows");
  const tooSoon = await emit(y.sock, 'player:action', { type: 'bs' });
  check(tooSoon && tooSoon.reason === 'not-yet', 'the next player cannot act until the pop-up is gone');
  await sleep(100);
  check(y.me.upNext && !y.me.yourTurn && y.me.legal === null, "the next player's phone shows no controls yet");
  const opened = await until(host, 'state:table', (s) => s.phase === 'BIDDING' && !s.turnLocked && s.turnPlayerId === y.pid, 5000).catch(() => null);
  check(!!opened && Date.now() >= afterBid.turnOpensAt - 200, 'the turn opens once the pop-up has had its time');
  await sleep(100);
  check(y.me.yourTurn && y.me.legal[4] === 3 && y.me.legal[5] === 2 && y.me.legal[1] === 1 && y.me.canCall,
    'the next player gets the right minimums (more 4s, same count higher, half for 1s)');
  const low = await emit(y.sock, 'player:action', { type: 'bid', qty: 2, face: 3 });
  check(low && low.reason === 'too-low' && low.min === 3, 'a lower bid is refused with the minimum');
  const bidEmote = await emit(z.sock, 'player:emote', { e: '😂' });
  check(bidEmote && bidEmote.ok && bidEmote.kind === 'bubble', 'reactions stay open during the bidding');

  // ═══════════ Roster lock ═══════════
  section('Disconnect safety');
  const frozen = y.me.dice.slice();
  y.sock.close();
  await sleep(1500);
  check(lastTable && lastTable.phase === 'BIDDING' && lastTable.turnPlayerId === y.pid,
    'the table waits on the dropped player instead of skipping them');
  check(lastTable && lastTable.waitingOn === yName, 'the host is told who it is waiting for');
  const ySeat = lastTable.seats.find((s) => s.playerId === y.pid);
  check(ySeat && ySeat.diceCount === 3 && ySeat.connected === false && !ySeat.busted, 'the dropped player keeps their seat and dice');

  const y2 = await connect();
  const re = await emit(y2, 'player:reconnect', { playerId: y.pid });
  check(re && re.ok && re.phase === 'BIDDING', yName + ' reconnects mid-round');
  check(re.me && re.me.yourTurn === true, 'it is still their turn — nobody acted for them');
  check(re.me && JSON.stringify(re.me.dice) === JSON.stringify(frozen), 'the same dice come back');
  check(re.table && re.table.currentBid && re.table.currentBid.qty === 2, 'the reconnect ack carries the table snapshot');
  track(yName, y2, y.pid);
  y.me = re.me;

  const b2 = await emit(y.sock, 'player:action', { type: 'bid', qty: 2, face: 6 });
  check(b2 && b2.ok, yName + ' raises to two 6s');
  await until(z.sock, 'you:state', (st) => st.yourTurn, 5000);

  // ═══════════ Reveal ═══════════
  section('Reveal');
  const allDice = {};
  ['Alice', 'Bob', 'Carol'].forEach((n) => { allDice[humans[n].pid] = humans[n].me.dice.slice(); });
  const actual = Object.values(allDice).reduce((a, ds) => a + ds.filter((d) => d === 6 || d === 1).length, 0);
  const revealSeen = until(host, 'state:table', (s) => s.phase === 'REVEAL', 3000);
  const call = await emit(z.sock, 'player:action', { type: 'bs' });
  check(call && call.ok, zName + ' calls BS on two 6s');
  const rv = (await revealSeen).reveal;
  check(rv && rv.type === 'bs' && rv.callerId === z.pid && rv.bid.playerId === y.pid, 'the reveal names the caller and the challenged bid');
  check(rv.order[0] === z.pid && rv.order.length === 3, 'the cups lift starting with the caller');
  const sameDice = Object.keys(allDice).length === Object.keys(rv.dice).length
    && Object.keys(allDice).every((pid) => JSON.stringify(rv.dice[pid]) === JSON.stringify(allDice[pid]));
  check(sameDice, "the reveal carries exactly everyone's dice");
  check(rv.count === actual, 'sixes plus wild 1s are counted (' + actual + ')');
  const expectLoser = actual >= 2 ? z.pid : y.pid;
  check(rv.loserId === expectLoser && rv.correct === (actual < 2), 'the right player loses the challenge');
  check(rv.startAt < rv.verdictAt && rv.verdictAt < rv.endAt, 'the reveal is timed: cups, then verdict, then the next round');
  await sleep(100);
  const loser = humans[byPid(expectLoser)];
  check(loser.me.reveal && loser.me.reveal.myDelta === -1, "the loser's phone knows it loses a die");

  const revealEmote = once(host, 'host:emote', 3000);
  const bubble = await emit(x.sock, 'player:emote', { e: '😱' });
  check(bubble && bubble.ok && bubble.kind === 'bubble' && bubble.cooldownMs === 2500, 'an emote during the reveal is a seat bubble');
  const bubbleSeen = await revealEmote.catch(() => null);
  check(bubbleSeen && bubbleSeen.kind === 'bubble' && bubbleSeen.id === x.pid, 'the host receives the bubble');
  const again = await emit(x.sock, 'player:emote', { e: '😂' });
  check(again && again.reason === 'cooldown', 'a second bubble inside 2.5s is refused');
  const bad = await emit(y.sock, 'player:emote', { e: '⚽' });
  check(bad && bad.reason === 'bad-emote', 'an emoji outside the set is rejected');
  await emit(host, 'host:setReactionsMuted', { muted: true });
  const muted = await emit(z.sock, 'player:emote', { e: '😀' });
  check(muted && muted.reason === 'muted', 'the host can mute reactions');
  await emit(host, 'host:setReactionsMuted', { muted: false });

  const r2 = await until(host, 'state:table', (s) => s.round === 2 && s.phase === 'ROLL', 30000).catch(() => null);
  check(!!r2, 'the next round rolls itself after the reveal');
  if (r2) {
    check(r2.seats.find((s) => s.playerId === expectLoser).diceCount === 2 && r2.totalDice === 8, 'the loser drops to 2 dice; 8 in play');
    check(r2.openerId === expectLoser, 'whoever lost the die opens the next round');
    check(r2.seats.every((s) => s.lastAction === null), 'every seat starts the round with a clean slate');
    await sleep(150);
    check(loser.me.dice.length === 2, "the loser's phone gets 2 fresh dice");
  }

  // ═══════════ Reset ═══════════
  section('Reset');
  const resetSeen = once(humans.Alice.sock, 'state:reset', 3000).then(() => true).catch(() => false);
  await emit(host, 'host:reset', {});
  check(await resetSeen, 'players are told the game was reset');
  Object.keys(humans).forEach((n) => { humans[n].sock.close(); delete humans[n]; });

  // ═══════════ Knocked out mid-game ═══════════
  // With three at the table the first player out sits on the rail while the
  // other two play on: they can't react until the final results.
  section('Knocked out');
  for (const name of ['Kai', 'Lee', 'Mo']) {
    const s = await connect();
    const pid = 'pid3_' + name;
    const ack = await emit(s, 'player:join', { playerId: pid, name });
    check(ack && ack.ok, name + ' joins');
    track(name, s, pid);
  }
  await emit(host, 'host:setStartDice', { startDice: 3 });
  await emit(host, 'host:start', {});
  {
    let busy3 = false;
    const drive3 = async () => {
      if (busy3 || !lastTable || lastTable.phase !== 'BIDDING') return;
      busy3 = true;
      try {
        const turn = byPid(lastTable.turnPlayerId);
        if (!turn) return;
        if (!lastTable.currentBid) await emit(humans[turn].sock, 'player:action', { type: 'bid', qty: lastTable.totalDice, face: 6 });
        else await emit(humans[turn].sock, 'player:action', { type: 'bs' });
      } finally { busy3 = false; }
    };
    const onTable = () => { setTimeout(drive3, 50); };
    host.on('state:table', onTable);
    const outNow = await until(host, 'state:table', (t) => t.seats.some((x) => x.busted) && t.seats.filter((x) => !x.busted).length >= 2, 120000).catch(() => null);
    host.off('state:table', onTable);
    check(!!outNow, 'one player is knocked out while two play on');
    if (outNow) {
      const goneSeat = outNow.seats.find((x) => x.busted);
      const gone = humans[byPid(goneSeat.playerId)];
      await sleep(5200);   // let any earlier cooldown lapse
      const blocked = await emit(gone.sock, 'player:emote', { e: '😭' });
      check(blocked && blocked.reason === 'out', 'a knocked-out player cannot react while the others are still playing');
    }
  }
  const reset3 = once(humans.Kai.sock, 'state:reset', 3000).then(() => true).catch(() => false);
  await emit(host, 'host:reset', {});
  await reset3;
  ['Kai', 'Lee', 'Mo'].forEach((n) => { humans[n].sock.close(); delete humans[n]; });

  // ═══════════ Heads-up to the finish ═══════════
  section('Final');
  for (const name of ['Ann', 'Ben']) {
    const s = await connect();
    const pid = 'pid2_' + name;
    const ack = await emit(s, 'player:join', { playerId: pid, name });
    check(ack && ack.ok, name + ' joins the new game');
    track(name, s, pid);
  }
  const cpuAdd = await emit(host, 'host:addBot', {});
  check(cpuAdd && cpuAdd.ok, 'a CPU takes a seat');
  await emit(host, 'host:reorder', { playerId: 'bot-1', beforeId: 'pid2_Ann' });
  await emit(host, 'host:setStartDice', { startDice: 3 });
  await emit(host, 'host:start', {});
  const midRematch = await emit(host, 'host:rematch', {});
  check(midRematch && midRematch.ok === false && midRematch.reason === 'not-final', 'a rematch is refused mid-game');
  // Whoever is on turn makes an impossible bid; the next player calls BS — the bidder loses every human-driven round.
  let busy = false;
  const drive = async () => {
    if (busy || !lastTable || lastTable.phase !== 'BIDDING') return;
    busy = true;
    try {
      const turn = byPid(lastTable.turnPlayerId);
      if (!turn) return;
      if (!lastTable.currentBid) await emit(humans[turn].sock, 'player:action', { type: 'bid', qty: lastTable.totalDice, face: 6 });
      else await emit(humans[turn].sock, 'player:action', { type: 'bs' });
    } finally { busy = false; }
  };
  const onDrive = () => { setTimeout(drive, 50); };
  host.on('state:table', onDrive);
  // The CPU's own moves (and a Spot On winning a die back) can stretch the game; nudge the driver too.
  const driveTimer = setInterval(drive, 1000);
  const fin = await once(host, 'state:final', 600000).catch(() => null);
  clearInterval(driveTimer);
  host.off('state:table', onDrive);
  check(!!fin, 'the game plays down to a winner');
  if (fin) {
    check(fin.standings.length === 3 && fin.standings.map((r) => r.place).join(',') === '1,2,3', 'final standings rank 1st, 2nd and 3rd');
    check(!!fin.winnerName && fin.standings[0].playerId === fin.winnerId, 'the winner is named');
    check(fin.standings[1].outRound >= 3, 'the loser went out after losing all 3 dice');
    check(Array.isArray(fin.stats) && fin.stats.every((r) => r.rounds === fin.rounds || r.busted),
      'the final screen carries per-player stats');
    // The CPU may win; the best-placed human stands in for the champion.
    const humanRows = fin.standings.filter((r) => !r.isBot);
    const champ = humans[byPid(humanRows[0].playerId)];
    const out = humans[byPid(humanRows[1].playerId)];
    const endReact = await emit(champ.sock, 'player:emote', { e: '🎉' });
    check(endReact && endReact.ok && endReact.kind === 'float', 'the best-placed human can float an emote on the final standings');
    const outReact = await emit(out.sock, 'player:emote', { e: '😭' });
    check(outReact && outReact.ok && outReact.kind === 'float', 'a knocked-out player can float an emote on the final standings too');
    const outSock = await connect();
    const reFinal = await emit(outSock, 'player:reconnect', { playerId: out.pid });
    check(reFinal && reFinal.ok && reFinal.final && reFinal.me && reFinal.me.busted, 'a reconnect on the final screen gets the standings');
    track(byPid(out.pid), outSock, out.pid);
  }

  // ═══════════ Play again ═══════════
  section('Rematch');
  if (fin) {
    const seatsBefore = fin.stats.map((r) => r.playerId);
    check(seatsBefore.indexOf('bot-1') === 0 && seatsBefore.length === 3, 'the finished table was CPU, Ann, Ben');
    const knocked = fin.stats.filter((r) => r.busted).map((r) => r.playerId);
    const notHostRe = await emit(humans.Ann.sock, 'host:rematch', {});
    check(notHostRe && notHostRe.reason === 'not-host', 'a player cannot start a rematch');
    // One phone is away when the host hits Play again: it keeps its seat.
    // The phone that stays connected belongs to a player knocked out last game.
    const ranked = fin.standings.filter((r) => !r.isBot);
    const hereName = byPid(ranked[1].playerId);
    const awayName = byPid(ranked[0].playerId);
    humans[awayName].sock.close();
    await sleep(200);
    const away = humans[awayName];
    const here = humans[hereName];
    const lobbyRe = once(host, 'state:lobby', 3000).catch(() => null);
    const tableRe = until(host, 'state:table', (t) => t.round === 1 && t.phase === 'ROLL', 3000).catch(() => null);
    const privRe = until(here.sock, 'you:state', (st) => st.phase === 'ROLL' && st.round === 1, 3000).catch(() => null);
    const both = await Promise.all([emit(host, 'host:rematch', {}), emit(host, 'host:rematch', {})]);
    check(both.filter((r) => r && r.ok).length === 1, 'Play again starts exactly one new game');
    check(both.some((r) => r && r.reason === 'not-final'), 'a double-fired Play again is refused the second time');
    const lr = await lobbyRe;
    check(lr && lr.phase === 'ROLL' && lr.total === 3, 'the lobby broadcast goes out as on a normal start');
    const t1 = await tableRe;
    check(!!t1, 'everyone is sent straight to round 1');
    if (t1) {
      check(t1.seats.map((x) => x.playerId).join(',') === seatsBefore.join(','), 'same players in the same seats, CPU included');
      check(t1.startDice === 3 && t1.seats.every((x) => x.diceCount === 3 && !x.busted && x.place === null) && t1.totalDice === 9,
        'everyone is back to the starting 3 dice');
      check(knocked.every((id) => t1.seats.some((x) => x.playerId === id && !x.busted)), 'players knocked out last game are back in');
      check(t1.currentBid === null && t1.bidCount === 0 && t1.reveal === null && t1.lastActed === null && t1.seats.every((x) => x.lastAction === null),
        'no bid, call or reveal carries over');
      check(t1.stats.every((r) => r.rounds === 1 && r.bids === 0 && r.diceLost === 0 && r.outRound === null), 'stats start over');
      check(seatsBefore.indexOf(t1.openerId) >= 0, 'an opener is chosen for the new game');
      const awaySeat = t1.seats.find((x) => x.playerId === away.pid);
      check(awaySeat && awaySeat.connected === false && awaySeat.diceCount === 3, 'the away player keeps their seat and gets dice');
    }
    const priv = await privRe;
    check(priv && priv.dice.length === 3 && priv.diceCount === 3 && !priv.busted && priv.place === null && priv.reveal === null,
      'the knocked-out player is back in and privately gets 3 fresh dice');
    const again = await emit(host, 'host:rematch', {});
    check(again && again.reason === 'not-final', 'Play again is refused once the new game is under way');
    const lateSock2 = await connect();
    const late2 = await emit(lateSock2, 'player:join', { playerId: 'pid_Late2', name: 'Late' });
    check(late2 && late2.reason === 'game-in-progress', 'nobody new can join the rematch');
    lateSock2.close();

    const awaySock = await connect();
    const reAway = await emit(awaySock, 'player:reconnect', { playerId: away.pid });
    check(reAway && reAway.ok && reAway.table && reAway.table.round === 1 && !reAway.final, 'a phone reconnecting mid-rematch lands on the new table');
    check(reAway && reAway.me && reAway.me.dice.length === 3 && !reAway.me.busted, 'and gets its fresh dice back');
    track(awayName, awaySock, away.pid);

    const host2 = await connect();
    const tableForHost2 = once(host2, 'state:table', 3000).catch(() => null);
    const auth2 = await emit(host2, 'host:auth', {});
    const ht = await tableForHost2;
    check(auth2 && auth2.ok && auth2.phase !== 'FINAL' && ht && ht.round === 1 && ht.seats.length === 3,
      'a host reconnecting mid-rematch gets the new table');
    host2.close();
  }

  // ═══════════ Secrecy ═══════════
  section('Secrecy');
  let leaks = 0;
  for (const rec of publicLog) {
    const p = rec.payload;
    if (p.phase !== 'REVEAL' && p.reveal) leaks++;
    (p.seats || []).forEach((s) => { if ('dice' in s) leaks++; });
  }
  check(publicLog.length > 20, 'captured a meaningful number of public broadcasts (' + publicLog.length + ')');
  check(leaks === 0, 'no public broadcast carried a die outside a reveal');

  // ═══════════ Done ═══════════
  Object.keys(humans).forEach((n) => humans[n].sock.close());
  host.close();
  server.close();
  console.log('\n' + (failed ? '✗ liarsdice integration: FAILURES above' : '✓ liarsdice integration: all checks passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\n✗ liarsdice integration crashed:', e);
  process.exit(1);
});
