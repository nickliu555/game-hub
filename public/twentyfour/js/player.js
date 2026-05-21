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
  const pHeader = document.querySelector('.p-header');
  const viewLobby = document.getElementById('view-lobby');
  const viewIntro = document.getElementById('view-intro');
  const viewPuzzle = document.getElementById('view-puzzle');
  const viewFinalWait = document.getElementById('view-final-wait');
  const viewFinal = document.getElementById('view-final');
  const viewDone = document.getElementById('view-done');
  const pIntroCountdown = document.getElementById('pIntroCountdown');
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
    viewIntro.style.display = (name === 'intro') ? 'flex' : 'none';
    viewPuzzle.style.display = (name === 'puzzle') ? 'flex' : 'none';
    viewFinalWait.style.display = (name === 'final-wait') ? 'flex' : 'none';
    viewFinal.style.display = (name === 'final') ? 'flex' : 'none';
    viewDone.style.display  = (name === 'done')  ? 'flex' : 'none';
    // After the round timer ends the score chip and countdown are just
    // noise — the personal stats card and the host leaderboard already
    // show the score, and the timer reads 0:00 forever. Hide them on the
    // final views, keep the name so the player still recognizes their
    // device. Any other view restores the normal header.
    if (pHeader) {
      const ended = (name === 'final-wait' || name === 'final');
      pHeader.classList.toggle('header-end', ended);
    }
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

  // ---------------- Multiplayer puzzle state ----------------
  // Tile UI + rational math + combine logic all live in puzzle-engine.js
  // (shared with practice mode). This file owns the multiplayer-specific
  // bits: current puzzle id, skip timer, server submission + ack handling.
  let currentPuzzleId = null;
  let servedAt = 0;
  let skipEligibleAt = 0;

  const engine = window.PuzzleEngine.create({
    numbersEl: numbersEl,
    opsEl: opsEl,
    undoBtn: undoBtn,
    resetBtn: resetBtn,
    onSolve: function (steps) {
      // Engine has locked itself and shown the win flash. Reflect the lock
      // on the (engine-external) skip button immediately so the player
      // can't tap Skip during the ~450ms before the next puzzle loads.
      updateSkipBtn();
      // Submit to server for authoritative scoring; advance on ack.
      socket.emit('player:solve', { puzzleId: currentPuzzleId, steps: steps }, function (res) {
        if (!res || !res.ok) {
          // Server rejected (stale puzzle, bad steps, etc.) — reset locally.
          engine.reset();
          engine.unlock();
          updateSkipBtn();
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
          // happen because the engine checks locally, but recover anyway.
          engine.reset();
          engine.unlock();
          updateSkipBtn();
        }
      });
    },
  });

  function loadPuzzle(payload) {
    currentPuzzleId = payload.puzzleId;
    servedAt = payload.servedAt;
    skipEligibleAt = payload.skipEligibleAt;
    engine.loadPuzzle(payload.numbers);
    updateSkipBtn();
    showView('puzzle');
  }

  function updateSkipBtn() {
    const remaining = Math.max(0, skipEligibleAt - Date.now());
    if (remaining > 0) {
      skipBtn.disabled = true;
      skipRemainingEl.textContent = Math.ceil(remaining / 1000) + 's';
    } else {
      skipBtn.disabled = engine.isLocked();
      skipRemainingEl.textContent = '';
    }
  }
  // The "skip" button has a server-enforced 20s lockout — keep the UI in
  // sync without polling the server.
  setInterval(updateSkipBtn, 250);

  skipBtn.addEventListener('click', function () {
    if (engine.isLocked()) return;
    if (Date.now() < skipEligibleAt) return;
    engine.lock();
    updateSkipBtn();
    socket.emit('player:skip', { puzzleId: currentPuzzleId }, function (res) {
      if (!res || !res.ok) {
        engine.unlock();
        updateSkipBtn();
        return;
      }
      if (res.next) loadPuzzle(res.next);
      else if (res.done) showDone(null);
    });
  });

  // ---------------- Pre-round "Get ready" intro ----------------
  let introTimer = null;
  function stopIntroTimer() {
    if (introTimer) { clearInterval(introTimer); introTimer = null; }
  }
  function renderIntro(payload) {
    stopIntroTimer();
    if (payload && typeof payload.serverNow === 'number') {
      clockOffset = payload.serverNow - Date.now();
    }
    const endsAt = (payload && payload.endsAt) || (Date.now() + 3000);
    // Reset the round chip while we wait for the actual round start.
    pCountdown.textContent = '—';
    pCountdown.classList.remove('warn', 'urgent');
    showView('intro');
    function tick() {
      const left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (pIntroCountdown) pIntroCountdown.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
  }

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
      else if (res.phase === 'INTRO') {
        renderIntro(res.intro);
      }
      else if (res.phase === 'ROUND') {
        applyRound(res.round);
        if (res.done) showDone(res.done);
        else if (res.currentPuzzle) loadPuzzle(res.currentPuzzle);
        else showView('lobby'); // shouldn't happen, but be defensive
      } else if (res.phase === 'FINAL') {
        // Reconnecting into FINAL — the host's reveal moment has already
        // passed, so skip the "Look up!" interstitial and go straight to
        // the personal stats card.
        showFinalStats(res);
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
    cancelFinalWait();
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
    stopIntroTimer();
    applyRound(r);
  });
  socket.on('state:intro', function (p) {
    renderIntro(p);
  });
  socket.on('puzzle:next', function (p) {
    stopIntroTimer();
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
    showFinalWait(f);
  });

  // Duration of the host's "Time's up! → Now for the results…" splash. Kept
  // in sync with public/twentyfour/js/host.js showFinalIntro() so the phone's
  // "Look up!" card swaps to personal stats just as the host reveals podium.
  const FINAL_WAIT_MS = 3800;
  let finalWaitTimer = null;
  function cancelFinalWait() {
    if (finalWaitTimer) { clearTimeout(finalWaitTimer); finalWaitTimer = null; }
  }

  function showFinalWait(f) {
    cancelFinalWait();
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    pCountdown.textContent = '0:00';
    pCountdown.classList.remove('warn');
    showView('final-wait');
    finalWaitTimer = setTimeout(function () {
      finalWaitTimer = null;
      showFinalStats(f);
    }, FINAL_WAIT_MS);
  }

  function showFinalStats(f) {
    cancelFinalWait();
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    showView('final');
    pCountdown.textContent = '0:00';
    pCountdown.classList.remove('warn');
    // Small buzz to pull attention back to the phone for the personal recap.
    if (navigator.vibrate) { try { navigator.vibrate(40); } catch (_) {} }
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
        // Medal tier prefix + color class for the top three; everyone else
        // gets the default accent-orange rank line.
        const tierClass = (rank === 1) ? 'rank-gold'
                        : (rank === 2) ? 'rank-silver'
                        : (rank === 3) ? 'rank-bronze'
                        : '';
        const medal = (rank === 1) ? '🥇 '
                    : (rank === 2) ? '🥈 '
                    : (rank === 3) ? '🥉 '
                    : '';
        finalRankLine.className = 'rank-line' + (tierClass ? ' ' + tierClass : '');
        finalRankLine.textContent = medal + 'You finished ' + ordinal(rank) + ' of ' + total;
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
