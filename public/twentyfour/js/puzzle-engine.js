(function () {
  'use strict';

  // ============================================================
  // puzzle-engine.js
  //
  // Shared 24-game puzzle tile/op interaction engine. Owns rendering of
  // the four number tiles + four operator buttons, the tap-A → tap-op →
  // tap-B combine flow, exact-rational arithmetic, undo/reset, divide-by-
  // zero handling, and auto-detection of solve (last tile === 24) or
  // wrong-result shake.
  //
  // Used by:
  //   public/twentyfour/js/player.js    (multiplayer)
  //   public/twentyfour/js/practice.js  (solo practice)
  //
  // The engine does NOT know about sockets, scores, skip buttons, server
  // validation, or anything game-mode-specific. The host code provides
  // onSolve(steps) to react to a successful combine to 24, and gets to
  // decide what to do next (submit to server, advance to next puzzle, etc.).
  // ============================================================

  // ---------------- Exact rational arithmetic ----------------
  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { const t = b; b = a % b; a = t; }
    return a || 1;
  }
  function rMake(n, d) {
    if (d === 0) return null;
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d);
    return { n: n / g, d: d / g };
  }
  function rAdd(a, b) { return rMake(a.n * b.d + b.n * a.d, a.d * b.d); }
  function rSub(a, b) { return rMake(a.n * b.d - b.n * a.d, a.d * b.d); }
  function rMul(a, b) { return rMake(a.n * b.n, a.d * b.d); }
  function rDiv(a, b) { if (b.n === 0) return null; return rMake(a.n * b.d, a.d * b.n); }
  function rEq(a, b) { return a.n === b.n && a.d === b.d; }
  const OPS = { '+': rAdd, '-': rSub, '*': rMul, '/': rDiv };

  // Render a rational either as a plain integer or a stacked fraction.
  function tileInnerHtml(r) {
    if (r.d === 1) return String(r.n);
    return (
      '<div class="frac">' +
        '<div class="num">' + r.n + '</div>' +
        '<div class="bar"></div>' +
        '<div class="den">' + r.d + '</div>' +
      '</div>'
    );
  }

  // ---------------- Controller factory ----------------
  /**
   * Create a puzzle controller bound to the given DOM elements.
   *
   * @param {Object} opts
   * @param {HTMLElement} opts.numbersEl  - container for the 4 tiles
   * @param {HTMLElement} opts.opsEl      - container for the 4 .op buttons
   * @param {HTMLElement} [opts.undoBtn]  - optional Undo button
   * @param {HTMLElement} [opts.resetBtn] - optional Reset button
   * @param {(steps:Array)=>void} opts.onSolve  - called when one tile is left
   *        and equals 24. `steps` is the combine history [{aId,op,bId},…].
   *        The engine locks itself before calling onSolve; the host must
   *        call ctrl.unlock() or ctrl.loadPuzzle(...) to re-enable input.
   * @param {()=>void} [opts.onWrong] - called when one tile remains and
   *        does NOT equal 24. Default behavior (if omitted): shake the
   *        offending tile and auto-reset after 550ms. Provide a custom
   *        handler to override (e.g. show a toast).
   * @param {(step:Object)=>void} [opts.onCombine] - called after every
   *        successful combine step (not div-by-zero). Useful for haptics
   *        or sound effects.
   * @returns controller API: { loadPuzzle, reset, undo, lock, unlock,
   *        isLocked, destroy }
   */
  function create(opts) {
    if (!opts || !opts.numbersEl || !opts.opsEl) {
      throw new Error('PuzzleEngine.create requires { numbersEl, opsEl }');
    }
    const numbersEl = opts.numbersEl;
    const opsEl = opts.opsEl;
    const undoBtn = opts.undoBtn || null;
    const resetBtn = opts.resetBtn || null;
    const onSolve = typeof opts.onSolve === 'function' ? opts.onSolve : function () {};
    const onWrong = typeof opts.onWrong === 'function' ? opts.onWrong : null;
    const onCombine = typeof opts.onCombine === 'function' ? opts.onCombine : null;

    let originalNumbers = null;            // int[4] from caller
    let tiles = [];                        // [rational | null]
    let history = [];                      // [{aId, op, bId, prevA, prevB}]
    let selected = { aId: null, op: null };// tap-A then tap-op then tap-B
    let locked = true;                     // input disabled until loadPuzzle
    let autoResetTimer = null;             // pending shake-then-reset

    function loadPuzzle(numbers) {
      cancelAutoReset();
      originalNumbers = numbers.slice();
      tiles = originalNumbers.map(function (n) { return rMake(n, 1); });
      history = [];
      selected = { aId: null, op: null };
      locked = false;
      renderAll();
    }

    function reset() {
      if (!originalNumbers) return;
      cancelAutoReset();
      tiles = originalNumbers.map(function (n) { return rMake(n, 1); });
      history = [];
      selected = { aId: null, op: null };
      // reset() is allowed even while locked — the host may want to
      // visually restore the puzzle while the user studies an answer.
      renderAll();
    }

    function undo() {
      if (locked) return;
      // Undo peels one tap at a time, in reverse order:
      //   1. operator selection      →  clear op (A tile stays selected)
      //   2. A tile selection        →  clear A
      //   3. last committed combine  →  pop history, restore both tiles
      //      AND re-select A + op so the next two undos can peel those
      //      individual taps too (a full A+op+B commit takes 3 undos
      //      to fully reverse).
      if (selected.op !== null) {
        selected.op = null;
        renderAll();
        return;
      }
      if (selected.aId !== null) {
        selected.aId = null;
        renderAll();
        return;
      }
      if (!history.length) return;
      const step = history.pop();
      tiles[step.aId] = step.prevA;
      tiles[step.bId] = step.prevB;
      selected = { aId: step.aId, op: step.op };
      renderAll();
    }

    function lock() { locked = true; renderAll(); }
    function unlock() { locked = false; renderAll(); }
    function isLocked() { return locked; }

    function cancelAutoReset() {
      if (autoResetTimer) { clearTimeout(autoResetTimer); autoResetTimer = null; }
    }

    // ---------------- Rendering ----------------
    function renderTiles() {
      numbersEl.innerHTML = tiles.map(function (r, i) {
        if (!r) return '<div class="tile consumed" data-id="' + i + '"></div>';
        const cls = ['tile'];
        if (selected.aId === i) cls.push('selected');
        return '<div class="' + cls.join(' ') + '" data-id="' + i + '">' + tileInnerHtml(r) + '</div>';
      }).join('');
    }
    function renderOps() {
      Array.prototype.forEach.call(opsEl.querySelectorAll('.op'), function (btn) {
        btn.classList.toggle('selected', btn.dataset.op === selected.op);
        // Operators are only meaningful once an A tile is selected.
        btn.disabled = (selected.aId === null) || locked;
      });
    }
    function renderControls() {
      // Undo and Reset are both enabled whenever there's anything to
      // reverse — a pending operator pick, a pending A pick, or one or
      // more committed combines. Reset wipes everything back to the
      // initial four tiles; Undo peels one tap at a time.
      const hasState = history.length > 0 || selected.aId !== null || selected.op !== null;
      if (undoBtn) undoBtn.disabled = !hasState || locked;
      if (resetBtn) resetBtn.disabled = !hasState || locked;
    }
    function renderAll() { renderTiles(); renderOps(); renderControls(); }

    function shakeTile(id) {
      const el = numbersEl.querySelector('.tile[data-id="' + id + '"]');
      if (!el) return;
      el.classList.add('shake');
      setTimeout(function () { el.classList.remove('shake'); }, 450);
    }

    // ---------------- Interaction ----------------
    function onTileClick(e) {
      if (locked) return;
      const tile = e.target.closest('.tile');
      if (!tile || tile.classList.contains('consumed') || !numbersEl.contains(tile)) return;
      const id = parseInt(tile.dataset.id, 10);
      if (!Number.isInteger(id) || !tiles[id]) return;

      // Step 1: pick A
      if (selected.aId === null) {
        selected.aId = id;
        selected.op = null;
        renderAll();
        return;
      }
      // Tapping A again deselects
      if (selected.aId === id && !selected.op) {
        selected.aId = null;
        renderAll();
        return;
      }
      // Step 2 (after op picked): pick B and commit
      if (selected.op) {
        if (id === selected.aId) {
          // Tapping A while an op is selected → keep A, ignore the tap
          // (re-selecting A with an op active is meaningless).
          return;
        }
        commitStep(selected.aId, selected.op, id);
        return;
      }
      // Otherwise replace A
      selected.aId = id;
      renderAll();
    }

    function onOpClick(e) {
      if (locked) return;
      const btn = e.target.closest('.op');
      if (!btn || btn.disabled || !opsEl.contains(btn)) return;
      if (selected.aId === null) return;
      selected.op = btn.dataset.op;
      renderAll();
    }

    function commitStep(aId, op, bId) {
      const a = tiles[aId];
      const b = tiles[bId];
      const fn = OPS[op];
      const r = fn(a, b);
      if (r === null) {
        // Division by zero — flash B and clear selection.
        shakeTile(bId);
        selected = { aId: null, op: null };
        renderTiles();
        renderOps();
        return;
      }
      const step = { aId: aId, op: op, bId: bId, prevA: a, prevB: b };
      history.push(step);
      tiles[aId] = null;
      tiles[bId] = r;
      selected = { aId: null, op: null };
      renderAll();
      if (onCombine) {
        try { onCombine({ aId: aId, op: op, bId: bId }); } catch (_) {}
      }

      // Was that the final combine?
      const remaining = tiles.filter(function (t) { return t !== null; });
      if (remaining.length !== 1) return;

      const lastId = tiles.findIndex(function (t) { return t !== null; });
      if (rEq(remaining[0], { n: 24, d: 1 })) {
        locked = true;
        renderAll();
        // Add the win class AFTER renderAll — renderTiles rebuilds the DOM
        // via innerHTML, so any class added before would be wiped out.
        const winTile = numbersEl.querySelector('.tile[data-id="' + lastId + '"]');
        if (winTile) winTile.classList.add('win');
        const steps = history.map(function (s) {
          return { aId: s.aId, op: s.op, bId: s.bId };
        });
        try { onSolve(steps); } catch (_) {}
      } else {
        shakeTile(lastId);
        if (onWrong) {
          try { onWrong(); } catch (_) {}
        } else {
          autoResetTimer = setTimeout(function () {
            autoResetTimer = null;
            reset();
          }, 550);
        }
      }
    }

    function destroy() {
      cancelAutoReset();
      numbersEl.removeEventListener('click', onTileClick);
      opsEl.removeEventListener('click', onOpClick);
      if (undoBtn) undoBtn.removeEventListener('click', undo);
      if (resetBtn) resetBtn.removeEventListener('click', reset);
    }

    // Wire up listeners and paint initial (empty/locked) state.
    numbersEl.addEventListener('click', onTileClick);
    opsEl.addEventListener('click', onOpClick);
    if (undoBtn) undoBtn.addEventListener('click', undo);
    if (resetBtn) resetBtn.addEventListener('click', reset);
    renderAll();

    return {
      loadPuzzle: loadPuzzle,
      reset: reset,
      undo: undo,
      lock: lock,
      unlock: unlock,
      isLocked: isLocked,
      destroy: destroy,
    };
  }

  // Expose as a small global for non-module callers.
  window.PuzzleEngine = {
    create: create,
    tileInnerHtml: tileInnerHtml,
    rMake: rMake,
    rEq: rEq,
  };
})();
