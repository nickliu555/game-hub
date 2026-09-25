// Socket-level integration test for Empire.
//
// Mounts the Empire namespace on a throwaway http server and drives it
// with real socket.io clients — no browser involved. Covers the host
// auth gate, the submission rules, reactions, kick/withdraw, the reveal
// gates, and reset.
//
//   node scripts/itest-empire.js

const express = require('express');
const http = require('http');
const { io: Client } = require('socket.io-client');

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key-not-real';

const mountEmpire = require('../server/empire');

let passed = 0;
let failed = 0;
function check(cond, msg) {
    if (cond) { passed++; console.log('  \u2713 ' + msg); }
    else { failed++; console.log('  \u2717 ' + msg); }
}
function section(name) { console.log('\n\u2014 ' + name); }

// Promise-wrapped emit-with-ack.
function emit(sock, event, payload) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ack timeout: ' + event)), 15000);
        sock.emit(event, payload || {}, (res) => { clearTimeout(t); resolve(res); });
    });
}

function once(sock, event, timeoutMs) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('event timeout: ' + event)), timeoutMs || 5000);
        sock.once(event, (data) => { clearTimeout(t); resolve(data); });
    });
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const sock = Client(`http://localhost:${port}/empire`, {
            transports: ['websocket'], forceNew: true,
        });
        const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
        sock.on('connect', () => { clearTimeout(t); resolve(sock); });
        sock.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    });
}

async function run() {
    const app = express();
    const server = http.createServer(app);
    mountEmpire(app, server, { getPublicBaseUrl: () => 'http://localhost' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const host = await connect(port);
    const alice = await connect(port);
    const bob = await connect(port);
    const sockets = [host, alice, bob];

    try {
        section('Host auth');
        // Host-only events must be refused before auth.
        const preAuth = await emit(alice, 'host:start');
        check(preAuth.ok === false && preAuth.reason === 'not-host',
            'a non-host cannot start the game');
        const preKick = await emit(alice, 'host:kick', { playerId: 'whoever' });
        check(preKick.ok === false && preKick.reason === 'not-host',
            'a non-host cannot kick');
        const preReset = await emit(alice, 'host:full-reset');
        check(preReset.ok === false && preReset.reason === 'not-host',
            'a non-host cannot reset');

        const auth = await emit(host, 'host:auth');
        check(auth.ok === true && auth.state && auth.state.phase === 'submission',
            'host:auth returns a state snapshot in the submission phase');

        section('Submissions');
        const aliceId = 'player-alice';
        const bobId = 'player-bob';
        const a = await emit(alice, 'player:submit', { playerId: aliceId, name: 'Alice', word: 'apple' });
        check(a.ok === true, 'Alice submits');
        const b = await emit(bob, 'player:submit', { playerId: bobId, name: 'Bob', word: 'banana' });
        check(b.ok === true, 'Bob submits');

        const state1 = (await emit(host, 'host:auth')).state;
        check(state1.playerCount === 2, 'roster holds 2 players');
        check(state1.players.map(p => p.name).sort().join(',') === 'Alice,Bob',
            'roster carries both names with ids');

        const dupName = await emit(bob, 'player:submit', { playerId: 'player-carol', name: 'alice', word: 'cherry' });
        check(dupName.ok === false && dupName.reason === 'name-taken', 'a duplicate name is rejected');
        const dupWord = await emit(bob, 'player:submit', { playerId: 'player-carol', name: 'Carol', word: 'apple' });
        check(dupWord.ok === false && dupWord.reason === 'word-taken', 'a duplicate word is rejected');
        const reserved = await emit(bob, 'player:submit', { playerId: 'player-carol', name: 'AI Bot', word: 'cherry' });
        check(reserved.ok === false && reserved.reason === 'reserved-name', 'the bot name is reserved');

        section('Reconnect');
        const re = await emit(alice, 'player:reconnect', { playerId: aliceId });
        check(re.ok === true && re.submitted === true && re.player.word === 'apple',
            'reconnect returns the player\'s own submission');
        const reNew = await emit(bob, 'player:reconnect', { playerId: 'player-nobody' });
        check(reNew.ok === true && reNew.submitted === false,
            'reconnect for an unknown id reports no submission');
        // Put bob's identity back after the reconnect above reassigned it.
        await emit(bob, 'player:reconnect', { playerId: bobId });

        section('Reactions');
        const reaction = once(host, 'host:reaction');
        const r1 = await emit(alice, 'player:reaction', { index: 4 });
        check(r1.ok === true, 'a valid reaction is accepted');
        check((await reaction).index === 4, 'the reaction reaches the host');
        const r2 = await emit(alice, 'player:reaction', { index: 4 });
        check(r2.ok === false && r2.reason === 'cooldown', 'a second reaction hits the cooldown');
        const rBad = await emit(bob, 'player:reaction', { index: 99 });
        check(rBad.ok === false && rBad.reason === 'bad-index', 'an out-of-range reaction index is rejected');

        await emit(host, 'host:reactions-muted', { muted: true });
        const rMuted = await emit(bob, 'player:reaction', { index: 0 });
        check(rMuted.ok === false && rMuted.reason === 'muted', 'reactions are blocked while muted');
        await emit(host, 'host:reactions-muted', { muted: false });

        section('Kick & withdraw');
        const kicked = once(bob, 'player:kicked');
        const k = await emit(host, 'host:kick', { playerId: bobId });
        check(k.ok === true, 'the host can kick by player id');
        check((await kicked).playerId === bobId, 'the kicked player is named by id');
        check((await emit(host, 'host:auth')).state.playerCount === 1, 'the roster drops to 1');

        await emit(bob, 'player:submit', { playerId: bobId, name: 'Bob', word: 'banana' });
        const w = await emit(alice, 'player:withdraw', { playerId: aliceId });
        check(w.ok === true, 'a player can withdraw their own submission');
        check((await emit(host, 'host:auth')).state.playerCount === 1, 'the roster drops after a withdraw');
        await emit(alice, 'player:submit', { playerId: aliceId, name: 'Alice', word: 'apple' });

        section('Reveal gates');
        const earlyWords = await emit(host, 'host:words');
        check(earlyWords.ok === false && earlyWords.reason === 'not-started',
            'words are hidden before the game starts');

        const start = await emit(host, 'host:start');
        check(start.ok === true, 'the host starts the game');
        const words = await emit(host, 'host:words');
        check(words.ok === true && words.words.slice().sort().join(',') === 'apple,banana',
            'the shuffled pile holds every word');
        const attr = await emit(host, 'host:attribution');
        const pairs = attr.attribution.map(s => s.player + ':' + s.word).sort().join(' ');
        check(pairs === 'Alice:apple Bob:banana', 'attribution pairs names to words');

        const late = await emit(alice, 'player:submit', { playerId: 'player-late', name: 'Late', word: 'durian' });
        check(late.ok === false && late.reason === 'wrong-phase',
            'submissions are closed once the game starts');

        section('Reset');
        const broadcast = once(alice, 'state:update');
        const reset = await emit(host, 'host:reset');
        check(reset.ok === true, 'the host can reset');
        const after = await broadcast;
        check(after.phase === 'submission' && after.playerCount === 0,
            'reset empties the roster and reopens submissions');
        check(after.round === state1.round + 1, 'reset advances the round');
        check(after.hasApiKey === true, 'reset keeps the API key');
    } catch (e) {
        failed++;
        console.log('  \u2717 harness error: ' + e.message);
    } finally {
        sockets.forEach(s => s.close());
        server.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

run();
