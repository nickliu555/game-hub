'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { chromium, webkit, expect } = require('@playwright/test');
const { io: connect } = require('socket.io-client');
const mount = require('../server/stackingroyale');
const { Board } = require('../public/stackingroyale/js/engine');

const check = expect.configure({ timeout: 8000 });
const screenshots = [];

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => socket.timeout(4000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));
}

async function isolatedServer() {
  const app = express();
  const server = http.createServer(app);
  let base;
  app.use(express.static(path.resolve(__dirname, '../public')));
  const mounted = mount(app, server, { getPublicBaseUrl: () => base });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    assert.notEqual(server.address().port, 3000);
    return { ...mounted, base, async close() {
      mounted.close();
      await new Promise(resolve => server._triviaIo.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    } };
  } catch (error) {
    mounted.close();
    await new Promise(resolve => server._triviaIo.close(resolve));
    throw error;
  }
}

async function shot(page, engine, phase) {
  const file = `/tmp/stackingroyale-cpu-${engine}-${phase}.png`;
  await page.screenshot({ path: file, animations: 'disabled' });
  screenshots.push(file);
  console.log(`SCREENSHOT ${file}`);
}

async function contained(page, selectors) {
  const failures = await page.evaluate(selectors => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('document overflows horizontally');
    for (const selector of selectors) {
      const elements = [...document.querySelectorAll(selector)];
      if (!elements.length) problems.push(`${selector}: missing`);
      for (const element of elements) {
        const bounds = element.getBoundingClientRect();
        if (!bounds.width || !bounds.height || bounds.left < -1 || bounds.right > innerWidth + 1 || bounds.top < -1 || bounds.bottom > innerHeight + 1) problems.push(`${selector}: outside viewport ${JSON.stringify(bounds.toJSON())}`);
      }
    }
    return problems;
  }, selectors);
  assert.deepEqual(failures, []);
}

async function scrollRoster(page, selector, pinned) {
  const list = page.locator(selector);
  const before = await page.locator(pinned).evaluate(element => element.getBoundingClientRect().toJSON());
  const metrics = await list.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, width: element.clientWidth, contentWidth: element.scrollWidth, overflow: getComputedStyle(element).overflowY }));
  assert.ok(metrics.height > 0 && metrics.content > metrics.height, `${selector} must scroll: ${JSON.stringify(metrics)}`);
  assert.match(metrics.overflow, /auto|scroll/);
  assert.ok(metrics.contentWidth <= metrics.width + 1, `${selector} must not clip long names horizontally`);
  const bounds = await list.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, metrics.content);
  await check.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  assert.deepEqual(await page.locator(pinned).evaluate(element => element.getBoundingClientRect().toJSON()), before, `${selector} header must stay pinned`);
  await page.mouse.wheel(0, -metrics.content);
  await check.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
}

async function coloredCanvas(canvas) {
  await check(canvas).toBeVisible();
  await check.poll(() => canvas.evaluate(element => {
    const pixels = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
    const colors = new Set();
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (!pixels[offset + 3]) continue;
      const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      colors.add(channels.join(','));
      if (Math.max(...channels) > 100 && Math.max(...channels) - Math.min(...channels) > 45) colored++;
    }
    return colors.size >= 8 && colored > 100;
  }), { message: 'Canvas must show actual colored pieces' }).toBe(true);
}

async function audioCount(page) {
  return page.evaluate(() => window.cpuAudioStarts.length);
}

async function scenario(engine, browserType) {
  const server = await isolatedServer();
  const { game, ns } = server;
  const clients = [];
  const issues = [];
  let browser;
  let host;
  let phone;
  let intentionalOffline = false;
  let phase = 'launch';
  function monitor(page, role) {
    page.on('pageerror', error => issues.push(`${role}: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error' && !intentionalOffline) issues.push(`${role} console: ${message.text()}`);
    });
    page.on('response', response => {
      if (response.status() >= 400) issues.push(`${role} HTTP ${response.status()}: ${response.url()}`);
    });
    page.on('requestfailed', failed => {
      if (!intentionalOffline && !/aborted|cancelled|canceled/i.test(failed.failure()?.errorText || '')) issues.push(`${role} load: ${failed.url()} ${failed.failure()?.errorText}`);
    });
  }
  async function addHuman(index) {
    const socket = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    await check.poll(() => socket.connected).toBe(true);
    const joined = await request(socket, 'player:join', { playerId: `cpu-browser-human-${index}`, name: `${String(index).padStart(2, '0')}${'W'.repeat(18)}` });
    assert.equal(joined.ok, true, JSON.stringify(joined));
  }
  async function cpuControlsDisabled() {
    await check(host.locator('#addBotBtn')).toBeDisabled();
    for (const level of ['novice', 'easy', 'medium', 'hard']) await check(host.locator(`#diffSeg [data-diff="${level}"]`)).toBeDisabled();
  }
  try {
    browser = await browserType.launch({ headless: true });
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const phoneContext = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
    await hostContext.addInitScript(() => {
      window.cpuAudioStarts = [];
      const AudioClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioClass) return;
      const create = AudioClass.prototype.createOscillator;
      AudioClass.prototype.createOscillator = function (...args) {
        const context = this;
        const oscillator = create.apply(context, args);
        const start = oscillator.start;
        oscillator.start = function (...times) {
          window.cpuAudioStarts.push({ frequency: oscillator.frequency.value, state: context.state });
          return start.apply(this, times);
        };
        return oscillator;
      };
    });
    host = await hostContext.newPage();
    phone = await phoneContext.newPage();
    monitor(host, 'host');
    monitor(phone, 'phone');
    phase = 'difficulty-controls';
    await host.goto(`${server.base}/stackingroyale/host`);
    await check(host.locator('#network')).toBeHidden();
    await check(host.locator('#addBotBtn'), 'CPU host UI contract: addBotBtn must exist').toBeVisible();
    await check(host.locator('#addBotBtn')).toHaveText('Add CPU');
    await check(host.locator('#addBotBtn svg')).toBeVisible();
    await check(host.locator('#diffSeg button')).toHaveText(['Novice', 'Easy', 'Medium', 'Hard']);
    await check(host.locator('#diffSeg [data-diff="medium"]')).toHaveAttribute('aria-pressed', 'true');
    for (const level of ['easy', 'medium', 'hard', 'novice']) {
      await host.locator(`#diffSeg [data-diff="${level}"]`).click();
      await check.poll(() => game.botDifficulty).toBe(level);
      await check(host.locator('#diffSeg [aria-pressed="true"]')).toHaveCount(1);
      await check(host.locator(`#diffSeg [data-diff="${level}"]`)).toHaveAttribute('aria-pressed', 'true');
      await host.reload();
      await check(host.locator('#network')).toBeHidden();
      await check(host.locator(`#diffSeg [data-diff="${level}"]`)).toHaveAttribute('aria-pressed', 'true');
    }
    phase = 'add-remove';
    const beforeJoinAudio = await audioCount(host);
    await host.locator('#addBotBtn').click();
    await check(host.locator('.player-chip.is-bot')).toHaveCount(1);
    await check.poll(() => audioCount(host)).toBeGreaterThan(beforeJoinAudio);
    const removedId = [...game.players.keys()][0];
    await host.locator('.player-chip.is-bot .kick').click();
    await check(host.locator('.gm-overlay')).toBeVisible();
    assert.equal(game.players.has(removedId), true);
    await host.locator('.gm-overlay [data-act="cancel"]').click();
    await check(host.locator('.gm-overlay')).toBeHidden();
    assert.equal(game.players.has(removedId), true);
    await host.locator('.player-chip.is-bot .kick').click();
    await host.locator('.gm-overlay [data-act="ok"]').click();
    await check(host.locator('.player-chip.is-bot')).toHaveCount(0);
    assert.equal(game.players.has(removedId), false);
    await host.locator('#addBotBtn').click();
    await check(host.locator('.player-chip.is-bot')).toHaveCount(1);
    const firstBot = [...game.players.values()][0];
    assert.equal(firstBot.isBot, true);
    assert.notEqual(firstBot.id, removedId);
    await phone.goto(`${server.base}/stackingroyale/join`);
    await check(phone.locator('#joinBtn')).toBeEnabled();
    await phone.locator('#nameInput').fill('W'.repeat(20));
    await phone.locator('#joinBtn').tap();
    await phone.waitForURL('**/stackingroyale/play');
    await check(phone.locator('#waiting')).toBeVisible();
    const humanId = await phone.evaluate(() => localStorage.getItem('stackingroyale.playerId'));
    const human = game.players.get(humanId);
    assert.ok(human && !human.isBot);
    phase = 'roster25';
    for (let index = 0; index < 23; index++) await addHuman(index);
    await check(host.locator('.player-chip')).toHaveCount(25);
    await check(phone.locator('#lobbyCount')).toHaveText('25');
    await scrollRoster(host, '#lobbyRoster', '.lobby-header');
    const namesFit = await host.locator('.player-chip .pname').evaluateAll(names => names.every(name => name.scrollWidth <= name.clientWidth + 1 && getComputedStyle(name).textOverflow !== 'ellipsis'));
    assert.equal(namesFit, true, 'Long lobby names must wrap without clipping or truncating');
    await contained(host, ['#lobbyRoster', '.lobby-header', '#startBtn', '#addBotBtn', '#diffSeg']);
    await contained(phone, ['#waiting', '.p-header', '#playerFooter']);
    await shot(host, engine, 'lobby25');
    await shot(phone, engine, 'lobby-phone');
    await check(host.locator('#startHint, .cpu-actions')).toHaveCount(0);
    for (const width of [1366, 320]) {
      await host.setViewportSize({ width, height: width === 320 ? 568 : 768 });
      await host.locator('.start-row').scrollIntoViewIfNeeded();
      const layout = await host.locator('.start-row').evaluate(row => {
        const add = row.querySelector('#addBotBtn');
        const start = row.querySelector('#startBtn');
        return { row: row.getBoundingClientRect().toJSON(), add: add.getBoundingClientRect().toJSON(), start: start.getBoundingClientRect().toJSON(), siblings: add.parentElement === start.parentElement };
      });
      assert.equal(layout.siblings, true);
      assert(Math.abs(layout.add.left - layout.row.left) <= 1);
      assert(Math.abs(layout.start.right - layout.row.right) <= 1);
      assert(Math.abs(layout.add.top + layout.add.height / 2 - layout.start.top - layout.start.height / 2) <= 1);
      assert(layout.add.right + 8 <= layout.start.left);
      await contained(host, ['.start-row', '#addBotBtn', '#startBtn']);
      if (width === 320) await shot(host, engine, 'lobby320-actions');
    }
    await host.setViewportSize({ width: 1366, height: 768 });
    phase = 'disconnect';
    await check(host.locator('#addBotBtn')).toBeEnabled();
    for (const button of await host.locator('#diffSeg button').all()) await check(button).toBeEnabled();
    intentionalOffline = true;
    await hostContext.setOffline(true);
    for (const socket of ns.sockets.values()) if (socket.data.role === 'host') socket.conn.close();
    await check(host.locator('#network')).toBeVisible();
    await cpuControlsDisabled();
    await check(host.locator('#startBtn')).toBeDisabled();
    for (const button of await host.locator('.kick').all()) await check(button).toBeDisabled();
    await hostContext.setOffline(false);
    await check(host.locator('#network')).toBeHidden();
    intentionalOffline = false;
    await check(host.locator('#addBotBtn')).toBeEnabled();
    for (const button of await host.locator('#diffSeg button').all()) await check(button).toBeEnabled();
    assert.equal(game.players.size, 25);
    phase = 'full30';
    for (let count = 26; count <= 30; count++) {
      await host.locator('#addBotBtn').click();
      await check(host.locator('.player-chip')).toHaveCount(count);
    }
    await check(host.locator('.player-chip.is-bot')).toHaveCount(6);
    await check(phone.locator('#lobbyCount')).toHaveText('30');
    await check(host.locator('#addBotBtn')).toBeDisabled();
    for (const button of await host.locator('#diffSeg button, .kick').all()) await check(button).toBeEnabled();
    await check(host.locator('#startBtn')).toBeEnabled();
    await shot(host, engine, 'full30');
    const botIds = [...game.players.values()].filter(player => player.isBot).map(player => player.id);
    assert.equal(botIds.length, 6);
    phase = 'playing';
    const beforeStartAudio = await audioCount(host);
    await host.locator('#startBtn').click();
    await check.poll(() => game.phase).toBe('PLAYING');
    await check.poll(() => audioCount(host)).toBeGreaterThan(beforeStartAudio);
    await cpuControlsDisabled();
    await check.poll(() => botIds.every(id => game.players.get(id).board.view().locks > 0), { timeout: 15000, message: 'Every CPU must actually lock pieces via the server planner' }).toBe(true);
    assert.equal(game.players.size, 30);
    for (const id of botIds) assert.equal(game.players.get(id).seq, 0);
    await coloredCanvas(host.locator('#featuredBoards canvas').first());
    await check.poll(async () => {
      const label = await host.locator('#featuredBoards canvas').first().getAttribute('aria-label');
      const leader = [...game.players.values()].sort((first, second) => Number(second.alive) - Number(first.alive) || second.lines - first.lines)[0];
      return label === `${leader.name}'s board`;
    }, { message: 'First featured board must follow automatic alive/lines ranking' }).toBe(true);
    await coloredCanvas(phone.locator('#boardCanvas'));
    const humanLocks = human.board.view().locks;
    const humanSeq = human.seq;
    await phone.locator('#leftBtn').tap();
    await check.poll(() => human.seq).toBeGreaterThan(humanSeq);
    await phone.locator('#dropBtn').tap();
    await check.poll(() => human.board.view().locks).toBeGreaterThan(humanLocks);
    await scrollRoster(host, '#battleRoster', '.match-heading');
    await contained(host, ['#featuredBoards', '#battleRoster', '#pauseBtn']);
    await contained(phone, ['#boardCanvas', '#controller', '.p-header']);
    await shot(host, engine, 'playing-host');
    await shot(phone, engine, 'playing-phone');
    phase = 'paused-reload';
    await host.locator('#pauseBtn').click();
    await check.poll(() => game.paused).toBe(true);
    await check(phone.locator('#overlayTitle')).toHaveText('Paused');
    await check(phone.locator('#dropBtn')).toBeDisabled();
    const frozen = [...game.players.values()].map(player => ({ id: player.id, board: player.board.snapshot(), planner: JSON.stringify(player.bot), survivalMs: player.survivalMs }));
    const matchId = game.matchId;
    const elapsed = game.elapsedMs;
    for (let tick = 0; tick < 120; tick++) game.step();
    await shot(host, engine, 'paused-host');
    await shot(phone, engine, 'paused-phone');
    await host.reload();
    await phone.reload();
    await check(host.locator('#network')).toBeHidden();
    await check(host.locator('#matchOverlayTitle')).toHaveText('Paused');
    await check(phone.locator('#overlayTitle')).toHaveText('Paused');
    await check.poll(() => human.connected).toBe(true);
    assert.equal(await phone.evaluate(() => localStorage.getItem('stackingroyale.playerId')), humanId);
    assert.equal(game.matchId, matchId);
    assert.equal(game.elapsedMs, elapsed);
    assert.equal(game.botDifficulty, 'novice');
    await check(host.locator('#diffSeg [data-diff="novice"]')).toHaveAttribute('aria-pressed', 'true');
    assert.deepEqual([...game.players.values()].filter(player => player.isBot).map(player => player.id), botIds);
    assert.deepEqual([...game.players.values()].map(player => ({ id: player.id, board: player.board.snapshot(), planner: JSON.stringify(player.bot), survivalMs: player.survivalMs })), frozen);
    await shot(host, engine, 'reload-host');
    const beforeResumeLocks = firstBot.board.view().locks;
    await host.locator('#pauseBtn').click();
    await check(phone.locator('#dropBtn')).toBeEnabled();
    await check.poll(() => firstBot.board.view().locks, { timeout: 15000 }).toBeGreaterThan(beforeResumeLocks);
    await host.locator('#pauseBtn').click();
    await check.poll(() => game.paused).toBe(true);
    phase = 'final';
    for (const player of game.players.values()) if (player.id !== firstBot.id) player.board = Board.from({ ...new Board(42).snapshot(), active: null, over: true });
    const beforeFinalAudio = await audioCount(host);
    await host.locator('#pauseBtn').click();
    await check(host.locator('#view-final')).toBeVisible();
    await check(phone.locator('#results')).toBeVisible();
    assert.equal(game.phase, 'FINAL');
    assert.deepEqual(game.winnerIds, [firstBot.id]);
    await check(host.locator('#finalRoster .final-row')).toHaveCount(30);
    await check(phone.locator('#standings').locator(':scope > *')).toHaveCount(30);
    await check.poll(() => audioCount(host)).toBeGreaterThan(beforeFinalAudio);
    assert.equal(await host.evaluate(() => window.cpuAudioStarts.some(entry => entry.state === 'running' && entry.frequency > 0)), true, 'Audio cues must start on a running AudioContext');
    await cpuControlsDisabled();
    await scrollRoster(host, '#finalRoster', '.final-header');
    await contained(host, ['#winnerTitle', '#finalRoster', '#againBtn']);
    await contained(phone, ['#resultTitle', '#standings']);
    await shot(host, engine, 'final-host');
    await shot(phone, engine, 'final-phone');
    phase = 'reset';
    await host.locator('#againBtn').click();
    await check(host.locator('#view-lobby')).toBeVisible();
    await check(host.locator('.player-chip')).toHaveCount(0);
    await check(host.locator('#diffSeg [data-diff="medium"]')).toHaveAttribute('aria-pressed', 'true');
    await check(host.locator('#addBotBtn')).toBeEnabled();
    await check(host.locator('#startBtn')).toBeDisabled();
    assert.equal(game.players.size, 0);
    assert.equal(game.botDifficulty, 'medium');
    await phone.waitForURL('**/stackingroyale/join');
    assert.equal(await phone.evaluate(() => localStorage.getItem('stackingroyale.playerId')), null);
    await shot(host, engine, 'reset-host');
    assert.deepEqual(issues, [], 'No browser page errors, console errors, or failed assets');
    console.log(`PASS CPU browser ${engine}: difficulty, refresh, modal removal, 25/30 roster, offline controls, CPU locks, canvas, phone input, frozen pause/reload, final/reset, audio; no page errors`);
  } catch (error) {
    if (host && !host.isClosed()) await shot(host, engine, `failure-${phase}`).catch(() => {});
    if (phone && !phone.isClosed()) await shot(phone, engine, `failure-${phase}-phone`).catch(() => {});
    throw new Error(`${engine} at ${phase}: ${error.stack}\nBrowser issues: ${JSON.stringify(issues)}`);
  } finally {
    for (const socket of clients) socket.disconnect();
    try { if (browser) await browser.close(); } finally { await server.close(); }
  }
}

async function run() {
  const engines = { chromium, webkit };
  const requested = (process.env.SR_CPU_BROWSER_ENGINES || 'chromium,webkit').split(',').map(name => name.trim());
  assert.ok(requested.length && requested.every(name => Object.hasOwn(engines, name)), 'SR_CPU_BROWSER_ENGINES must contain chromium and/or webkit');
  const failures = [];
  for (const name of requested) {
    try { await scenario(name, engines[name]); } catch (error) { failures.push(error.message); console.error(error.message); }
  }
  console.log(`CPU browser screenshots: ${screenshots.length}`);
  assert.deepEqual(failures, [], 'CPU browser scenarios failed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });