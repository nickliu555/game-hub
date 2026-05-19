(function () {
  'use strict';

  // ---------------- Boot guard ----------------
  const playerId = localStorage.getItem('twentyfour.playerId');
  if (!playerId) {
    window.location.replace('/twentyfour/join');
    return;
  }

  const meName = document.getElementById('meName');
  const meScore = document.getElementById('meScore');
  const pCountdown = document.getElementById('pCountdown');
  const viewLobby = document.getElementById('view-lobby');
  const viewPuzzle = document.getElementById('view-puzzle');
  const viewFinal = document.getElementById('view-final');
  const viewDone = document.getElementById('view-done');
  const lobbyPlayerCount = document.getElementById('lobbyPlayerCount');
  const lobbyPlayerCountValue = document.getElementById('lobbyPlayerCountValue');
  const lobbyPlayerCountLabel = document.getElementById('lobbyPlayerCountLabel');
  const numbersEl = document.getElementById('numbers');
  const opsEl = document.getElementById('ops');
  const undoBtn = document.getElementById('undoBtn');
  const resetBtn = document.getElementById('resetBtn');
  const skipBtn = document.getElementById('skipBtn');
  const skipRemainingEl = document.getElementById('skipRemaining');
  const finalSolves = document.getElementById('finalSolves');
  const finalSkips = document.getElementById('finalSkips');
  const finalRankLine = document.getElementById('finalRankLine');
  const doneSolves = document.getElementById('doneSolves');
  const doneSkips = document.getElementById('doneSkips');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');

  meName.textContent = localStorage.getItem('twentyfour.playerName') || '…';

  function showView(name) {
    viewLobby.style.display = (name === 'lobby') ? 'flex' : 'none';
    viewPuzzle.style.display = (name === 'puzzle') ? 'flex' : 'none';
    viewFinal.style.display = (name === 'final') ? 'flex' : 'none';
    viewDone.style.display  = (name === 'done')  ? 'flex' : 'none';
  }

  // Live player count shown in the lobby waiting view. Mirrors Empire/Trivia.
  function setLobbyPlayerCount(total) {
    if (typeof total !== 'number' || total <= 0) {
      if (lobbyPlayerCount) lobbyPlayerCount.hidden = true;
      return;
    }
    if (lobbyPlayerCountValue) lobbyPlayerCountValue.textContent = String(total);
    if (lobbyPlayerCountLabel) lobbyPlayerCountLabel.textContent = total === 1 ? 'player' : 'players';
    if (lobbyPlayerCount) lobbyPlayerCount.hidden = false;
  }

  function showDone(payload) {
    // Player has walked past the last puzzle in the shared queue. Lock
    // them onto a celebratory screen until the round timer ends, at
    // which point `state:final` will swap them to the leaderboard view.
    const solves = (payload && typeof payload.solvedCount === 'number') ? payload.solvedCount : 0;
    const skips  = (payload && typeof payload.skippedCount === 'number') ? payload.skippedCount : 0;
    doneSolves.textContent = solves;
    doneSkips.textContent = skips;
    showView('done');
  }

  // ---------------- Rational arithmetic (mirror of server/solver.js) ----------------
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; }
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

  // ---------------- Puzzle state ----------------
  let currentPuzzleId = null;
  let originalNumbers = null;  // int[4] from server
  let servedAt = 0;
  let skipEligibleAt = 0;
  // Live state. Each tile slot 0..3 either has a value (rational) or null
  // if consumed. We track combine history so Undo can revert.
  let tiles = [];          // [rational | null]
  let history = [];        // [{aId, op, bId, prevA, prevB}]
  let selected = { aId: null, op: null };  // tap-A then tap-op then tap-B
  let solving = false;     // true while waiting for server ack

  function loadPuzzle(payload) {
    currentPuzzleId = payload.puzzleId;
    originalNumbers = payload.numbers.slice();
    servedAt = payload.servedAt;
    skipEligibleAt = payload.skipEligibleAt;
    tiles = originalNumbers.map(function (n) { return rMake(n, 1); });
    history = [];
    selected = { aId: null, op: null };
    solving = false;
    renderTiles();
    renderOps();
    renderControls();
    showView('puzzle');
  }

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
      btn.disabled = (selected.aId === null) || solving;
    });
  }
  function renderControls() {
    undoBtn.disabled = history.length === 0 || solving;
    resetBtn.disabled = history.length === 0 || solving;
    updateSkipBtn();
  }
  function updateSkipBtn() {
    const remaining = Math.max(0, skipEligibleAt - Date.now());
    if (remaining > 0) {
      skipBtn.disabled = true;
      skipRemainingEl.textContent = Math.ceil(remaining / 1000) + 's';
    } else {
      skipBtn.disabled = solving;
      skipRemainingEl.textContent = '';
    }
  }
  // The "skip" button has a server-enforced 20s lockout — keep the UI in
  // sync without polling the server.
  setInterval(updateSkipBtn, 250);

  // ---------------- Tile + op interactions ----------------
  numbersEl.addEventListener('click', function (e) {
    if (solving) return;
    const tile = e.target.closest('.tile');
    if (!tile || tile.classList.contains('consumed')) return;
    const id = parseInt(tile.dataset.id, 10);
    if (!Number.isInteger(id) || !tiles[id]) return;

    // Step 1: pick A
    if (selected.aId === null) {
      selected.aId = id;
      selected.op = null;
      renderTiles();
      renderOps();
      return;
    }
    // Tapping A again deselects
    if (selected.aId === id && !selected.op) {
      selected.aId = null;
      renderTiles();
      renderOps();
      return;
    }
    // Step 2 (after op picked): pick B and commit
    if (selected.op) {
      if (id === selected.aId) {
        // Tapping A while an op is selected → swap A
        selected.aId = id;
        renderTiles();
        return;
      }
      commitStep(selected.aId, selected.op, id);
      return;
    }
    // Otherwise replace A
    selected.aId = id;
    renderTiles();
  });

  opsEl.addEventListener('click', function (e) {
    if (solving) return;
    const btn = e.target.closest('.op');
    if (!btn || btn.disabled) return;
    if (selected.aId === null) return;
    selected.op = btn.dataset.op;
    renderOps();
  });

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
    history.push({ aId: aId, op: op, bId: bId, prevA: a, prevB: b });
    tiles[aId] = null;
    tiles[bId] = r;
    selected = { aId: null, op: null };
    renderTiles();
    renderOps();
    renderControls();

    // Was that the final combine?
    const remaining = tiles.filter(function (t) { return t !== null; });
    if (remaining.length === 1) {
      if (rEq(remaining[0], { n: 24, d: 1 })) {
        submitSolve();
      } else {
        // Not 24 — shake and auto-reset.
        const lastId = tiles.findIndex(function (t) { return t !== null; });
        shakeTile(lastId);
        setTimeout(resetPuzzle, 550);
      }
    }
  }

  function shakeTile(id) {
    const el = numbersEl.querySelector('.tile[data-id="' + id + '"]');
    if (!el) return;
    el.classList.add('shake');
    setTimeout(function () { el.classList.remove('shake'); }, 450);
  }

  function resetPuzzle() {
    tiles = originalNumbers.map(function (n) { return rMake(n, 1); });
    history = [];
    selected = { aId: null, op: null };
    renderTiles();
    renderOps();
    renderControls();
  }

  undoBtn.addEventListener('click', function () {
    if (!history.length || solving) return;
    const step = history.pop();
    tiles[step.aId] = step.prevA;
    tiles[step.bId] = step.prevB;
    selected = { aId: null, op: null };
    renderTiles();
    renderOps();

    renderControls();
  });
  resetBtn.addEventListener('click', resetPuzzle);

  // ---------------- Solve / skip ----------------
  function submitSolve() {
    solving = true;
    renderOps();
    renderControls();
    // Brief win animation on the remaining tile.
    const lastId = tiles.findIndex(function (t) { return t !== null; });
    const winTile = numbersEl.querySelector('.tile[data-id="' + lastId + '"]');
    if (winTile) winTile.classList.add('win');

    const steps = history.map(function (s) { return { aId: s.aId, op: s.op, bId: s.bId }; });
    socket.emit('player:solve', { puzzleId: currentPuzzleId, steps: steps }, function (res) {
      if (!res || !res.ok) {
        // Server rejected (stale puzzle, bad steps, etc.) — just reset locally.
        solving = false;
        resetPuzzle();
        return;
      }
      if (res.accepted) {
        meScore.textContent = res.score;
        if (res.next) {
          // Tiny delay so the player sees the win flash before swapping.
          setTimeout(function () { loadPuzzle(res.next); }, 450);
        } else if (res.done) {
          setTimeout(function () { showDone({ solvedCount: res.score }); }, 450);
        }
      } else {
        // Accepted as a valid sequence but didn't equal 24 — shouldn't
        // happen because we check locally, but reset just in case.
        solving = false;
        resetPuzzle();
      }
    });
  }

  skipBtn.addEventListener('click', function () {
    if (solving) return;
    if (Date.now() < skipEligibleAt) return;
    solving = true;
    renderControls();
    socket.emit('player:skip', { puzzleId: currentPuzzleId }, function (res) {
      solving = false;
      if (!res || !res.ok) {
        renderControls();
        return;
      }
      if (res.next) loadPuzzle(res.next);
      else if (res.done) showDone(null);
    });
  });

  // ---------------- Round countdown (player-side) ----------------
  let roundEndsAt = 0;
  let countdownTimer = null;
  let clockOffset = 0;
  let lastBuzzSec = -1;
  function serverNow() { return Date.now() + clockOffset; }
  function applyRound(round) {
    if (!round) return;
    if (typeof round.serverNow === 'number') {
      clockOffset = round.serverNow - Date.now();
    }
    roundEndsAt = round.roundEndsAt;
    lastBuzzSec = -1;
    tickCountdown();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdown, 250);
  }
  function tickCountdown() {
    const ms = Math.max(0, roundEndsAt - serverNow());
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    pCountdown.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    const warn = totalSec <= 10 && totalSec > 5;
    const urgent = totalSec <= 5 && totalSec > 0;
    pCountdown.classList.toggle('warn', warn);
    pCountdown.classList.toggle('urgent', urgent);
    // Haptic nudge at the start of the 10s warn and again at the start of
    // the 5s urgent window. Guard with lastBuzzSec so we fire each only once.
    if (totalSec !== lastBuzzSec) {
      lastBuzzSec = totalSec;
      if (navigator.vibrate) {
        if (totalSec === 10) navigator.vibrate(80);
        else if (totalSec === 5) navigator.vibrate([60, 40, 60]);
        else if (urgent) navigator.vibrate(40);
      }
    }
    if (ms <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      pCountdown.classList.remove('warn', 'urgent');
    }
  }

  // ---------------- Host presence ----------------
  function setHostPresent(present) {
    hostAbsentOverlay.hidden = !!present;
  }

  // ---------------- Socket wiring ----------------
  const socket = io('/twentyfour', { transports: ['polling', 'websocket'] });

  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        // Player no longer exists on server (host reset, kicked, etc.)
        const savedName = localStorage.getItem('twentyfour.playerName') || '';
        if (savedName) localStorage.setItem('twentyfour.rejoinName', savedName);
        localStorage.removeItem('twentyfour.playerId');
        localStorage.removeItem('twentyfour.playerName');
        window.location.replace('/twentyfour/join');
        return;
      }
      meName.textContent = res.player.name;
      meScore.textContent = res.player.score || 0;
      setHostPresent(res.hostPresent !== false);

      if (res.phase === 'LOBBY') {
        setLobbyPlayerCount(res.total);
        showView('lobby');
      }
      else if (res.phase === 'ROUND') {
        applyRound(res.round);
        if (res.done) showDone(res.done);
        else if (res.currentPuzzle) loadPuzzle(res.currentPuzzle);
        else showView('lobby'); // shouldn't happen, but be defensive
      } else if (res.phase === 'FINAL') {
        showFinal();
      }
    });
  });

  socket.on('state:hostPresence', function (p) {
    setHostPresent(!(p && p.present === false));
  });
  socket.on('state:lobby', function (s) {
    if (s && typeof s.total === 'number') setLobbyPlayerCount(s.total);
  });
  socket.on('state:reset', function () {
    // Host reset the game — kick us back to join.
    const savedName = localStorage.getItem('twentyfour.playerName') || '';
    if (savedName) localStorage.setItem('twentyfour.rejoinName', savedName);
    localStorage.removeItem('twentyfour.playerId');
    localStorage.removeItem('twentyfour.playerName');
    window.location.replace('/twentyfour/join');
  });
  socket.on('player:rejected', function () {
    localStorage.removeItem('twentyfour.playerId');
    localStorage.removeItem('twentyfour.playerName');
    window.location.replace('/twentyfour/join');
  });
  socket.on('state:round', function (r) {
    applyRound(r);
  });
  socket.on('puzzle:next', function (p) {
    if (p) loadPuzzle(p);
  });
  socket.on('puzzle:done', function (p) {
    showDone(p);
  });
  socket.on('score:update', function (p) {
    // Find ourselves in the leaderboard to keep the score chip up to date.
    if (!p || !p.leaderboard) return;
    const me = p.leaderboard.find(function (x) { return x.id === playerId; });
    if (me) meScore.textContent = me.score;
  });
  socket.on('state:final', function (f) {
    showFinal(f);
  });

  function showFinal(f) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    showView('final');
    pCountdown.textContent = '0:00';
    pCountdown.classList.remove('warn');
    // Pull our own row from the leaderboard so we can show real solved /
    // skipped counts. (Score == solvedCount in this game, but read it from
    // the explicit fields for clarity.)
    if (f && f.fullLeaderboard) {
      const me = f.fullLeaderboard.find(function (x) { return x.id === playerId; });
      if (me) {
        finalSolves.textContent = (typeof me.solvedCount === 'number') ? me.solvedCount : me.score;
        finalSkips.textContent = (typeof me.skippedCount === 'number') ? me.skippedCount : 0;
        // Trust the server-assigned rank (competition style: ties share a
        // rank). Fall back to array position if the server didn't send one.
        const rank = (typeof me.rank === 'number') ? me.rank : (f.fullLeaderboard.indexOf(me) + 1);
        const total = f.fullLeaderboard.length;
        finalRankLine.textContent = 'You finished ' + ordinal(rank) + ' of ' + total;
      } else {
        finalSkips.textContent = '0';
      }
    } else {
      finalSkips.textContent = '0';
    }
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
})();
