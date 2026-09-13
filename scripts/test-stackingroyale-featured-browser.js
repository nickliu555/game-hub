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
  async function close() {
    mounted.close();
    await new Promise(resolve => server._triviaIo.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(server.listening, false, 'Owned HTTP server must be closed');
    assert.equal(mounted.ns.sockets.size, 0, 'Owned sockets must be closed');
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    assert.notEqual(server.address().port, 3000);
    base = `http://127.0.0.1:${server.address().port}`;
    return { ...mounted, base, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function shot(page, label) {
  const file = `/tmp/stackingroyale-featured-${label}.png`;
  await page.screenshot({ path: file, animations: 'disabled' });
  screenshots.push(file);
  console.log(`SCREENSHOT ${file}`);
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
  }), { message: 'Canvas must contain rendered colored pieces, not just a background' }).toBe(true);
}

async function accessible(element) {
  await element.scrollIntoViewIfNeeded();
  const problems = await element.evaluate(target => {
    const bounds = target.getBoundingClientRect();
    const failures = [];
    if (!bounds.width || !bounds.height || bounds.left < -1 || bounds.right > innerWidth + 1 || bounds.top < -1 || bounds.bottom > innerHeight + 1) failures.push('outside viewport');
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const rect = ancestor.getBoundingClientRect();
      const left = rect.left + ancestor.clientLeft;
      const top = rect.top + ancestor.clientTop;
      if (/auto|scroll|hidden|clip/.test(style.overflowX) && (bounds.left < left - 1 || bounds.right > left + ancestor.clientWidth + 1)) failures.push(`horizontally clipped by ${ancestor.className}`);
      if (/auto|scroll|hidden|clip/.test(style.overflowY) && (bounds.top < top - 1 || bounds.bottom > top + ancestor.clientHeight + 1)) failures.push(`vertically clipped by ${ancestor.className}`);
    }
    return failures;
  });
  assert.deepEqual(problems, [], `${await element.getAttribute('class') || await element.getAttribute('aria-label')} must be fully reachable`);
}

async function textFits(page, selector) {
  const failures = await page.locator(selector).evaluateAll(elements => {
    const problems = [];
    if (!elements.length) problems.push('missing text');
    for (const element of elements) {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none' && Number(style.webkitLineClamp) > 0) problems.push(`${element.textContent}: truncated`);
      if (element.clientWidth && element.scrollWidth > element.clientWidth + 1) problems.push(`${element.textContent}: horizontal overflow`);
      if (element.clientHeight && element.scrollHeight > element.clientHeight + 1 && !/auto|scroll/.test(style.overflowY)) problems.push(`${element.textContent}: vertical clipping`);
      const range = document.createRange();
      range.selectNodeContents(element);
      for (const rect of range.getClientRects()) {
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) problems.push(`${element.textContent}: unwrapped text`);
      }
    }
    return problems;
  });
  assert.deepEqual(failures, [], `${selector} must preserve full text`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No document horizontal overflow');
}

async function scrollRoster(page, selector, pinned) {
  const list = page.locator(selector);
  await list.scrollIntoViewIfNeeded();
  const before = await page.locator(pinned).boundingBox();
  const metrics = await list.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, width: element.clientWidth, contentWidth: element.scrollWidth, overflow: getComputedStyle(element).overflowY }));
  assert.ok(metrics.height > 0 && metrics.content > metrics.height, `${selector} must scroll: ${JSON.stringify(metrics)}`);
  assert.match(metrics.overflow, /auto|scroll/);
  assert.ok(metrics.contentWidth <= metrics.width + 1, `${selector} must not clip names horizontally`);
  const bounds = await list.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, metrics.content);
  await check.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  assert.deepEqual(await page.locator(pinned).boundingBox(), before, 'Roster header must stay pinned');
  await accessible(list.locator(':scope > *').last());
  await accessible(list.locator(':scope > *').first());
}

async function scenario(engine, browserType, count) {
  const server = await isolatedServer();
  const { game, ns } = server;
  const clients = [];
  const issues = [];
  const label = `${engine}-${count}`;
  let browser;
  let host;
  let phone;
  let phase = 'launch';
  function monitor(page, role) {
    page.on('pageerror', error => issues.push(`${role}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') issues.push(`${role}: ${message.text()}`); });
    page.on('response', response => { if (response.status() >= 400) issues.push(`${role}: HTTP ${response.status()} ${response.url()}`); });
    page.on('requestfailed', failed => {
      if (!/aborted|cancelled|canceled/i.test(failed.failure()?.errorText || '')) issues.push(`${role}: ${failed.url()} ${failed.failure()?.errorText}`);
    });
  }
  async function selection(players, expected) {
    ns.to('hosts').emit('state:match', game.state(true));
    const names = expected.map(index => players[index].name);
    await check.poll(() => host.locator('#featuredBoards canvas').evaluateAll(canvases => canvases.map(canvas => canvas.getAttribute('aria-label')))).toEqual(names.map(name => `${name}'s board`));
    await check(host.locator('#featuredBoards .featured-board')).toHaveCount(Math.min(4, count));
    await check(host.locator('#battleRoster div.watch-row.featured .pname')).toHaveText(names);
    await check(host.locator('#battleRoster .watch-row')).toHaveCount(count);
    await check(host.locator('#battleRoster button, #battleRoster [role="button"], #featureSeg')).toHaveCount(0);
    assert.deepEqual([...game.players.values()], players, 'Rendering must not mutate join order');
  }
  try {
    browser = await browserType.launch({ headless: true });
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const phoneContext = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
    await hostContext.addInitScript(() => {
      window.featuredAudioStarts = [];
      const AudioClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioClass) return;
      const create = AudioClass.prototype.createOscillator;
      AudioClass.prototype.createOscillator = function (...args) {
        const context = this;
        const oscillator = create.apply(context, args);
        const start = oscillator.start;
        oscillator.start = function (...times) {
          window.featuredAudioStarts.push({ frequency: oscillator.frequency.value, state: context.state });
          return start.apply(this, times);
        };
        return oscillator;
      };
    });
    host = await hostContext.newPage();
    phone = await phoneContext.newPage();
    monitor(host, 'host');
    monitor(phone, 'phone');
    phase = 'join';
    await host.goto(`${server.base}/stackingroyale/host`);
    await check(host.locator('#network')).toBeHidden();
    await check.poll(() => game.hostPresent).toBe(true);
    await host.locator('.lobby-header').click();
    const joinAudio = await host.evaluate(() => window.featuredAudioStarts.length);
    await phone.goto(`${server.base}/stackingroyale/join`);
    await check(phone.locator('#joinBtn')).toBeEnabled();
    await phone.locator('#nameInput').fill(`00${'W'.repeat(18)}`);
    await phone.locator('#joinBtn').tap();
    await phone.waitForURL('**/stackingroyale/play');
    await check(phone.locator('#waiting')).toBeVisible();
    const humanId = await phone.evaluate(() => localStorage.getItem('stackingroyale.playerId'));
    const human = game.players.get(humanId);
    assert.ok(human);
    await check.poll(() => host.evaluate(() => window.featuredAudioStarts.length)).toBeGreaterThan(joinAudio);
    for (let index = 1; index < count; index++) {
      const socket = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(socket);
      await check.poll(() => socket.connected).toBe(true);
      const joined = await request(socket, 'player:join', { playerId: `featured-${index}`, name: `${String(index).padStart(2, '0')}${'W'.repeat(18)}` });
      assert.equal(joined.ok, true, JSON.stringify(joined));
    }
    await check(host.locator('.player-chip')).toHaveCount(count);
    await check(phone.locator('#lobbyCount')).toHaveText(String(count));
    const players = [...game.players.values()];
    assert.ok(players.every(player => player.name.length === 20));
    if (count === 30) {
      await scrollRoster(host, '#lobbyRoster', '.lobby-header');
      await textFits(host, '.player-chip .pname');
      await shot(host, `${label}-lobby-desktop`);
    }
    phase = 'start-input';
    const startAudio = await host.evaluate(() => window.featuredAudioStarts.length);
    await host.locator('#startBtn').click();
    await check.poll(() => game.phase).toBe('PLAYING');
    await check.poll(() => host.evaluate(() => window.featuredAudioStarts.length)).toBeGreaterThan(startAudio);
    await check(phone.locator('#dropBtn')).toBeEnabled();
    const sequence = human.seq;
    await phone.locator('#leftBtn').tap();
    await check.poll(() => human.seq).toBeGreaterThan(sequence);
    const locks = human.board.view().locks;
    await phone.locator('#dropBtn').tap();
    await check.poll(() => human.board.view().locks).toBeGreaterThan(locks);
    await coloredCanvas(phone.locator('#boardCanvas'));
    await shot(host, `${label}-live-desktop`);
    await shot(phone, `${label}-live-phone320`);
    if (count >= 4) {
      await host.setViewportSize({ width: 320, height: 568 });
      for (let index = 0; index < 4; index++) {
        const canvas = host.locator('#featuredBoards canvas').nth(index);
        await accessible(canvas);
        await coloredCanvas(canvas);
        await shot(host, `${label}-live-host320-board${index + 1}`);
      }
      await host.setViewportSize({ width: 1366, height: 768 });
    }
    await host.locator('#pauseBtn').click();
    await check.poll(() => game.paused).toBe(true);
    await check(phone.locator('#overlayTitle')).toHaveText('Paused');
    await check(phone.locator('#dropBtn')).toBeDisabled();
    assert.equal(await host.evaluate(() => window.featuredAudioStarts.some(entry => entry.state === 'running' && entry.frequency > 0)), true, 'Audio cues must start on a running AudioContext');
    const frozenPhone = human.board.snapshot();
    const frozenSequence = human.seq;
    const matchId = game.matchId;
    const elapsed = game.elapsedMs;
    phase = 'automatic-ranking';
    await selection(players, Array.from({ length: Math.min(4, count) }, (_, index) => index));
    let expected;
    function fixture(index, lines, alive) {
      const player = players[index];
      player.lines = lines;
      player.alive = alive;
      player.placement = alive ? null : count;
      if (index !== 0) {
        const board = new Board(42 + index);
        for (let drop = 0; drop < 4; drop++) board.action('drop');
        const snapshot = board.snapshot();
        player.board = Board.from({ ...snapshot, lines, ...(alive ? {} : { active: null, over: true }) });
      }
    }
    if (count === 30) {
      fixture(1, 999, false);
      fixture(2, 50, true);
      fixture(3, 50, true);
      fixture(4, 80, true);
      fixture(5, 20, true);
      clients[3].disconnect();
      await check.poll(() => players[4].connected).toBe(false);
      assert.equal(players[4].alive, true);
      await selection(players, [4, 2, 3, 5]);
      await check(host.locator('.featured-board').first().locator('.featured-stats')).toHaveText(`${players[4].lines} lines`);
      await host.locator('#battleRoster .watch-row').filter({ hasText: players[1].name }).click();
      await selection(players, [4, 2, 3, 5]);
      fixture(6, 100, true);
      await selection(players, [6, 4, 2, 3]);
      fixture(6, 100, false);
      expected = [4, 2, 3, 5];
      await selection(players, expected);
    } else {
      fixture(count - 1, 40, true);
      expected = [count - 1, ...Array.from({ length: count - 1 }, (_, index) => index)];
      await selection(players, expected);
      if (count > 1) {
        fixture(count - 1, 999, false);
        expected = [...Array.from({ length: count - 1 }, (_, index) => index), count - 1];
        await selection(players, expected);
      }
    }
    phase = 'reload-phone-isolation';
    await host.reload();
    await check(host.locator('#network')).toBeHidden();
    await selection(players, expected);
    await phone.reload();
    await check(phone.locator('#overlayTitle')).toHaveText('Paused');
    await check.poll(() => human.connected).toBe(true);
    assert.equal(await phone.evaluate(() => localStorage.getItem('stackingroyale.playerId')), humanId);
    assert.deepEqual(human.board.snapshot(), frozenPhone);
    assert.equal(human.seq, frozenSequence);
    assert.equal(game.matchId, matchId);
    assert.equal(game.elapsedMs, elapsed);
    await check(phone.locator('#featuredBoards, #featureSeg')).toHaveCount(0);
    await coloredCanvas(phone.locator('#boardCanvas'));
    await accessible(phone.locator('#boardCanvas'));
    await accessible(phone.locator('#controller'));
    await textFits(phone, '.p-header .pname');
    phase = 'desktop-layout';
    for (const canvas of await host.locator('#featuredBoards canvas').all()) {
      await coloredCanvas(canvas);
      await accessible(canvas);
    }
    await textFits(host, '.featured-name .pname, .featured-stats, .watch-row .pname');
    for (const stats of await host.locator('.featured-stats').all()) {
      await check(stats).toHaveText(/^\d+ lines$/);
      await check(stats.locator(':scope > *')).toHaveCount(1);
      const centered = await stats.evaluate(element => {
        const text = element.firstElementChild.getBoundingClientRect();
        const board = element.closest('.featured-board').querySelector('canvas').getBoundingClientRect();
        return Math.abs(text.left + text.width / 2 - board.left - board.width / 2) <= 1;
      });
      assert.equal(centered, true, 'Lines must be centered beneath the board');
    }
    if (count === 30) await scrollRoster(host, '#battleRoster', '.roster-head');
    await shot(host, `${label}-ranked-desktop`);
    phase = 'narrow-layout';
    await host.setViewportSize({ width: 320, height: 568 });
    for (let index = 0; index < expected.length; index++) {
      const article = host.locator('.featured-board').nth(index);
      await accessible(article.locator('.featured-name'));
      await accessible(article.locator('canvas'));
      await coloredCanvas(article.locator('canvas'));
      await shot(host, `${label}-host320-board${index + 1}`);
      await accessible(article.locator('.featured-stats'));
    }
    if (count >= 2) {
      const metrics = await host.locator('#featuredBoards').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, left: element.scrollLeft, overflow: getComputedStyle(element).overflowX }));
      assert.ok(metrics.content > metrics.width && metrics.left > 0, 'Narrow host boards must be horizontally scrollable and reachable');
      assert.match(metrics.overflow, /auto|scroll/);
    }
    await textFits(host, '.featured-name .pname, .featured-stats, .watch-row .pname');
    if (count === 30) {
      await scrollRoster(host, '#battleRoster', '.roster-head');
      await shot(host, `${label}-host320-roster`);
    }
    await shot(phone, `${label}-paused-phone320`);
    phase = 'eliminated-fallback';
    if (count === 30) {
      for (let index = 1; index < count; index++) fixture(index, players[index].lines, index === 2);
      await selection(players, [2, 0, 1, 6]);
      await check(host.locator('.featured-board.out')).toHaveCount(2);
      await host.reload();
      await check(host.locator('#network')).toBeHidden();
      await selection(players, [2, 0, 1, 6]);
      for (const article of await host.locator('.featured-board').all()) {
        const style = await article.evaluate(element => ({
          out: element.classList.contains('out'),
          opacity: getComputedStyle(element).opacity,
          filter: getComputedStyle(element).filter,
          canvasOpacity: getComputedStyle(element.querySelector('canvas')).opacity,
        }));
        assert.equal(style.opacity, style.out ? '0.4' : '1');
        assert.equal(style.filter, style.out ? 'grayscale(1)' : 'none');
        assert.equal(style.canvasOpacity, '1');
      }
      await host.setViewportSize({ width: 1366, height: 768 });
      await shot(host, `${label}-eliminated-dimmed`);
      assert.equal(players[4].connected, false);
      assert.deepEqual(human.board.snapshot(), frozenPhone);
    }
    assert.equal(game.phase, 'PLAYING');
    assert.equal(game.paused, true);
    assert.equal(game.players.size, count);
    assert.deepEqual(issues, [], 'No browser errors or failed assets');
    console.log(`PASS featured ${label}: exact automatic order, roster retention, reload, phone input/isolation, canvas pixels, desktop/narrow accessibility, audio`);
  } catch (error) {
    if (host && !host.isClosed()) await shot(host, `${label}-failure-${phase}`).catch(() => {});
    if (phone && !phone.isClosed()) await shot(phone, `${label}-failure-${phase}-phone`).catch(() => {});
    throw new Error(`${label} at ${phase}: ${error.stack}\nBrowser issues: ${JSON.stringify(issues)}`);
  } finally {
    for (const socket of clients) socket.disconnect();
    try { if (browser) await browser.close(); } finally { await server.close(); }
  }
}

async function run() {
  const engines = { chromium, webkit };
  const requested = (process.env.SR_FEATURED_BROWSER_ENGINES || 'chromium,webkit').split(',').map(name => name.trim());
  assert.ok(requested.length && requested.every(name => Object.hasOwn(engines, name)), 'SR_FEATURED_BROWSER_ENGINES must contain chromium and/or webkit');
  const failures = [];
  for (const name of requested) {
    for (const count of [1, 2, 3, 4, 30]) {
      try { await scenario(name, engines[name], count); } catch (error) { failures.push(error.message); console.error(error.message); }
    }
  }
  console.log(`Featured browser screenshots: ${screenshots.length}`);
  assert.deepEqual(failures, [], 'Featured browser scenarios failed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });