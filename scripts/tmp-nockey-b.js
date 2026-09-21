const { chromium } = require('@playwright/test');

(async () => {
  const out = { errors: [] };
  const browser = await chromium.launch();
  try {
    const host = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    host.on('pageerror', (e) => out.errors.push('host: ' + e.message));
    // Force every skater to drive into the top board and record the worst breach.
    await host.addInitScript(() => {
      window.__maxOver = 0;
      window.__samples = 0;
      const iv = setInterval(() => {
        const N = window.Nockey;
        if (!N || !N.World || window.__patched) return;
        window.__patched = true;
        clearInterval(iv);
        const orig = N.World.prototype.step;
        N.World.prototype.step = function () {
          const self = this;
          (this.players || []).forEach((p) => { self.setInput(p.id, 0, -1, false); });
          const r = orig.apply(this, arguments);
          const S = this.stadium;
          (this.players || []).forEach((p) => {
            const over = Math.abs(p.y) - (S.halfH - p.r);
            if (over > window.__maxOver) window.__maxOver = over;
          });
          window.__samples++;
          return r;
        };
      }, 10);
    });
    await host.goto('http://localhost:3000/nockey/host', { waitUntil: 'networkidle' });

    for (let i = 0; i < 6; i++) { await host.click('#addBotBtn'); await host.waitForTimeout(250); }
    await host.waitForTimeout(500);
    await host.click('#startBtn');
    await host.waitForTimeout(16000);

    out.probe = await host.evaluate(() => ({
      patched: !!window.__patched,
      samples: window.__samples,
      maxOverPx: Math.round(window.__maxOver * 10) / 10,
    }));
    await host.screenshot({ path: '/tmp/nk-top.png' });

    // And the bottom board.
    await host.evaluate(() => {
      window.__maxOver = 0;
      const N = window.Nockey;
      const orig = N.World.prototype.step;
      N.World.prototype.step = function () {
        const self = this;
        (this.players || []).forEach((p) => { self.setInput(p.id, 0, 1, false); });
        const r = orig.apply(this, arguments);
        const S = this.stadium;
        (this.players || []).forEach((p) => {
          const over = Math.abs(p.y) - (S.halfH - p.r);
          if (over > window.__maxOver) window.__maxOver = over;
        });
        return r;
      };
    });
    await host.waitForTimeout(12000);
    out.probeBottom = await host.evaluate(() => Math.round(window.__maxOver * 10) / 10);
    await host.screenshot({ path: '/tmp/nk-bottom.png' });
  } catch (e) {
    out.fatal = String((e && e.message) || e).split('\n')[0];
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
})();
