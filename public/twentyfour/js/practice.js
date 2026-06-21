(function () {
  'use strict';

  // ============================================================
  // practice.js — solo "24" practice mode controller.
  //
  // Loads puzzles.json + solutions.json once on page open. User picks a
  // difficulty; we filter+shuffle the matching pool into a session queue
  // and serve puzzles one at a time using the shared puzzle-engine.js.
  //
  // - Timer pauses when play is blocked: during a Give Up reveal, while
  //   the tab is hidden, and while the change-difficulty or exit summary
  //   overlay is open.
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
  // Timer is built around "accumulated ms while actively playing" rather
  // than a wall-clock delta from session start, so it can pause cleanly
  // when (a) the player is reading a Give Up reveal or (b) the tab is
  // hidden in the background.
  let accumulatedMs = 0;
  let activeSegmentStart = 0; // ms timestamp when current run started; 0 = paused
  let viewActive = false;     // true while the puzzle view is the active one
  let pageVisible = (typeof document === 'undefined') ? true : !document.hidden;
  let timerHandle = null;
  let solvedCount = 0;
  let gaveUpCount = 0;
  // Name of the currently shown view ('setup' | 'puzzle' | 'answer'), tracked
  // so the session can be persisted/restored across a page refresh.
  let currentViewName = 'setup';

  // ---------------- Session persistence ----------------
  // Practice state lives only in memory, so a refresh used to dump the player
  // back on the difficulty picker. We snapshot the active session to
  // sessionStorage (per-tab, survives refresh) and restore it on boot so the
  // player stays on the same puzzle. The in-puzzle combine progress is not
  // restored — the puzzle reloads fresh — but the queue, stats, timer, and
  // current puzzle/answer view are preserved.
  const SESSION_KEY = 'twentyfour.practice.session';

  function saveSession() {
    if (currentPuzzleId === null) return; // nothing active to save
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        v: 1,
        difficulty: selectedDifficulty,
        queue: queue,
        cursor: cursor,
        currentPuzzleId: currentPuzzleId,
        solvedCount: solvedCount,
        gaveUpCount: gaveUpCount,
        elapsedMs: currentElapsedMs(),
        view: currentViewName,
      }));
    } catch (_) { /* private mode / quota — ignore */ }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  }
  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || s.v !== 1 || !Array.isArray(s.queue)
          || typeof s.currentPuzzleId !== 'number') return null;
      return s;
    } catch (_) { return null; }
  }

  function showView(name) {
    currentViewName = name;
    viewSetup.hidden = name !== 'setup';
    viewPuzzle.hidden = name !== 'puzzle';
    viewAnswer.hidden = name !== 'answer';
    // Timer only accumulates while the puzzle view is showing — the
    // answer view (Give Up reveal) and the setup screen don't count as
    // active play.
    setViewActive(name === 'puzzle');
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
      saveSession();
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
    accumulatedMs = 0;
    activeSegmentStart = 0;
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

  // Switch is only meaningful when the pending choice differs from the
  // current difficulty. Disabling it prevents an unintentional puzzle
  // reshuffle when the user opens the picker and confirms the same level.
  function updateDiffApplyState() {
    diffApplyBtn.disabled = (pendingDifficulty === null) || (pendingDifficulty === selectedDifficulty);
  }

  difficultyChip.addEventListener('click', function () {
    pendingDifficulty = selectedDifficulty;
    Array.prototype.forEach.call(changeDifficultyPicker.querySelectorAll('.diff-card'), function (b) {
      b.classList.toggle('selected', b.dataset.difficulty === selectedDifficulty);
    });
    updateDiffApplyState();
    diffOverlay.hidden = false;
    reconcileTimer();
  });

  changeDifficultyPicker.addEventListener('click', function (e) {
    const btn = e.target.closest('.diff-card');
    if (!btn) return;
    pendingDifficulty = btn.dataset.difficulty;
    Array.prototype.forEach.call(changeDifficultyPicker.querySelectorAll('.diff-card'), function (b) {
      b.classList.toggle('selected', b === btn);
    });
    updateDiffApplyState();
  });

  diffCancelBtn.addEventListener('click', function () {
    diffOverlay.hidden = true;
    pendingDifficulty = null;
    reconcileTimer();
  });

  diffApplyBtn.addEventListener('click', function () {
    // Same level as current → nothing to do; don't reshuffle the puzzle.
    if (!pendingDifficulty || pendingDifficulty === selectedDifficulty) {
      diffOverlay.hidden = true;
      pendingDifficulty = null;
      reconcileTimer();
      return;
    }
    if (poolSize(pendingDifficulty) === 0) {
      // Vanishingly unlikely (every difficulty has hundreds of puzzles),
      // but bail safely without disturbing the session if it ever happens.
      diffOverlay.hidden = true;
      pendingDifficulty = null;
      reconcileTimer();
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
    saveSession();
  }

  // ---------------- Give up ----------------
  // Paint the worked-solution card for a puzzle. Shared by the Give Up
  // button and session restore (so a refresh on the answer view comes back
  // to the same reveal).
  function renderAnswer(puzzleId) {
    const numbers = puzzles[puzzleId];
    const expr = (solutions && puzzleId < solutions.length)
      ? solutions[puzzleId]
      : null;
    answerNumbers.textContent = 'Using ' + numbers.join(', ');
    if (expr) {
      answerExpr.textContent = expr;
      answerNote.hidden = true;
    } else {
      answerExpr.textContent = '—';
      answerNote.hidden = false;
    }
  }

  giveUpBtn.addEventListener('click', function () {
    if (engine.isLocked()) return;
    if (currentPuzzleId === null) return;
    gaveUpCount++;
    engine.lock();
    renderAnswer(currentPuzzleId);
    showView('answer');
    saveSession();
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
  // Recompute whether the timer should be actively accumulating. Called
  // on every view change, visibility change, and overlay open/close. If we
  // transition from active → paused, fold the current segment into
  // accumulatedMs. If we transition from paused → active, start a fresh
  // segment.
  function reconcileTimer() {
    // An open overlay (change-difficulty or exit summary) blocks play, so
    // the timer pauses while either modal is up — same treatment as a
    // hidden tab or the Give Up reveal.
    const modalOpen = !diffOverlay.hidden || !exitOverlay.hidden;
    const want = viewActive && pageVisible && !modalOpen;
    const isAccumulating = activeSegmentStart !== 0;
    if (want && !isAccumulating) {
      activeSegmentStart = Date.now();
    } else if (!want && isAccumulating) {
      accumulatedMs += Date.now() - activeSegmentStart;
      activeSegmentStart = 0;
    }
    paintTimer();
  }
  function setViewActive(b) {
    viewActive = !!b;
    reconcileTimer();
  }
  function elapsedSec() {
    return Math.floor(currentElapsedMs() / 1000);
  }
  function currentElapsedMs() {
    let total = accumulatedMs;
    if (activeSegmentStart) total += (Date.now() - activeSegmentStart);
    return total;
  }
  function formatTime(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const ss = (s < 10 ? '0' : '') + s;
    if (h > 0) {
      const mm = (m < 10 ? '0' : '') + m;
      return h + ':' + mm + ':' + ss;
    }
    return m + ':' + ss;
  }
  function paintTimer() {
    timerDisplay.textContent = formatTime(elapsedSec());
  }
  function paintStats() {
    solvedDisplay.textContent = String(solvedCount);
    solvedLabel.textContent = solvedCount === 1 ? 'solved' : 'solved';
  }

  // Pause the timer when the tab is hidden (switched away, phone
  // locked, etc.) so a long break doesn't inflate the session time.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      pageVisible = !document.hidden;
      reconcileTimer();
      // Persist the folded timer so a refresh after backgrounding is accurate.
      saveSession();
    });
  }
  // pagehide fires on refresh/navigation (more reliable than beforeunload on
  // mobile Safari) — snapshot the latest timer value before the page unloads.
  window.addEventListener('pagehide', function () { saveSession(); });

  // ---------------- Back / exit overlay ----------------
  backBtn.addEventListener('click', function () {
    // Nothing accomplished yet → just navigate away.
    if (solvedCount === 0 && gaveUpCount === 0) {
      clearSession();
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
    reconcileTimer();
  });
  exitStayBtn.addEventListener('click', function () {
    exitOverlay.hidden = true;
    reconcileTimer();
  });
  exitLeaveBtn.addEventListener('click', function () {
    clearSession();
    window.location.href = getBackTarget();
  });

  // ---------------- Boot ----------------
  // Restore an in-progress session (refresh-safe) once puzzle data is ready;
  // otherwise stay on the difficulty picker.
  function restoreSession(s) {
    selectedDifficulty = s.difficulty || 'easy';
    queue = s.queue;
    cursor = (typeof s.cursor === 'number') ? s.cursor : 0;
    currentPuzzleId = s.currentPuzzleId;
    solvedCount = (typeof s.solvedCount === 'number') ? s.solvedCount : 0;
    gaveUpCount = (typeof s.gaveUpCount === 'number') ? s.gaveUpCount : 0;
    accumulatedMs = (typeof s.elapsedMs === 'number') ? s.elapsedMs : 0;
    activeSegmentStart = 0;
    paintStats();
    paintDifficultyChip();
    startTimer();
    if (s.view === 'answer') {
      engine.lock();
      renderAnswer(currentPuzzleId);
      showView('answer');
    } else {
      engine.loadPuzzle(puzzles[currentPuzzleId]);
      showView('puzzle');
    }
  }

  loadData().then(function () {
    const saved = loadSession();
    // Guard against a stale snapshot pointing past the loaded puzzle set.
    if (saved && saved.currentPuzzleId < puzzles.length) {
      restoreSession(saved);
    } else if (saved) {
      clearSession();
    }
  }).catch(function (err) {
    console.error('[practice] failed to load data:', err);
    setupError.textContent = 'Could not load puzzle data. Try refreshing.';
    setupError.hidden = false;
  });
})();
