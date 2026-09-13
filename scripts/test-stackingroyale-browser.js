'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');
const express = require('express');
const { io: connect } = require('socket.io-client');
const mount = require('../server/stackingroyale');
const { Board } = require('../public/stackingroyale/js/engine');
const { Field } = require('tetris-fumen');

const check = expect.configure({ timeout: 6000 });
const root = path.resolve(__dirname, '..');
const results = [];
const screenshots = [];
const observations = [];

async function isolatedServer() {
  const app = express();
  const server = http.createServer(app);
  let base;
  app.get('/', (_request, response) => response.sendFile(path.join(root, 'public/hub.html')));
  app.get('/api/games', (_request, response) => response.json(require('../games')));
  app.get('/api/games/:id', (request, response) => {
    const game = require('../games').find(entry => entry.id === request.params.id);
    if (game) response.json(game); else response.status(404).json({ error: 'Game not found' });
  });
  app.use(express.static(path.join(root, 'public')));
  const mounted = mount(app, server, { getPublicBaseUrl: () => base });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return { ...mounted, base, async close() {
    mounted.close();
    await new Promise(resolve => server._triviaIo.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  } };
}

async function shot(page, name, duringEffect = false) {
  if (!duringEffect) await page.evaluate(() => document.fonts.ready);
  const file = `/tmp/stackingroyale-${name}.png`;
  await page.screenshot({ path: file, animations: 'disabled' });
  screenshots.push(file);
  console.log(`SCREENSHOT ${file}`);
}

function monitor(page, label, issues) {
  page.on('pageerror', error => issues.push(`${label} pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') issues.push(`${label} console: ${message.text()}`);
  });
  page.on('requestfailed', request => {
    const failure = `${label} failed load: ${request.url()} ${request.failure()?.errorText}`;
    if (/ERR_ABORTED|cancelled|canceled/i.test(request.failure()?.errorText || '')) observations.push(failure);
    else issues.push(failure);
  });
  page.on('response', response => {
    if (response.status() >= 400) issues.push(`${label} HTTP ${response.status()}: ${response.url()}`);
  });
}

async function renderedCanvas(page, selector) {
  await check(page.locator(selector)).toBeVisible();
  await check.poll(() => page.locator(selector).evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    let colorful = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (!pixels[offset + 3]) continue;
      const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      colors.add(channels.join(','));
      if (Math.max(...channels) - Math.min(...channels) > 45 && Math.max(...channels) > 100) colorful++;
    }
    return colors.size >= 8 && colorful > 100;
  }), { message: `${selector}: actual canvas must contain colored pieces, not a blank fill` }).toBe(true);
}

async function sharedGameShell(page) {
  await noReactions(page);
  if (await page.locator('body[data-role="player"]').count()) {
    await check(page.locator('#targeting, [data-target]')).toHaveCount(0);
    await check(page.locator('#settingsBtn, #settingsPanel, #topbar, .game-topbar, #helpBtn, #helpOverlay, #backBtn, #backConfirm, #confirmStrip')).toHaveCount(0);
    await check(page.locator('.p-header .me .name')).toBeVisible();
    if (await page.locator('body').getAttribute('data-phase') === 'LOBBY') {
      for (const selector of ['#controlSettings', '#controlSettingsBtn', '#controlPopup']) await check(page.locator(selector)).toBeHidden();
      await check(page.locator('#controlModes')).toBeHidden();
      await check(page.locator('#playerPlace')).toBeHidden();
      await check(page.locator('#playerPlace')).toHaveText('');
      await check(page.locator('.p-header #lobbyCount, .p-header .lobby-player-count')).toHaveCount(0);
    } else {
      await check(page.locator('#playerPlace')).toBeVisible();
      await check(page.locator('#playerPlace')).toHaveText(/^(#\d+|\d+ left)$/);
    }
    await contained(page, ['.p-header', '.p-header .name', '#playerPlace']);
    return;
  }
  const join = await page.locator('body[data-role="join"]').count();
  if (join) {
    await check(page.locator('.join-brand')).toHaveText('🧱 Stacking Royale');
    await check(page.locator('.join-hero')).toBeVisible();
    await check(page.locator('.game-topbar, #topbar, .join-artwork, .join-art, #joinCount, .join-count, #playerCount')).toHaveCount(0);
    await centeredFooter(page, '.player-attribution', 'join');
    await contained(page, ['.join-brand', '.join-hero', '#joinForm', '.player-attribution']);
  } else if (await page.locator('body[data-role="practice"]').count()) {
    await check(page.locator('#topbar, .game-topbar, .gtb-brand, #settingsBtn, #settingsPanel, #helpBtn, #helpOverlay')).toHaveCount(0);
    await check(page.locator('link[href*="/shared/topbar.css"], script[src*="/shared/topbar.js"]')).toHaveCount(0);
    await check(page.locator('.session-heading h1')).toHaveText('Solo practice');
    await check(page.locator('#sessionTools > button')).toHaveCount(3);
    for (const id of ['backBtn', 'pauseBtn', 'restartBtn']) {
      await check(page.locator(`#sessionTools > #${id}`)).toBeVisible();
    }
    await check(page.locator('#sessionTools > #controlSettings > #controlSettingsBtn')).toBeVisible();
    await check(page.locator('#controlPopup > #controlModes')).toHaveCount(1);
    await check(page.locator('#controlPopup')).toBeHidden();
    await check(page.locator('#controlModes')).toBeHidden();
    await contained(page, ['.session-heading', '.session-heading h1', '#sessionTools', '#backBtn', '#pauseBtn', '#restartBtn', '#controlSettingsBtn']);
    const tools = await page.locator('#sessionTools > button, #sessionTools > #controlSettings > button').evaluateAll(buttons => buttons.map(button => {
      const bounds = button.getBoundingClientRect();
      return { id: button.id, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height, centerY: bounds.top + bounds.height / 2 };
    }));
    assert.deepEqual(tools.map(button => button.id), ['backBtn', 'pauseBtn', 'restartBtn', 'controlSettingsBtn']);
    assert.ok(tools.every((button, index) => button.width === 36 && button.height === 36 && Math.abs(button.centerY - tools[0].centerY) <= 1 && (!index || Math.abs(button.left - tools[index - 1].right - 6) <= 1)), `Practice tools must be 36px icons in one row with 6px gaps: ${JSON.stringify(tools)}`);
    const heading = await page.locator('.session-heading h1').evaluate(element => ({ bounds: element.getBoundingClientRect().toJSON(), block: element.parentElement.getBoundingClientRect().toJSON(), fontSize: getComputedStyle(element).fontSize, whiteSpace: getComputedStyle(element).whiteSpace }));
    assert.equal(heading.fontSize, '18px');
    assert.equal(heading.whiteSpace, 'nowrap');
    assert.ok(heading.bounds.right <= heading.block.right && heading.block.right <= tools[0].left && Math.abs(heading.block.top + heading.block.height / 2 - tools[0].centerY) <= 1, `Practice title block and all four icons must share one non-overlapping row: ${JSON.stringify({ heading, tools })}`);
  } else {
    await check(page.locator('.game-topbar .brand-bg')).toHaveText('🧱');
    await check(page.locator('.game-topbar .gtb-brand')).toHaveText('🧱 Stacking Royale');
    await check(page.locator('.game-topbar .gtb-controls .gtb-btn:not(#settingsPanel .gtb-btn)')).toHaveCount(3);
    await contained(page, ['.game-topbar', '.gtb-brand', '#backBtn', '#helpBtn', '#settingsBtn']);
    if (await page.locator('body[data-role="host"]').count()) {
      await check(page.locator('#settingsPanel')).toBeHidden();
      await page.locator('#settingsBtn').click();
      await check(page.locator('#settingsPanel')).toBeVisible();
      await check(page.locator('#settingsPanel > .gtb-btn')).toHaveCount(2);
      await check(page.locator('#settingsPanel > #fullscreenBtn.gtb-btn')).toHaveText('Fullscreen');
      await check(page.locator('#settingsPanel > .gtb-divider')).toHaveCount(1);
      await check(page.locator('#settingsPanel > #resetBtn.gtb-btn')).toHaveText('Reset game');
      await check(page.locator('#soundSeg')).toHaveCount(0);
      await iconsVisible(page, '#fullscreenBtn');
      await contained(page, ['#settingsPanel', '#fullscreenBtn', '#resetBtn']);
      await page.locator('#settingsBtn').click();
      await check(page.locator('#settingsPanel')).toBeHidden();
    }
  }
  const theme = await page.evaluate(() => ({
    font: getComputedStyle(document.body).fontFamily,
    background: getComputedStyle(document.body).backgroundImage,
    button: getComputedStyle(document.querySelector('.primary')).color,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  }));
  assert.match(theme.font, /Inter/, 'Use the existing games font family');
  assert.match(theme.background, /linear-gradient/, 'Use the existing dark game background');
  assert.equal(theme.accent, '#f1cb50');
  assert.equal(theme.button, 'rgb(26, 26, 26)', 'Gold primary actions need dark text');
}

async function noReactions(page) {
  await check(page.locator('#reactions, #reactionLayer, #reactionSeg, #reactionsSeg, .reactions, .reaction-pop, [data-muted]')).toHaveCount(0);
}

async function playerLobby(page, count) {
  await check(page.locator('body')).toHaveAttribute('data-phase', 'LOBBY');
  await sharedGameShell(page);
  await check(page.locator('#waiting')).toBeVisible();
  await check(page.locator('#waitStatus + .lobby-player-count')).toBeVisible();
  await check(page.locator('#lobbyCount')).toHaveText(String(count));
  await check(page.locator('#lobbyCountLabel')).toHaveText(`${count === 1 ? 'player' : 'players'} in the lobby`);
  await page.evaluate(() => document.fonts.ready);
  await contained(page, ['#waiting', '#waitStatus', '.lobby-player-count', '#lobbyCount', '#lobbyCountLabel']);
  const alignment = await page.locator('.lobby-player-count').evaluate(element => {
    const count = element.getBoundingClientRect();
    const status = document.querySelector('#waitStatus').getBoundingClientRect();
    return { countCenter: count.left + count.width / 2, statusCenter: status.left + status.width / 2, viewportCenter: innerWidth / 2, top: count.top, statusBottom: status.bottom };
  });
  assert.ok(Math.abs(alignment.countCenter - alignment.viewportCenter) <= 1 && Math.abs(alignment.countCenter - alignment.statusCenter) <= 1 && alignment.top >= alignment.statusBottom, `Lobby count must be centered below the waiting message: ${JSON.stringify(alignment)}`);
  await centeredFooter(page, '#playerFooter', 'play');
}

async function playerMatchShell(page, game, id, phase = game.phase) {
  await check(page.locator('body')).toHaveAttribute('data-phase', phase);
  await sharedGameShell(page);
  const player = game.players.get(id);
  const controlsVisible = ['COUNTDOWN', 'PLAYING'].includes(phase) && player.alive;
  if (controlsVisible) {
    await check(page.locator('.p-header #controlSettingsBtn')).toBeVisible();
    await check(page.locator('#controlPopup > #controlModes')).toHaveCount(1);
  } else {
    await check(page.locator('#controlSettings')).toBeHidden();
    await check(page.locator('#controlSettingsBtn')).toBeHidden();
    await check(page.locator('#controlModes')).toBeHidden();
  }
  await check(page.locator('#controlPopup')).toBeHidden();
  await check(page.locator('#controlSettingsBtn')).toHaveAttribute('aria-expanded', 'false');
  const remaining = [...game.players.values()].filter(player => player.alive).length;
  await check(page.locator('#playerPlace')).toHaveText(player.placement ? `#${player.placement}` : `${remaining} left`);
}

async function centeredFooter(page, selector, from, final = false) {
  const footer = page.locator(selector);
  await check(footer).toBeVisible();
  await check(footer.locator('.practice-link')).toHaveText('Practice solo');
  await check(footer.locator('.practice-link')).toHaveAttribute('href', `/stackingroyale/practice?from=${from}`);
  if (final) await check(footer.locator('#attribution')).toBeHidden();
  else await check(footer).toContainText('Developed by Nick Liu');
  await contained(page, [selector, `${selector} .practice-link`]);
  const alignment = await footer.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const link = element.querySelector('.practice-link').getBoundingClientRect();
    return { footer: bounds.left + bounds.width / 2, link: link.left + link.width / 2, viewport: innerWidth / 2, textAlign: getComputedStyle(element).textAlign };
  });
  assert.ok(Math.abs(alignment.footer - alignment.viewport) <= 1 && Math.abs(alignment.link - alignment.footer) <= 1, `${selector}: footer and practice link must be centered: ${JSON.stringify(alignment)}`);
  assert.equal(alignment.textAlign, 'center');
}

async function mobileAppProtections(page, label) {
  const failures = await page.evaluate(() => {
    const problems = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (!element.getClientRects().length || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      const editable = element.closest('input,textarea,[contenteditable="true"]');
      if (!editable && style.userSelect !== 'none' && style.webkitUserSelect !== 'none') {
        problems.push(`${element.tagName}${element.id ? '#' + element.id : '.' + element.getAttribute('class')}: userSelect=${style.userSelect}, webkitUserSelect=${style.webkitUserSelect}`);
      }
      if (style.touchAction === 'auto' || style.touchAction === 'manipulation' || style.touchAction.includes('pinch-zoom')) problems.push(`${element.tagName}#${element.id}: touchAction permits pinch: ${style.touchAction}`);
      if (editable && style.userSelect !== 'text' && style.webkitUserSelect !== 'text') problems.push(`${element.tagName}#${element.id}: editing selection must remain enabled`);
    }
    const viewport = new Map((document.querySelector('meta[name="viewport"]')?.content || '').split(',').map(entry => entry.trim().toLowerCase().split(/\s*=\s*/)));
    for (const [setting, value] of [['width', 'device-width'], ['initial-scale', '1'], ['minimum-scale', '1'], ['maximum-scale', '1'], ['user-scalable', 'no']]) {
      if (viewport.get(setting) !== value) problems.push(`viewport ${setting}: expected ${value}, got ${viewport.get(setting)}`);
    }
    const target = document.createElement('span');
    document.body.append(target);
    const types = ['gesturestart', 'gesturechange', 'gestureend', 'selectstart', 'contextmenu', 'dragstart', 'dblclick', 'touchstart', 'touchmove', 'wheel'];
    for (const type of types) target.addEventListener(type, event => event.stopImmediatePropagation());
    for (const type of types.slice(0, 7)) {
      if (target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })) !== false) problems.push(`${type}: capture listener must cancel despite child stopImmediatePropagation`);
    }
    for (const type of ['touchstart', 'touchmove']) for (const count of [2, 1]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({})) });
      if (target.dispatchEvent(event) !== (count === 1)) problems.push(`${type} with ${count} touches: dispatchEvent must return ${count === 1}`);
    }
    for (const ctrlKey of [true, false]) {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey, deltaY: 100 });
      if (target.dispatchEvent(event) !== !ctrlKey) problems.push(`wheel ctrlKey=${ctrlKey}: incorrect cancellation`);
    }
    target.remove();
    const firstEnd = new Event('touchend', { bubbles: true, cancelable: true });
    const secondEnd = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(firstEnd, 'touches', { value: [] });
    Object.defineProperty(secondEnd, 'touches', { value: [] });
    document.dispatchEvent(firstEnd);
    document.dispatchEvent(secondEnd);
    if (!secondEnd.defaultPrevented) problems.push('successive touchend: second event must be defaultPrevented');
    return problems;
  });
  const text = page.locator('body[data-role="player"] .p-header .me .name, body[data-role="practice"] .session-heading h1, body[data-role="join"] .join-brand');
  await check(text).toBeVisible();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await text.dblclick();
  const selection = await page.evaluate(() => window.getSelection().toString());
  if (selection !== '') failures.push(`native double-click selection must be empty, got ${JSON.stringify(selection)}`);
  assert.deepEqual(failures, [], `${label}: mobile app protections\n${failures.join('\n')}`);
}

async function pointerPress(page, selector) {
  const button = page.locator(selector);
  await check(button).toBeVisible();
  await check(button).toBeEnabled();
  const bounds = await button.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

async function openControlPopup(page) {
  await check(page.locator('#controlPopup')).toBeHidden();
  await check(page.locator('#controlModes')).toBeHidden();
  await check(page.locator('#controlSettingsBtn')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#controlSettingsBtn').click();
  await check(page.locator('#controlPopup')).toBeVisible();
  await check(page.locator('#controlModes')).toBeVisible();
  await check(page.locator('#controlSettingsBtn')).toHaveAttribute('aria-expanded', 'true');
  await check(page.locator('#controlModes [aria-pressed="true"]')).toBeFocused();
}

async function chooseControlMode(page, mode) {
  const popup = await page.locator('#controlPopup').count();
  if (popup) await openControlPopup(page);
  await page.locator(`#controlModes [data-mode="${mode}"]`).click();
  await check(page.locator('body')).toHaveAttribute('data-controls', mode);
  await check(page.locator(`#controlModes [data-mode="${mode}"]`)).toHaveAttribute('aria-pressed', 'true');
  await check(page.locator(`#controlModes [data-mode="${mode === 'buttons' ? 'gestures' : 'buttons'}"]`)).toHaveAttribute('aria-pressed', 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('stackingroyale.controls')), mode);
  if (popup) {
    await check(page.locator('#controlPopup')).toBeHidden();
    await check(page.locator('#controlModes')).toBeHidden();
    await check(page.locator('#controlSettingsBtn')).toHaveAttribute('aria-expanded', 'false');
    await check(page.locator('#controlSettingsBtn')).toBeFocused();
  }
}

async function gameplayLayout(page, label, position, minimumHeight = 0) {
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
  await noReactions(page);
  const player = await page.locator('body[data-role="player"]').count();
  if (player) {
    await sharedGameShell(page);
    await check(page.locator('#playerFooter')).toBeHidden();
    await check(page.locator('#attribution')).toBeHidden();
    await check(page.locator('.p-header #controlSettingsBtn')).toBeVisible();
  }
  const stableSelectors = [player ? '.p-header' : '.session-heading', '.board-stage', '#boardCanvas'];
  const before = [];
  for (const selector of stableSelectors) before.push(await page.locator(selector).boundingBox());
  async function unchangedLayout() {
    for (let index = 0; index < stableSelectors.length; index++) {
      assert.deepEqual(await page.locator(stableSelectors[index]).boundingBox(), before[index], `${label}: popup interactions must not move or resize ${stableSelectors[index]}`);
    }
  }
  {
    await check(page.locator('#controlPopup > #controlModes')).toHaveCount(1);
    await check(page.locator('#controller #controlModes')).toHaveCount(0);
    await openControlPopup(page);
    await unchangedLayout();
    if (!player) {
      const elapsed = (await saved(page)).elapsedMs;
      await check.poll(async () => (await saved(page)).elapsedMs, { message: `${label}: practice must keep running while the control popup is open` }).toBeGreaterThan(elapsed + 100);
      await check(page.locator('#boardOverlay')).toBeHidden();
      await check(page.locator('#controlPopup')).toBeVisible();
    }
    await contained(page, ['#controlPopup', '#controlModes', '#controlModes button']);
    const anchor = await page.locator('#controlSettingsBtn').boundingBox();
    const popup = await page.locator('#controlPopup').boundingBox();
    assert.equal(anchor.width, 36);
    assert.equal(anchor.height, 36);
    assert.equal(await page.locator('#controlPopup').evaluate(element => getComputedStyle(element).position), 'absolute');
    assert.ok(Math.abs(popup.x + popup.width - anchor.x - anchor.width) <= 1 && Math.abs(popup.y - anchor.y - anchor.height - 8) <= 1, `${label}: popup must anchor below gear: ${JSON.stringify({ anchor, popup })}`);
    await shot(page, `${label}-popup`);
    await page.locator(player ? '.p-header .name' : '.session-heading h1').click();
    await check(page.locator('#controlPopup')).toBeHidden();
    await check(page.locator('#controlModes')).toBeHidden();
    await check(page.locator('#controlSettingsBtn')).toHaveAttribute('aria-expanded', 'false');
    await unchangedLayout();
    await openControlPopup(page);
    await page.keyboard.press('Escape');
    await check(page.locator('#controlPopup')).toBeHidden();
    await check(page.locator('#controlModes')).toBeHidden();
    await check(page.locator('#controlSettingsBtn')).toHaveAttribute('aria-expanded', 'false');
    await check(page.locator('#controlSettingsBtn')).toBeFocused();
    await unchangedLayout();
    await openControlPopup(page);
    await page.locator('#controlSettingsBtn').click();
    await check(page.locator('#controlPopup')).toBeHidden();
    await check(page.locator('#controlModes')).toBeHidden();
    await check(page.locator('#controlSettingsBtn')).toHaveAttribute('aria-expanded', 'false');
    await unchangedLayout();
  }
  await check(page.locator('.stats > *')).toHaveCount(3);
  await check(page.locator('.stats > div > span')).toHaveText(['Lines', 'Level', 'Time']);
  await check(page.locator('.board-rail').first().locator('#boardLabel')).toHaveCount(1);
  for (const mode of ['gestures', 'buttons']) {
    await chooseControlMode(page, mode);
    if (mode === 'gestures') await check(page.locator('#leftBtn')).toBeHidden();
    if (!player) {
      await frames(page);
      await unchangedLayout();
      await check(page.locator('#boardOverlay')).toBeHidden();
      const elapsed = (await saved(page)).elapsedMs;
      await check.poll(async () => (await saved(page)).elapsedMs).toBeGreaterThan(elapsed + 100);
    }
  }
  const initialPosition = await position();
  await pointerPress(page, '#leftBtn');
  await check.poll(position, { message: `${label}: Buttons must work after returning from Gestures` }).toBe(initialPosition - 1);
  await pointerPress(page, '#rightBtn');
  await check.poll(position).toBe(initialPosition);
  await frames(page);
  const layout = await page.evaluate(() => {
    const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const boardLabel = document.querySelector('#boardLabel');
    const original = boardLabel.textContent;
    const samples = [];
    try {
      for (const feedback of ['', 'Tetris', 'Back-to-back T-spin triple combo 12 perfect clear']) {
        boardLabel.textContent = feedback;
        const items = [...document.querySelector('.stats').children].map(element => element.getBoundingClientRect().toJSON());
        samples.push({ feedback, items, center: (Math.min(...items.map(item => item.left)) + Math.max(...items.map(item => item.right))) / 2, surface: bounds('#playSurface'), label: bounds('#boardLabel'), rail: bounds('.board-rail') });
      }
    } finally {
      boardLabel.textContent = original;
    }
    return { samples, stats: bounds('.stats'), board: bounds('.board-stage'), header: document.querySelector('.p-header') ? { bounds: bounds('.p-header'), name: bounds('.p-header .name'), place: bounds('#playerPlace'), gear: bounds('#controlSettingsBtn'), display: getComputedStyle(document.querySelector('.p-header')).display } : null };
  });
  console.log(`LAYOUT ${label} ${JSON.stringify(layout)}`);
  for (const sample of layout.samples) {
    assert.ok(Math.abs(sample.center - (sample.surface.left + sample.surface.width / 2)) <= 1, `${label}: Lines/Level/Time group must be centered within 1px even with feedback: ${JSON.stringify(sample)}`);
    assert.ok(sample.items.every((item, index) => Math.abs(item.top + item.height / 2 - sample.items[0].top - sample.items[0].height / 2) <= 1 && (!index || item.left >= sample.items[index - 1].right)), `${label}: stats must share a non-overlapping row`);
    if (sample.feedback) assert.ok(sample.label.left >= sample.rail.left - 1 && sample.label.right <= sample.rail.right + 1 && sample.label.top >= sample.rail.top - 1 && sample.label.bottom <= sample.rail.bottom + 1, `${label}: feedback must fit the first board rail: ${JSON.stringify(sample)}`);
  }
  if (player) {
    const { header, stats, board } = layout;
    assert.equal(header.display, 'flex', `${label}: active header must use one flex row`);
    const items = [header.name, header.place, header.gear];
    assert.ok(items.every((item, index) => Math.abs(item.top + item.height / 2 - header.name.top - header.name.height / 2) <= 1 && (!index || item.left >= items[index - 1].right)), `${label}: name, score and gear must share a non-overlapping centered row: ${JSON.stringify(header)}`);
    assert.ok(items.every(item => item.top >= header.bounds.top - 1 && item.bottom <= header.bounds.bottom + 1) && header.bounds.bottom <= stats.top + 1 && stats.bottom <= board.top + 1, `${label}: header must sit above stats and board`);
    const nameScroll = await page.locator('.p-header .name').evaluate(element => {
      const style = getComputedStyle(element);
      const text = element.querySelector('.pname');
      const range = document.createRange();
      range.selectNodeContents(text);
      element.scrollLeft = 0;
      const start = range.getBoundingClientRect().left;
      element.scrollLeft = element.scrollWidth;
      const end = range.getBoundingClientRect().right;
      const result = { value: element.textContent, width: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft, start, end, bounds: element.getBoundingClientRect().toJSON(), whiteSpace: style.whiteSpace, overflow: style.overflowX, textOverflow: style.textOverflow, childTextOverflow: getComputedStyle(text).textOverflow };
      element.scrollLeft = 0;
      return result;
    });
    assert.equal(nameScroll.whiteSpace, 'nowrap');
    assert.equal(nameScroll.overflow, 'auto');
    assert.notEqual(nameScroll.textOverflow, 'ellipsis');
    assert.notEqual(nameScroll.childTextOverflow, 'ellipsis');
    assert.ok(Math.abs(nameScroll.start - nameScroll.bounds.left) <= 1 && nameScroll.end <= nameScroll.bounds.right + 1, `${label}: both ends of full name must be reachable: ${JSON.stringify(nameScroll)}`);
    if (nameScroll.scrollWidth > nameScroll.width) assert.ok(nameScroll.scrollLeft > 0, `${label}: overflowing name must scroll`);
    console.log(`NAME ${label} ${JSON.stringify(nameScroll)}`);
    await contained(page, ['.p-header .name', '#playerPlace', '#controlSettingsBtn']);
  } else {
    await sharedGameShell(page);
  }
  const spacing = await page.evaluate(() => {
    const board = document.querySelector('#boardCanvas').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#controller [data-action]')].filter(element => element.getClientRects().length).map(element => element.getBoundingClientRect().toJSON());
    return { board: board.toJSON(), buttons, gap: Math.min(...buttons.map(button => button.top)) - board.bottom, paddingTop: getComputedStyle(document.querySelector('#controller')).paddingTop };
  });
  console.log(`CONTROLS ${label} ${JSON.stringify(spacing)}`);
  assert.ok(spacing.buttons.length > 0, `${label}: actual controller buttons must be visible`);
  assert.equal(spacing.paddingTop, '12px', `${label}: shared controller padding must remain 12px`);
  assert.ok(spacing.gap >= 12, `${label}: actual board-to-buttons gap must be >=12px: ${JSON.stringify(spacing)}`);
  await contained(page, ['#controller [data-action]']);
  await check(page.locator('#targeting, [data-target]')).toHaveCount(0);
  await contained(page, ['.board-stage', '#boardCanvas', '#holdCanvas', '#nextCanvas', '#controller']);
  const metrics = await page.locator('#boardCanvas').evaluate(canvas => {
    const stage = canvas.closest('.board-stage');
    const frame = [...stage.children].find(element => element.contains(canvas));
    const stageRect = stage.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const boardRect = canvas.getBoundingClientRect();
    const rails = [...stage.children].filter(element => element !== frame).reduce((sum, element) => sum + element.getBoundingClientRect().width, 0);
    const gap = parseFloat(getComputedStyle(stage).columnGap) || 0;
    const available = { left: stageRect.left + stage.clientLeft, top: stageRect.top + stage.clientTop, width: stage.clientWidth, height: stage.clientHeight };
    return { board: boardRect.toJSON(), frame: frameRect.toJSON(), available, expectedWidth: Math.floor(Math.min(stage.clientHeight / 2, stage.clientWidth - rails - gap * (stage.children.length - 1))) };
  });
  console.log(`BOARD ${label} ${JSON.stringify(metrics)}`);
  assert.ok(metrics.board.height >= minimumHeight, `${label}: multiplayer board height must be >=${minimumHeight}px: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.board.width > 0 && metrics.board.height > 0, `${label}: board must have positive dimensions`);
  assert.ok(Math.abs(metrics.frame.width - metrics.expectedWidth) <= 2, `${label}: board must fit the remaining stage client area: ${JSON.stringify(metrics)}`);
  assert.ok(Math.abs(metrics.board.height - metrics.board.width * 2) <= 2, `${label}: board must preserve its 10x20 aspect ratio: ${JSON.stringify(metrics)}`);
  for (const [name, bounds] of [['frame', metrics.frame], ['board', metrics.board]]) {
    assert.ok(bounds.left >= metrics.available.left - 1 && bounds.right <= metrics.available.left + metrics.available.width + 1 && bounds.top >= metrics.available.top - 1 && bounds.bottom <= metrics.available.top + metrics.available.height + 1, `${label}: ${name} must be contained in the stage client area: ${JSON.stringify(metrics)}`);
  }
  await mobileAppProtections(page, label);
  await shot(page, `${label}-layout`);
}

async function contained(page, selectors) {
  const problems = await page.evaluate(selectors => {
    const failures = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) failures.push(`document horizontal overflow ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!element.getClientRects().length) continue;
        const rect = element.getBoundingClientRect();
        if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) failures.push(`${selector}: bounds ${JSON.stringify(rect.toJSON())}, viewport ${innerWidth}x${innerHeight}`);
        if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'auto') failures.push(`${selector}: clipped width ${element.scrollWidth} > ${element.clientWidth}`);
      }
    }
    return failures;
  }, selectors);
  assert.deepEqual(problems, [], problems.join('\n'));
}

function fixture(clear = false) {
  const field = Field.create();
  if (clear) {
    field.set(9, 8, 'X');
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 10; column++) if (column !== 4) field.set(column, row, 'X');
    }
  }
  return Board.from({
    ...new Board(42).snapshot(),
    field: field.str({ reduced: false, garbage: false, separator: '' }),
    active: clear ? { type: 'I', x: 4, y: 2, rotation: 'right' } : { type: 'T', x: 4, y: 18, rotation: 'spawn' },
  });
}

async function frames(page, count = 12, minimumMs = 0) {
  await page.evaluate(({ count, minimumMs }) => new Promise(resolve => {
    const started = performance.now();
    function next() { if (--count <= 0 && performance.now() - started >= minimumMs) resolve(); else requestAnimationFrame(next); }
    requestAnimationFrame(next);
  }), { count, minimumMs });
}

async function watchClear(page, selector, rows, threshold = 140) {
  await page.evaluate(({ selector, rows, threshold }) => {
    const canvas = document.querySelector(selector);
    if (!canvas || canvas.width !== 300 || canvas.height !== 600) throw new Error(`Missing rendered board: ${selector}`);
    const probe = { samples: [], pending: null, started: performance.now() };
    probe.sample = function () {
      const pixels = canvas.getContext('2d').getImageData(0, 0, 300, 600).data;
      const bright = Array(20).fill(0);
      let particles = 0;
      let luminance = 0;
      let hash = 2166136261;
      const top = Math.min(...rows) * 30;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const column = (offset / 4) % 300;
        const vertical = Math.floor(offset / 4 / 300);
        const row = Math.floor(vertical / 30);
        hash = Math.imul(hash ^ (red | green << 8 | blue << 16), 16777619) >>> 0;
        if (Math.min(red, green, blue) > threshold) bright[row]++;
        if (rows.includes(row)) luminance += (red + green + blue) / 3;
        if (column >= 5 && column < 265 && vertical >= top - 60 && vertical < top - 2
          && Math.max(red, green, blue) > 65 && Math.max(red, green, blue) - Math.min(red, green, blue) > 30) particles++;
      }
      const sample = { time: performance.now() - probe.started, bright, particles, luminance: luminance / (rows.length * 9000), hash };
      probe.samples.push(sample);
      return sample;
    };
    probe.before = probe.sample();
    function sampleFrame() { probe.sample(); probe.pending = requestAnimationFrame(sampleFrame); }
    probe.pending = requestAnimationFrame(sampleFrame);
    window.srClearProbe = probe;
  }, { selector, rows, threshold });
}

async function clearDrop(page) {
  await page.evaluate(() => document.addEventListener('pointerdown', event => { window.srClearPointerId = event.pointerId; }, { once: true, capture: true }));
  await page.mouse.move(1, 1);
  await page.mouse.down();
  try {
    return await page.evaluate(() => {
      const button = document.querySelector('#dropBtn');
      if (button.disabled) throw new Error('Clear action must use an enabled drop control');
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: window.srClearPointerId, pointerType: 'mouse', button: 0, buttons: 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: window.srClearPointerId, pointerType: 'mouse', button: 0 }));
      return window.srClearProbe.sample();
    });
  } finally {
    await page.mouse.up();
  }
}

async function finishClear(page, label, rows, immediate, { still = false, pristine = false } = {}) {
  await frames(page, 2, 550);
  const data = await page.evaluate(() => {
    const probe = window.srClearProbe;
    const settled = probe.sample();
    cancelAnimationFrame(probe.pending);
    return { before: probe.before, samples: probe.samples, settled };
  });
  const total = sample => rows.reduce((sum, row) => sum + sample.bright[row], 0);
  const peak = data.samples.reduce((best, sample) => total(sample) > total(best) ? sample : best, data.before);
  const first = immediate || peak;
  assert.ok(total(first) > total(data.before) + rows.length * 3000, `${label}: cleared-row bright pixels must rise: ${JSON.stringify({ before: data.before, first })}`);
  assert.ok(first.luminance > data.before.luminance + 20, `${label}: cleared rows must visibly brighten`);
  assert.ok(total(data.settled) < total(peak) - rows.length * 3000, `${label}: flash must settle after >=550ms`);
  const middle = data.samples.filter(sample => sample.time > first.time + 40 && sample.time < first.time + (still ? 160 : 450));
  assert.ok(middle.length > 0, `${label}: real animation frames must sample the effect interval`);
  if (still) {
    assert.ok(data.samples.every(sample => sample.particles === 0), `${label}: reduced motion must not emit moving particles`);
    assert.ok(data.samples.filter(sample => sample.time > first.time + 180).every(sample => sample.hash === data.before.hash), `${label}: reduced-motion flash must end after 160ms`);
  } else {
    assert.ok(middle.some(sample => sample.particles > Math.max(data.before.particles, data.settled.particles) + 8), `${label}: intermediate frames must contain colored particles above the original cleared rows`);
  }
  if (pristine) assert.equal(data.settled.hash, data.before.hash, `${label}: animation must leave no residual pixels`);
  console.log(`CLEAR ${label} ${JSON.stringify({ before: total(data.before), peak: total(peak), settled: total(data.settled), particles: Math.max(...middle.map(sample => sample.particles)), frames: data.samples.length, elapsed: data.settled.time })}`);
  return data;
}

async function rendererClearCases(page, label) {
  await page.locator('#pauseBtn').click();
  await pausedPractice(page);
  try {
    for (const { rows, still } of [{ rows: [19], still: false }, { rows: [12, 17], still: false }, { rows: [16, 17, 18, 19], still: true }]) {
      await page.emulateMedia({ reducedMotion: still ? 'reduce' : 'no-preference' });
      await page.evaluate(() => {
        document.querySelector('#clearTestCanvas')?.remove();
        const canvas = document.createElement('canvas');
        canvas.id = 'clearTestCanvas';
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:150px;height:300px;pointer-events:none;z-index:9999';
        document.body.append(canvas);
        window.srClearView = { grid: Array(20).fill('__________'), active: [], ghost: [], lines: 0, locks: 0, elapsedMs: 0, clearRows: [] };
        SRRender.draw(canvas, window.srClearView);
      });
      await watchClear(page, '#clearTestCanvas', rows, still ? 110 : 140);
      const immediate = await page.evaluate(rows => {
        Object.assign(window.srClearView, { lines: rows.length, locks: 1, elapsedMs: 100, clearRows: rows });
        SRRender.draw(document.querySelector('#clearTestCanvas'), window.srClearView);
        return window.srClearProbe.sample();
      }, rows);
      for (let row = 0; row < 20; row++) {
        if (rows.includes(row)) assert.ok(immediate.bright[row] > 6000, `${label}: original screen row ${row} must flash`);
        else assert.equal(immediate.bright[row], 0, `${label}: uncleared row ${row} must not flash`);
      }
      const caseLabel = `${label}-${still ? 'reduced-motion' : rows.length === 1 ? 'single-row' : 'noncontiguous'}`;
      await shot(page, caseLabel, true);
      const data = await finishClear(page, caseLabel, rows, immediate, { still, pristine: true });
      await watchClear(page, '#clearTestCanvas', rows);
      await page.evaluate(() => {
        const canvas = document.querySelector('#clearTestCanvas');
        SRRender.draw(canvas, window.srClearView);
        window.srClearProbe.sample();
        SRRender.draw(canvas, { ...window.srClearView, lines: 0, locks: 0, elapsedMs: 50 });
        window.srClearProbe.sample();
        SRRender.draw(canvas, window.srClearView);
        window.srClearProbe.sample();
      });
      await frames(page, 2, 550);
      const replay = await page.evaluate(() => {
        cancelAnimationFrame(window.srClearProbe.pending);
        return window.srClearProbe.samples;
      });
      assert.ok(replay.every(sample => sample.hash === data.settled.hash), `${caseLabel}: identical or stale-then-current snapshots must not replay the effect`);
    }
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      cancelAnimationFrame(window.srClearProbe?.pending);
      document.querySelector('#clearTestCanvas')?.remove();
      delete window.srClearProbe;
      delete window.srClearView;
    });
  }
}

async function phoneLayout(page) {
  const failures = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`document horizontal overflow: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const element of document.querySelectorAll('button, h1, h2, .pname, .stats, .confirm-strip, .board-overlay, .final-columns > span, .final-row > span, #standings small')) {
      if (!element.getClientRects().length) continue;
      const selector = element.id ? '#' + element.id : element.tagName + '.' + element.className;
      if (element.scrollWidth > element.clientWidth + 1) problems.push(`${selector}: text width ${element.scrollWidth} > ${element.clientWidth}`);
      const style = getComputedStyle(element);
      if (element.scrollHeight > element.clientHeight + 1 && ['hidden', 'clip'].includes(style.overflowY)) problems.push(`${selector}: text height clipped`);
      const range = document.createRange();
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
        range.selectNodeContents(node);
        for (const text of range.getClientRects()) {
          let ancestor = element;
          let scrollableX = false;
          let scrollableY = false;
          while (ancestor && ancestor !== document.body) {
            const bounds = ancestor.getBoundingClientRect();
            const css = getComputedStyle(ancestor);
            if (['auto', 'scroll'].includes(css.overflowX)) scrollableX = true;
            if (['auto', 'scroll'].includes(css.overflowY)) scrollableY = true;
            if (!scrollableX && ['hidden', 'clip'].includes(css.overflowX) && (text.left < bounds.left - 1 || text.right > bounds.right + 1)) problems.push(`${selector}: text clipped horizontally by ${ancestor.id || ancestor.className}`);
            if (!scrollableY && ['hidden', 'clip'].includes(css.overflowY) && (text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1)) problems.push(`${selector}: text clipped vertically by ${ancestor.id || ancestor.className}`);
            ancestor = ancestor.parentElement;
          }
        }
      }
    }
    return [...new Set(problems)];
  });
  assert.deepEqual(failures, [], failures.join('\n'));
}

async function iconsVisible(page, selector = '.icon-btn') {
  const buttons = page.locator(selector);
  for (let index = 0; index < await buttons.count(); index++) {
    const button = buttons.nth(index);
    if (!await button.isVisible()) continue;
    await button.scrollIntoViewIfNeeded();
    await check(button.locator('svg')).toBeVisible();
    assert.equal(await button.locator('svg').evaluate(icon => {
      const rect = icon.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && !!icon.querySelector('path,rect,circle,line,polyline,polygon');
    }), true, `${selector}[${index}]: missing Lucide artwork`);
  }
}

async function scrollList(page, selector, count, pinned, screenshotLabel) {
  const list = page.locator(selector);
  await check(list.locator(':scope > *')).toHaveCount(count);
  await contained(page, [selector, ...pinned]);
  const metrics = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
  assert.ok(metrics.scroll > metrics.client + 5, `${selector}: ${count} entries must create internal scrolling: ${JSON.stringify(metrics)}`);
  assert.match(metrics.overflow, /auto|scroll/, `${selector}: scrolling must be enabled`);
  const initialPinned = await page.locator(pinned[0]).boundingBox();
  await list.hover();
  await page.mouse.wheel(0, 10000);
  await check.poll(() => list.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2), { message: `${selector}: last entry must be reachable` }).toBe(true);
  await contained(page, [`${selector} > :last-child`, ...pinned]);
  await phoneLayout(page);
  if (screenshotLabel) await shot(page, `${screenshotLabel}-bottom`);
  await page.mouse.wheel(0, -10000);
  await check.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
  await contained(page, [`${selector} > :first-child`, ...pinned]);
  assert.deepEqual(await page.locator(pinned[0]).boundingBox(), initialPinned, `${selector}: scrolling must not move the header`);
}

async function drag(page, horizontal, vertical, slow = false) {
  await page.locator('#boardCanvas').scrollIntoViewIfNeeded();
  const rect = await page.locator('#boardCanvas').boundingBox();
  const startX = rect.x + rect.width * 0.5;
  const startY = rect.y + rect.height * 0.25;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  if (slow) await frames(page, 14);
  await page.mouse.move(startX + horizontal, startY + vertical, { steps: slow ? 5 : 1 });
  await page.mouse.up();
}

async function saved(page) {
  return page.evaluate(() => JSON.parse(SRUI.storage.get('practice.session')).board);
}

async function installPractice(page, server, snapshot) {
  await page.goto(`${server.base}/`);
  await page.evaluate(snapshot => localStorage.setItem('stackingroyale.practice.session', typeof snapshot === 'string' ? snapshot : JSON.stringify({ version: 1, board: snapshot, phase: 'paused' })), snapshot);
  await page.goto(`${server.base}/stackingroyale/practice`);
}

async function pausedPractice(page) {
  await check(page.locator('#overlayTitle')).toHaveText('Paused');
  await check(page.locator('#boardOverlay')).toBeVisible();
  const before = await saved(page);
  await frames(page);
  assert.deepEqual(await saved(page), before, 'Paused practice snapshot must remain unchanged');
  await check(page.locator('#dropBtn')).toBeDisabled();
}

async function practice(browser, name, server, issues, width = 375, height = 740) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const label = `${name}-practice-${width}`;
  monitor(page, label, issues);
  const sockets = [];
  page.on('websocket', socket => sockets.push(socket.url()));
  try {
    await page.goto(`${server.base}/stackingroyale/practice`);
    await check(page.locator('#resumeBtn')).toHaveText('Start practice');
    await sharedGameShell(page);
    await page.locator('#resumeBtn').click();
    await check(page.locator('#boardOverlay')).toBeHidden();
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    await page.waitForFunction(() => JSON.parse(SRUI.storage.get('practice.session'))?.board.elapsedMs > 100);
    await renderedCanvas(page, '#boardCanvas');
    await shot(page, `${label}-live`);
    await gameplayLayout(page, label, async () => (await saved(page)).active.x);
    const bounds = await page.locator('#controller').boundingBox();
    assert.ok(bounds.y + bounds.height <= height, `${label}: portrait controls must fit without scrolling`);
    await phoneLayout(page);
    await iconsVisible(page);
    await contained(page, ['#dropBtn']);
    await installPractice(page, server, fixture().snapshot());
    await pausedPractice(page);
    await page.locator('#resumeBtn').click();
    const initial = await saved(page);
    await page.locator('#leftBtn').click();
    await check.poll(async () => (await saved(page)).active.x).toBe(initial.active.x - 1);
    await page.locator('#rightBtn').click();
    await check.poll(async () => (await saved(page)).active.x).toBe(initial.active.x);
    await page.keyboard.press('ArrowUp');
    await check.poll(async () => (await saved(page)).active.rotation).toBe('right');
    await page.keyboard.press('c');
    await check.poll(async () => (await saved(page)).hold).toBe('T');
    await page.keyboard.press('Space');
    await check.poll(async () => (await saved(page)).locks).toBe(1);
    await page.locator('#dropBtn').click();
    await check.poll(async () => (await saved(page)).locks).toBe(2);
    await page.locator('#pauseBtn').click();
    await pausedPractice(page);
    const beforeRefresh = await saved(page);
    await page.reload();
    await pausedPractice(page);
    assert.deepEqual(await saved(page), beforeRefresh, 'Refresh restores the same paused board');
    await page.locator('#resumeBtn').click();
    await page.evaluate(() => {
      sessionStorage.removeItem('sr-test-hidden');
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) sessionStorage.setItem('sr-test-hidden', 'true');
      });
    });
    await page.goto(`${server.base}/`);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('sr-test-hidden')), 'true', 'Real navigation must exercise visibilitychange with document.hidden, without mocking visibility');
    await page.goto(`${server.base}/stackingroyale/practice`);
    await pausedPractice(page);
    await page.locator('#resumeBtn').click();
    await page.locator('#restartBtn').click();
    await check(page.locator('#confirmStrip')).toBeVisible();
    const beforeCancel = await saved(page);
    await page.locator('#cancelConfirm').click();
    await check(page.locator('#confirmStrip')).toBeHidden();
    assert.deepEqual(await saved(page), beforeCancel, 'Cancel must preserve board');
    for (let restart = 0; restart < 3; restart++) {
      await page.locator('#restartBtn').click();
      await check(page.locator('#confirmStrip')).toBeVisible();
      await page.locator('#restartBtn').click();
      await check(page.locator('#boardOverlay')).toBeHidden();
      await check.poll(async () => (await saved(page)).locks).toBe(0);
      await page.locator('#dropBtn').click();
      await check.poll(async () => (await saved(page)).locks).toBe(1);
    }
    await page.locator('#backBtn').click();
    await check(page.locator('#confirmText')).toContainText('Back again');
    await page.locator('#cancelConfirm').click();
    await pausedPractice(page);
    await installPractice(page, server, fixture().snapshot());
    await page.locator('#resumeBtn').click();
    await chooseControlMode(page, 'gestures');
    await page.locator('#pauseBtn').click();
    await pausedPractice(page);
    const beforeModeRefresh = await saved(page);
    await page.reload();
    await pausedPractice(page);
    assert.deepEqual(await saved(page), beforeModeRefresh, 'Control preference refresh must preserve the paused board');
    await check(page.locator('body')).toHaveAttribute('data-controls', 'gestures');
    await check(page.locator('#controlPopup')).toBeHidden();
    await check(page.locator('#controlModes')).toBeHidden();
    assert.equal(await page.evaluate(() => localStorage.getItem('stackingroyale.controls')), 'gestures');
    await openControlPopup(page);
    await check(page.locator('[data-mode="gestures"]')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await check(page.locator('#controlPopup')).toBeHidden();
    await pausedPractice(page);
    await page.locator('#resumeBtn').click();
    const gestureStart = await saved(page);
    await drag(page, 45, 0);
    await check.poll(async () => (await saved(page)).active.x).toBeGreaterThan(gestureStart.active.x);
    await drag(page, -45, 0);
    await check.poll(async () => (await saved(page)).active.x).toBe(gestureStart.active.x);
    await drag(page, 0, 0);
    await check.poll(async () => (await saved(page)).active.rotation).toBe('right');
    const beforeSoft = await saved(page);
    await drag(page, 0, 50, true);
    await check.poll(async () => (await saved(page)).active.y).toBeLessThan(beforeSoft.active.y);
    assert.equal((await saved(page)).locks, 0, 'Slow drag must not hard drop');
    await drag(page, 0, 115);
    await check.poll(async () => (await saved(page)).locks).toBe(1);
    await installPractice(page, server, fixture(true).snapshot());
    await page.locator('#resumeBtn').click();
    const clearRows = [16, 17, 18, 19];
    await watchClear(page, '#boardCanvas', clearRows);
    const immediateClear = await clearDrop(page);
    await shot(page, `${label}-lineclear`, true);
    await finishClear(page, label, clearRows, immediateClear);
    await check(page.locator('#linesStat')).toHaveText('4');
    await check.poll(async () => (await saved(page)).lines).toBe(4);
    await renderedCanvas(page, '#boardCanvas');
    await phoneLayout(page);
    await rendererClearCases(page, label);
    for (const corrupt of ['{broken-json', JSON.stringify({ version: 1, board: { version: 1, field: 'invalid' } })]) {
      await installPractice(page, server, corrupt);
      await check(page.locator('#resumeBtn')).toHaveText('Start practice');
      assert.equal(await page.evaluate(() => SRUI.storage.get('practice.session')), null, 'Corrupted snapshot must be removed');
      await page.locator('#resumeBtn').click();
      await check(page.locator('#boardOverlay')).toBeHidden();
    }
    await page.setViewportSize({ width: 568, height: 320 });
    await phoneLayout(page);
    await page.locator('#dropBtn').scrollIntoViewIfNeeded();
    await contained(page, ['#dropBtn']);
    await page.locator('#dropBtn').click();
    await check.poll(async () => (await saved(page)).locks).toBe(1);
    await shot(page, `${label}-landscape`);
    assert.deepEqual(sockets, [], 'Practice must not open a WebSocket');
  } catch (error) {
    await shot(page, `${label}-FAIL`).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));
}

function stackingMetadata() {
  const game = require('../games').find(entry => entry.id === 'stackingroyale');
  assert.equal(game.playerCount, '1–30', 'Hub player count must contain only the supported roster range');
  assert.equal(game.emoji, '🧱', 'Stacking Royale branding must use the brick');
}

async function holdResource(page, url) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Set();
  let released;
  const handler = async route => {
    const continued = gate.then(() => route.continue());
    pending.add(continued);
    try { await continued; } finally { pending.delete(continued); }
  };
  await page.route(url, handler);
  return () => {
    if (!released) {
      release();
      released = (async () => {
        await Promise.all([...pending]);
        await page.unroute(url, handler);
      })();
    }
    return released;
  };
}

async function irisArrival(page, label, releaseScript) {
  try {
    await check(page.locator('html')).toHaveClass(/iris-incoming/);
    await check(page.locator('#irisOverlay')).toHaveClass(/no-transition/);
    await check(page.locator('#irisOverlay .iris-emoji')).toHaveText('🧱');
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('iris_entering')).emoji), '🧱');
    const fontWait = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
    try {
      process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
      await shot(page, `${label}-preload`, true);
    } finally {
      if (fontWait === undefined) delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
      else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = fontWait;
    }
  } finally {
    await releaseScript();
  }
  await page.waitForLoadState('load');
  for (const selector of ['script[src="/shared/iris-preload.js"]:not([defer]):not([async])', 'link[href="/shared/iris.css"]', 'script[src="/shared/iris.js"]']) {
    await check(page.locator(selector)).toHaveCount(1);
  }
  await check.poll(() => page.evaluate(() => sessionStorage.getItem('iris_entering')), { message: `${label}: arrival must consume iris_entering` }).toBe(null);
  await check(page.locator('html')).not.toHaveClass(/iris-incoming|iris-active/);
  await check(page.locator('#irisOverlay')).not.toHaveClass(/revealing/);
}

async function irisJourney(page, server, destination, trigger, label) {
  const releaseDocument = await holdResource(page, `${server.base}${destination}`);
  const releaseScript = await holdResource(page, '**/shared/iris.js');
  try {
    await trigger();
    await check(page.locator('#irisOverlay')).toHaveClass(/revealing/);
    await check(page.locator('#irisOverlay .iris-emoji')).toHaveText('🧱');
    const entering = await page.evaluate(() => JSON.parse(sessionStorage.getItem('iris_entering')));
    assert.equal(entering.emoji, '🧱');
    assert.equal(entering.color, destination === '/' ? '#1b2838' : require('../games').find(entry => entry.id === 'stackingroyale').color);
    await shot(page, `${label}-source`, true);
    await releaseDocument();
    await page.waitForURL(`${server.base}${destination}`, { waitUntil: 'commit' });
    await irisArrival(page, label, releaseScript);
  } finally {
    await releaseDocument();
    await releaseScript();
  }
}

async function hubCard(page) {
  stackingMetadata();
  const card = page.locator('.game-card').filter({ has: page.locator('.game-name', { hasText: /^Stacking Royale$/ }) });
  await check(card.locator('.game-emoji')).toHaveText('🧱');
  await check(card.locator('.game-meta > span').first()).toHaveText('👥 1–30');
  await check(card.locator('.game-meta > span').first()).not.toContainText('(solo practice)');
  await card.click();
  await check(page.locator('.hub-modal-header .game-emoji')).toHaveText('🧱');
  await check(page.locator('.hub-modal-header .game-meta > span').first()).toHaveText('👥 1–30');
}

async function irisRoundtrip(browser, name, server, issues, stale = false) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const label = `${name}-presence-iris-${stale ? 'stale' : 'roundtrip'}`;
  monitor(page, label, issues);
  try {
    await page.goto(server.base);
    if (stale) {
      for (const role of ['host', 'practice']) {
        await page.evaluate(() => sessionStorage.setItem('iris_entering', JSON.stringify({ emoji: '🧱', color: '#1b2838' })));
        const releaseScript = await holdResource(page, '**/shared/iris.js');
        try {
          await page.goto(`${server.base}/stackingroyale/${role}`, { waitUntil: 'commit' });
          await irisArrival(page, `${label}-${role}`, releaseScript);
        } finally { await releaseScript(); }
        await page.reload();
        assert.equal(await page.evaluate(() => sessionStorage.getItem('iris_entering')), null);
        await check(page.locator('html')).not.toHaveClass(/iris-incoming|iris-active/);
        await check(page.locator('#irisOverlay.revealing')).toHaveCount(0);
        if (role === 'practice') {
          await check(page.locator('.session-heading h1')).toHaveText('Solo practice');
          await check(page.locator('.gtb-brand')).toHaveCount(0);
        } else {
          await check(page.locator('.gtb-brand .brand-bg')).toHaveText('🧱');
        }
      }
    } else {
      await hubCard(page);
      await irisJourney(page, server, '/stackingroyale/host', () => page.locator('.btn-play').click({ noWaitAfter: true }), `${label}-hub-host`);
      await check(page.locator('#network')).toBeHidden();
      await check(page.locator('.gtb-brand .brand-bg')).toHaveText('🧱');
      await page.locator('#backBtn').click();
      await check(page.locator('.gm-overlay')).toBeVisible();
      await page.locator('.gm-overlay [data-act="cancel"]').click();
      assert.equal(server.game.hostPresent, true, 'Cancelling Hub leave must retain host authorization');
      await page.locator('#backBtn').click();
      await irisJourney(page, server, '/', () => page.locator('.gm-overlay [data-act="ok"]').click({ noWaitAfter: true }), `${label}-host-hub`);
      assert.equal(server.game.hostPresent, false);
      await hubCard(page);
      await page.locator('.btn-practice').click();
      await page.waitForURL('**/stackingroyale/practice?from=hub');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('iris_entering')), null, 'Practice must not inherit the previous Hub roundtrip flag');
      await check(page.locator('html')).not.toHaveClass(/iris-incoming|iris-active/);
      await check(page.locator('.session-heading h1')).toHaveText('Solo practice');
      await check(page.locator('.gtb-brand')).toHaveCount(0);
      await page.locator('#resumeBtn').click();
      await page.locator('#dropBtn').click();
      await check.poll(async () => (await saved(page)).locks).toBe(1);
      assert.equal(server.game.hostPresent, false, 'Solo practice must work without a host');
      assert.equal(server.game.players.size, 0);
    }
  } catch (error) {
    await shot(page, `${label}-FAIL`).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

async function observePlayerSocket(page) {
  await page.addInitScript(() => {
    let clientFactory;
    window.srPresenceTraffic = [];
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() { return clientFactory; },
      set(factory) {
        clientFactory = new Proxy(factory, {
          apply(target, receiver, args) {
            const socket = Reflect.apply(target, receiver, args);
            window.srPresenceSocket = socket;
            socket.onAnyOutgoing((event, payload) => {
              if (event === 'player:action') window.srPresenceTraffic.push({ event, payload });
            });
            return socket;
          },
        });
      },
    });
  });
}

async function absentOverlay(page, label) {
  await check(page.locator('#hostAbsentOverlay')).toBeVisible();
  await check(page.locator('#hostAbsentTitle')).toHaveText('No game in progress');
  await check(page.locator('#hostAbsentOverlay .icon')).toHaveText('🧱');
  await check(page.locator('#hostAbsentOverlay')).toHaveAttribute('role', 'dialog');
  await check(page.locator('#hostAbsentOverlay')).toHaveAttribute('aria-modal', 'true');
  await check(page.locator('.overlay-practice-link')).toHaveText('Practice solo');
  await check(page.locator('.overlay-practice-link')).toHaveAttribute('href', '/stackingroyale/practice?from=play');
  assert.equal(await page.locator('.player-shell').evaluate(element => element.inert), true);
  for (const button of await page.locator('#controller [data-action]').all()) await check(button).toBeDisabled();
  for (const [width, height] of [[320, 568], [375, 740]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await frames(page);
    await contained(page, ['#hostAbsentOverlay', '.host-absent-card', '#hostAbsentTitle', '#hostAbsentOverlay .icon', '#hostAbsentOverlay .sub', '.overlay-practice-link']);
    const bounds = await page.locator('#hostAbsentOverlay').boundingBox();
    assert.ok(Math.abs(bounds.x) <= 1 && Math.abs(bounds.y) <= 1 && Math.abs(bounds.width - width) <= 1 && Math.abs(bounds.height - height) <= 1, `${label}: overlay must cover the entire viewport: ${JSON.stringify(bounds)}`);
    const overflow = await page.locator('.host-absent-card').evaluate(element => element.scrollHeight > element.clientHeight + 1);
    assert.equal(overflow, false, `${label}: overlay copy must not clip vertically`);
    await shot(page, `${label}-absent-${width}x${height}`);
  }
}

async function joinPresenceCard(page) {
  return page.locator('#hostAbsentOverlay').evaluate(overlay => {
    const clone = overlay.cloneNode(true);
    clone.querySelector('a').setAttribute('href', '/stackingroyale/practice');
    clone.removeAttribute('hidden');
    const properties = ['display', 'position', 'inset', 'z-index', 'width', 'max-width', 'padding', 'gap', 'border', 'border-radius', 'background-color', 'background-image', 'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'overflow-wrap', 'box-shadow', 'backdrop-filter'];
    return {
      markup: clone.outerHTML.replace(/>\s+</g, '><'),
      styles: [overlay, ...overlay.querySelectorAll('*')].map(element => {
        const style = getComputedStyle(element);
        return Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
      }),
    };
  });
}

async function blockedJoinPresence(page, reference, label) {
  await check(page.locator('#hostAbsentOverlay')).toBeVisible();
  await check(page.locator('#hostAbsentTitle')).toHaveText('No game in progress');
  await check(page.locator('#hostAbsentOverlay .overlay-practice-link')).toHaveAttribute('href', '/stackingroyale/practice?from=join');
  for (const selector of ['.join-hero', '.join-brand', '.player-attribution']) {
    assert.equal(await page.locator(selector).evaluate(element => element.inert), true, `${label}: ${selector} must be inert`);
  }
  for (const selector of ['#nameInput', '#joinBtn', '#reconnectBtn']) await check(page.locator(selector)).toBeDisabled();
  const originalName = await page.locator('#nameInput').inputValue();
  await page.locator('#nameInput').evaluate(element => element.focus());
  await check(page.locator('#nameInput')).not.toBeFocused();
  await page.keyboard.type('Blocked name');
  await check(page.locator('#nameInput')).toHaveValue(originalName);
  await page.locator('#hostAbsentOverlay .overlay-practice-link').focus();
  await check(page.locator('#hostAbsentOverlay .overlay-practice-link')).toBeFocused();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.join-hero, .join-brand, .player-attribution')), false, `${label}: Tab must not enter inert content`);
  await page.evaluate(() => document.querySelector('#joinForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await check(page).toHaveURL(/\/stackingroyale\/join$/);
  for (const [width, height] of [[320, 568], [375, 740]]) {
    await page.setViewportSize({ width, height });
    await reference.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await reference.evaluate(() => document.fonts.ready);
    await frames(page);
    assert.deepEqual(await joinPresenceCard(page), await joinPresenceCard(reference), `${label}: join must use the exact player overlay markup and styles at ${width}px`);
    await contained(page, ['#hostAbsentOverlay', '.host-absent-card', '#hostAbsentTitle', '#hostAbsentOverlay .icon', '#hostAbsentOverlay .sub', '.overlay-practice-link']);
    const bounds = await page.locator('#hostAbsentOverlay').boundingBox();
    assert.ok(Math.abs(bounds.x) <= 1 && Math.abs(bounds.y) <= 1 && Math.abs(bounds.width - width) <= 1 && Math.abs(bounds.height - height) <= 1, `${label}: blocker must cover the viewport`);
    assert.equal(await page.locator('#hostAbsentOverlay .host-absent-card').evaluate(element => element.scrollHeight > element.clientHeight + 1), false, `${label}: card must not clip`);
    const coveredPoint = await page.locator('#nameInput').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [bounds.left + 2, bounds.right - 2, bounds.left + bounds.width / 2].map(horizontal => ({ horizontal, vertical: bounds.top + bounds.height / 2 })).find(point => {
        const covering = document.elementFromPoint(point.horizontal, point.vertical);
        return covering?.closest('#hostAbsentOverlay') && !covering.closest('a');
      });
    });
    assert.ok(coveredPoint, `${label}: the overlay must intercept a click over the name input`);
    await page.mouse.click(coveredPoint.horizontal, coveredPoint.vertical);
    await check(page.locator('#nameInput')).not.toBeFocused();
    await page.keyboard.type('Still blocked');
    await check(page.locator('#nameInput')).toHaveValue(originalName);
    await shot(page, `${label}-${width}x${height}`);
  }
}

async function blockedRoundJoin(page, label) {
  await check(page.locator('#hostAbsentOverlay')).toBeHidden();
  await check(page.locator('#roundLockedOverlay')).toBeVisible();
  await check(page.locator('#roundLockedTitle')).toHaveText('Match in progress');
  await check(page.locator('#roundLockedOverlay .sub')).toContainText("You can't hop in mid-game.");
  await check(page.locator('#roundLockedOverlay .overlay-practice-link')).toHaveAttribute('href', '/stackingroyale/practice?from=join');
  for (const selector of ['.join-hero', '.join-brand', '.player-attribution']) {
    assert.equal(await page.locator(selector).evaluate(element => element.inert), true, `${label}: ${selector} must be inert`);
  }
  for (const selector of ['#nameInput', '#joinBtn']) await check(page.locator(selector)).toBeDisabled();
  const bounds = await page.locator('#roundLockedOverlay').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(Math.abs(bounds.x) <= 1 && Math.abs(bounds.y) <= 1 && Math.abs(bounds.width - viewport.width) <= 1 && Math.abs(bounds.height - viewport.height) <= 1, `${label}: blocker must cover the viewport`);
  assert.equal(await page.locator('#roundLockedOverlay .host-absent-card').evaluate(element => element.scrollHeight > element.clientHeight + 1), false, `${label}: card must not clip`);
}

async function presenceJoin(browser, name, server, issues) {
  const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const joinContext = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const freshContext = await browser.newContext({ viewport: { width: 375, height: 740 } });
  const referenceContext = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const host = await hostContext.newPage();
  const phone = await joinContext.newPage();
  const fresh = await freshContext.newPage();
  const reference = await referenceContext.newPage();
  const label = `${name}-presence-join`;
  for (const [role, page] of [['host', host], ['join', phone], ['fresh-play', fresh]]) monitor(page, `${label}-${role}`, issues);
  const clients = [];
  let stage = 'never-opened-host';
  try {
    assert.equal(server.game.hostPresent, false);
    await reference.route('**/stackingroyale/js/player.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await reference.goto(`${server.base}/stackingroyale/play`);
    await check(reference.locator('#hostAbsentOverlay')).toHaveCSS('position', 'fixed');
    const releaseJoin = await holdResource(phone, '**/stackingroyale/js/join.js');
    try {
      await phone.goto(`${server.base}/stackingroyale/join`, { waitUntil: 'commit' });
      await check(phone.locator('#hostAbsentOverlay')).toBeVisible();
      assert.equal(await phone.locator('#hostAbsentOverlay').evaluate(element => element.hidden), false, 'Join must block before its script initializes');
      assert.equal(await phone.locator('.join-hero').evaluate(element => element.inert), true);
    } finally { await releaseJoin(); }
    await phone.waitForLoadState('load');
    await blockedJoinPresence(phone, reference, `${label}-direct`);
    await fresh.goto(`${server.base}/stackingroyale/play`);
    await fresh.waitForURL('**/stackingroyale/join');
    await blockedJoinPresence(fresh, reference, `${label}-fresh-play`);
    assert.equal(server.game.players.size, 0, 'Blocked form must not join the roster');
    stage = 'practice';
    await fresh.locator('#hostAbsentOverlay .overlay-practice-link').click();
    await fresh.waitForURL('**/stackingroyale/practice?from=join');
    await fresh.locator('#resumeBtn').click();
    await fresh.locator('#dropBtn').click();
    await check.poll(async () => (await saved(fresh)).locks).toBe(1);
    await renderedCanvas(fresh, '#boardCanvas');
    assert.equal(server.game.hostPresent, false);
    assert.equal(server.game.players.size, 0, 'Practice must not join multiplayer');
    await fresh.goto(`${server.base}/stackingroyale/join`);
    stage = 'host-return';
    await host.goto(`${server.base}/stackingroyale/host`);
    await check(host.locator('#network')).toBeHidden();
    for (const page of [phone, fresh]) {
      await check(page.locator('#hostAbsentOverlay')).toBeHidden();
      await check(page.locator('#nameInput')).toBeEnabled();
      await check(page.locator('#joinBtn')).toBeEnabled();
      assert.equal(await page.locator('.join-hero').evaluate(element => element.inert), false);
      await page.locator('#nameInput').fill('Host returned');
      await check(page.locator('#nameInput')).toHaveValue('Host returned');
    }
    for (const phase of ['LOBBY', 'PLAYING']) {
      stage = `leave-${phase}`;
      if (phase === 'PLAYING') {
        for (const playerId of ['join-presence-one', 'join-presence-two']) {
          const client = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
          clients.push(client);
          await check.poll(() => client.connected).toBe(true);
          assert.equal((await request(client, 'player:join', { playerId, name: playerId })).ok, true);
        }
        await host.locator('#startBtn').click();
        await check.poll(() => server.game.phase).toBe('PLAYING');
        await check(phone.locator('#gateTitle')).toHaveText('Match in progress');
        await blockedRoundJoin(phone, `${label}-playing`);
        await blockedRoundJoin(fresh, `${label}-playing-fresh`);
      }
      await host.locator('#backBtn').click();
      const hostSocket = [...server.ns.sockets.values()].find(socket => socket.data.role === 'host');
      let leaveObserved = false;
      hostSocket.on('host:leave', () => { leaveObserved = true; });
      const releaseHub = await holdResource(host, `${server.base}/`);
      try {
        await host.locator('.gm-overlay [data-act="ok"]').click({ noWaitAfter: true });
        for (const page of [phone, fresh]) await check(page.locator('#hostAbsentOverlay'), { timeout: 1500 }).toBeVisible();
        assert.equal(leaveObserved, true);
        assert.equal(server.game.hostPresent, false);
        assert.equal(server.ns.sockets.has(hostSocket.id), true, 'Intentional leave must block before socket disconnect');
      } finally { await releaseHub(); }
      await host.waitForURL(`${server.base}/`);
      await blockedJoinPresence(phone, reference, `${label}-${phase}-absent`);
      assert.equal(server.game.phase, phase);
      if (phase === 'PLAYING') {
        assert.equal(await phone.locator('#gateTitle').evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('#hostAbsentOverlay') !== null;
        }), true, 'No game in progress must cover the inline Match in progress gate');
      }
      stage = `reload-${phase}`;
      await phone.reload();
      await blockedJoinPresence(phone, reference, `${label}-${phase}-reload`);
      await host.goto(`${server.base}/stackingroyale/host`);
      await check(phone.locator('#hostAbsentOverlay')).toBeHidden();
      if (phase === 'LOBBY') {
        await check(phone.locator('#roundLockedOverlay')).toBeHidden();
        await check(phone.locator('#nameInput')).toBeEnabled();
        await check(phone.locator('#joinBtn')).toBeEnabled();
      } else {
        await blockedRoundJoin(phone, `${label}-${phase}-host-return`);
      }
    }
  } catch (error) {
    await shot(phone, `${label}-${stage}-FAIL`).catch(() => {});
    throw new Error(`${label} stage ${stage}: ${error.stack}`, { cause: error });
  } finally {
    for (const client of clients) client.disconnect();
    for (const context of [referenceContext, freshContext, joinContext, hostContext]) await context.close();
  }
}

async function blockedPresenceInput(page, player, label) {
  const sequence = player.seq;
  const position = player.board?.snapshot().active?.x;
  const traffic = await page.evaluate(() => window.srPresenceTraffic.length);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.mouse.move(5, 5);
  await page.mouse.down();
  try {
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('#controller [data-action]')) {
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 }));
        button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0 }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      for (const key of ['ArrowRight', 'ArrowDown', 'ArrowUp', 'z', 'x', 'c', ' ']) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      }
    });
  } finally { await page.mouse.up(); }
  await frames(page, 12, 400);
  assert.equal(player.seq, sequence, `${label}: blocked input must not advance server sequence`);
  assert.equal(player.board?.snapshot().active?.x, position, `${label}: blocked movement must not change the active piece's horizontal position`);
  assert.equal(await page.evaluate(() => window.srPresenceTraffic.length), traffic, `${label}: blocked input must not emit action events, even offline`);
  return sequence;
}

async function presenceLifecycle(browser, name, server, issues, kind) {
  const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const phoneContext = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const host = await hostContext.newPage();
  const phone = await phoneContext.newPage();
  const label = `${name}-presence-${kind}`;
  monitor(host, `${label}-host`, issues);
  monitor(phone, `${label}-phone`, issues);
  await observePlayerSocket(phone);
  let bot;
  let stage = 'join';
  try {
    await host.goto(`${server.base}/stackingroyale/host`);
    await check(host.locator('#network')).toBeHidden();
    await phone.goto(`${server.base}/stackingroyale/join`);
    await check(phone.locator('.join-brand')).toHaveText('🧱 Stacking Royale');
    await check(phone.locator('#joinBtn')).toBeEnabled();
    await phone.locator('#nameInput').fill('WWWWWWWWWWWWWWWWWWWW');
    await phone.locator('#joinBtn').click();
    await phone.waitForURL('**/stackingroyale/play');
    await check(phone.locator('#hostAbsentOverlay')).toBeHidden();
    await check(phone.locator('#waiting .pulse')).toHaveText('🧱');
    const playerId = await phone.evaluate(() => SRUI.storage.get('playerId'));
    const player = server.game.players.get(playerId);
    bot = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
    await check.poll(() => bot.connected).toBe(true);
    assert.equal((await request(bot, 'player:join', { playerId: 'presence-peer', name: 'Presence peer' })).ok, true);
    const roster = [...server.game.players.keys()];
    if (kind !== 'lobby') {
      await host.locator('#startBtn').click();
      await check(phone.locator('#dropBtn')).toBeEnabled();
      await check(phone.locator('#targeting, [data-target]')).toHaveCount(0);
      await phone.keyboard.down('ArrowLeft');
      await check.poll(() => player.seq).toBeGreaterThan(0);
    }
    const matchId = server.game.matchId;
    stage = 'absence';
    if (kind === 'unexpected') {
      const hostSocket = [...server.ns.sockets.values()].find(socket => socket.data.role === 'host');
      const lostAt = Date.now();
      hostSocket.disconnect(true);
      await check(host.locator('#network')).toBeVisible();
      assert.equal(server.game.hostPresent, true, 'Unexpected host loss must retain presence during grace');
      await check(phone.locator('#hostAbsentOverlay')).toBeHidden();
      await phone.keyboard.up('ArrowLeft');
      await phone.keyboard.press('ArrowRight');
      await check(phone.locator('#dropBtn')).toBeEnabled();
      await check.poll(() => server.game.hostPresent, { timeout: 20000, intervals: [100] }).toBe(false);
      assert.ok(Date.now() - lostAt >= 14000, 'Unexpected disconnect must honor the real 15-second host grace');
    } else if (kind === 'network') {
      await phone.evaluate(() => {
        window.srPresenceSocket.io.reconnection(false);
        window.srPresenceSocket.io.engine.close();
      });
      assert.equal(server.game.hostPresent, true, 'Player connection loss must not mark the host absent');
      await check(phone.locator('#network')).toBeVisible();
    } else {
      await host.locator('#backBtn').click();
      const hostSocket = [...server.ns.sockets.values()].find(socket => socket.data.role === 'host');
      let leaveObserved = false;
      hostSocket.on('host:leave', () => { leaveObserved = true; });
      const releaseHub = await holdResource(host, `${server.base}/`);
      try {
        await host.locator('.gm-overlay [data-act="ok"]').click({ noWaitAfter: true });
        await check(phone.locator('#hostAbsentOverlay'), { timeout: 1500 }).toBeVisible();
        assert.equal(leaveObserved, true, 'Actual Hub confirmation must send host:leave');
        assert.equal(server.game.hostPresent, false);
        assert.equal(server.ns.sockets.has(hostSocket.id), true, 'Overlay must appear before navigation disconnects the host socket');
      } finally { await releaseHub(); }
      await host.waitForURL(`${server.base}/`);
    }
    await absentOverlay(phone, label);
    const sequence = await blockedPresenceInput(phone, player, label);
    const traffic = await phone.evaluate(() => window.srPresenceTraffic.length);
    if (kind !== 'lobby') {
      const elapsed = server.game.elapsedMs;
      const boardElapsed = player.board.snapshot().elapsedMs;
      await check.poll(() => server.game.elapsedMs).toBeGreaterThan(elapsed + 200);
      assert.ok(player.board.snapshot().elapsedMs > boardElapsed, 'AFK board simulation must continue during absence');
    }
    assert.deepEqual([...server.game.players.keys()], roster);
    assert.equal(server.game.matchId, matchId);
    if (kind === 'lobby' || kind === 'intentional') {
      stage = 'late-reload';
      const releasePlayer = await holdResource(phone, '**/stackingroyale/js/player.js');
      try {
        await phone.reload({ waitUntil: 'commit' });
        await check(phone.locator('#hostAbsentOverlay')).toBeVisible();
        assert.equal(await phone.locator('#hostAbsentOverlay').evaluate(element => element.hidden), false, 'Unavailable overlay must be visible before player.js initializes');
      } finally { await releasePlayer(); }
      await phone.waitForLoadState('load');
      await check.poll(() => player.connected).toBe(true);
      await absentOverlay(phone, `${label}-reload`);
      await blockedPresenceInput(phone, player, `${label}-reload`);
    }
    stage = 'return';
    if (kind === 'network') await phone.evaluate(() => window.srPresenceSocket.connect());
    else await host.goto(`${server.base}/stackingroyale/host`);
    await check(phone.locator('#hostAbsentOverlay')).toBeHidden();
    assert.equal(await phone.locator('.player-shell').evaluate(element => element.inert), false);
    assert.deepEqual([...server.game.players.keys()], roster, 'Host return must preserve every roster entry');
    assert.equal(server.game.matchId, matchId);
    if (kind !== 'lobby') {
      await check(phone.locator('#dropBtn')).toBeEnabled();
      const returnedTraffic = await phone.evaluate(() => window.srPresenceTraffic.length);
      if (kind === 'network' || kind === 'unexpected') assert.equal(returnedTraffic, traffic, 'Reconnection must not flush blocked input');
      await frames(phone, 12, 400);
      assert.equal(player.seq, sequence, 'Held input must not resume without a fresh press');
      await phone.keyboard.up('ArrowLeft');
      const position = player.board.snapshot().active.x;
      await phone.keyboard.press('ArrowRight');
      await check.poll(() => player.seq).toBe(sequence + 1);
      await check.poll(() => player.board.snapshot().active.x).toBe(position + 1);
      const last = await phone.evaluate(() => window.srPresenceTraffic.filter(item => item.event === 'player:action').at(-1));
      assert.equal(last.payload.seq, sequence + 1, 'Blocked synthetic inputs must not increment the client sequence');
      await renderedCanvas(phone, '#boardCanvas');
    } else {
      await playerLobby(phone, 2);
      await check(host.locator('#startBtn')).toBeEnabled();
    }
    await shot(phone, `${label}-returned`);
  } catch (error) {
    await shot(phone, `${label}-${stage}-FAIL`).catch(() => {});
    await shot(host, `${label}-${stage}-host-FAIL`).catch(() => {});
    throw new Error(`${label} stage ${stage}: ${error.stack}`, { cause: error });
  } finally {
    if (bot) bot.disconnect();
    await phoneContext.close();
    await hostContext.close();
  }
}

function survivalClock(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function survivalRows(page, players, host = false, complete = true) {
  const rows = page.locator(host ? '#finalRoster > .final-row' : '#standings > .roster-row');
  if (complete) await check(rows).toHaveCount(players.length);
  if (host) {
    await check(page.locator('.final-columns > span').nth(2)).toHaveText('Survived');
    await check(page.locator('.final-columns')).not.toContainText('Sent');
  }
  for (const player of players) {
    assert.ok(Number.isFinite(player.survivalMs) && player.survivalMs >= 0, `${player.id}: survivalMs must be active simulated time`);
    const row = rows.filter({ has: page.locator('.pname', { hasText: new RegExp(`^${player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    await check(row, `${player.id} (${player.name}): unique standings row`).toHaveCount(1);
    if (player.placement) await check(row.locator('.place')).toHaveText(`#${player.placement}`);
    const winnerSuffix = player.alive && player.placement === 1 ? '+' : '';
    await check(row.locator(host ? ':scope > span:last-child' : 'small'), `${player.id} (${player.name}): survival time`).toHaveText(`${host ? '' : 'Survived '}${survivalClock(player.survivalMs)}${winnerSuffix}`);
  }
  const clipping = await rows.evaluateAll(elements => elements.flatMap(row => {
    const bounds = row.getBoundingClientRect();
    const problems = [];
    for (const cell of row.querySelectorAll('.pname, .place, small, :scope > span')) {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const cellBounds = cell.getBoundingClientRect();
      for (const text of range.getClientRects()) {
        if (text.left < cellBounds.left - 1 || text.right > cellBounds.right + 1 || text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1 || text.left < bounds.left - 1 || text.right > bounds.right + 1) problems.push(`${row.textContent}: text escapes its cell or row`);
      }
    }
    return problems;
  }));
  assert.deepEqual(clipping, [], 'Standings names, placements and survival times must not overlap or clip');
}

async function incomingIndicator(page, amount) {
  const indicator = page.locator('#incoming');
  await check(indicator).toHaveCount(1);
  if (!amount) {
    await check(indicator).toBeHidden();
    return;
  }
  await check(indicator).toBeVisible();
  await check(indicator).toHaveText(`+${amount}`);
  await check(page.locator('.board-rail').first().locator('#incoming')).toHaveCount(1);
  const hold = await page.locator('#holdCanvas').boundingBox();
  const bounds = await indicator.boundingBox();
  assert.ok(bounds.y >= hold.y + hold.height, 'Incoming indicator must sit below Hold');
  await contained(page, ['#incoming']);
}

async function singlePlayer(browser, name, server, issues) {
  const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const phoneContext = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const host = await hostContext.newPage();
  const phone = await phoneContext.newPage();
  monitor(host, `${name}-solo-host`, issues);
  monitor(phone, `${name}-solo-phone`, issues);
  try {
    await host.goto(`${server.base}/stackingroyale/host`);
    await check(host.locator('#network')).toBeHidden();
    await check(host.locator('#startBtn')).toBeDisabled();
    await phone.goto(`${server.base}/stackingroyale/join`);
    await check(phone.locator('#joinBtn')).toBeEnabled();
    await sharedGameShell(phone);
    await phone.locator('#nameInput').fill('Solo Player');
    await phone.locator('#joinBtn').click();
    await phone.waitForURL('**/stackingroyale/play');
    await playerLobby(phone, 1);
    await check(host.locator('#startBtn')).toBeEnabled();
    await host.locator('#startBtn').click();
    const player = [...server.game.players.values()][0];
    await playerMatchShell(phone, server.game, player.id, 'COUNTDOWN');
    await check.poll(() => server.game.phase).toBe('PLAYING');
    await check.poll(() => server.game.elapsedMs).toBeGreaterThan(1000);
    assert.equal(server.game.phase, 'PLAYING');
    await check(phone.locator('#dropBtn')).toBeEnabled();
    await check(phone.locator('#targeting, [data-target]')).toHaveCount(0);
    await incomingIndicator(phone, 0);
    await renderedCanvas(phone, '#boardCanvas');
    await renderedCanvas(host, '#featuredBoards canvas');
    await phoneLayout(phone);
    await gameplayLayout(phone, `${name}-solo-player`, () => player.board.snapshot().active.x);
    await contained(host, ['#view-match', '#featuredBoards', '#featuredBoards canvas', '#battleRoster', '#pauseBtn']);
    await host.locator('#pauseBtn').click();
    await check(phone.locator('#overlayTitle')).toHaveText('Paused');
    await playerMatchShell(phone, server.game, player.id);
    const before = player.board.snapshot();
    const pausedSurvival = player.survivalMs;
    assert.equal(pausedSurvival, server.game.elapsedMs);
    await host.reload();
    await phone.reload();
    await check(host.locator('#matchOverlayTitle')).toHaveText('Paused');
    await check(phone.locator('#overlayTitle')).toHaveText('Paused');
    await playerMatchShell(phone, server.game, player.id);
    assert.deepEqual(player.board.snapshot(), before);
    assert.equal(player.survivalMs, pausedSurvival, 'Paused reconnect must not add survival time');
    await host.locator('#pauseBtn').click();
    await check(phone.locator('#dropBtn')).toBeEnabled();
    await phone.locator('#dropBtn').click();
    await check.poll(() => player.board.snapshot().locks).toBe(1);
    assert.equal(server.game.phase, 'PLAYING');
    assert.deepEqual(player.targetIds, []);
    assert.equal(player.board.view().incoming, 0);
    await shot(host, `${name}-solo-host-live`);
    await shot(phone, `${name}-solo-player-live`);
    player.board.enqueueGarbage(40, 0, 0, 'fixture');
    for (let drop = 0; drop < 10 && server.game.phase === 'PLAYING'; drop++) {
      const sequence = player.seq;
      await phone.locator('#dropBtn').click();
      await check.poll(() => player.seq).toBeGreaterThan(sequence);
    }
    await check(host.locator('#view-final')).toBeVisible();
    await check(phone.locator('#results')).toBeVisible();
    await playerMatchShell(phone, server.game, player.id, 'FINAL');
    assert.equal(player.alive, false);
    assert.deepEqual(server.game.winnerIds, []);
    const finalState = server.game.state();
    assert.equal(player.survivalMs, finalState.elapsedMs, 'Solo survival ends with the match');
    for (const reconnected of [false, true]) {
      if (reconnected) {
        await host.reload();
        await phone.reload();
      }
      await check(host.locator('#view-final')).toBeVisible();
      await check(phone.locator('#results')).toBeVisible();
      assert.equal(await phone.evaluate(() => SRUI.storage.get('playerId')), player.id);
      await survivalRows(host, finalState.players, true);
      await survivalRows(phone, finalState.players);
      await phoneLayout(host);
      await phoneLayout(phone);
      await shot(host, `${name}-solo-host-final${reconnected ? '-reconnect' : ''}`);
      await shot(phone, `${name}-solo-player-final${reconnected ? '-reconnect' : ''}`);
      assert.equal(player.survivalMs, finalState.elapsedMs, 'Final reconnect must retain survival time');
    }
  } finally {
    await phoneContext.close();
    await hostContext.close();
  }
}

async function multiplayer(browser, name, server, issues, count) {
  const contexts = [];
  const clients = [];
  const pages = [];
  const label = `${name}-${count}players`;
  const { game, ns } = server;
  const originalRandom = game.random;
  let stage = 'join';
  async function newPage(role, width, height) {
    const context = await browser.newContext({ viewport: { width, height } });
    contexts.push(context);
    const page = await context.newPage();
    pages.push({ role, page });
    monitor(page, `${label}-${role}`, issues);
    return page;
  }
  async function client(index) {
    const socket = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture client connection timeout')), 5000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });
    const joined = await request(socket, 'player:join', { playerId: `browser-${index}`, name: `${String(index).padStart(2, '0')}${'W'.repeat(18)}` });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    return socket;
  }
  async function active(page) {
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'Headless player must genuinely be visible');
    await check(page.locator('#waiting')).toBeHidden();
    await check(page.locator('#boardOverlay')).toBeHidden();
    await check(page.locator('#dropBtn')).toBeEnabled();
    await playerMatchShell(page, game, await page.evaluate(() => SRUI.storage.get('playerId')), 'PLAYING');
    const time = await page.locator('#timeStat').textContent();
    await check.poll(() => page.locator('#timeStat').textContent(), { message: '#timeStat must advance on the unpaused visible player' }).not.toBe(time);
  }
  async function resetAndRejoin(host, phones, ids, hostSocketId, final) {
    const phase = final ? 'FINAL' : 'PLAYING';
    const previousMatchId = game.matchId;
    const previousIds = [...game.players.keys()];
    const previousNames = ids.map(id => game.players.get(id).name);
    const resetLabel = final ? 'final-reset' : 'live-reset';
    stage = resetLabel;
    assert.equal(game.phase, phase);
    if (!final) await host.locator('#settingsBtn').click();
    const resetButton = host.locator(final ? '#againBtn' : '#resetBtn');
    if (final) {
      await check(resetButton).toHaveText('New Game');
      await resetButton.click();
      await check(host.locator('.gm-overlay')).toBeHidden();
    } else {
      await resetButton.click();
      await host.locator('.gm-overlay [data-act="cancel"]').click();
      assert.equal(game.phase, phase);
      assert.deepEqual([...game.players.keys()], previousIds);
      await host.locator('#settingsBtn').click();
      await resetButton.click();
      await host.locator('.gm-overlay [data-act="ok"]').click();
    }
    await check(host.locator('#view-lobby')).toBeVisible();
    await check(host.locator('#lobbyRoster > .player-chip')).toHaveCount(0);
    await check(host.locator('#startBtn')).toBeDisabled();
    await check(host.locator('#network')).toBeHidden();
    assert.equal(game.phase, 'LOBBY');
    assert.equal(game.players.size, 0);
    assert.equal(game.hostPresent, true);
    assert.notEqual(game.matchId, previousMatchId);
    assert.equal(ns.sockets.has(hostSocketId), true, 'Reset must retain the original host connection');
    await shot(host, `${label}-${resetLabel}-host-empty`);
    for (let index = 0; index < phones.length; index++) {
      const phone = phones[index];
      await phone.waitForURL('**/stackingroyale/join');
      await check(phone.locator('#joinForm')).toBeVisible();
      await check(phone.locator('#nameInput')).toBeVisible();
      await check(phone.locator('#joinBtn')).toBeEnabled();
      await check(phone.locator('#reconnectBtn')).toBeHidden();
      assert.equal(await phone.evaluate(() => SRUI.storage.get('playerId')), null);
      await sharedGameShell(phone);
      await shot(phone, `${label}-${resetLabel}-phone${index + 1}-join`);
    }
    assert.equal(game.players.size, 0, 'Redirected phones must not automatically rejoin');
    await check(host.locator('#startBtn')).toBeDisabled();
    stage = `${resetLabel}-fresh-join`;
    for (let index = 0; index < phones.length; index++) {
      const phone = phones[index];
      const name = index ? `Fresh${'W'.repeat(15)}` : previousNames[index];
      await phone.locator('#nameInput').fill(name);
      await phone.locator('#joinBtn').click();
      await phone.waitForURL('**/stackingroyale/play');
      await check(phone.locator('#waitTitle')).toHaveText("You're in!");
      const newId = await phone.evaluate(() => SRUI.storage.get('playerId'));
      assert.ok(newId && !previousIds.includes(newId), 'Fresh join must create a new player identity');
      assert.equal(game.players.get(newId).name, name);
      ids[index] = newId;
      for (const joinedPhone of phones.slice(0, index + 1)) await playerLobby(joinedPhone, index + 1);
      await check(host.locator('#lobbyRoster > .player-chip')).toHaveCount(index + 1);
    }
    assert.equal(game.players.size, phones.length);
    for (const id of previousIds) assert.equal(game.players.has(id), false);
    await check(host.locator('#startBtn')).toBeEnabled();
    await shot(host, `${label}-${resetLabel}-host-fresh-lobby`);
    await host.locator('#startBtn').click();
    await check.poll(() => game.phase).toBe('PLAYING');
    assert.equal(ns.sockets.has(hostSocketId), true, 'The same authorized host must start the new game without reloading');
    for (const phone of phones) await active(phone);
  }
  try {
    const host = await newPage('host', 1366, 768);
    await host.goto(`${server.base}/stackingroyale/host`);
    await check(host.locator('#network')).toBeHidden();
    await sharedGameShell(host);
    await check(host.locator('#qrImage')).toBeVisible();
    assert.equal(await host.locator('#qrImage').evaluate(image => image.naturalWidth > 0), true);
    const phones = [];
    const ids = [];
    for (let index = 0; index < 2; index++) {
      const phone = await newPage(`phone${index + 1}`, index ? 320 : 375, index ? 568 : 740);
      phones.push(phone);
      await phone.goto(`${server.base}/stackingroyale/join`);
      await check(phone.locator('#joinBtn')).toBeEnabled();
      await sharedGameShell(phone);
      assert.equal(await phone.locator('#nameInput').evaluate(element => getComputedStyle(element).color), 'rgb(26, 26, 26)', 'Name input must remain readable on white');
      await phone.evaluate(() => document.fonts.ready);
      await phone.locator('#nameInput').fill('W'.repeat(19) + index);
      await phone.locator('#joinBtn').click();
      await phone.waitForURL('**/stackingroyale/play');
      await check(phone.locator('#waitTitle')).toHaveText("You're in!");
      for (const joinedPhone of phones) await playerLobby(joinedPhone, index + 1);
      await check(phone.locator('.lobby-wait .pulse')).toHaveText('🧱');
      await check(phone.locator('#attribution')).toBeVisible();
      await centeredFooter(phone, '#playerFooter', 'play');
      await phoneLayout(phone);
      await mobileAppProtections(phone, `${label}-waiting-${index ? 320 : 375}`);
      await shot(phone, `${label}-player-${index ? 320 : 375}-waiting`);
      ids.push(await phone.evaluate(() => SRUI.storage.get('playerId')));
    }
    for (let index = 2; index < count; index++) await client(index);
    await check(host.locator('#lobbyRoster > .player-chip')).toHaveCount(count);
    assert.equal(game.players.size, count);
    for (let index = 0; index < phones.length; index++) {
      const phone = phones[index];
      await playerLobby(phone, count);
      await phone.reload();
      await playerLobby(phone, count);
      assert.equal(await phone.evaluate(() => SRUI.storage.get('playerId')), ids[index]);
      assert.equal(game.players.size, count, 'Lobby reconnect must not duplicate a player');
      await phoneLayout(phone);
      await shot(phone, `${label}-player-${index ? 320 : 375}-waiting-full`);
    }
    for (const player of game.players.values()) assert.equal(player.name.length, 20);
    stage = 'lobby-layout';
    await shot(host, `${label}-host-lobby`);
    await contained(host, ['#view-lobby', '#lobbyRoster', '#startBtn']);
    await phoneLayout(host);
    const panelHeights = await host.locator('.lobby-left, .lobby-right').evaluateAll(panels => panels.map(panel => panel.getBoundingClientRect().height));
    assert.ok(Math.abs(panelHeights[0] - panelHeights[1]) <= 1, 'Lobby panels must share the same grid height');
    assert.equal(await host.locator('.lobby-right').evaluate(panel => getComputedStyle(panel).backgroundColor), 'rgba(0, 0, 0, 0)', 'Noggle lobby has no extra card around the roster');
    if (count >= 25) await scrollList(host, '#lobbyRoster', count, ['.lobby-header', '.start-row']);
    await iconsVisible(host, '#startBtn, #backBtn, #settingsBtn');
    stage = 'start-and-player-progression';
    await host.locator('#startBtn').click();
    for (let index = 0; index < phones.length; index++) await playerMatchShell(phones[index], game, ids[index], 'COUNTDOWN');
    await check.poll(() => game.phase).toBe('PLAYING');
    await check(host.locator('#matchOverlay')).toBeHidden();
    for (const phone of phones) await active(phone);
    await renderedCanvas(host, '#featuredBoards .featured-board:first-child canvas');
    await shot(host, `${label}-host-live`);
    for (let index = 0; index < phones.length; index++) {
      await renderedCanvas(phones[index], '#boardCanvas');
      await check(phones[index].locator('.p-header .name')).toHaveText(game.players.get(ids[index]).name);
      assert.equal(await phones[index].locator('.p-header .name').evaluate(element => element.scrollWidth > element.clientWidth), true, 'Maximum-length name must exercise horizontal scrolling');
      await shot(phones[index], `${label}-player-${index ? 320 : 375}-live`);
      await phoneLayout(phones[index]);
      await gameplayLayout(phones[index], `${label}-player-${index ? 320 : 375}`, () => game.players.get(ids[index]).board.snapshot().active.x, index ? 330 : 500);
      await iconsVisible(phones[index], '#dropBtn, #holdBtn, #cwBtn');
    }
    if (count >= 25) await scrollList(host, '#battleRoster', count, ['.match-heading', '.battle-sidebar .roster-head']);
    await contained(host, ['#view-match', '#featuredBoards', '#featuredBoards canvas', '#battleRoster', '#pauseBtn']);
    stage = 'two-phone-input';
    for (let index = 0; index < phones.length; index++) {
      const phone = phones[index];
      const player = game.players.get(ids[index]);
      const before = player.seq;
      await phone.locator('#leftBtn').click();
      await check.poll(() => player.seq).toBe(before + 1);
      await phone.locator('#holdBtn').click();
      await check.poll(() => player.board.snapshot().hold).not.toBeNull();
      await phone.locator('#cwBtn').click();
      await check.poll(() => player.seq).toBe(before + 3);
      await phone.locator('#dropBtn').click();
      await check.poll(() => player.board.snapshot().locks).toBe(1);
      await check(phone.locator('#targeting, [data-target]')).toHaveCount(0);
      await incomingIndicator(phone, 0);
    }
    await chooseControlMode(phones[1], 'gestures');
    const gestureSeq = game.players.get(ids[1]).seq;
    await drag(phones[1], 40, 0);
    await check.poll(() => game.players.get(ids[1]).seq).toBeGreaterThan(gestureSeq);
    stage = 'host-pause-reconnect-resume';
    await host.locator('#pauseBtn').click();
    await check.poll(() => game.paused).toBe(true);
    for (const phone of phones) {
      await check(phone.locator('#overlayTitle')).toHaveText('Paused');
      await check(phone.locator('#dropBtn')).toBeDisabled();
      await sharedGameShell(phone);
    }
    const snapshots = ids.map(id => game.players.get(id).board.snapshot());
    const pausedSurvivals = [...game.players.values()].map(player => player.survivalMs);
    assert.ok(pausedSurvivals.every(milliseconds => milliseconds === game.elapsedMs));
    await frames(host);
    assert.deepEqual(ids.map(id => game.players.get(id).board.snapshot()), snapshots);
    const matchId = game.matchId;
    await host.reload();
    await check(host.locator('#matchOverlayTitle')).toHaveText('Paused');
    for (let index = 0; index < phones.length; index++) {
      await phones[index].reload();
      await check(phones[index].locator('#overlayTitle')).toHaveText('Paused');
      await playerMatchShell(phones[index], game, ids[index]);
      const mode = index ? 'gestures' : 'buttons';
      await check(phones[index].locator('body')).toHaveAttribute('data-controls', mode);
      await check(phones[index].locator(`#controlModes [data-mode="${mode}"]`)).toHaveAttribute('aria-pressed', 'true');
      assert.equal(await phones[index].evaluate(() => localStorage.getItem('stackingroyale.controls')), mode);
      assert.equal(await phones[index].evaluate(() => SRUI.storage.get('playerId')), ids[index]);
    }
    assert.equal(game.matchId, matchId);
    assert.deepEqual(ids.map(id => game.players.get(id).board.snapshot()), snapshots);
    assert.deepEqual([...game.players.values()].map(player => player.survivalMs), pausedSurvivals, 'Paused reconnect must freeze every player survival time');
    await host.locator('#pauseBtn').click();
    for (const phone of phones) await active(phone);
    await host.reload();
    await check(host.locator('#matchOverlay')).toBeHidden();
    await phones[0].reload();
    await active(phones[0]);
    assert.equal(game.matchId, matchId);
    await noReactions(host);
    for (const phone of phones) await noReactions(phone);
    stage = 'genuine-attack';
    await host.locator('#pauseBtn').click();
    await check.poll(() => game.paused).toBe(true);
    const attacker = game.players.get(ids[0]);
    const target = game.players.get(ids[1]);
    attacker.board = fixture(true);
    for (const player of game.players.values()) {
      if (player !== attacker) player.board = fixture();
    }
    game.random = () => 0;
    const events = [];
    const collectEvents = event => events.push(event);
    ns.to(attacker.socketId).emit('state:board', { matchId, seq: attacker.seq, board: attacker.board.snapshot() });
    await check(phones[0].locator('#linesStat')).toHaveText('0');
    const observer = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(observer);
    observer.on('battle:event', collectEvents);
    await check.poll(() => observer.connected).toBe(true);
    await host.locator('#pauseBtn').click();
    await check(phones[0].locator('#dropBtn')).toBeEnabled();
    const clearRows = [16, 17, 18, 19];
    const attackerCanvas = '#featuredBoards .featured-board:first-child canvas';
    await frames(host, 2, 150);
    await watchClear(host, attackerCanvas, clearRows);
    await watchClear(phones[0], '#boardCanvas', clearRows);
    const immediateClear = await clearDrop(phones[0]);
    await Promise.all([
      shot(phones[0], `${label}-player-lineclear`, true),
      (async () => {
        await host.waitForFunction(() => window.srClearProbe.samples.some(sample => sample.bright.slice(16).reduce((sum, value) => sum + value, 0) > 24000), null, { timeout: 3000, polling: 'raf' });
        await shot(host, `${label}-host-lineclear`, true);
      })(),
    ]);
    await finishClear(phones[0], `${label}-player`, clearRows, immediateClear);
    await finishClear(host, `${label}-host`, clearRows);
    await check.poll(() => attacker.lines).toBe(4);
    await check.poll(() => events.some(event => event.type === 'attack' && event.from === attacker.id && event.to === target.id)).toBe(true);
    game.random = originalRandom;
    await check(host.locator('#battleFeed')).toContainText('sent');
    assert.ok(target.board.view().incoming > 0);
    await incomingIndicator(phones[1], target.board.view().incoming);
    await shot(phones[1], `${label}-player-incoming`);
    stage = 'normal-topout-final';
    const losers = [...game.players.values()].filter(player => player.id !== ids[0]);
    let earlyEliminated = null;
    for (const loser of losers) {
      loser.board.enqueueGarbage(40, 0, 0, attacker.id);
      for (let drop = 0; drop < 10 && loser.alive; drop++) {
        const nextSeq = loser.seq + 1;
        if (loser.id === ids[1]) {
          await phones[1].locator('#dropBtn').click();
          await check.poll(() => loser.seq).toBe(nextSeq);
        } else {
          const socket = clients.find(socket => socket.id === loser.socketId);
          const response = await request(socket, 'player:action', { matchId, seq: nextSeq, action: 'drop' });
          assert.equal(response.ok, true, JSON.stringify(response));
        }
      }
      await check.poll(() => loser.alive).toBe(false);
      assert.equal(loser.board.over, true, 'Topout must originate in the real engine');
      if (loser.id === ids[1]) {
        await check(phones[1].locator('#results')).toBeVisible();
        await playerMatchShell(phones[1], game, loser.id);
        await centeredFooter(phones[1], '#playerFooter', 'play', true);
        await phoneLayout(phones[1]);
        await survivalRows(phones[1], [{ ...loser }], false, false);
        if (count > 2) {
          earlyEliminated = { id: loser.id, survivalMs: loser.survivalMs };
          await check.poll(() => game.elapsedMs).toBeGreaterThan(earlyEliminated.survivalMs + 1100);
          assert.equal(game.phase, 'PLAYING');
          assert.equal(loser.survivalMs, earlyEliminated.survivalMs, 'Eliminated survival must freeze while others keep playing');
          await survivalRows(phones[1], [{ ...loser }], false, false);
          await host.locator('#pauseBtn').click();
          await check.poll(() => game.paused).toBe(true);
          const eliminatedState = game.state();
          await phones[1].reload();
          await check(phones[1].locator('#results')).toBeVisible();
          assert.equal(await phones[1].evaluate(() => SRUI.storage.get('playerId')), loser.id);
          await playerMatchShell(phones[1], game, loser.id, 'PLAYING');
          await survivalRows(phones[1], eliminatedState.players);
          assert.equal(loser.survivalMs, earlyEliminated.survivalMs, 'Eliminated reconnect must retain frozen survival time');
          await scrollList(phones[1], '#standings', count, ['#resultEyebrow', '#resultTitle', '#spectateTools', '#playerFooter'], `${label}-player-320-eliminated-reconnect`);
          await shot(phones[1], `${label}-player-320-eliminated-reconnect`);
          await host.locator('#pauseBtn').click();
          await check.poll(() => game.paused).toBe(false);
        }
      }
    }
    await check.poll(() => game.phase).toBe('FINAL');
    assert.deepEqual(game.winnerIds, [ids[0]]);
    const finalState = game.state();
    assert.equal(game.players.get(ids[0]).survivalMs, finalState.elapsedMs, 'Winner survival must equal active match time');
    if (earlyEliminated) {
      assert.equal(game.players.get(earlyEliminated.id).survivalMs, earlyEliminated.survivalMs);
      assert.ok(earlyEliminated.survivalMs < finalState.elapsedMs, 'Early elimination must have less survival time than the winner');
      assert.notEqual(survivalClock(earlyEliminated.survivalMs), survivalClock(finalState.elapsedMs), 'Fixture must expose different displayed survival times');
    }
    await check(host.locator('#view-final')).toBeVisible();
    await check(host.locator('#finalRoster > .final-row')).toHaveCount(count);
    await survivalRows(host, finalState.players, true);
    await shot(host, `${label}-host-final`);
    await contained(host, ['#view-final', '#winnerTitle', '#finalRoster', '#againBtn']);
    await phoneLayout(host);
    if (count >= 25) await scrollList(host, '#finalRoster', count, ['.final-header', '.final-columns', '.final-actions'], `${label}-host-final`);
    for (const phone of phones) {
      await check(phone.locator('#results')).toBeVisible();
      await playerMatchShell(phone, game, await phone.evaluate(() => SRUI.storage.get('playerId')), 'FINAL');
      await check(phone.locator('#standings > .roster-row')).toHaveCount(count);
      await survivalRows(phone, finalState.players);
      await check(phone.locator('#controller')).toBeHidden();
      await centeredFooter(phone, '#playerFooter', 'play', true);
      await check(phone.locator('#attribution')).toBeHidden();
      await phoneLayout(phone);
      if (count >= 25) await scrollList(phone, '#standings', count, ['#resultEyebrow', '#resultTitle', '#playerFooter'], `${label}-player-${phone.viewportSize().width}-final`);
      await shot(phone, `${label}-player-${phone.viewportSize().width}-final`);
    }
    stage = 'final-survival-reconnect';
    await host.reload();
    await check(host.locator('#view-final')).toBeVisible();
    await survivalRows(host, finalState.players, true);
    await phoneLayout(host);
    await shot(host, `${label}-host-final-reconnect`);
    for (let index = 0; index < phones.length; index++) {
      const phone = phones[index];
      await phone.reload();
      await check(phone.locator('#results')).toBeVisible();
      assert.equal(await phone.evaluate(() => SRUI.storage.get('playerId')), ids[index]);
      await playerMatchShell(phone, game, ids[index], 'FINAL');
      await survivalRows(phone, finalState.players);
      await phoneLayout(phone);
      await shot(phone, `${label}-player-${phone.viewportSize().width}-final-reconnect`);
    }
    assert.equal(game.elapsedMs, finalState.elapsedMs);
    assert.deepEqual(game.state().players.map(player => [player.id, player.survivalMs]), finalState.players.map(player => [player.id, player.survivalMs]), 'Final reloads must retain every player survival time');
    const playerSocketIds = [...game.players.values()].map(player => player.socketId);
    const hostSocketIds = [...ns.sockets.keys()].filter(id => !playerSocketIds.includes(id) && !clients.some(socket => socket.id === id));
    assert.equal(hostSocketIds.length, 1, 'There must be one host connection before reset');
    await resetAndRejoin(host, phones, ids, hostSocketIds[0], true);
    await resetAndRejoin(host, phones, ids, hostSocketIds[0], false);
  } catch (error) {
    for (const { role, page } of pages) {
      await shot(page, `${label}-${role}-${stage}-FAIL`).catch(() => {});
      const details = await page.evaluate(() => ({ visibility: document.visibilityState, overlay: document.querySelector('#overlayTitle')?.textContent, time: document.querySelector('#timeStat')?.textContent, network: document.querySelector('#network')?.textContent, horizontal: document.documentElement.scrollWidth, viewport: [innerWidth, innerHeight] })).catch(() => ({}));
      observations.push(`${label}-${role} at ${stage}: ${JSON.stringify(details)}`);
    }
    throw new Error(`${label} stage ${stage}: ${error.stack}`, { cause: error });
  } finally {
    game.random = originalRandom;
    for (const socket of clients) socket.disconnect();
    for (const context of contexts) await context.close();
  }
}

async function mobileLockEarly(browser, name, server, issues, role) {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const label = `${name}-mobile-lock-${role}`;
  const clients = [];
  let release;
  monitor(page, label, issues);
  try {
    const host = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(host);
    await check.poll(() => host.connected).toBe(true);
    assert.equal((await request(host, 'host:auth')).ok, true);
    if (role === 'player') {
      const player = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(player);
      await check.poll(() => player.connected).toBe(true);
      assert.equal((await request(player, 'player:join', { playerId: 'mobile-lock-player', name: 'W'.repeat(20) })).ok, true);
    }
    await page.addInitScript(role => {
      if (role === 'player') localStorage.setItem('stackingroyale.playerId', 'mobile-lock-player');
      window.lockRegistrations = [];
      const original = document.addEventListener;
      document.addEventListener = function (type, listener, options) {
        if (document.currentScript?.src.includes('/controls.js')) window.lockRegistrations.push({ type, capture: !!options?.capture, passive: options?.passive, bodyAbsent: document.body === null, readyState: document.readyState, src: document.currentScript.src });
        return original.call(this, type, listener, options);
      };
    }, role);
    release = await holdResource(page, /\/stackingroyale\/js\/(common\.js|engine[^/]*\.js)(\?.*)?$/);
    await page.goto(`${server.base}/stackingroyale/${role === 'player' ? 'play' : role}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.SRControls && document.body, null, { polling: 50, timeout: 6000 });
    assert.equal(await page.evaluate(() => typeof window.SRUI), 'undefined', 'Deferred common.js must still be held');
    if (role !== 'join') assert.equal(await page.evaluate(() => typeof window.StackingRoyale), 'undefined', 'Deferred engine must still be held');
    const registrations = await page.evaluate(() => window.lockRegistrations);
    assert.deepEqual(registrations.map(entry => entry.type).sort(), ['selectstart', 'contextmenu', 'dragstart', 'dblclick', 'gesturestart', 'gesturechange', 'gestureend', 'touchstart', 'touchmove', 'touchend', 'wheel', 'selectionchange'].sort());
    for (const entry of registrations) {
      assert.ok(entry.bodyAbsent && entry.readyState === 'loading', `${entry.type}: lock must install synchronously before body`);
      assert.equal(new URL(entry.src).search, '?v=2');
      if (entry.type !== 'selectionchange') assert.ok(entry.capture && entry.passive === false, `${entry.type}: capture/nonpassive required`);
    }
    const early = await page.evaluate(() => {
      const target = document.createElement('span');
      document.body.append(target);
      const failures = [];
      function verify() {
        const cases = ['selectstart', 'contextmenu', 'dragstart', 'dblclick', 'gesturestart', 'gesturechange', 'gestureend'].map(type => ({ type, cancel: true }));
        for (const type of ['touchstart', 'touchmove']) for (const count of [1, 2, 3]) cases.push({ type, count, cancel: count > 1 });
        for (const ctrlKey of [false, true]) cases.push({ type: 'wheel', ctrlKey, cancel: ctrlKey });
        for (const sample of cases) {
          const event = new Event(sample.type, { cancelable: true, bubbles: true });
          if (sample.count) Object.defineProperty(event, 'touches', { value: Array.from({ length: sample.count }, () => ({})) });
          if (sample.type === 'wheel') Object.defineProperty(event, 'ctrlKey', { value: sample.ctrlKey });
          let calls = 0;
          const prevent = event.preventDefault;
          event.preventDefault = function () { calls++; prevent.call(this); };
          let canceledAtTarget;
          target.addEventListener(sample.type, childEvent => { canceledAtTarget = childEvent.defaultPrevented; childEvent.stopImmediatePropagation(); }, { once: true });
          const returned = target.dispatchEvent(event);
          if (returned !== !sample.cancel || canceledAtTarget !== sample.cancel || calls !== Number(sample.cancel)) failures.push({ sample, returned, canceledAtTarget, calls });
        }
        const end = () => target.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
        end();
        if (end() !== false) failures.push('Rapid second touchend was not canceled');
      }
      verify();
      let added = 0;
      const add = document.addEventListener;
      document.addEventListener = function (...args) { added++; return add.apply(this, args); };
      try { for (let repeat = 0; repeat < 5; repeat++) SRControls.lockZoom(); } finally { document.addEventListener = add; }
      verify();
      target.remove();
      return { failures, added };
    });
    assert.deepEqual(early, { failures: [], added: 0 }, 'Early lock must cancel exactly once, even after repeated lockZoom calls');
    await check(page.locator('script[src="/stackingroyale/js/controls.js?v=2"]')).toHaveCount(1);
    assert.equal(await page.locator('script[src*="/controls.js"]').evaluate(script => script.defer || script.async), false);
    await check(page.locator('link[href="/stackingroyale/css/touch.css?v=2"]')).toHaveCount(1);
    await release();
    await page.waitForLoadState('load');
    if (role === 'join') await check(page.locator('#joinBtn')).toBeEnabled();
    if (role === 'player') await check(page.locator('#waitTitle')).toHaveText("You're in!");
    if (role === 'practice') await check(page.locator('#resumeBtn')).toHaveText('Start practice');
    assert.deepEqual(await page.evaluate(() => window.lockRegistrations), registrations, 'Existing page lockZoom call must not re-register lock listeners');
    await mobileAppProtections(page, label);
    const selectionCleared = await page.evaluate(() => {
      document.activeElement?.blur();
      const target = document.createElement('span');
      target.textContent = 'Noneditable selection regression';
      document.body.append(target);
      target.style.userSelect = 'text';
      target.style.webkitUserSelect = 'text';
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const before = selection.toString();
      document.dispatchEvent(new Event('selectionchange'));
      const after = selection.toString();
      target.remove();
      return { before, after };
    });
    assert.ok(selectionCleared.before.length > 0, 'Selection fixture must contain actual text');
    assert.equal(selectionCleared.after, '', 'selectionchange must clear noneditable text');
    if (role === 'join') {
      const input = page.locator('#nameInput');
      assert.ok(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16), 'Small-screen input font must be >=16px to avoid iOS focus autozoom');
      await frames(page, 1, 400);
      await input.tap();
      await check(input).toBeFocused();
      await page.keyboard.type('Mobile Lock');
      await check(input).toHaveValue('Mobile Lock');
      await input.press('ArrowLeft');
      await input.press('Shift+ArrowLeft');
      const edit = await input.evaluate(element => {
        const selection = [element.selectionStart, element.selectionEnd];
        document.dispatchEvent(new Event('selectionchange'));
        const canceled = ['selectstart', 'contextmenu', 'dragstart', 'dblclick'].filter(type => !element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));
        return { selection, after: [element.selectionStart, element.selectionEnd], canceled };
      });
      assert.deepEqual(edit, { selection: [9, 10], after: [9, 10], canceled: [] }, 'Input caret, selection and editing defaults must survive the lock');
      await page.keyboard.type('X');
      await check(input).toHaveValue('Mobile LoXk');
      await input.dblclick();
      assert.ok(await input.evaluate(element => element.selectionEnd > element.selectionStart), 'Native input doubleclick must select editable text');
    }
    assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    observations.push(`${label}: synchronous pre-body ?v=2 lock, held deferred assets, capture cancellation, idempotence, selection and editing PASS; iOS gesture events are synthetic, not real Safari.`);
  } catch (error) {
    if (release) await release().catch(() => {});
    await shot(page, `${label}-FAIL`).catch(() => {});
    throw error;
  } finally {
    if (release) await release().catch(() => {});
    await context.close();
    for (const client of clients) client.disconnect();
  }
}

async function nativeTouchPath(session, points, nextPoints = [], duration = 0, page) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  if (duration) await frames(page, 1, duration);
  for (const touchPoints of nextPoints) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints });
    if (page) await frames(page, 1);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  if (page) await frames(page, 1);
}

async function mobileLockTouch(browser, name, server, issues) {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const host = await hostContext.newPage();
  const clients = [];
  const label = `${name}-mobile-lock-touch`;
  let stage = 'practice';
  monitor(page, label, issues);
  monitor(host, `${label}-host`, issues);
  const session = name === 'chromium' ? await context.newCDPSession(page) : null;
  if (session) await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.addInitScript(() => {
    let controls;
    window.mobileActions = [];
    window.mobileScaleSamples = [];
    window.mobileScaleArmed = false;
    Object.defineProperty(window, 'SRControls', {
      configurable: true,
      get() { return controls; },
      set(value) {
        controls = value;
        const bind = value.bind;
        value.bind = function (options) {
          return bind({ ...options, action(action) { window.mobileActions.push(action); return options.action(action); } });
        };
      },
    });
    for (const type of ['touchstart', 'touchmove', 'touchend']) document.addEventListener(type, event => {
      if (window.mobileScaleArmed) window.mobileScaleSamples.push({ type, trusted: event.isTrusted, contacts: event.touches.length, scale: visualViewport.scale });
    }, { capture: true, passive: true });
    visualViewport.addEventListener('resize', () => {
      if (window.mobileScaleArmed) window.mobileScaleSamples.push({ type: 'resize', scale: visualViewport.scale });
    });
  });
  async function armScaleProbe() {
    await check.poll(() => page.evaluate(() => visualViewport.scale)).toBe(1);
    await frames(page, 2);
    await page.evaluate(() => { window.mobileScaleArmed = true; });
  }
  async function center(selector) {
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds, `${stage}: missing ${selector}`);
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, id: 1 };
  }
  async function scaleUnchanged() {
    const scales = await page.evaluate(() => ({ current: visualViewport.scale, samples: window.mobileScaleSamples }));
    assert.equal(scales.current, 1, `${stage}: visual viewport scale`);
    assert.ok(scales.samples.every(sample => sample.scale === 1), `${stage}: transient zoom: ${JSON.stringify(scales.samples)}`);
  }
  async function selectionInteractions(selector) {
    const text = page.locator(selector);
    await text.dblclick();
    assert.equal(await page.evaluate(() => getSelection().toString()), '', `${selector}: native doubleclick must not select text`);
    const bounds = await text.boundingBox();
    await page.mouse.move(bounds.x + 3, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 12 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => getSelection().toString()), '', `${selector}: native drag must not select text`);
    if (session) await nativeTouchPath(session, [await center(selector)], [], 650, page);
    else await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await check.poll(() => page.evaluate(() => getSelection().toString())).toBe('');
    await scaleUnchanged();
  }
  async function pinchAndSpread(selector) {
    if (!session) return;
    const point = await center(selector);
    const contacts = distance => [{ x: 160 - distance, y: point.y, id: 1 }, { x: 160 + distance, y: point.y, id: 2 }];
    for (const distances of [[20, 35, 55, 75, 100], [100, 75, 55, 35, 20]]) {
      await nativeTouchPath(session, contacts(distances[0]), distances.slice(1).map(contacts), 0, page);
      await scaleUnchanged();
    }
    await check.poll(() => page.evaluate(() => window.mobileScaleSamples.some(sample => sample.trusted && sample.type === 'touchstart' && sample.contacts === 2)), { message: 'CDP pinch must deliver actual trusted two-contact input, even when canceled at touchstart' }).toBe(true);
  }
  async function modesAndControls(role) {
    stage = `${role}-controls`;
    await renderedCanvas(page, '#boardCanvas');
    await page.locator('#controlSettingsBtn').tap();
    await check(page.locator('#controlPopup')).toBeVisible();
    await mobileAppProtections(page, `${label}-${role}-popup`);
    await check(page.locator('#controlPopup')).toBeHidden();
    await page.locator('#controlSettingsBtn').tap();
    await check(page.locator('#controlPopup')).toBeVisible();
    await page.locator('#controlModes [data-mode="gestures"]').tap();
    await check(page.locator('body')).toHaveAttribute('data-controls', 'gestures');
    await check(page.locator('#controlPopup')).toBeHidden();
    await page.evaluate(() => { window.mobileActions = []; });
    const canvas = await center('#boardCanvas');
    if (session) await nativeTouchPath(session, [canvas], [[{ ...canvas, x: canvas.x + 45 }]], 0, page);
    else await page.locator('#boardCanvas').tap();
    await check.poll(() => page.evaluate(() => window.mobileActions)).toEqual([session ? 'right' : 'rotateCW']);
    await page.locator('#controlSettingsBtn').tap();
    await check(page.locator('#controlPopup')).toBeVisible();
    await page.locator('#controlModes [data-mode="buttons"]').tap();
    await check(page.locator('body')).toHaveAttribute('data-controls', 'buttons');
    await check(page.locator('#controlPopup')).toBeHidden();
    for (let burst = 0; burst < 4; burst++) {
      const direction = burst % 2 ? 'right' : 'left';
      const move = await center(`#${direction}Btn`);
      const rotate = { ...await center('#cwBtn'), id: 2 };
      const before = role === 'practice' ? await saved(page) : server.game.players.get(await page.evaluate(() => SRUI.storage.get('playerId'))).board.snapshot();
      await page.evaluate(() => { window.mobileActions = []; });
      if (session) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [move] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [move, rotate] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.touchscreen.tap(move.x, move.y);
        await page.touchscreen.tap(rotate.x, rotate.y);
      }
      await check.poll(() => page.evaluate(() => window.mobileActions)).toEqual([direction, 'rotateCW']);
      await check.poll(async () => {
        const after = role === 'practice' ? await saved(page) : server.game.players.get(await page.evaluate(() => SRUI.storage.get('playerId'))).board.snapshot();
        return after.active.x === before.active.x + (direction === 'left' ? -1 : 1) && after.active.rotation !== before.active.rotation;
      }, { message: `${role}: both thumb actions must reach the actual board` }).toBe(true);
      await scaleUnchanged();
    }
    await pinchAndSpread(role === 'practice' ? '.session-heading h1' : '#playerName');
    if (role === 'practice') await page.locator('#pauseBtn').tap();
    else await host.locator('#pauseBtn').click();
    await check(page.locator('#dropBtn')).toBeDisabled();
    assert.equal(await page.locator('#dropBtn').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
    const disabled = await center('#dropBtn');
    const before = role === 'practice' ? await saved(page) : server.game.players.get(await page.evaluate(() => SRUI.storage.get('playerId'))).board.snapshot();
    await page.evaluate(() => { window.mobileActions = []; });
    await page.touchscreen.tap(disabled.x, disabled.y);
    await page.touchscreen.tap(disabled.x, disabled.y);
    await frames(page, 2);
    assert.deepEqual(await page.evaluate(() => window.mobileActions), [], 'Disabled button taps must not invoke actions');
    const after = role === 'practice' ? await saved(page) : server.game.players.get(await page.evaluate(() => SRUI.storage.get('playerId'))).board.snapshot();
    assert.deepEqual(after, before, 'Disabled button path must preserve the paused board');
    await scaleUnchanged();
  }
  async function touchScroll(selector, horizontal = false) {
    const element = page.locator(selector);
    const metrics = await element.evaluate(element => ({ client: element.clientHeight, total: element.scrollHeight, width: element.clientWidth, totalWidth: element.scrollWidth, touchAction: getComputedStyle(element).touchAction }));
    assert.ok(horizontal ? metrics.totalWidth > metrics.width : metrics.total > metrics.client, `${selector}: fixture must overflow`);
    assert.equal(metrics.touchAction, 'pan-x pan-y', `${selector}: one-finger panning must remain enabled without pinch`);
    const before = await page.locator('.p-header').boundingBox();
    if (session) {
      for (let swipe = 0; swipe < 16; swipe++) {
        const bounds = await element.boundingBox();
        const start = { x: horizontal ? bounds.x + bounds.width - 10 : bounds.x + bounds.width / 2, y: horizontal ? bounds.y + bounds.height / 2 : bounds.y + bounds.height - 15, id: 1 };
        const distance = horizontal ? bounds.width - 20 : bounds.height - 30;
        const points = Array.from({ length: 8 }, (_, index) => [{ ...start, x: start.x - (horizontal ? distance * (index + 1) / 8 : 0), y: start.y - (horizontal ? 0 : distance * (index + 1) / 8) }]);
        await nativeTouchPath(session, [start], points, 0, page);
        await frames(page, 2);
        if (await element.evaluate((element, horizontal) => horizontal ? element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 : element.scrollTop + element.clientHeight >= element.scrollHeight - 2, horizontal)) break;
      }
    } else {
      await element.evaluate((element, horizontal) => { if (horizontal) element.scrollLeft = element.scrollWidth; else element.scrollTop = element.scrollHeight; }, horizontal);
      observations.push(`${label}: ${selector} verifies scroll reachability programmatically; mobile WebKit Playwright has no native touch-drag or wheel API. Native single-finger scrolling is covered in Chromium only.`);
    }
    await check.poll(() => element.evaluate((element, horizontal) => horizontal ? element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 : element.scrollTop + element.clientHeight >= element.scrollHeight - 2, horizontal), { message: `${selector}: last content must be reachable` }).toBe(true);
    assert.deepEqual(await page.locator('.p-header').boundingBox(), before, 'Scrolling must keep the header pinned');
    if (!horizontal) await contained(page, [`${selector} > :last-child`, '.p-header', '#resultTitle']);
    assert.equal(await page.evaluate(() => getSelection().toString()), '');
    await scaleUnchanged();
  }
  try {
    await page.goto(`${server.base}/stackingroyale/practice`);
    const capability = await page.evaluate(() => ({ maxTouchPoints: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches }));
    observations.push(`${label}: touch context ${JSON.stringify(capability)} (hasTouch=true, isMobile=true).`);
    await armScaleProbe();
    await selectionInteractions('.session-heading h1');
    assert.ok(await page.evaluate(() => window.mobileScaleSamples.some(sample => sample.type === 'touchstart' && sample.trusted)), 'Touch-capable context must deliver trusted touch input');
    await pinchAndSpread('.session-heading h1');
    await page.locator('#resumeBtn').tap();
    await modesAndControls('practice');
    stage = 'player-join';
    await host.goto(`${server.base}/stackingroyale/host`);
    await check(host.locator('#network')).toBeHidden();
    await page.goto(`${server.base}/stackingroyale/join`);
    await check(page.locator('#joinBtn')).toBeEnabled();
    await armScaleProbe();
    await selectionInteractions('.join-brand');
    await pinchAndSpread('.join-brand');
    await page.locator('#nameInput').fill('W'.repeat(20));
    await page.locator('#joinBtn').tap();
    await page.waitForURL('**/stackingroyale/play');
    await armScaleProbe();
    const playerId = await page.evaluate(() => SRUI.storage.get('playerId'));
    for (let index = 1; index < 25; index++) {
      const socket = connect(`${server.base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(socket);
      await check.poll(() => socket.connected).toBe(true);
      assert.equal((await request(socket, 'player:join', { playerId: `touch-${index}`, name: String(index).padStart(2, '0') + 'W'.repeat(18) })).ok, true);
    }
    await selectionInteractions('#playerName');
    await host.locator('#startBtn').click();
    await check.poll(() => server.game.phase).toBe('PLAYING');
    await check(page.locator('#dropBtn')).toBeEnabled();
    await modesAndControls('player');
    stage = 'header-scroll';
    await touchScroll('#playerName', true);
    stage = 'results-scroll';
    await host.locator('#pauseBtn').click();
    await check.poll(() => server.game.paused).toBe(false);
    const player = server.game.players.get(playerId);
    player.board.enqueueGarbage(40, 0, 0, 'touch-1');
    for (let drop = 0; drop < 10 && player.alive; drop++) {
      const seq = player.seq;
      await page.locator('#dropBtn').tap();
      await check.poll(() => player.seq).toBe(seq + 1);
    }
    await check(page.locator('#results')).toBeVisible();
    await page.reload();
    await check(page.locator('#standings > .roster-row')).toHaveCount(25);
    await armScaleProbe();
    await touchScroll('#standings');
    await mobileAppProtections(page, `${label}-results`);
    await selectionInteractions('#resultTitle');
    await shot(page, `${label}-results-bottom`);
    observations.push(`${label}: ${session ? 'trusted CDP pinch/spread, long-press, simultaneous two-thumb actions and single-finger name/results scroll' : 'mobile WebKit taps; synthetic iOS gestures only, not real Safari or native pinch/long-press'}; practice/player actual board actions, disabled path, popup modes and scale=1 PASS.`);
  } catch (error) {
    await shot(page, `${label}-${stage}-FAIL`).catch(() => {});
    throw new Error(`${label} ${stage}: ${error.stack}`, { cause: error });
  } finally {
    for (const client of clients) client.disconnect();
    if (session) await session.detach().catch(() => {});
    await context.close();
    await hostContext.close();
  }
}

async function main() {
  const scenarioFilter = process.env.SR_BROWSER_SCENARIOS ? new RegExp(process.env.SR_BROWSER_SCENARIOS) : null;
  const engineFilter = process.env.SR_BROWSER_ENGINES ? process.env.SR_BROWSER_ENGINES.split(',').map(name => name.trim()) : null;
  if (engineFilter) assert.ok(engineFilter.every(name => ['chromium', 'webkit'].includes(name)), 'SR_BROWSER_ENGINES must contain chromium and/or webkit');
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    if (engineFilter && !engineFilter.includes(name)) continue;
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      for (const [scenario, run] of [
        ...['join', 'player', 'practice'].map(role => [`mobile-lock-${role}`, (server, issues) => mobileLockEarly(browser, name, server, issues, role)]),
        ['mobile-lock-touch', (server, issues) => mobileLockTouch(browser, name, server, issues)],
        ['practice-375', (server, issues) => practice(browser, name, server, issues)],
        ['practice-320', (server, issues) => practice(browser, name, server, issues, 320, 568)],
        ['single-player-host', (server, issues) => singlePlayer(browser, name, server, issues)],
        ['multiplayer-2', (server, issues) => multiplayer(browser, name, server, issues, 2)],
        ['multiplayer-30', (server, issues) => multiplayer(browser, name, server, issues, 30)],
        ['presence-join', (server, issues) => presenceJoin(browser, name, server, issues)],
        ['presence-lobby', (server, issues) => presenceLifecycle(browser, name, server, issues, 'lobby')],
        ['presence-intentional', (server, issues) => presenceLifecycle(browser, name, server, issues, 'intentional')],
        ['presence-unexpected', (server, issues) => presenceLifecycle(browser, name, server, issues, 'unexpected')],
        ['presence-network', (server, issues) => presenceLifecycle(browser, name, server, issues, 'network')],
        ['iris-roundtrip', (server, issues) => irisRoundtrip(browser, name, server, issues)],
        ['iris-stale-arrivals', (server, issues) => irisRoundtrip(browser, name, server, issues, true)],
      ]) {
        if (scenarioFilter && !scenarioFilter.test(scenario)) continue;
        let server;
        const issues = [];
        try {
          server = await isolatedServer();
          console.log(`RUN ${name} ${scenario} ${server.base}`);
          await run(server, issues);
          assert.deepEqual(issues, [], issues.join('\n'));
          results.push({ browser: name, scenario, status: 'PASS' });
          console.log(`PASS ${name} ${scenario}`);
        } catch (error) {
          results.push({ browser: name, scenario, status: 'FAIL', error: error.stack, issues });
          console.error(`FAIL ${name} ${scenario}: ${error.message}`);
          process.exitCode = 1;
        } finally {
          if (server) await server.close();
        }
      }
    } catch (error) {
      results.push({ browser: name, status: 'BLOCKED', error: error.stack });
      process.exitCode = 1;
    } finally {
      if (browser) await browser.close();
    }
  }
  console.log(JSON.stringify({ results, observations, screenshots }, null, 2));
  assert.ok(results.length, 'No browser scenarios matched the requested filters');
}

main().catch(error => { console.error(error); process.exitCode = 1; });