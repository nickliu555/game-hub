/* ===== Herd Mind · Player ===== */
(function () {
  'use strict';

  var playerId = localStorage.getItem('herdmind.playerId');
  if (!playerId) { window.location.replace('/herdmind/join'); return; }

  var socket = io('/herdmind', { transports: ['polling', 'websocket'] });
  var rejected = false;

  var elName = document.getElementById('playerName');
  var elScore = document.getElementById('playerScore');
  var elView = document.getElementById('playerView');
  var reactionBar = document.getElementById('reactionBar');
  var attribution = document.getElementById('playerAttribution');

  var clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(p) { if (p && typeof p.serverNow === 'number') clockOffset = p.serverNow - Date.now(); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function render(html) { elView.innerHTML = '<div class="state-card">' + html + '</div>'; }
  function tryVibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }

  var currentQuestion = null;
  var answeredThisRound = false;
  var lobbyTotal = 0;
  var hasCow = false;
  var hostPresent = true;

  function setScore(v) { if (typeof v === 'number') elScore.textContent = v; }
  function setName(name) {
    elName.innerHTML = escapeHtml(name) + (hasCow ? ' <span class="cow-badge" title="You hold the Pink Cow">🐄</span>' : '');
  }
  function setCow(v) { hasCow = !!v; setName(cachedName); }
  var cachedName = '—';

  function setAttribution(v) { if (attribution) attribution.hidden = !v; }

  // ---- Reactions gating ----
  var reactionsAllowed = false;
  var reactionsMutedByHost = false;
  function setReactionsAllowed(v) { reactionsAllowed = !!v; updateReactionState(); }
  function updateReactionState() {
    var on = reactionsAllowed && !reactionsMutedByHost && hostPresent;
    reactionBar.hidden = !on;
  }

  // ---- Views ----
  function renderLobby() {
    setReactionsAllowed(true);
    var label = lobbyTotal === 1 ? 'player' : 'players';
    var countLine = lobbyTotal > 0
      ? '<div class="lobby-player-count"><span class="pulse-dot"></span><span><strong>' + lobbyTotal + '</strong> ' + label + ' in the lobby</span></div>'
      : '';
    render(
      '<div class="lobby-hero" aria-hidden="true"><span>🐄</span></div>' +
      '<h2>You\'re in!</h2>' +
      '<p>Look up at the big screen. The game will start soon.</p>' + countLine
    );
    setAttribution(true);
  }

  var introTimer = null;
  function stopIntroTimer() { if (introTimer) { clearInterval(introTimer); introTimer = null; } }
  function renderIntro(p) {
    setReactionsAllowed(false);
    setAttribution(false);
    stopIntroTimer();
    syncClock(p);
    var endsAt = (p && p.endsAt) || (serverNow() + 4000);
    elView.innerHTML =
      '<div class="state-card intro-card">' +
        '<div class="intro-hint">Get ready…</div>' +
        '<h2 class="intro-title">Herd up!</h2>' +
        '<div class="intro-countdown" id="pIntro">5</div>' +
        '<p>First question coming up.</p>' +
      '</div>';
    var el = document.getElementById('pIntro');
    function tick() {
      var left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (el) el.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
  }

  function renderQuestion(q) {
    currentQuestion = q;
    answeredThisRound = false;
    setReactionsAllowed(false);
    setAttribution(false);
    stopIntroTimer();
    syncClock(q);
    var timeLeft = Math.max(0, Math.ceil((q.endsAt - serverNow()) / 1000));
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="countdown-pill" id="pcount">' + timeLeft + 's</div>' +
        '<div class="urgent-bar" id="urgentBar" aria-hidden="true"></div>' +
        '<h2>' + escapeHtml(q.text) + '</h2>' +
        '<form class="answer-form" id="answerForm" autocomplete="off">' +
          '<input class="answer-input" id="answerInput" type="text" maxlength="40" ' +
            'autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="send" ' +
            'placeholder="Type your answer" />' +
          '<button type="submit" class="btn-accent">Lock it in</button>' +
          '<p class="answer-hint">Match the most popular answer to score!</p>' +
        '</form>' +
      '</div>';
    var form = document.getElementById('answerForm');
    var input = document.getElementById('answerInput');
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submitAnswer(input.value);
    });
    startCountdown();
  }

  function renderLocked(answer) {
    stopCountdown();
    document.body.classList.remove('urgent');
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2>Answer locked in!</h2>' +
        '<div class="locked-answer">' + escapeHtml(answer) + '</div>' +
        '<p>Waiting for everyone else…</p>' +
      '</div>';
  }

  function submitAnswer(text) {
    if (!currentQuestion || answeredThisRound) return;
    var clean = String(text || '').trim();
    if (!clean) {
      var input = document.getElementById('answerInput');
      if (input) { input.focus(); }
      var hint = document.querySelector('.answer-hint');
      if (hint) { hint.textContent = 'Type something first!'; hint.style.color = 'var(--warn)'; }
      return;
    }
    answeredThisRound = true;
    renderLocked(clean.slice(0, 40));
    socket.emit('player:answer', { questionId: currentQuestion.id, answer: clean }, function (res) {
      if (!res || !res.ok) {
        if (res && (res.reason === 'too-late' || res.reason === 'not-accepting-answers')) {
          elView.innerHTML = '<div class="state-card"><h2>Time\'s up!</h2><p>Wait for the reveal.</p></div>';
        } else if (res && res.reason === 'already-answered') {
          /* keep locked view */
        } else {
          answeredThisRound = false;
          if (currentQuestion) renderQuestion(currentQuestion);
        }
      }
    });
  }

  function renderReviewing() {
    stopCountdown();
    document.body.classList.remove('urgent');
    setReactionsAllowed(false);
    render('<div class="reviewing-spinner"></div><h2>Answers are in!</h2><p>The host is reviewing everyone\'s answers…</p>');
  }

  function renderResult(res) {
    stopCountdown();
    document.body.classList.remove('urgent');
    setReactionsAllowed(true);
    setScore(res.totalScore);
    setCow(res.hasCow);

    var main = '';
    if (res.gotCow) {
      main =
        '<div class="result-cow-emoji">🐄</div>' +
        '<h2 class="result-cow">You\'ve got the Pink Cow</h2>' +
        '<p>You can\'t win while you hold it.</p>';
    } else if (res.matchedHerd) {
      main =
        '<h2 class="result-herd">You matched the herd! 🎉</h2>' +
        '<div class="result-points result-herd">+' + res.pointsEarned + '</div>';
    } else {
      var miss = res.hadMajority
        ? 'You didn\'t match the biggest herd this round.'
        : 'No clear majority this round — nobody scored.';
      main = '<h2 class="result-miss">No point this round</h2><p>' + miss + '</p>';
    }
    if (res.hasCow && !res.gotCow) {
      main += '<p class="result-cow">🐄 You\'re still holding the Pink Cow.</p>';
    }

    var foot = '';
    if (!res.answered) {
      foot += '<p class="result-you-answered">You didn\'t submit an answer.</p>';
    } else if (res.answer) {
      foot += '<p class="result-you-answered">You said: "' + escapeHtml(res.answer) + '"</p>';
    }
    if (res.gameOver) {
      foot += res.isWinner
        ? '<p class="result-rank"><strong>🏆 You win!</strong> Check the big screen.</p>'
        : '<p class="result-rank">Game over — check the big screen for the winner!</p>';
    } else {
      foot += res.tied
        ? '<p class="result-rank">You\'re tied at <strong>#' + res.rank + '</strong></p>'
        : '<p class="result-rank">You\'re <strong>#' + res.rank + '</strong></p>';
    }

    render('<div class="result-main">' + main + '</div><div class="result-foot">' + foot + '</div>');
  }

  function renderFinal() {
    stopCountdown();
    setReactionsAllowed(true);
    render('<h2>Thanks for playing! 🐄</h2><p>Check the big screen for the final results.</p>');
    setAttribution(true);
  }

  // ---- Countdown ----
  var countdownRaf = null, haptic5 = false, haptic2 = false, urgentAdded = false;
  function stopCountdown() { if (countdownRaf) { cancelAnimationFrame(countdownRaf); countdownRaf = null; } }
  function startCountdown() {
    stopCountdown();
    haptic5 = false; haptic2 = false; urgentAdded = false;
    var lastLeft = -1;
    function tick() {
      if (!currentQuestion) return stopCountdown();
      var el = document.getElementById('pcount');
      if (!el) return stopCountdown();
      var msLeft = Math.max(0, currentQuestion.endsAt - serverNow());
      var left = Math.ceil(msLeft / 1000);
      var stillAnswering = !answeredThisRound;
      if (left !== lastLeft) {
        lastLeft = left;
        el.textContent = left + 's';
        if (stillAnswering && left <= 5 && left > 0) {
          if (!urgentAdded) {
            urgentAdded = true;
            document.body.classList.add('urgent');
            el.classList.add('urgent');
            var bar = document.getElementById('urgentBar');
            if (bar) bar.style.animationDelay = '-' + ((5000 - msLeft) / 1000).toFixed(2) + 's';
          }
          if (!haptic5) { haptic5 = true; tryVibrate(50); }
          if (left <= 2 && !haptic2) { haptic2 = true; tryVibrate([90, 60, 90]); }
        }
      }
      if (msLeft <= 0) { stopCountdown(); return; }
      countdownRaf = requestAnimationFrame(tick);
    }
    countdownRaf = requestAnimationFrame(tick);
  }

  // ---- Host presence ----
  function updateHostPresence(present) {
    var was = hostPresent;
    hostPresent = !!present;
    var ov = document.getElementById('hostAbsentOverlay');
    if (ov) ov.hidden = hostPresent;
    updateReactionState();
    if (was && !hostPresent) {
      stopCountdown(); stopIntroTimer();
      localStorage.removeItem('herdmind.playerId');
      localStorage.removeItem('herdmind.playerName');
    } else if (!was && hostPresent) {
      window.location.replace('/herdmind/join');
    }
  }
  socket.on('state:hostPresence', function (p) { updateHostPresence(!(p && p.present === false)); });

  // ---- Socket ----
  socket.on('connect', function () {
    if (rejected) return;
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (rejected) return;
      if (!res || !res.ok) {
        localStorage.removeItem('herdmind.playerId');
        localStorage.removeItem('herdmind.playerName');
        window.location.replace('/herdmind/join');
        return;
      }
      cachedName = res.player.name;
      hasCow = !!res.hasCow;
      setName(cachedName);
      setScore(res.player.score || 0);
      reactionsMutedByHost = !!res.reactionsMuted;
      hostPresent = res.hostPresent !== false;
      var ov = document.getElementById('hostAbsentOverlay');
      if (ov) ov.hidden = hostPresent;

      if (res.phase === 'LOBBY') { lobbyTotal = res.total || 0; renderLobby(); }
      else if (res.phase === 'INTRO') renderIntro(res.intro);
      else if (res.phase === 'QUESTION' && res.question) {
        if (res.myAnswer) { currentQuestion = res.question; answeredThisRound = true; renderLocked(res.myAnswer); }
        else renderQuestion(res.question);
      }
      else if (res.phase === 'REVIEW') renderReviewing();
      else if (res.phase === 'REVEAL') { if (res.myResult) renderResult(res.myResult); else render('<h2>Hold tight…</h2><p>Results are on the big screen.</p>'); }
      else if (res.phase === 'FINAL') renderFinal();
      updateReactionState();
    });
  });

  socket.on('state:lobby', function (s) {
    if (typeof s.total === 'number') lobbyTotal = s.total;
    // Only re-render the lobby card if we're already showing lobby (avoid clobbering other views).
    if (elView.querySelector('.lobby-hero')) renderLobby();
  });
  socket.on('state:intro', renderIntro);
  socket.on('state:question', renderQuestion);
  socket.on('state:reviewing', renderReviewing);
  socket.on('state:reveal', function () { /* per-player result arrives via player:result */ });
  socket.on('player:result', renderResult);
  socket.on('state:final', renderFinal);
  socket.on('state:reset', function () {
    var name = localStorage.getItem('herdmind.playerName') || '';
    if (name) localStorage.setItem('herdmind.rejoinName', name);
    localStorage.removeItem('herdmind.playerId');
    localStorage.removeItem('herdmind.playerName');
    window.location.replace('/herdmind/join');
  });

  socket.on('player:rejected', function (payload) {
    rejected = true;
    stopCountdown();
    setReactionsAllowed(false);
    var reason = payload && payload.reason;
    var savedName = localStorage.getItem('herdmind.playerName') || '';
    if (reason === 'kicked' || reason === 'reset') {
      if (savedName) localStorage.setItem('herdmind.rejoinName', savedName);
    }
    localStorage.removeItem('herdmind.playerId');
    localStorage.removeItem('herdmind.playerName');
    var msg = {
      'kicked': 'You were removed by the host.',
      'reset': 'The host has reset the game.',
    }[reason] || 'Disconnected.';
    reactionBar.hidden = true;
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2>' + msg + '</h2>' +
        '<button class="btn-accent" onclick="window.location.replace(\'/herdmind/join\')">Rejoin</button>' +
      '</div>';
  });

  socket.on('state:reactionsMuted', function (p) { reactionsMutedByHost = !!(p && p.muted); updateReactionState(); });

  // ---- Reaction bar ----
  var REACTION_COOLDOWN_MS = 10 * 1000;
  var REACTION_LS_KEY = 'herdmind.lastReactionAt';
  var reactionCooldown = document.getElementById('reactionCooldown');
  var reactionUntil = 0, cooldownRaf = null;
  var reactionBtns = Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn'));

  var storedLast = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
  if (storedLast && Date.now() - storedLast < REACTION_COOLDOWN_MS) {
    reactionUntil = storedLast + REACTION_COOLDOWN_MS;
    startCooldown();
  }
  function startCooldown() {
    if (cooldownRaf) cancelAnimationFrame(cooldownRaf);
    function tick() {
      var left = reactionUntil - Date.now();
      if (left <= 0) {
        reactionBtns.forEach(function (b) { b.disabled = false; });
        reactionCooldown.hidden = true;
        cooldownRaf = null;
        return;
      }
      reactionBtns.forEach(function (b) { b.disabled = true; });
      reactionCooldown.hidden = false;
      reactionCooldown.textContent = Math.ceil(left / 1000) + 's';
      cooldownRaf = requestAnimationFrame(tick);
    }
    tick();
  }
  reactionBar.addEventListener('click', function (e) {
    var btn = e.target.closest('.reaction-btn');
    if (!btn || btn.disabled) return;
    var idx = parseInt(btn.dataset.reaction, 10);
    if (isNaN(idx)) return;
    var now = Date.now();
    reactionUntil = now + REACTION_COOLDOWN_MS;
    localStorage.setItem(REACTION_LS_KEY, String(now));
    startCooldown();
    socket.emit('player:reaction', { index: idx }, function (res) {
      if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
        reactionUntil = Date.now() + res.retryInMs;
        localStorage.setItem(REACTION_LS_KEY, String(Date.now() + res.retryInMs - REACTION_COOLDOWN_MS));
        startCooldown();
      }
    });
  });
})();
