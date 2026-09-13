(function () {
  'use strict';
  const colors = { I: '#47c8d3', O: '#f1cb50', T: '#ef827d', S: '#50c99a', Z: '#ed695e', J: '#619ed6', L: '#f1a75d', X: '#879b98' };
  const shapes = { I: [[0, 1], [1, 1], [2, 1], [3, 1]], O: [[1, 0], [2, 0], [1, 1], [2, 1]], T: [[1, 0], [0, 1], [1, 1], [2, 1]], S: [[1, 0], [2, 0], [0, 1], [1, 1]], Z: [[0, 0], [1, 0], [1, 1], [2, 1]], J: [[0, 0], [0, 1], [1, 1], [2, 1]], L: [[2, 0], [0, 1], [1, 1], [2, 1]] };
  const boards = new WeakMap();
  const reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function block(context, column, row, type, unit, ghost) {
    if (row < 0) return;
    const left = column * unit + 1;
    const top = row * unit + 1;
    context.fillStyle = colors[type] || colors.X;
    if (ghost) {
      context.globalAlpha = 0.55;
      context.lineWidth = Math.max(1, unit * 0.07);
      context.strokeStyle = context.fillStyle;
      context.strokeRect(left + 2, top + 2, unit - 6, unit - 6);
      context.globalAlpha = 1;
      return;
    }
    context.fillRect(left, top, unit - 2, unit - 2);
    context.fillStyle = 'rgba(255,255,255,.24)';
    context.fillRect(left + 2, top + 2, unit - 6, Math.max(2, unit * 0.1));
    context.fillStyle = 'rgba(0,0,0,.15)';
    context.fillRect(left + 2, top + unit - 6, unit - 6, 3);
  }
  function paint(canvas, view) {
    if (!canvas) return;
    if (canvas.width !== 300 || canvas.height !== 600) { canvas.width = 300; canvas.height = 600; }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#172422';
    context.fillRect(0, 0, 300, 600);
    context.strokeStyle = '#22332f';
    context.lineWidth = 1;
    for (let column = 1; column < 10; column++) { context.beginPath(); context.moveTo(column * 30, 0); context.lineTo(column * 30, 600); context.stroke(); }
    for (let row = 1; row < 20; row++) { context.beginPath(); context.moveTo(0, row * 30); context.lineTo(300, row * 30); context.stroke(); }
    if (!view) return;
    (view.grid || []).forEach(function (cells, row) { Array.from(cells).forEach(function (type, column) { if (type !== '_') block(context, column, row, type, 30, false); }); });
    (view.ghost || []).forEach(function (cell) { block(context, cell.x, cell.y, cell.type, 30, true); });
    (view.active || []).forEach(function (cell) { block(context, cell.x, cell.y, cell.type, 30, false); });
  }
  function paintClears(context, animations, now) {
    context.save();
    context.beginPath();
    context.rect(0, 0, 300, 600);
    context.clip();
    animations.forEach(function (animation) {
      const progress = Math.min(1, (now - animation.started) / animation.duration);
      const fade = 1 - progress;
      const still = animation.still || (reducedMotion && reducedMotion.matches);
      const strength = animation.count / 4;
      animation.rows.forEach(function (row) {
        const top = row * 30;
        context.fillStyle = '#ffffff';
        context.globalAlpha = fade * (still ? 0.45 : 0.5 + strength * 0.22 + Math.sin(progress * Math.PI) * 0.18);
        context.fillRect(0, top, 300, 30);
        if (still) return;
        context.globalAlpha = fade * 0.9;
        context.fillStyle = colors.I;
        context.fillRect(0, top, 300, 2 + strength * 2);
        context.fillStyle = '#ffffff';
        context.fillRect(progress * 360 - 60, top, 60, 30);
        const count = 6 + animation.count * 2;
        for (let index = 0; index < count; index += 1) {
          const origin = (index + 0.5) * 300 / count;
          const horizontal = origin + (origin - 150) * progress * 0.35;
          const vertical = top + 15 - progress * (24 + (index % 4) * 12 + strength * 35);
          const size = (3 + index % 3 + strength * 2) * (1 - progress * 0.5);
          context.fillStyle = [colors.I, colors.O, colors.T][index % 3];
          context.globalAlpha = fade * 0.95;
          context.fillRect(horizontal - size / 2, vertical - size / 2, size, size);
        }
      });
    });
    context.restore();
  }
  function frame(canvas, state, now) {
    state.animations = state.animations.filter(function (animation) { return now - animation.started < animation.duration; });
    paint(canvas, state.view);
    const context = canvas.getContext('2d');
    if (!context || canvas.isConnected === false) state.animations = [];
    if (state.animations.length) {
      paintClears(context, state.animations, now);
      if (state.pending === null && typeof window.requestAnimationFrame === 'function') {
        state.pending = window.requestAnimationFrame(function () {
          state.pending = null;
          frame(canvas, state, performance.now());
        });
      }
    } else if (state.pending !== null) {
      window.cancelAnimationFrame(state.pending);
      state.pending = null;
    }
  }
  function draw(canvas, view) {
    if (!canvas) return;
    let state = boards.get(canvas);
    if (!state) {
      state = { view: null, lines: null, locks: 0, animations: [], pending: null };
      boards.set(canvas, state);
    }
    const now = performance.now();
    if (!view || (view.lines === 0 && view.locks === 0 && view.elapsedMs === 0)) {
      state.lines = null;
      state.locks = 0;
      state.animations = [];
    }
    if (view && Number.isSafeInteger(view.lines) && Number.isSafeInteger(view.locks)) {
      if (state.lines !== null && view.lines > state.lines && view.locks > state.locks && Array.isArray(view.clearRows)) {
        const rows = Array.from(new Set(view.clearRows.filter(function (row) { return Number.isInteger(row) && row >= -3 && row <= 19; }))).slice(0, 4);
        const visible = rows.filter(function (row) { return row >= 0; });
        if (visible.length) {
          const still = !!(reducedMotion && reducedMotion.matches);
          state.animations.push({ rows: visible, count: rows.length, started: now, duration: still ? 160 : 500, still: still });
          state.animations = state.animations.slice(-2);
        }
      }
      state.lines = Math.max(state.lines === null ? 0 : state.lines, view.lines);
      state.locks = Math.max(state.locks, view.locks);
    }
    state.view = view;
    frame(canvas, state, now);
  }
  function preview(canvas, pieces) {
    if (!canvas) return;
    const items = Array.isArray(pieces) ? pieces : [pieces];
    canvas.width = 100;
    canvas.height = Math.max(1, items.length) * 60;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    items.forEach(function (type, index) {
      context.save(); context.translate(10, index * 60 + 8);
      (shapes[type] || []).forEach(function (cell) { block(context, cell[0], cell[1], type, 20, false); });
      context.restore();
    });
  }
  function artwork(canvas) {
    const grid = Array.from({ length: 20 }, function () { return Array(10).fill('_'); });
    const rows = ['SS__TTT_LL_', 'JSS__T_LLO', 'JJJZZI__OO', 'LLZZ_I_SS_', 'LLOO_I__SS', 'JJOO_ITTTO'];
    rows.forEach(function (row, index) { grid[index + 14] = row.split(''); });
    draw(canvas, { grid: grid, active: [{ x: 4, y: 5, type: 'T' }, { x: 3, y: 6, type: 'T' }, { x: 4, y: 6, type: 'T' }, { x: 5, y: 6, type: 'T' }], ghost: [{ x: 4, y: 12, type: 'T' }, { x: 3, y: 13, type: 'T' }, { x: 4, y: 13, type: 'T' }, { x: 5, y: 13, type: 'T' }] });
  }
  window.SRRender = { draw: draw, preview: preview, artwork: artwork };
}());