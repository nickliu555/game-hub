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
  const viewKicked = document.getElementById('view-kicked');
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
  const scoreFloat = document.getElementById('scoreFloat');
  const finalPoints = document.getElementById('finalPoints');
  const finalSolves = document.getElementById('finalSolves');
  const finalSkips = document.getElementById('finalSkips');
  const finalRankLine = document.getElementById('finalRankLine');
  const unfinishedSection = document.getElementById('unfinishedSection');
  const unfinishedToggle = document.getElementById('unfinishedToggle');
  const unfinishedToggleLabel = document.getElementById('unfinishedToggleLabel');
  const unfinishedList = document.getElementById('unfinishedList');
  const donePoints = document.getElementById('donePoints');
  const doneSolves = document.getElementById('doneSolves');
  const doneSkips = document.getElementById('doneSkips');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');

  meName.textContent = localStorage.getItem('twentyfour.playerName') || '…';

  // Kahoot/Trivia-style scoring helpers. Mirrors server constants.
  function formatScore(n) {
    const v = (typeof n === 'number' && Number.isFinite(n)) ? n : 0;
    return v.toLocaleString('en-US');
  }
  function setScoreDisplay(score) {
    const v = (typeof score === 'number' && Number.isFinite(score)) ? score : 0;
    meScore.textContent = formatScore(v);
    meScore.classList.toggle('negative', v < 0);
  }
  // Spawn a transient "+N" / "−N" overlay next to the score chip. The
  // element auto-removes after the CSS animation completes.
  function showScoreFloat(delta) {
    if (!scoreFloat || typeof delta !== 'number' || delta === 0) return;
    const item = document.createElement('div');
    item.className = 'score-float-item' + (delta < 0 ? ' negative' : '');
    item.textContent = (delta > 0 ? '+' : '−') + Math.abs(delta);
    scoreFloat.appendChild(item);
    setTimeout(function () { item.remove(); }, 1200);
  }

  function showView(name) {
    viewLobby.style.display = (name === 'lobby') ? 'flex' : 'none';
    viewIntro.style.display = (name === 'intro') ? 'flex' : 'none';
    viewPuzzle.style.display = (name === 'puzzle') ? 'flex' : 'none';
    viewFinalWait.style.display = (name === 'final-wait') ? 'flex' : 'none';
    viewFinal.style.display = (name === 'final') ? 'flex' : 'none';
    viewDone.style.display  = (name === 'done')  ? 'flex' : 'none';
    if (viewKicked) viewKicked.style.display = (name === 'kicked') ? 'flex' : 'none';
    // After the round timer ends, score and timer are redundant with the
    // personal stats card + host leaderboard. Hide them so just the name
    // remains centered. Any other view restores the normal three-part header.
    if (pHeader) {
      const ended = (name === 'final-wait' || name === 'final');
      pHeader.classList.toggle('header-end', ended);
    }
    // Reactions are allowed in social/idle phases only — never during
    // the intro countdown, active puzzles, or the "you solved them all"
    // lockout view. setReactionsAllowed() is a no-op until the DOM refs
    // are wired up at the bottom of this IIFE, but reads the right state.
    if (typeof setReactionsAllowed === 'function') {
      const allow = (name === 'lobby' || name === 'final-wait' || name === 'final');
      setReactionsAllowed(allow);
      // Attribution credit only during the lobby (pre-game wait). Once
      // the round is underway or the final stats card is up, the line
      // would just compete with content the player actually cares about.
      const attribution = document.getElementById('playerAttribution');
      if (attribution) attribution.hidden = (name !== 'lobby');
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
    const points = (payload && typeof payload.score === 'number') ? payload.score : 0;
    if (donePoints) donePoints.textContent = formatScore(points);
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
          setScoreDisplay(res.score);
          if (typeof res.pointsAwarded === 'number') {
            showScoreFloat(res.pointsAwarded);
          }
          if (res.next) {
            // Tiny delay so the player sees the win flash before swapping.
            setTimeout(function () { loadPuzzle(res.next); }, 450);
          } else if (res.done) {
            setTimeout(function () {
              showDone({
                score: res.score,
                solvedCount: undefined, // server doesn't include counts in solve ack; UI falls back to 0
                skippedCount: undefined,
              });
            }, 450);
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
  // The "skip" button has a server-enforced 10s lockout — keep the UI in
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
      if (typeof res.score === 'number') setScoreDisplay(res.score);
      if (typeof res.penalty === 'number') showScoreFloat(-res.penalty);
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
    // New round starting — clear any leftover "didn't finish" state from
    // the previous round so it doesn't bleed into this one.
    unfinishedPayload = null;
    revealedIds.clear();
    if (unfinishedSection) unfinishedSection.hidden = true;
    if (unfinishedList) {
      unfinishedList.innerHTML = '';
      unfinishedList.hidden = true;
    }
    if (unfinishedToggle) unfinishedToggle.setAttribute('aria-expanded', 'false');
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
      setScoreDisplay(res.player.score || 0);
      setHostPresent(res.hostPresent !== false);
      // Initial mute state from the reconnect ack — covers the case where
      // we (re)load mid-game after the host already muted reactions.
      reactionsMutedByHost = !!res.reactionsMuted;
      updateReactionButtonState();

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
        // the personal stats card. The server includes our personal
        // "puzzles you didn't finish" payload in the same snapshot.
        if (res.youFinal) unfinishedPayload = res.youFinal;
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
    // Host kicked us — show a message instead of a silent redirect so the
    // player understands why they were bounced. Matches Trivia's behavior.
    cancelFinalWait();
    const savedName = localStorage.getItem('twentyfour.playerName') || '';
    if (savedName) localStorage.setItem('twentyfour.rejoinName', savedName);
    localStorage.removeItem('twentyfour.playerId');
    localStorage.removeItem('twentyfour.playerName');
    showView('kicked');
  });
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  if (kickRejoinBtn) {
    kickRejoinBtn.addEventListener('click', function () {
      window.location.replace('/twentyfour/join');
    });
  }
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
    if (me) setScoreDisplay(me.score);
  });
  socket.on('state:final', function (f) {
    showFinalWait(f);
  });
  // Private per-player payload: list of puzzle ids the player didn't
  // finish (skipped + in-flight at buzzer). Arrives alongside state:final;
  // we stash it and re-render the unfinished section if the stats card
  // is already on screen.
  socket.on('you:final', function (p) {
    unfinishedPayload = p || { unfinishedIds: [] };
    // Eagerly prefetch puzzles + solutions data so the reveal feels
    // instant when the player taps it. Failure is non-fatal — render
    // handles the error path.
    loadLookupData().catch(function () {});
    renderUnfinishedSection();
  });

  // Duration of the host's "Time's up! → Now for the results…" splash. Kept
  // in sync with public/twentyfour/js/host.js showFinalIntro() so the phone's
  // "Look up!" card swaps to personal stats just as the host reveals podium.
  const FINAL_WAIT_MS = 3800;
  let finalWaitTimer = null;
  function cancelFinalWait() {
    if (finalWaitTimer) { clearTimeout(finalWaitTimer); finalWaitTimer = null; }
  }

  // ---------------- "Puzzles you didn't finish" section ----------------
  // The server sends a private `you:final` payload listing puzzle ids the
  // player engaged with but didn't solve. We render them as a collapsible
  // list of tap-to-reveal solutions, sourced from the same static data
  // files that Solo Practice uses. Data is fetched lazily and browser-
  // cached after the first round.
  let unfinishedPayload = null;     // { unfinishedIds: number[] }
  let lookupData = null;            // { puzzles, solutions } once loaded
  let lookupPromise = null;         // in-flight fetch promise (dedup)
  let lookupFailed = false;
  // Track which rows the player has already revealed so a re-render
  // (e.g. on visibility change) doesn't collapse them back.
  const revealedIds = new Set();

  function loadLookupData() {
    if (lookupData) return Promise.resolve(lookupData);
    if (lookupPromise) return lookupPromise;
    lookupPromise = Promise.all([
      fetch('/twentyfour/data/puzzles.json').then(function (r) { return r.json(); }),
      fetch('/twentyfour/data/solutions.json').then(function (r) { return r.json(); }),
    ]).then(function (results) {
      lookupData = { puzzles: results[0], solutions: results[1] };
      lookupFailed = false;
      return lookupData;
    }).catch(function (err) {
      lookupPromise = null;
      lookupFailed = true;
      throw err;
    });
    return lookupPromise;
  }

  function renderUnfinishedSection() {
    if (!unfinishedSection) return;
    const ids = (unfinishedPayload && Array.isArray(unfinishedPayload.unfinishedIds))
      ? unfinishedPayload.unfinishedIds
      : [];
    if (ids.length === 0) {
      unfinishedSection.hidden = true;
      return;
    }
    unfinishedSection.hidden = false;
    unfinishedToggleLabel.textContent = 'Puzzles you didn\'t finish (' + ids.length + ')';

    // Build the rows. If lookup data isn't ready yet, render placeholders
    // and re-render once the fetch resolves.
    if (!lookupData) {
      unfinishedList.innerHTML = ids.map(function (id) {
        return '<div class="unfinished-row" data-id="' + id + '">'
             +   '<div class="unfinished-numbers unfinished-numbers-loading">Loading…</div>'
             + '</div>';
      }).join('');
      loadLookupData().then(function () {
        renderUnfinishedSection();
      }).catch(function () {
        unfinishedList.innerHTML =
          '<div class="unfinished-error">Couldn\'t load solutions — try refreshing.</div>';
      });
      return;
    }
    unfinishedList.innerHTML = ids.map(function (id) {
      const nums = (lookupData.puzzles && id < lookupData.puzzles.length)
        ? lookupData.puzzles[id]
        : null;
      const numHtml = nums
        ? nums.map(function (n) { return '<span class="unfinished-chip">' + n + '</span>'; }).join('')
        : '<span class="unfinished-chip unfinished-chip-missing">?</span>';
      const revealed = revealedIds.has(id);
      const solution = (lookupData.solutions && id < lookupData.solutions.length)
        ? lookupData.solutions[id]
        : null;
      const revealHtml = revealed
        ? '<div class="unfinished-solution">' + (solution ? escapeHtml(solution) : 'No clean solution available') + '</div>'
        : '<button type="button" class="unfinished-reveal" data-id="' + id + '">Show solution</button>';
      return '<div class="unfinished-row" data-id="' + id + '">'
           +   '<div class="unfinished-numbers">' + numHtml + '</div>'
           +   revealHtml
           + '</div>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  if (unfinishedToggle && unfinishedList) {
    unfinishedToggle.addEventListener('click', function () {
      const expanded = unfinishedToggle.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      unfinishedToggle.setAttribute('aria-expanded', String(next));
      unfinishedList.hidden = !next;
      if (next) {
        // Make sure rows are populated when first expanded (handles the
        // case where the payload arrived but renderUnfinishedSection
        // hasn't been called with lookupData yet).
        if (!lookupData && !lookupFailed) {
          loadLookupData().then(function () { renderUnfinishedSection(); })
            .catch(function () { renderUnfinishedSection(); });
        }
      }
    });
    unfinishedList.addEventListener('click', function (e) {
      const btn = e.target.closest('.unfinished-reveal');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (!Number.isInteger(id)) return;
      revealedIds.add(id);
      renderUnfinishedSection();
    });
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
    // Pull our own row from the leaderboard so we can show real points,
    // solved, and skipped counts.
    if (f && f.fullLeaderboard) {
      const me = f.fullLeaderboard.find(function (x) { return x.id === playerId; });
      if (me) {
        if (finalPoints) finalPoints.textContent = formatScore(me.score || 0);
        setScoreDisplay(me.score || 0);
        finalSolves.textContent = (typeof me.solvedCount === 'number') ? me.solvedCount : 0;
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
    // Re-render the "puzzles you didn't finish" section. If the
    // `you:final` payload hasn't arrived yet, this is a no-op until the
    // listener fires.
    renderUnfinishedSection();
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---------------- Reactions ----------------
  // Floating emoji bursts sent to the host screen. Mirrors trivia's
  // implementation: 6 emojis, 10s per-player cooldown (persisted to
  // localStorage so a refresh doesn't grant a free reaction), host can
  // globally mute. Gated to lobby + final views via showView() below.
  const REACTION_COOLDOWN_MS_CLIENT = 10 * 1000;
  const REACTION_LS_KEY = 'twentyfour.lastReactionAt';
  const reactionBar = document.getElementById('reactionBar');
  const reactionCooldownEl = document.getElementById('reactionCooldown');
  const reactionBtns = reactionBar
    ? Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn'))
    : [];
  let reactionsAllowed = false;
  let reactionUntilMs = 0;
  let reactionCountdownTimer = null;
  let reactionsMutedByHost = false;

  function setReactionsAllowed(allowed) {
    reactionsAllowed = allowed;
    if (!reactionBar) return;
    reactionBar.hidden = !allowed;
    document.body.classList.toggle('has-reaction-bar', !!allowed);
    updateReactionButtonState();
  }
  function updateReactionButtonState() {
    if (!reactionBar) return;
    const now = Date.now();
    const onCooldown = now < reactionUntilMs;
    const disabled = !reactionsAllowed || onCooldown || reactionsMutedByHost;
    reactionBtns.forEach(function (b) { b.disabled = disabled; });
    if (reactionsMutedByHost && reactionsAllowed) {
      reactionCooldownEl.hidden = false;
      reactionCooldownEl.textContent = 'Reactions paused by host';
    } else if (onCooldown && reactionsAllowed) {
      const sec = Math.ceil((reactionUntilMs - now) / 1000);
      reactionCooldownEl.hidden = false;
      reactionCooldownEl.textContent = sec + 's';
    } else {
      reactionCooldownEl.hidden = true;
    }
  }
  function startReactionCountdown() {
    if (reactionCountdownTimer) clearInterval(reactionCountdownTimer);
    updateReactionButtonState();
    reactionCountdownTimer = setInterval(function () {
      if (Date.now() >= reactionUntilMs) {
        clearInterval(reactionCountdownTimer);
        reactionCountdownTimer = null;
      }
      updateReactionButtonState();
    }, 250);
  }
  (function restoreReactionCooldown() {
    const stored = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
    if (!stored) return;
    const elapsed = Date.now() - stored;
    if (elapsed < REACTION_COOLDOWN_MS_CLIENT) {
      reactionUntilMs = stored + REACTION_COOLDOWN_MS_CLIENT;
    } else {
      localStorage.removeItem(REACTION_LS_KEY);
    }
  })();
  if (Date.now() < reactionUntilMs) {
    startReactionCountdown();
  }
  if (reactionBar) {
    reactionBar.addEventListener('click', function (e) {
      const btn = e.target.closest('.reaction-btn');
      if (!btn || btn.disabled) return;
      const idx = parseInt(btn.dataset.reaction, 10);
      if (isNaN(idx)) return;
      const now = Date.now();
      reactionUntilMs = now + REACTION_COOLDOWN_MS_CLIENT;
      localStorage.setItem(REACTION_LS_KEY, String(now));
      startReactionCountdown();
      socket.emit('player:reaction', { index: idx }, function (res) {
        if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
          const ackNow = Date.now();
          reactionUntilMs = ackNow + res.retryInMs;
          localStorage.setItem(
            REACTION_LS_KEY,
            String(ackNow + res.retryInMs - REACTION_COOLDOWN_MS_CLIENT)
          );
          startReactionCountdown();
        }
      });
    });
  }
  socket.on('state:reactionsMuted', function (p) {
    reactionsMutedByHost = !!(p && p.muted);
    updateReactionButtonState();
  });
})();
