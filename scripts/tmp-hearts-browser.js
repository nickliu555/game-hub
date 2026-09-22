'use strict';
// Throwaway browser smoke: host lobby + 3 hard CPUs + 1 human, play a full hand.
const { chromium } = require('playwright');

(async () => {
  const errs = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  host.on('pageerror', (e) => errs.push('HOST ' + e.message));
  await host.goto('http://localhost:3000/hearts/host', { waitUntil: 'networkidle' });

  const sel = '#difficultySeg .seg-btn[data-value="hard"]';
  if (!(await host.isVisible(sel))) {
    const gear = await host.$('#settingsBtn, .topbar-settings, [data-action="settings"]');
    if (gear) { await gear.click(); await host.waitForTimeout(400); }
  }
  if (await host.isVisible(sel)) await host.click(sel);
  const on = await host.getAttribute(sel, 'class');
  if (!/\bon\b/.test(on || '')) throw new Error('hard not selected: ' + on);
  const closeBtn = await host.$('#settingsClose, .modal-close');
  if (closeBtn && (await closeBtn.isVisible())) { await closeBtn.click(); await host.waitForTimeout(300); }

  const player = await ctx.newPage();
  player.on('pageerror', (e) => errs.push('PLAYER ' + e.message));
  await player.goto('http://localhost:3000/hearts/join', { waitUntil: 'networkidle' });
  await player.fill('#nameInput', 'Nick');
  await player.click('#joinForm button[type="submit"]');
  await player.waitForURL(/\/hearts\/play/, { timeout: 10000 });

  for (let i = 0; i < 3; i++) {
    await host.click('#addBotBtn');
    await host.waitForTimeout(250);
  }
  await host.click('#startBtn');

  // Pass three cards if the hand calls for it, then play until the hand ends.
  const step = async () => {
    if (await player.isVisible('#pv-pass')) {
      const cards = await player.$$('#pv-pass .hand-card:not(.picked)');
      for (const c of cards.slice(0, 3)) await c.dispatchEvent('pointerdown');
      await player.waitForTimeout(150);
      const btn = await player.$('#passBtn:not([disabled])');
      if (btn) { await btn.dispatchEvent('pointerdown'); await btn.click({ force: true }); }
      return true;
    }
    if (await player.isVisible('#pv-play')) {
      const card = await player.$('#pv-play .hand-card:not(.illegal)');
      if (card) {
        await card.dispatchEvent('pointerdown');
        await player.waitForTimeout(150);
        const btn = await player.$('#playBtn:not([disabled])');
        if (btn) { await btn.dispatchEvent('pointerdown'); await btn.click({ force: true }); }
        return true;
      }
    }
    return false;
  };

  const deadline = Date.now() + 240000;
  let rows = 0;
  const seen = new Set();
  while (Date.now() < deadline) {
    const v = await player.$$eval('.p-view.active', (n) => n.map((e) => e.id).join(','))
      .catch(() => '?');
    const hv = await host.$$eval('.view.active', (n) => n.map((e) => e.id).join(','))
      .catch(() => '?');
    if (!seen.has(v + '|' + hv)) { seen.add(v + '|' + hv); console.log('view', hv, '/', v); }
    await step();
    await player.waitForTimeout(400);
    rows = await host.$$eval('#scoreRows > *', (n) => n.length).catch(() => 0);
    if (rows >= 4) break;
  }

  console.log('score rows:', rows, '| page errors:', errs.length);
  errs.forEach((e) => console.log('  ' + e));
  console.log(rows >= 4 && errs.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  await browser.close();
})().catch((e) => { console.error('RESULT: FAIL', e.message); process.exit(1); });
