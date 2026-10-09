/* Snake Party — hand-designed obstacle maps.
 *
 * The board is bounded by deadly edges (no wrapping) and SCALES with the number
 * of snakes, so a small game stays as tight as a full one (~250 cells a snake):
 *   1 snake → 24×14 · 2 → 30×18 · 3 → 36×22 · 4 → 40×24
 * Every layout is designed once on the full 40×24 board and scaled to fit.
 * Obstacles are rectangles in the TOP-LEFT quadrant, mirrored into the other
 * three — that keeps every map fair to all four spawn seats. Spawns sit near the
 * centre, facing outward, so snakes start moving away from each other.
 *
 * Exposes window.SnakePartyMaps = { SIZES, sizeFor(n), list, count, build(i, n) }.
 */
(function (global) {
  'use strict';

  const BASE_W = 40, BASE_H = 24;
  // Board size by snake count (index = number of snakes).
  const SIZES = [null, { w: 24, h: 14 }, { w: 30, h: 18 }, { w: 36, h: 22 }, { w: 40, h: 24 }];

  // Seats 1 and 3, designed on 40×24. Seats 2 and 4 are their mirror images
  // (through the board centre), so the start is fair whatever the size.
  // Direction indices: 0=up 1=down 2=left 3=right.
  const SEAT1 = { x: 13, y: 12, dir: 2 };   // centre-left, heading left
  const SEAT3 = { x: 20, y: 7, dir: 0 };    // upper-centre, heading up
  const OPPOSITE = [1, 0, 3, 2];

  // Rectangles are [x, y, w, h] in the top-left quadrant of the 40×24 design.
  const LIST = [
    { name: 'Four Stones', quad: [[6, 4, 2, 2]] },
    { name: 'Brackets', quad: [[4, 3, 6, 1], [4, 3, 1, 4]] },
    { name: 'Lanes', quad: [[3, 5, 13, 1]] },
    { name: 'Pillars', quad: [[5, 3, 2, 2], [11, 3, 2, 2], [5, 8, 2, 2], [11, 8, 2, 2], [16, 3, 2, 2]] },
    { name: 'Corner Keeps', quad: [[0, 0, 4, 1], [0, 0, 1, 4], [9, 5, 3, 3]] },
    { name: 'Staircase', quad: [[4, 2, 3, 1], [6, 3, 3, 1], [8, 4, 3, 1], [14, 8, 1, 3]] },
  ];

  function sizeFor(n) {
    const k = Math.max(1, Math.min(SIZES.length - 1, Math.round(Number(n)) || SIZES.length - 1));
    return SIZES[k];
  }

  // Scale a design rectangle into the top-left quadrant of a W×H board. Edges
  // are scaled (not the size), so neighbouring pieces keep their gaps, and
  // nothing ever spills past the centre lines.
  function scaleRect(r, W, H) {
    const sx = W / BASE_W, sy = H / BASE_H;
    const x0 = Math.round(r[0] * sx), y0 = Math.round(r[1] * sy);
    let x1 = Math.round((r[0] + r[2]) * sx), y1 = Math.round((r[1] + r[3]) * sy);
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;
    x1 = Math.min(x1, W / 2); y1 = Math.min(y1, H / 2);
    return [x0, y0, x1 - x0, y1 - y0];
  }

  function mirror(rects, W, H) {
    const out = [];
    rects.forEach(function (r) {
      const x = r[0], y = r[1], w = r[2], h = r[3];
      out.push([x, y, w, h]);
      out.push([W - x - w, y, w, h]);
      out.push([x, H - y - h, w, h]);
      out.push([W - x - w, H - y - h, w, h]);
    });
    return out;
  }

  function spawnsFor(W, H) {
    function sc(s) { return { x: Math.round(s.x * W / BASE_W), y: Math.round(s.y * H / BASE_H), dir: s.dir }; }
    function flip(s) { return { x: W - 1 - s.x, y: H - 1 - s.y, dir: OPPOSITE[s.dir] }; }
    const s1 = sc(SEAT1), s3 = sc(SEAT3);
    return [s1, flip(s1), s3, flip(s3)];
  }

  /** Map `i` sized for `n` snakes (defaults to the full 4-snake board). */
  function build(i, n) {
    const count = LIST.length;
    const def = LIST[((i % count) + count) % count];
    const size = sizeFor(n == null ? 4 : n);
    const W = size.w, H = size.h;
    const wall = new Uint8Array(W * H);
    mirror(def.quad.map(function (r) { return scaleRect(r, W, H); }), W, H).forEach(function (r) {
      for (let y = r[1]; y < r[1] + r[3]; y++) {
        for (let x = r[0]; x < r[0] + r[2]; x++) {
          if (x >= 0 && x < W && y >= 0 && y < H) wall[y * W + x] = 1;
        }
      }
    });
    return { name: def.name, w: W, h: H, wall: wall, spawns: spawnsFor(W, H) };
  }

  global.SnakePartyMaps = { SIZES: SIZES, sizeFor: sizeFor, list: LIST, count: LIST.length, build: build };
})(typeof window !== 'undefined' ? window : globalThis);
