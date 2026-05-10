(function () {
  'use strict';

  const playerId = localStorage.getItem('trivia.playerId');
  if (!playerId) {
    window.location.replace('/trivia/join');
    return;
  }

  const elName = document.getElementById('playerName');
  const elScore = document.getElementById('playerScore');
  const elView = document.getElementById('playerView');

  elName.textContent = localStorage.getItem('trivia.playerName') || '…';

  const socket = io('/trivia', { transports: ['polling', 'websocket'] });

  let currentQuestion = null;
  let answeredQuestionId = null;
  let countdownInterval = null;
  let lastResult = null;

  // ---------------- Rendering ----------------
  function render(html) {
    elView.innerHTML = '<div class="state-card">' + html + '</div>';
  }

  function renderLobbyWaiting() {
    render(
      '<h2>You\'re in!</h2>' +
      '<p>Look up at the big screen. The quiz will start soon.</p>' +
      '<p style="margin-top:14px; color: var(--muted); font-size: 14px;">Keep this tab open.</p>'
    );
  }

  // ---------------- Intro ----------------
  let introTimer = null;
  function stopIntroTimer() {
    if (introTimer) { clearInterval(introTimer); introTimer = null; }
  }
  function renderIntro(payload) {
    stopIntroTimer();
    if (payload && typeof payload.serverNow === 'number') {
      clockOffset = payload.serverNow - Date.now();
    }
    const endsAt = (payload && payload.endsAt) || (Date.now() + 5000);
    elView.innerHTML =
      '<div class="state-card intro-card">' +
        '<div class="intro-hint">Up next…</div>' +
        '<h2 class="intro-title">Get ready</h2>' +
        '<div class="intro-countdown" id="pIntroCountdown">5</div>' +
        '<p>First question coming up.</p>' +
      '</div>';
    const el = document.getElementById('pIntroCountdown');
    function tick() {
      const left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (el) el.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
  }

  // ---------------- Prompt ----------------
  function renderPrompt(p) {
    stopCountdown();
    stopIntroTimer();
    currentQuestion = null;
    answeredQuestionId = null;
    if (p && typeof p.serverNow === 'number') {
      clockOffset = p.serverNow - Date.now();
    }
    const finalBanner = (p && p.isLastQuestion)
      ? '<div class="final-question-banner">🏆 Final Question!</div>'
      : '';
    elView.innerHTML =
      '<div class="state-card prompt-card">' +
        finalBanner +
        '<div class="intro-hint">Question ' + (p.index + 1) + ' of ' + p.total + '</div>' +
        '<h2>Look up!</h2>' +
        '<p>Read the question on the big screen.</p>' +
        '<p style="margin-top:10px; color: var(--muted); font-size: 14px;">Choices appear in a moment…</p>' +
      '</div>';
  }

  const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];
  function shape(i) { return '<span class="choice-letter">' + (CHOICE_LETTERS[i] || '') + '</span>'; }

  let clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }

  function renderQuestion(q) {
    currentQuestion = q;
    answeredQuestionId = null;
    if (typeof q.serverNow === 'number') clockOffset = q.serverNow - Date.now();
    const timeLeft = Math.max(0, Math.ceil((q.endsAt - serverNow()) / 1000));
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="countdown-pill" id="pcountdown">' + timeLeft + 's</div>' +
        '<div class="urgent-bar" id="urgentBar" aria-hidden="true"></div>' +
        '<h2>Make your pick</h2>' +
        '<p style="color: var(--muted);">Question ' + (q.index + 1) + ' of ' + q.total + '</p>' +
        '<div class="tiles" id="pTiles">' +
          [0,1,2,3].map(function (i) {
            return '<button class="tile tile-color-' + i + '" data-choice="' + i + '" aria-label="Choice ' + CHOICE_LETTERS[i] + '">' + shape(i) + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    const tilesEl = document.getElementById('pTiles');
    tilesEl.addEventListener('click', function (e) {
      const btn = e.target.closest('.tile');
      if (!btn) return;
      const choice = parseInt(btn.dataset.choice, 10);
      submitAnswer(choice);
    });

    startCountdown();
  }

  function renderAnswerLocked(choiceIndex) {
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2>Answer locked in!</h2>' +
        '<div style="font-size: 56px; margin: 14px 0; color: white; display:inline-flex; align-items:center; justify-content:center; width:120px; height:120px; border-radius: 20px;" class="tile-color-' + choiceIndex + '">' + shape(choiceIndex) + '</div>' +
        '<p>Waiting for everyone else…</p>' +
      '</div>';
  }

  function renderResult(res) {
    const correct = res.wasCorrect;
    const pts = res.pointsEarned;
    const rank = res.rank;
    const total = res.totalPlayers;
    const klass = correct ? 'result-correct' : 'result-wrong';
    const heading = res.answered
      ? (correct ? 'Correct! 🎉' : 'Not quite…')
      : 'Too slow!';
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2 class="' + klass + '">' + heading + '</h2>' +
        (res.answered
          ? '<div class="result-points ' + klass + '">+' + pts + '</div>'
          : '<p>No answer recorded.</p>') +
        (res.isLastQuestion
          ? '<p class="result-rank">Final results coming up on the big screen…</p>'
          : '<p class="result-rank">You are <strong>#' + rank + '</strong> of ' + total + '</p>') +
      '</div>';
  }

  function renderFinal() {
    render(
      '<h2>Thanks for playing! 🎉</h2>' +
      '<p>Check the big screen for the winners.</p>'
    );
  }

  function renderRejected(reason) {
    setReactionsAllowed(false);
    const msg = {
      'kicked': 'You were removed by the host.',
      'lobby-closed': 'The quiz has already started.',
      'unknown-player': 'Your session was not found. Please rejoin.',
      'reset': 'The host has reset the game.',
    }[reason] || 'Disconnected.';
    const savedName = localStorage.getItem('trivia.playerName') || '';
    if (reason === 'reset' && savedName) {
      localStorage.setItem('trivia.rejoinName', savedName);
    } else {
      localStorage.removeItem('trivia.rejoinName');
    }
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2>' + msg + '</h2>' +
        '<button class="btn-primary" style="margin-top: 16px;" onclick="localStorage.removeItem(\'trivia.playerId\'); localStorage.removeItem(\'trivia.playerName\'); window.location.replace(\'/trivia/join\');">Rejoin</button>' +
      '</div>';
  }

  // ---------------- Countdown ----------------
  let urgentClassAdded = false;
  let haptic5Fired = false;
  let haptic2Fired = false;

  function tryVibrate(pattern) {
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (e) {}
  }

  function startCountdown() {
    stopCountdown();
    urgentClassAdded = false;
    haptic5Fired = false;
    haptic2Fired = false;
    countdownInterval = setInterval(function () {
      if (!currentQuestion) return stopCountdown();
      const el = document.getElementById('pcountdown');
      if (!el) return stopCountdown();
      const left = Math.max(0, Math.ceil((currentQuestion.endsAt - serverNow()) / 1000));
      el.textContent = left + 's';

      const stillAnswering =
        !answeredQuestionId || answeredQuestionId !== currentQuestion.id;

      if (stillAnswering && left <= 5 && left > 0) {
        if (!urgentClassAdded) {
          urgentClassAdded = true;
          document.body.classList.add('urgent');
          el.classList.add('urgent');
          const bar = document.getElementById('urgentBar');
          if (bar) {
            const msLeftPrecise = Math.max(0, currentQuestion.endsAt - serverNow());
            const elapsedInUrgent = 5000 - msLeftPrecise;
            bar.style.animationDelay = '-' + (elapsedInUrgent / 1000).toFixed(2) + 's';
          }
        }
        if (left <= 5 && !haptic5Fired) { haptic5Fired = true; tryVibrate(50); }
        if (left <= 2 && !haptic2Fired) { haptic2Fired = true; tryVibrate([90, 60, 90]); }
      } else if (urgentClassAdded && (!stillAnswering || left <= 0)) {
        urgentClassAdded = false;
        document.body.classList.remove('urgent');
        el.classList.remove('urgent');
      }

      if (left <= 0) stopCountdown();
    }, 250);
  }
  function stopCountdown() {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    document.body.classList.remove('urgent');
    const el = document.getElementById('pcountdown');
    if (el) el.classList.remove('urgent');
  }

  // ---------------- Actions ----------------
  function submitAnswer(choiceIndex) {
    if (!currentQuestion || answeredQuestionId === currentQuestion.id) return;
    answeredQuestionId = currentQuestion.id;
    renderAnswerLocked(choiceIndex);
    socket.emit('player:answer', { questionId: currentQuestion.id, choiceIndex: choiceIndex }, function (res) {
      if (!res || !res.ok) {
        if (res && (res.reason === 'too-late' || res.reason === 'not-accepting-answers')) {
          answeredQuestionId = currentQuestion.id;
          elView.innerHTML =
            '<div class="state-card">' +
              '<h2>Time\'s up!</h2>' +
              '<p>Wait for the next question.</p>' +
            '</div>';
        } else {
          answeredQuestionId = null;
          renderQuestion(currentQuestion);
        }
      }
    });
  }

  let rejected = false;

  // ---------------- Reactions ----------------
  const REACTION_COOLDOWN_MS = 10 * 1000;
  const REACTION_LS_KEY = 'trivia.lastReactionAt';
  const reactionBar = document.getElementById('reactionBar');
  const reactionCooldownEl = document.getElementById('reactionCooldown');
  const reactionBtns = reactionBar
    ? Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn'))
    : [];
  let reactionsAllowed = false;
  let reactionUntilMs = 0;
  let reactionCountdownTimer = null;
  let reactionsMutedByHost = false;
  let hostPresent = true;
  function updateHostPresence(present) {
    const wasPresent = hostPresent;
    hostPresent = !!present;
    const ov = document.getElementById('hostAbsentOverlay');
    if (ov) ov.hidden = hostPresent;
    if (wasPresent && !hostPresent) {
      // Host just left. Stop everything and clear local player state so when
      // the host returns we send the player back to the join page.
      stopCountdown();
      stopIntroTimer && stopIntroTimer();
      localStorage.removeItem('trivia.playerId');
      localStorage.removeItem('trivia.playerName');
    } else if (!wasPresent && hostPresent) {
      // Host returned. Local state was cleared on departure; bounce to the
      // join page so the player can re-enter their name into the fresh game.
      window.location.replace('/trivia/join');
    }
  }

  (function restoreReactionCooldown() {
    const stored = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
    if (!stored) return;
    const elapsed = Date.now() - stored;
    if (elapsed < REACTION_COOLDOWN_MS) {
      reactionUntilMs = stored + REACTION_COOLDOWN_MS;
    } else {
      localStorage.removeItem(REACTION_LS_KEY);
    }
  })();
  if (Date.now() < reactionUntilMs) {
    startReactionCountdown();
  }

  function setReactionsAllowed(allowed) {
    reactionsAllowed = allowed;
    if (!reactionBar) return;
    reactionBar.hidden = !allowed;
    document.body.classList.toggle('has-reaction-bar', !!allowed);
    updateReactionButtonState();
  }
  function updateReactionButtonState() {
    const now = Date.now();
    const onCooldown = now < reactionUntilMs;
    const disabled = !reactionsAllowed || onCooldown || rejected || reactionsMutedByHost;
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
  if (reactionBar) {
    reactionBar.addEventListener('click', function (e) {
      const btn = e.target.closest('.reaction-btn');
      if (!btn || btn.disabled) return;
      const idx = parseInt(btn.dataset.reaction, 10);
      if (isNaN(idx)) return;
      const now = Date.now();
      reactionUntilMs = now + REACTION_COOLDOWN_MS;
      localStorage.setItem(REACTION_LS_KEY, String(now));
      startReactionCountdown();
      socket.emit('player:reaction', { index: idx }, function (res) {
        if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
          const ackNow = Date.now();
          reactionUntilMs = ackNow + res.retryInMs;
          localStorage.setItem(
            REACTION_LS_KEY,
            String(ackNow + res.retryInMs - REACTION_COOLDOWN_MS)
          );
          startReactionCountdown();
        }
      });
    });
  }

  // ---------------- Socket wiring ----------------
  socket.on('connect', function () {
    if (rejected) return;
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (rejected) return;
      if (!res || !res.ok) {
        localStorage.removeItem('trivia.playerId');
        localStorage.removeItem('trivia.playerName');
        window.location.replace('/trivia/join');
        return;
      }
      elName.textContent = res.player.name;
      elScore.textContent = res.player.score || 0;
      reactionsMutedByHost = !!res.reactionsMuted;
      updateHostPresence(res.hostPresent !== false);
      updateReactionButtonState();
      if (res.phase === 'LOBBY') { setReactionsAllowed(true); renderLobbyWaiting(); }
      else if (res.phase === 'INTRO') { setReactionsAllowed(false); renderIntro(res.intro); }
      else if (res.phase === 'PROMPT') { setReactionsAllowed(false); renderPrompt(res.prompt); }
      else if (res.phase === 'QUESTION' && res.question) {
        setReactionsAllowed(false);
        if (typeof res.myChoiceIndex === 'number') {
          currentQuestion = res.question;
          answeredQuestionId = res.question.id;
          if (typeof res.question.serverNow === 'number') {
            clockOffset = res.question.serverNow - Date.now();
          }
          renderAnswerLocked(res.myChoiceIndex);
        } else {
          renderQuestion(res.question);
        }
      }
      else if (res.phase === 'REVEAL') {
        setReactionsAllowed(true);
        if (res.myResult) renderResult(res.myResult);
        else render('<h2>Hold tight…</h2><p>Next question coming up.</p>');
      }
      else if (res.phase === 'FINAL') { setReactionsAllowed(true); renderFinal(); }
    });
  });

  socket.on('state:lobby', function (s) {
    if (rejected) return;
    if (s && s.phase === 'LOBBY') {
      setReactionsAllowed(true);
      if (!currentQuestion || answeredQuestionId === (currentQuestion && currentQuestion.id)) {
        renderLobbyWaiting();
      }
    }
  });

  socket.on('state:reactionsMuted', function (p) {
    reactionsMutedByHost = !!(p && p.muted);
    updateReactionButtonState();
  });

  socket.on('state:hostPresence', function (p) {
    updateHostPresence(!(p && p.present === false));
  });

  socket.on('state:question', function (q) {
    if (rejected) return;
    setReactionsAllowed(false);
    renderQuestion(q);
  });

  socket.on('state:intro', function (payload) {
    if (rejected) return;
    setReactionsAllowed(false);
    renderIntro(payload);
  });

  socket.on('state:prompt', function (p) {
    if (rejected) return;
    setReactionsAllowed(false);
    renderPrompt(p);
  });

  var REVEAL_HOLD_MS = 3200;
  var pendingResult = null;
  var holdRevealUntil = 0;

  function applyReveal() {
    if (rejected) return;
    setReactionsAllowed(true);
    if (!lastResult || (currentQuestion && lastResult.questionId !== currentQuestion.id)) {
      render('<h2>Hold tight…</h2><p>Results on the big screen.</p>');
    }
    if (pendingResult) {
      var res = pendingResult;
      pendingResult = null;
      lastResult = res;
      elScore.textContent = res.totalScore;
      renderResult(res);
    }
  }

  socket.on('state:reveal', function (r) {
    if (rejected) return;
    stopCountdown();
    var pill = document.getElementById('pcountdown');
    if (pill) {
      pill.textContent = '0s';
      pill.classList.add('urgent');
    }
    document.body.classList.remove('urgent');
    var reason = r && r.endReason;
    var didNotAnswer =
      reason === 'timeout' &&
      currentQuestion &&
      answeredQuestionId !== currentQuestion.id;
    if (didNotAnswer) {
      holdRevealUntil = 0;
      setTimeout(applyReveal, 600);
    } else if (reason === 'timeout' || reason === 'all-answered') {
      holdRevealUntil = Date.now() + REVEAL_HOLD_MS;
      setTimeout(applyReveal, REVEAL_HOLD_MS);
    } else {
      holdRevealUntil = 0;
      setTimeout(applyReveal, 400);
    }
  });

  socket.on('player:result', function (res) {
    if (rejected) return;
    var wait = holdRevealUntil - Date.now();
    if (wait > 0) {
      pendingResult = res;
      return;
    }
    lastResult = res;
    elScore.textContent = res.totalScore;
    renderResult(res);
  });

  socket.on('state:final', function () {
    if (rejected) return;
    setReactionsAllowed(true);
    stopCountdown();
    renderFinal();
  });

  socket.on('state:reset', function () {
    rejected = true;
    stopCountdown();
    stopIntroTimer();
    localStorage.removeItem('trivia.playerId');
    renderRejected('reset');
  });

  socket.on('player:rejected', function (payload) {
    rejected = true;
    stopCountdown();
    localStorage.removeItem('trivia.playerId');
    localStorage.removeItem('trivia.playerName');
    renderRejected(payload && payload.reason);
  });

  socket.on('disconnect', function () {
    if (rejected) return;
    render('<h2>Reconnecting…</h2><p>Don\'t refresh.</p>');
  });
})();
