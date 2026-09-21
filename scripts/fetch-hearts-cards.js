#!/usr/bin/env node
/**
 * Builds the Hearts card deck in public/hearts/assets/cards/.
 *
 * Source art: Byron Knoll's "Vector Playing Cards" (public domain), via the CC0
 * repo github.com/rnvannatta/playing-cards. Pips/aces ship as optimised SVG
 * (a few KB, crisp on a TV); the 12 court cards are far too heavy as vectors
 * (370KB-1.1MB each) so they are rasterised to WebP.
 *
 *   node scripts/fetch-hearts-cards.js            # download the sources
 *   HEARTS_CARDS_SRC=/path/to/svg-cards node ...  # use a local checkout
 */

const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

const RAW_BASE = 'https://raw.githubusercontent.com/rnvannatta/playing-cards/master/svg-cards';
const OUT_DIR = path.join(__dirname, '..', 'public', 'hearts', 'assets', 'cards');
const LOCAL_SRC = process.env.HEARTS_CARDS_SRC || null;

const SUITS = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };
const RANKS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  J: 'jack', Q: 'queen', K: 'king', A: 'ace',
};
const COURTS = new Set(['J', 'Q', 'K']);

// Byron Knoll's art is 167.0869141 x 242.6669922, which is not the poker 2.5:3.5
// ratio. Widening the viewBox to the left and redrawing the white card body with
// a proper corner radius fixes it (this is the upstream Makefile's xmlstarlet
// edit, ported so the build needs no extra tooling).
const CARD_W = 173.3359647;
const CARD_H = 242.6669922;
const VIEW_BOX = `-2.8651769 0 ${CARD_W} ${CARD_H}`;
const BODY_PATH =
  'M -2.8651769,8.6668 A 8.6668,8.6668 0 0 1 5.8016231,0 H 161.8039878 ' +
  'A 8.6668,8.6668 0 0 1 170.4707878,8.6668 V 234.0001922 ' +
  'A 8.6668,8.6668 0 0 1 161.8039878,242.6669922 H 5.8016231 ' +
  'A 8.6668,8.6668 0 0 1 -2.8651769,234.0001922 Z';

// Rasterised courts: 2x the largest on-screen card (~150px wide on a TV).
const COURT_WIDTH = 320;
const COURT_QUALITY = 0.82;

const SVGO_CONFIG = {
  multipass: true,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          removeViewBox: false,
          cleanupIds: { minify: true },
          cleanupNumericValues: { floatPrecision: 2 },
          convertPathData: { floatPrecision: 2, transformPrecision: 3 },
          mergePaths: { floatPrecision: 2 },
        },
      },
    },
    'removeDimensions',
    'reusePaths',
  ],
};

function cardCodes() {
  const out = [];
  for (const rank of Object.keys(RANKS)) for (const suit of Object.keys(SUITS)) out.push(rank + suit);
  return out;
}

function sourceName(code) {
  const suit = SUITS[code.slice(-1)];
  const rank = RANKS[code.slice(0, -1)];
  return `${rank}_of_${suit}.svg`;
}

async function readSource(name) {
  if (LOCAL_SRC) return fs.readFileSync(path.join(LOCAL_SRC, name), 'utf8');
  const res = await fetch(`${RAW_BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
}

/** Replace the `id="path5"` card body and widen the root viewBox to poker ratio. */
function toPokerRatio(svg, name) {
  const marker = svg.indexOf('id="path5"');
  if (marker < 0) throw new Error(`${name}: no id="path5" card-body element`);
  const start = svg.lastIndexOf('<', marker);
  const end = svg.indexOf('>', marker) + 1;
  const body = `<path style="fill:#FFFFFF;stroke:none;" d="${BODY_PATH}" id="path5" />`;
  let out = svg.slice(0, start) + body + svg.slice(end);

  const tagEnd = out.indexOf('>', out.indexOf('<svg'));
  let head = out.slice(0, tagEnd);
  const tail = out.slice(tagEnd);
  if (!/viewBox=/.test(head) || !/width=/.test(head)) throw new Error(`${name}: missing width/viewBox`);
  head = head
    .replace(/\bwidth="[^"]*"/, `width="${CARD_W}pt"`)
    .replace(/\bheight="[^"]*"/, `height="${CARD_H}pt"`)
    .replace(/\bviewBox="[^"]*"/, `viewBox="${VIEW_BOX}"`);
  return head + tail;
}

/** Hearts-themed card back — hand-drawn so it matches the table felt and stays tiny. */
function buildCardBack() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" role="img" aria-label="Card back">
<defs>
<linearGradient id="hb-f" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#a81d36"/><stop offset=".55" stop-color="#8e1b2e"/><stop offset="1" stop-color="#5e0f1f"/>
</linearGradient>
<pattern id="hb-p" width="21.7" height="21.7" patternUnits="userSpaceOnUse" patternTransform="rotate(45 0 0)">
<path d="M10.85 16.6 4.6 10.6a4.3 4.3 0 0 1 6.25-5.9 4.3 4.3 0 0 1 6.25 5.9Z" fill="#fff" fill-opacity=".14"/>
</pattern>
</defs>
<path d="${BODY_PATH}" fill="#FFFFFF"/>
<g>
<path d="M2.13 5 H165.47 A5 5 0 0 1 170.47 10 V232.67 A5 5 0 0 1 165.47 237.67 H2.13 A5 5 0 0 1 -2.87 232.67 V10 A5 5 0 0 1 2.13 5 Z" fill="url(#hb-f)"/>
<path d="M2.13 5 H165.47 A5 5 0 0 1 170.47 10 V232.67 A5 5 0 0 1 165.47 237.67 H2.13 A5 5 0 0 1 -2.87 232.67 V10 A5 5 0 0 1 2.13 5 Z" fill="url(#hb-p)"/>
<path d="M8.13 11 H159.47 A3 3 0 0 1 162.47 14 V228.67 A3 3 0 0 1 159.47 231.67 H8.13 A3 3 0 0 1 5.13 228.67 V14 A3 3 0 0 1 8.13 11 Z" fill="none" stroke="#f6d9a0" stroke-opacity=".55" stroke-width="1.6"/>
<path d="M83.8 168 48.6 134.2a24.2 24.2 0 0 1 35.2-33.2 24.2 24.2 0 0 1 35.2 33.2Z" fill="#fff" fill-opacity=".92"/>
<path d="M83.8 168 48.6 134.2a24.2 24.2 0 0 1 35.2-33.2 24.2 24.2 0 0 1 35.2 33.2Z" fill="none" stroke="#5e0f1f" stroke-opacity=".35" stroke-width="2"/>
</g>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const codes = cardCodes();
  const pips = codes.filter((c) => !COURTS.has(c.slice(0, -1)));
  const courts = codes.filter((c) => COURTS.has(c.slice(0, -1)));

  console.log(`Building ${codes.length} cards into ${path.relative(process.cwd(), OUT_DIR)}`);
  console.log(LOCAL_SRC ? `  source: ${LOCAL_SRC}` : `  source: ${RAW_BASE}`);

  let svgBytes = 0;
  for (const code of pips) {
    const name = sourceName(code);
    const fixed = toPokerRatio(await readSource(name), name);
    const { data } = optimize(fixed, { ...SVGO_CONFIG, path: name });
    fs.writeFileSync(path.join(OUT_DIR, `${code}.svg`), data);
    svgBytes += Buffer.byteLength(data);
  }
  console.log(`  ${pips.length} pip/ace SVGs  ${(svgBytes / 1024).toFixed(0)}KB total`);

  // Court art only compresses acceptably as a raster; Chromium does the encode.
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let webpBytes = 0;
  try {
    for (const code of courts) {
      const name = sourceName(code);
      const fixed = toPokerRatio(await readSource(name), name);
      const dataUrl = await page.evaluate(async ({ svg, width, height, quality }) => {
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        return canvas.toDataURL('image/webp', quality);
      }, {
        svg: fixed,
        width: COURT_WIDTH,
        height: Math.round((COURT_WIDTH * CARD_H) / CARD_W),
        quality: COURT_QUALITY,
      });
      if (!dataUrl.startsWith('data:image/webp')) throw new Error(`${name}: WebP encode failed`);
      const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
      fs.writeFileSync(path.join(OUT_DIR, `${code}.webp`), buf);
      webpBytes += buf.length;
    }
  } finally {
    await browser.close();
  }
  console.log(`  ${courts.length} court WebPs  ${(webpBytes / 1024).toFixed(0)}KB total`);

  const back = optimize(buildCardBack(), { ...SVGO_CONFIG, path: 'back.svg' }).data;
  fs.writeFileSync(path.join(OUT_DIR, 'back.svg'), back);
  fs.writeFileSync(
    path.join(OUT_DIR, 'CREDITS.txt'),
    'Card faces: "Vector Playing Cards" by Byron Knoll — public domain.\n' +
    'Retrieved from https://github.com/rnvannatta/playing-cards (CC0-1.0).\n' +
    'Court cards rasterised to WebP; pips/aces optimised as SVG.\n' +
    'Card back drawn for Game Hub.\n'
  );

  const total = svgBytes + webpBytes + Buffer.byteLength(back);
  console.log(`  back.svg + CREDITS.txt`);
  console.log(`Done — ${(total / 1024).toFixed(0)}KB total deck.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
