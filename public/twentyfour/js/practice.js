(function () {
  'use strict';

  // ============================================================
  // practice.js — solo "24" practice mode controller.
  //
  // Loads puzzles.json + solutions.json once on page open. User picks a
  // difficulty; we filter+shuffle the matching pool into a session queue
  // and serve puzzles one at a time using the shared puzzle-engine.js.
  //
  // - Timer runs continuously from Start (no pause).
  // - Solved counter increments on engine onSolve.
  // - Give Up reveals the worked solution from solutions[puzzle.id] and
  //   shows a Next button. Give Up does NOT increment the counter.
  // - "← Back" shows a summary modal if the player has done anything
  //   (solved or gave up at least once); otherwise it exits immediately.
  // ============================================================

  // ---------------- DOM refs ----------------
  const backBtn = document.getElementById('backBtn');
  const viewSetup = document.getElementById('view-setup');
  const viewPuzzle = document.getElementById('view-puzzle');
  const viewAnswer = document.getElementById('view-answer');
  const difficultyPicker = document.getElementById('difficultyPicker');
  const startBtn = document.getElementById('startBtn');
  const setupLoading = document.getElementById('setupLoading');
  const setupError = document.getElementById('setupError');
  const numbersEl = document.getElementById('numbers');
  const opsEl = document.getElementById('ops');
  const undoBtn = document.getElementById('undoBtn');
  const resetBtn = document.getElementById('resetBtn');
  const giveUpBtn = document.getElementById('giveUpBtn');
  const timerDisplay = document.getElementById('timerDisplay');
  const solvedDisplay = document.getElementById('solvedDisplay');
  const solvedLabel = document.getElementById('solvedLabel');
  const answerNumbers = document.getElementById('answerNumbers');
  const answerExpr = document.getElementById('answerExpr');
  const answerNote = document.getElementById('answerNote');
  const nextBtn = document.getElementById('nextBtn');
  const exitOverlay = document.getElementById('exitOverlay');
  const exitTitle = document.getElementById('exitTitle');
  const exitStats = document.getElementById('exitStats');
  const exitSolved = document.getElementById('exitSolved');
  const exitTime = document.getElementById('exitTime');
  const exitStayBtn = document.getElementById('exitStayBtn');
  const exitLeaveBtn = document.getElementById('exitLeaveBtn');
  const difficultyChip = document.getElementById('difficultyChip');
  const difficultyDisplay = document.getElementById('difficultyDisplay');
  const diffOverlay = document.getElementById('diffOverlay');
  const changeDifficultyPicker = document.getElementById('changeDifficultyPicker');
  const diffCancelBtn = document.getElementById('diffCancelBtn');
  const diffApplyBtn = document.getElementById('diffApplyBtn');

  // Human-readable labels for the chip.
  const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard', any: 'Any' };

  // ---------------- Back navigation target ----------------
  // /twentyfour/practice?from=join → back to /twentyfour/join
  // /twentyfour/practice?from=hub  → back to /
  // (default) → /
  function getBackTarget() {
    const params = new URLSearchParams(window.location.search);
    const from = (params.get('from') || '').toLowerCase();
    if (from === 'join') return '/twentyfour/join';
    if (from === 'play') return '/twentyfour/play';
    return '/';
  }

  // ---------------- Data loading ----------------
  // Both files live at /twentyfour/data/ and are committed as static assets.
  let puzzles = null;        // [[a,b,c,d], ...]
  let solutions = null;      // [exprString | null, ...] — indexed identically
  let dataReady = false;

  function loadData() {
    return Promise.all([
      fetch('/twentyfour/data/puzzles.json').then(function (r) { return r.json(); }),
      fetch('/twentyfour/data/solutions.json').then(function (r) { return r.json(); }),
    ]).then(function (results) {
      puzzles = results[0];
      solutions = results[1];
      if (!Array.isArray(puzzles) || !Array.isArray(solutions)) {
        throw new Error('puzzles or solutions is not an array');
      }
      if (solutions.length !== puzzles.length) {
        // Stale solutions.json — practice can still run, but log loudly.
        console.warn('[practice] solutions.length (' + solutions.length + ') != puzzles.length (' + puzzles.length + ').');
      }
      dataReady = true;
      paintDifficultyCounts();
    });
  }

  // ---------------- Difficulty partitioning ----------------
  // Mirrors server/twentyfour/puzzles.js: split puzzles into easy/medium/
  // hard thirds by index. Any remainder accumulates into `hard`.
  function getPool(difficulty) {
    const n = puzzles.length;
    const third = Math.floor(n / 3);
    const easyEnd = third;
    const mediumEnd = third * 2;
    // We collect puzzle indices (== puzzle.id), not the number arrays —
    // we need the id to look up the solution later.
    const ids = [];
    if (difficulty === 'easy') {
      for (let i = 0; i < easyEnd; i++) ids.push(i);
    } else if (difficulty === 'medium') {
      for (let i = easyEnd; i < mediumEnd; i++) ids.push(i);
    } else if (difficulty === 'hard') {
      for (let i = mediumEnd; i < n; i++) ids.push(i);
    } else {
      for (let i = 0; i < n; i++) ids.push(i);
    }
    return ids;
  }

  function poolSize(difficulty) {
    if (!puzzles) return 0;
    return getPool(difficulty).length;
  }

  function paintDifficultyCounts() {
    // Apply counts to every [data-count] inside both pickers (setup +
    // the in-session change overlay).
    const els = document.querySelectorAll('.difficulty-picker [data-count]');
    Array.prototype.forEach.call(els, function (el) {
      const d = el.dataset.count;
      el.textContent = poolSize(d).toLocaleString() + ' puzzles';
    });
  }

  function paintDifficultyChip() {
    difficultyDisplay.textContent = DIFFICULTY_LABELS[selectedDifficulty] || 'Easy';
  }

  function fisherYates(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---------------- Session state ----------------
  let selectedDifficulty = 'easy';
  let queue = [];             // shuffled list of puzzle ids to serve
  let cursor = 0;             // next index into queue
  let currentPuzzleId = null;
  let sessionStartTs = 0;
  let timerHandle = null;
  let solvedCount = 0;
  let gaveUpCount = 0;

  function showView(name) {
    viewSetup.hidden = name !== 'setup';
    viewPuzzle.hidden = name !== 'puzzle';
    viewAnswer.hidden = name !== 'answer';
  }

  // ---------------- Puzzle engine ----------------
  // Created once and reused across all puzzles in the session.
  const engine = window.PuzzleEngine.create({
    numbersEl: numbersEl,
    opsEl: opsEl,
    undoBtn: undoBtn,
    resetBtn: resetBtn,
    onSolve: function () {
      // Engine has shown the win flash and locked itself. Bump the
      // counter and advance after a short delay so the player sees it.
      solvedCount++;
      paintStats();
      setTimeout(serveNext, 500);
    },
  });

  // ---------------- Difficulty picker ----------------
  difficultyPicker.addEventListener('click', function (e) {
    const btn = e.target.closest('.diff-card');
    if (!btn) return;
    Array.prototype.forEach.call(difficultyPicker.querySelectorAll('.diff-card'), function (b) {
      b.classList.toggle('selected', b === btn);
    });
    selectedDifficulty = btn.dataset.difficulty;
  });

  // ---------------- Start ----------------
  startBtn.addEventListener('click', function () {
    if (!dataReady) {
      setupLoading.hidden = false;
      return;
    }
    if (poolSize(selectedDifficulty) === 0) {
      setupError.textContent = 'No puzzles available for that difficulty.';
      setupError.hidden = false;
      return;
    }
    setupError.hidden = true;
    queue = fisherYates(getPool(selectedDifficulty));
    cursor = 0;
    solvedCount = 0;
    gaveUpCount = 0;
    sessionStartTs = Date.now();
    paintStats();
    paintDifficultyChip();
    startTimer();
    showView('puzzle');
    serveNext();
  });

  // ---------------- Change difficulty (mid-session) ----------------
  // The stats-bar chip opens an overlay; picking + Switch reshuffles
  // the queue from the new pool and serves the next puzzle. Timer and
  // solved counter intentionally persist — the session continues.
  let pendingDifficulty = null;

  difficultyChip.addEventListener('click', function () {
    pendingDifficulty = selectedDifficulty;
    Array.prototype.forEach.call(changeDifficultyPicker.querySelectorAll('.diff-card'), function (b) {
      b.classList.toggle('selected', b.dataset.difficulty === selectedDifficulty);
    });
    diffOverlay.hidden = false;
  });

  changeDifficultyPicker.addEventListener('click', function (e) {
    const btn = e.target.closest('.diff-card');
    if (!btn) return;
    pendingDifficulty = btn.dataset.difficulty;
    Array.prototype.forEach.call(changeDifficultyPicker.querySelectorAll('.diff-card'), function (b) {
      b.classList.toggle('selected', b === btn);
    });
  });

  diffCancelBtn.addEventListener('click', function () {
    diffOverlay.hidden = true;
    pendingDifficulty = null;
  });

  diffApplyBtn.addEventListener('click', function () {
    if (!pendingDifficulty) { diffOverlay.hidden = true; return; }
    if (poolSize(pendingDifficulty) === 0) {
      // Vanishingly unlikely (every difficulty has hundreds of puzzles),
      // but bail safely without disturbing the session if it ever happens.
      diffOverlay.hidden = true;
      pendingDifficulty = null;
      return;
    }
    selectedDifficulty = pendingDifficulty;
    pendingDifficulty = null;
    queue = fisherYates(getPool(selectedDifficulty));
    cursor = 0;
    paintDifficultyChip();
    diffOverlay.hidden = true;
    // If we're showing the answer card, advancing to the next puzzle
    // from the new pool is the natural next step. Either way the queue
    // has been replaced, so serveNext draws from the new difficulty.
    serveNext();
  });

  // ---------------- Serve next ----------------
  function serveNext() {
    if (cursor >= queue.length) {
      // Wrap around with a fresh shuffle. Vanishingly rare on Easy (454
      // puzzles) but trivial to handle.
      queue = fisherYates(getPool(selectedDifficulty));
      cursor = 0;
    }
    currentPuzzleId = queue[cursor++];
    const numbers = puzzles[currentPuzzleId];
    engine.loadPuzzle(numbers);
    showView('puzzle');
  }

  // ---------------- Give up ----------------
  giveUpBtn.addEventListener('click', function () {
    if (engine.isLocked()) return;
    if (currentPuzzleId === null) return;
    gaveUpCount++;
    engine.lock();
    const numbers = puzzles[currentPuzzleId];
    const expr = (solutions && currentPuzzleId < solutions.length)
      ? solutions[currentPuzzleId]
      : null;
    answerNumbers.textContent = 'Using ' + numbers.join(', ');
    if (expr) {
      answerExpr.textContent = expr;
      answerNote.hidden = true;
    } else {
      answerExpr.textContent = '—';
      answerNote.hidden = false;
    }
    showView('answer');
  });

  nextBtn.addEventListener('click', function () {
    serveNext();
  });

  // ---------------- Timer ----------------
  function startTimer() {
    stopTimer();
    paintTimer();
    timerHandle = setInterval(paintTimer, 1000);
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }
  function elapsedSec() {
    if (!sessionStartTs) return 0;
    return Math.floor((Date.now() - sessionStartTs) / 1000);
  }
  function formatTime(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function paintTimer() {
    timerDisplay.textContent = formatTime(elapsedSec());
  }
  function paintStats() {
    solvedDisplay.textContent = String(solvedCount);
    solvedLabel.textContent = solvedCount === 1 ? 'solved' : 'solved';
  }

  // ---------------- Back / exit overlay ----------------
  backBtn.addEventListener('click', function () {
    // Nothing accomplished yet → just navigate away.
    if (solvedCount === 0 && gaveUpCount === 0) {
      window.location.href = getBackTarget();
      return;
    }
    // Otherwise show a summary modal.
    exitTitle.textContent = solvedCount > 0
      ? 'Nice session!'
      : 'Leaving so soon?';
    exitSolved.textContent = String(solvedCount);
    exitTime.textContent = formatTime(elapsedSec());
    exitStats.hidden = false;
    exitOverlay.hidden = false;
  });
  exitStayBtn.addEventListener('click', function () {
    exitOverlay.hidden = true;
  });
  exitLeaveBtn.addEventListener('click', function () {
    window.location.href = getBackTarget();
  });

  // ---------------- Boot ----------------
  loadData().catch(function (err) {
    console.error('[practice] failed to load data:', err);
    setupError.textContent = 'Could not load puzzle data. Try refreshing.';
    setupError.hidden = false;
  });
})();
