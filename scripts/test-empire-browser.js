'use strict';

/**
 * Empire browser regression oracle.
 *
 * Drives a full Host + two-phone playthrough through the real UI, so it stays
 * valid across the SSE → Socket.IO refactor. Spawns its own server on a spare
 * port with a dummy GROQ_API_KEY (which starts the game in the submission
 * phase and skips the API-key setup screen).
 *
 *   node scripts/test-empire-browser.js
 */

const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = Number(process.env.EMPIRE_TEST_PORT || 3123);
const BASE = 'http://localhost:' + PORT;
const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(ok, label) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + label);
  if (ok) pass++; else failures.push(label);
}
function section(name) { console.log('\n\u2014 ' + name); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/empire/join');
      if (r.ok) return true;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('server did not come up on ' + PORT);
}

/** Each phone needs its own context — localStorage drives the rejoin path. */
async function newPhone(browser, errors, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(label + ': ' + e));
  return { ctx, page };
}

async function submitWord(page, name, word) {
  await page.goto(BASE + '/empire/join', { waitUntil: 'networkidle' });
  await page.waitForSelector('#viewPlayerSubmit', { state: 'visible', timeout: 15000 });
  await page.fill('#playerName', name);
  await page.fill('#playerWord', word);
  await page.click('#btnPlayerSubmit');
  await page.waitForURL(/\/empire\/play/, { timeout: 20000 });
}

/** The shared modal is custom markup, not window.confirm. */
async function confirmModal(page) {
  await page.waitForSelector('.gm-btn[data-act="ok"]', { state: 'visible', timeout: 5000 });
  await page.click('.gm-btn[data-act="ok"]');
}

const visible = (page, sel) => page.locator(sel).isVisible().catch(() => false);

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), GROQ_API_KEY: 'test-key-not-real' }),
    stdio: 'ignore',
  });

  const browser = await chromium.launch();
  const errors = [];
  let ctxs = [];

  try {
    await waitServer();

    // ── Host ──────────────────────────────────────────────
    section('Host lobby');
    const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    ctxs.push(hostCtx);
    const host = await hostCtx.newPage();
    host.on('pageerror', (e) => errors.push('host: ' + e));
    await host.goto(BASE + '/empire/host', { waitUntil: 'networkidle' });

    await host.waitForSelector('#viewHostSubmission', { state: 'visible', timeout: 15000 });
    check(true, 'host lands in the lobby (API key came from the env var)');
    check((await host.textContent('#hostPlayerCount')).trim() === '0', 'lobby starts at 0 players');

    // ── Players join ──────────────────────────────────────
    section('Submissions');
    const alice = await newPhone(browser, errors, 'alice');
    const bob = await newPhone(browser, errors, 'bob');
    ctxs.push(alice.ctx, bob.ctx);

    await submitWord(alice.page, 'Alice', 'apple');
    await alice.page.waitForSelector('#viewPlayerDone', { state: 'visible', timeout: 10000 });
    check(true, 'Alice submits and lands on the done view');

    await submitWord(bob.page, 'Bob', 'banana');
    await bob.page.waitForSelector('#viewPlayerDone', { state: 'visible', timeout: 10000 });
    check(true, 'Bob submits and lands on the done view');

    await host.waitForFunction(() =>
      document.querySelectorAll('#playerNamesInner .player-chip').length === 2, null, { timeout: 10000 });
    const chips = await host.$$eval('#playerNamesInner .player-chip', (els) => els.map((e) => e.textContent.trim()));
    check((await host.textContent('#hostPlayerCount')).trim() === '2', 'host shows 2 players');
    check(chips.join(',') === 'Alice,Bob', 'host lists both names: ' + chips.join(', '));

    // Duplicate name is refused.
    const dupe = await newPhone(browser, errors, 'dupe');
    ctxs.push(dupe.ctx);
    await dupe.page.goto(BASE + '/empire/join', { waitUntil: 'networkidle' });
    await dupe.page.fill('#playerName', 'Alice');
    await dupe.page.fill('#playerWord', 'avocado');
    await dupe.page.click('#btnPlayerSubmit');
    await dupe.page.waitForSelector('#playerSubmitMsg.show', { timeout: 10000 });
    check(/already/i.test(await dupe.page.textContent('#playerSubmitMsg')), 'a duplicate name is rejected');

    // ── Reactions ─────────────────────────────────────────
    section('Reactions');
    const before = await host.$$eval('.reaction-float, #reactionLayer > *', (e) => e.length).catch(() => 0);
    await alice.page.click('#globalReactionBar .reaction-btn[data-reaction="4"]');
    const reacted = await host.waitForFunction((n) =>
      document.querySelectorAll('.reaction-float, #reactionLayer > *').length > n,
    before, { timeout: 8000 }).then(() => true).catch(() => false);
    check(reacted, 'a player reaction reaches the host screen');

    // ── Kick ──────────────────────────────────────────────
    section('Kick');
    await host.click('#playerNamesInner .player-chip:nth-child(2)');
    await confirmModal(host);
    await bob.page.waitForSelector('#viewPlayerKicked', { state: 'visible', timeout: 10000 });
    check(true, 'a kicked player sees the kicked view');
    await host.waitForFunction(() =>
      document.querySelectorAll('#playerNamesInner .player-chip').length === 1, null, { timeout: 8000 });
    check((await host.textContent('#hostPlayerCount')).trim() === '1', 'host count drops to 1 after a kick');

    // Bob rejoins so we can start.
    await submitWord(bob.page, 'Bob', 'banana');
    await bob.page.waitForSelector('#viewPlayerDone', { state: 'visible', timeout: 10000 });
    check(true, 'the kicked player can rejoin');

    // ── Withdraw ──────────────────────────────────────────
    section('Withdraw');
    await bob.page.click('#btnChangeWord');
    await bob.page.waitForURL(/\/empire\/join/, { timeout: 10000 });
    check(true, 'withdraw returns the player to the join form');
    await submitWord(bob.page, 'Bob', 'banana');
    await bob.page.waitForSelector('#viewPlayerDone', { state: 'visible', timeout: 10000 });

    // ── Start ─────────────────────────────────────────────
    section('Start');
    await host.click('#btnStartGame');
    await host.waitForSelector('#viewHostGame', { state: 'visible', timeout: 20000 });
    check(true, 'host moves to the game view');
    await alice.page.waitForSelector('#viewPlayerGame', { state: 'visible', timeout: 10000 });
    await bob.page.waitForSelector('#viewPlayerGame', { state: 'visible', timeout: 10000 });
    check(true, 'both phones move to the playing view');

    await host.click('#btnWords');
    await host.waitForFunction(() =>
      document.querySelectorAll('#wordsGrid .word-chip').length === 2, null, { timeout: 10000 });
    const words = await host.$$eval('#wordsGrid .word-chip', (e) => e.map((x) => x.textContent.trim()).sort());
    check(words.join(',') === 'apple,banana', 'all words revealed: ' + words.join(', '));

    await host.click('#btnAttribution');
    await confirmModal(host);
    await host.waitForFunction(() =>
      document.querySelectorAll('#attributionContainer .attribution-item').length === 2, null, { timeout: 10000 });
    const attr = await host.$$eval('#attributionContainer .attribution-item', (els) => els.map((e) => ({
      player: e.querySelector('.attribution-player').textContent.trim(),
      word: e.querySelector('.attribution-word').textContent.trim(),
    })));
    const pairs = attr.map((a) => a.player + ':' + a.word).sort().join(' ');
    check(pairs === 'Alice:apple Bob:banana', 'attribution pairs names to words: ' + pairs);

    // ── Reset ─────────────────────────────────────────────
    section('Reset');
    await host.click('[data-gtb-settings-toggle]');   // Reset lives in the settings panel
    await host.click('#empireResetBtn');
    await confirmModal(host);
    await host.waitForSelector('#viewHostSubmission', { state: 'visible', timeout: 10000 });
    check((await host.textContent('#hostPlayerCount')).trim() === '0', 'reset empties the lobby');
    await alice.page.waitForSelector('#viewPlayerNewRound', { state: 'visible', timeout: 10000 });
    check(true, 'players are told a new round started');

    // ── Host absence ──────────────────────────────────────
    section('Host absence');
    await host.close();
    const overlay = await alice.page.waitForFunction(() => {
      const el = document.getElementById('hostAbsentOverlay');
      return !!el && el.classList.contains('show');
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    check(overlay, 'closing the host page raises the host-absent overlay');

    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors[0] : ''));
  } catch (e) {
    check(false, 'harness error: ' + e.message);
  } finally {
    for (const c of ctxs) await c.close().catch(() => {});
    await browser.close().catch(() => {});
    server.kill('SIGKILL');
  }

  console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(failures.length ? 1 : 0);
})();
