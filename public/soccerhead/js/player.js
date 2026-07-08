(function () {
  'use strict';

  const playerId = localStorage.getItem('soccerhead.playerId');
  const playerName = localStorage.getItem('soccerhead.playerName') || 'Player';
  if (!playerId) { window.location.replace('/soccerhead/join'); return; }

  // Must match the host's dash cooldown so the on-screen ring is honest.
  const DASH_COOLDOWN_MS = 2200;
  const DASH_TAP_MS = 350;
  // Input codes shared with the server relay + host engine.
  const LEFT = 0, RIGHT = 1, JUMP = 2, KICK = 3;

  const socket = io('/soccerhead', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const body = document.body;
  const views = {
    lobby: document.getElementById('view-lobby'),
    controller: document.getElementById('view-controller'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const lobbyTeamBadge = document.getElementById('lobbyTeamBadge');
  const lobbyName = document.getElementById('lobbyName');
  const scoreRed = document.getElementById('scoreRed');
  const scoreBlue = document.getElementById('scoreBlue');
  const hudClock = document.getElementById('hudClock');
  const hudYou = document.getElementById('hudYou');
  const ctrlOverlay = document.getElementById('ctrlOverlay');
  const coCount = document.getElementById('coCount');
  const coText = document.getElementById('coText');
  const flash = document.getElementById('flash');
  const flashText = document.getElementById('flashText');
  const rotateHint = document.getElementById('rotateHint');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalScore = document.getElementById('finalScore');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const pad = document.getElementById('pad');
  const dashLeft = document.getElementById('dashLeft');
  const dashRight = document.getElementById('dashRight');

  const btns = {
    0: document.getElementById('btnLeft'),
    1: document.getElementById('btnRight'),
    2: document.getElementById('btnJump'),
    3: document.getElementById('btnKick'),
  };

  // ---------------- State ----------------
  let myTeam = 'red';
  let currentPhase = 'LOBBY';
  let controlsEnabled = false;
  let lastTap = { 0: 0, 1: 0 };
  let dashCooldownUntil = 0;
  let dashRingTimer = null;
  const activePointers = new Map(); // pointerId -> code

  function showView(name) {
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].style.display = (k === name) ? '' : 'none';
    });
    body.classList.toggle('playing', name === 'controller');
    updateRotateHint();
  }

  function setTeam(team) {
    myTeam = team === 'blue' ? 'blue' : 'red';
    body.setAttribute('data-team', myTeam);
    if (lobbyTeamBadge) lobbyTeamBadge.textContent = myTeam.toUpperCase();
    if (hudYou) hudYou.innerHTML = 'You\'re on <b>' + (myTeam === 'blue' ? 'Blue' : 'Red') + '</b>';
  }
  setTeam(myTeam);
  if (lobbyName) lobbyName.textContent = playerName;

  // ---------------- Host presence ----------------
  function setHostPresent(present) {
    if (hostAbsentOverlay) hostAbsentOverlay.hidden = !!present;
  }
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });

  // ---------------- Boot / reconnect ----------------
  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        localStorage.setItem('soccerhead.rejoinName', playerName);
        localStorage.removeItem('soccerhead.playerId');
        window.location.replace('/soccerhead/join');
        return;
      }
      setHostPresent(res.hostPresent !== false);
      if (res.player && res.player.team) setTeam(res.player.team);
      applyPhase(res);
    });
  });

  function applyPhase(res) {
    currentPhase = res.phase;
    if (res.phase === 'LOBBY') {
      applyLobby(res.lobby);
      showView('lobby');
    } else if (res.phase === 'PLAYING') {
      resumeMatch(res.match);
    } else if (res.phase === 'FINAL') {
      if (res.match) { setScores(res.match.redScore, res.match.blueScore); }
      renderFinal(res.match || {});
    }
  }

  function applyLobby(lobby) {
    if (!lobby) return;
    // Keep my team badge in sync if the host reassigned me in the lobby.
    const all = [].concat(
      (lobby.teams && lobby.teams.red || []).map(function (p) { return { id: p.id, team: 'red' }; }),
      (lobby.teams && lobby.teams.blue || []).map(function (p) { return { id: p.id, team: 'blue' }; })
    );
    const me = all.find(function (p) { return p.id === playerId; });
    if (me) setTeam(me.team);
  }
  socket.on('state:lobby', function (lobby) {
    if (currentPhase === 'LOBBY' || (lobby && lobby.phase === 'LOBBY')) {
      currentPhase = 'LOBBY';
      applyLobby(lobby);
      showView('lobby');
    }
  });
  socket.on('state:reset', function () {
    // Host reset — our session is gone; bounce back to join.
    localStorage.setItem('soccerhead.rejoinName', playerName);
    localStorage.removeItem('soccerhead.playerId');
    window.location.replace('/soccerhead/join');
  });
  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') {
      localStorage.removeItem('soccerhead.playerId');
      releaseAll();
      showView('kicked');
    }
  });

  // ---------------- Match events ----------------
  socket.on('m:start', function (d) {
    currentPhase = 'PLAYING';
    if (d && d.roster) {
      const mine = d.roster.find(function (r) { return r.id === playerId; });
      if (mine) setTeam(mine.team);
    }
    setScores(0, 0);
    setClock((d && d.durationSec ? d.durationSec : 90) * 1000, false);
    showView('controller');
    setControls(false);
    showOverlay(null, 'Get ready…');
  });
  socket.on('m:countdown', function (d) {
    if (currentPhase !== 'PLAYING') { currentPhase = 'PLAYING'; showView('controller'); }
    setControls(false);
    showOverlay(d && d.n != null ? String(d.n) : '', 'Get ready…');
  });
  socket.on('m:play', function () {
    currentPhase = 'PLAYING';
    hideOverlay();
    setControls(true);
  });
  socket.on('m:clock', function (d) { setClock(d && d.ms, !!(d && d.sudden)); });
  socket.on('m:goal', function (d) {
    setControls(false);
    if (d) setScores(d.red, d.blue);
    const team = d && d.team;
    showFlash((team === 'blue' ? 'BLUE' : 'RED') + ' SCORES!', team === myTeam);
  });
  socket.on('m:sudden', function () {
    setClock(0, true);
    showFlash('SUDDEN DEATH', false);
  });
  socket.on('m:end', function (d) {
    currentPhase = 'FINAL';
    setControls(false);
    renderFinal(d || {});
  });

  function resumeMatch(match) {
    currentPhase = 'PLAYING';
    showView('controller');
    if (match) {
      setScores(match.redScore, match.blueScore);
      setClock(match.clockMs, !!match.sudden);
    }
    if (match && match.live) { hideOverlay(); setControls(true); }
    else { setControls(false); showOverlay(null, 'Get ready…'); }
  }

  // ---------------- HUD ----------------
  function setScores(r, b) {
    if (typeof r === 'number') scoreRed.textContent = r;
    if (typeof b === 'number') scoreBlue.textContent = b;
  }
  function setClock(ms, sudden) {
    if (typeof ms === 'number') {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      hudClock.textContent = sudden ? 'SD' : (m + ':' + (s < 10 ? '0' : '') + s);
      hudClock.classList.toggle('urgent', !sudden && total <= 10);
    }
    hudClock.classList.toggle('sudden', !!sudden);
    if (sudden) hudClock.textContent = 'SD';
  }

  function showOverlay(count, text) {
    if (!ctrlOverlay) return;
    ctrlOverlay.hidden = false;
    if (count && count.length) {
      coCount.style.display = '';
      coCount.textContent = count;
      // Re-trigger the pop animation.
      coCount.style.animation = 'none';
      void coCount.offsetWidth;
      coCount.style.animation = '';
    } else {
      coCount.style.display = 'none';
    }
    coText.textContent = text || '';
  }
  function hideOverlay() { if (ctrlOverlay) ctrlOverlay.hidden = true; }

  let flashTimer = null;
  function showFlash(text, good) {
    if (!flash) return;
    flashText.textContent = text;
    flashText.style.color = good ? 'var(--good)' : 'var(--accent)';
    flash.hidden = false;
    flashText.style.animation = 'none';
    void flashText.offsetWidth;
    flashText.style.animation = '';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flash.hidden = true; }, 1600);
  }

  function renderFinal(d) {
    const r = d.red != null ? d.red : Number(scoreRed.textContent);
    const b = d.blue != null ? d.blue : Number(scoreBlue.textContent);
    finalScore.textContent = 'Red ' + r + ' – ' + b + ' Blue';
    const winner = d.winner;
    if (!winner) {
      finalEmoji.textContent = '🤝';
      finalTitle.textContent = 'Draw!';
    } else if (winner === myTeam) {
      finalEmoji.textContent = '🏆';
      finalTitle.textContent = 'You win!';
    } else {
      finalEmoji.textContent = '😤';
      finalTitle.textContent = 'You lost';
    }
    showView('final');
  }

  // ---------------- Controls (input) ----------------
  function send(code, down) { socket.emit('in', { c: code, d: down ? 1 : 0 }); }

  function press(code, btn) {
    btn.classList.add('pressed');
    // Always give visual feedback, but only transmit input once play is live.
    // Buttons held during the countdown are flushed the moment controls enable.
    if (!controlsEnabled) return;
    send(code, true);
    if (code === LEFT || code === RIGHT) maybeDash(code, btn);
  }
  function releaseCode(code, btn) {
    btn.classList.remove('pressed');
    send(code, false);
  }
  function releaseAll() {
    activePointers.forEach(function (code) {
      const btn = btns[code];
      if (btn) btn.classList.remove('pressed');
      send(code, false);
    });
    activePointers.clear();
  }
  function setControls(enabled) {
    if (!enabled && controlsEnabled) releaseAll();
    const wasEnabled = controlsEnabled;
    controlsEnabled = enabled;
    // Play just started: instantly send any direction the player is already
    // holding so there is zero delay off the countdown.
    if (enabled && !wasEnabled) {
      activePointers.forEach(function (code) { send(code, true); });
    }
    if (pad) pad.style.opacity = enabled ? '1' : '0.55';
  }

  Object.keys(btns).forEach(function (k) {
    const code = Number(k);
    const btn = btns[code];
    if (!btn) return;
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      // Track presses even during the countdown (controls not yet enabled) so a
      // held left/right is ready to fire the instant play begins.
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      activePointers.set(e.pointerId, code);
      press(code, btn);
    });
    function up(e) {
      if (!activePointers.has(e.pointerId)) return;
      const c = activePointers.get(e.pointerId);
      activePointers.delete(e.pointerId);
      releaseCode(c, btns[c]);
    }
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
  });

  // Dash: a fast double-tap of the same movement button.
  function maybeDash(code, btn) {
    const now = Date.now();
    const dir = code === LEFT ? -1 : 1;
    if (now - lastTap[code] <= DASH_TAP_MS) {
      lastTap[code] = 0;
      doDash(dir, btn);
    } else {
      lastTap[code] = now;
    }
  }
  function doDash(dir, btn) {
    const now = Date.now();
    if (now < dashCooldownUntil) return;
    socket.emit('dash', { dir: dir });
    dashCooldownUntil = now + DASH_COOLDOWN_MS;
    if (btn) { btn.classList.remove('dashed'); void btn.offsetWidth; btn.classList.add('dashed'); }
    startDashRing();
  }
  function startDashRing() {
    dashLeft.classList.add('charging');
    dashRight.classList.add('charging');
    if (dashRingTimer) clearInterval(dashRingTimer);
    dashRingTimer = setInterval(function () {
      const remain = dashCooldownUntil - Date.now();
      if (remain <= 0) {
        clearInterval(dashRingTimer); dashRingTimer = null;
        dashLeft.classList.remove('charging');
        dashRight.classList.remove('charging');
        return;
      }
      const deg = (remain / DASH_COOLDOWN_MS) * 360;
      dashLeft.style.setProperty('--pct', deg + 'deg');
      dashRight.style.setProperty('--pct', deg + 'deg');
    }, 60);
  }

  // Release everything if the tab is hidden (finger-lift never arrives).
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseAll();
  });
  window.addEventListener('blur', releaseAll);

  // ---------------- Lock zoom ----------------
  // iOS Safari ignores `user-scalable=no`, so pinch- and double-tap-zoom still
  // work and would drift the controller off-screen. Suppress them explicitly so
  // the gamepad stays rock-steady while players hammer the buttons.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (evt) {
    document.addEventListener(evt, function (e) { e.preventDefault(); }, { passive: false });
  });
  let lastTouchEnd = 0;
  document.addEventListener('touchend', function (e) {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault(); // double-tap zoom
    lastTouchEnd = now;
  }, { passive: false });
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault(); // pinch zoom
  }, { passive: false });

  // ---------------- Rotate hint ----------------
  const portraitMq = window.matchMedia('(orientation: portrait)');
  function updateRotateHint() {
    const inController = body.classList.contains('playing');
    if (rotateHint) rotateHint.hidden = !(inController && portraitMq.matches);
  }
  if (portraitMq.addEventListener) portraitMq.addEventListener('change', updateRotateHint);
  else if (portraitMq.addListener) portraitMq.addListener(updateRotateHint);
  window.addEventListener('resize', updateRotateHint);

  // ---------------- Kicked → rejoin ----------------
  if (kickRejoinBtn) {
    kickRejoinBtn.addEventListener('click', function () {
      localStorage.setItem('soccerhead.rejoinName', playerName);
      window.location.replace('/soccerhead/join');
    });
  }
})();
