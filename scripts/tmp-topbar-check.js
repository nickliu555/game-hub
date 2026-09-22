'use strict';
// Temp check: topbar shows Hub / Fullscreen / Settings, with Help inside Settings.
const { chromium } = require('@playwright/test');

const BASE = 'http://localhost:3000';
const GAMES = ['bombbrawl', 'camo', 'catclash', 'empire', 'hearts', 'herdmind', 'mazechomp',
  'nockey', 'noggle', 'rankfive', 'shootball', 'soccerhead', 'stackingroyale', 'trivia',
  'twentyfour'];

let failures = 0;
function check(ok, label, detail) {
  if (ok) return;
  failures++;
  console.log('    ✗ ' + label + (detail ? ' — ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch();
  for (const game of GAMES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    const before = failures;
    await page.goto(BASE + '/' + game + '/host', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    const shape = await page.evaluate(() => {
      const bar = document.querySelector('.gtb-controls');
      if (!bar) return { error: 'no .gtb-controls' };
      const direct = Array.from(bar.children);
      const fs = bar.querySelector(':scope > [id$="ullscreenBtn"]');
      const panel = document.querySelector('.gtb-settings-panel');
      const help = panel && Array.from(panel.querySelectorAll('button')).find(
        (b) => b.hasAttribute('data-gtb-help-open') || /how to play/i.test(b.getAttribute('title') || ''));
      return {
        barLabels: direct.map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()),
        fullscreenInBar: !!fs,
        fullscreenVisible: !!(fs && fs.offsetParent !== null),
        helpInPanel: !!help,
        helpIsFirstInPanel: !!(help && panel.firstElementChild === help),
        panelHidden: !!(panel && panel.hidden),
        helpStillInBar: !!bar.querySelector(':scope > [data-gtb-help-open], :scope > [title*="How to play" i]'),
      };
    });

    check(!shape.error, game + ': topbar present', shape.error);
    check(shape.fullscreenInBar, game + ': Fullscreen is a direct child of .gtb-controls');
    check(shape.fullscreenVisible, game + ': Fullscreen is visible in the bar');
    check(!shape.helpStillInBar, game + ': Help is no longer in the bar');
    check(shape.helpInPanel, game + ': Help lives in the settings panel');
    check(shape.helpIsFirstInPanel, game + ': Help is the first item in the panel');
    check(shape.panelHidden, game + ': panel starts hidden');
    check(shape.barLabels.length === 3, game + ': bar has 3 controls', JSON.stringify(shape.barLabels));

    // Settings opens the panel, Help opens the overlay and closes the panel.
    await page.locator('.gtb-controls [data-gtb-settings-toggle]').click();
    const opened = await page.evaluate(() => !document.querySelector('.gtb-settings-panel').hidden);
    check(opened, game + ': Settings opens the panel');
    await page.locator('.gtb-settings-panel button[title*="How to play" i]').click();
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => {
      const ov = document.querySelector('.gtb-help-overlay, #helpOverlay');
      return {
        helpOpen: !!(ov && (ov.classList.contains('is-open') || ov.classList.contains('show'))),
        panelClosed: !!document.querySelector('.gtb-settings-panel').hidden,
      };
    });
    check(after.helpOpen, game + ': Help opens the overlay');
    check(after.panelClosed, game + ': opening Help closes the panel');

    check(errs.length === 0, game + ': no page errors', errs.join(' | '));
    console.log((failures === before ? '  ✓ ' : '  ✗ ') + game + ' — ' + JSON.stringify(shape.barLabels));
    await ctx.close();
  }

  // Narrow TV/laptop width: the bar must not wrap now that Fullscreen is wider.
  const ctx = await browser.newContext({ viewport: { width: 640, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/hearts/host', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => {
    const tops = Array.from(document.querySelectorAll('.gtb-controls > *'))
      .map((el) => Math.round(el.getBoundingClientRect().top));
    return new Set(tops).size;
  });
  console.log('  ' + (rows === 1 ? '✓' : 'ℹ') + ' hearts @640px: topbar occupies ' + rows + ' row(s)');
  await ctx.close();

  await browser.close();
  console.log(failures ? '\n✗ ' + failures + ' check(s) failed\n' : '\n✓ all topbar checks passed\n');
  process.exit(failures ? 1 : 0);
})();
