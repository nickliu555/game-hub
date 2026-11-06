(function () {
  'use strict';

  // ============================================================
  // Ragdoll Rumble — phone controller.
  //
  // The phone is a dumb input device: it streams the thumbstick vector plus
  // the JUMP / ACTION buttons (`in`) to the host, and mirrors whatever match
  // state the host broadcasts. All simulation lives on the host.
  // ============================================================

  const PID = localStorage.getItem('ragdollrumble.playerId');
  if (!PID) { window.location.replace('/ragdollrumble/join'); return; }

  // ---------------- Kill all zoom / scroll / selection behaviour ----------------
  // This is a fixed fullscreen gamepad — it must NEVER zoom, pan or select. iOS
  // Safari ignores maximum-scale/user-scalable, and driving the stick and a
  // button together is a two-finger gesture the browser reads as a pinch, so
  // block it explicitly: pinch (iOS gesture events + every touch move),
  // double-tap-to-zoom, and the long-press callout.
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      // Swallow every move, not just multi-touch: once iOS has started a pinch
      // the follow-up events are no longer cancelable, so the first one has to
      // die too. The final/knocked-out card is the one region allowed to scroll.
      if (!e.cancelable) return;
      if (e.target && e.target.closest && e.target.closest('.out-inner')) return;
      e.preventDefault();
    }, { passive: false });
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
    document.addEventListener('contextmenu', stop, { passive: false });
    document.addEventListener('selectstart', stop, { passive: false });
    document.addEventListener('dragstart', stop, { passive: false });
    // iOS still scrolls the document behind a fixed body on some versions.
    window.addEventListener('scroll', function () { window.scrollTo(0, 0); }, { passive: true });
  }());

  const FALLBACK_COLORS = ['#FF4D4D', '#3DA5FF', '#3DDC84', '#FFD23F', '#B266FF', '#FF8A3D', '#2EE6D6', '#FF6FB5'];
  const ITEM_ICONS = { bat: '🏏', bomb: '💣', rock: '🪨' };
  const CHARGE_START_MS = 220;
  const CHARGE_FULL_MS = 1000;

  // ---------- DOM ----------
  const el = function (id) { return document.getElementById(id); };
  const nameEl = el('pName');
  const scoreEl = el('pScore');
  const waitTitle = el('waitTitle');
  const waitSub = el('waitSub');
  const stickZone = el('stickZone');
  const stickBase = el('stickBase');
  const stickKnob = el('stickKnob');
  const actBtn = el('actBtn');
  const jumpBtn = el('jumpBtn');
  const actIcon = el('actIcon');
  const chargeRing = el('chargeRing');
  const hudDmg = el('hudDmg');
  const hudItem = el('hudItem');
  const countOverlay = el('countOverlay');
  const pcNote = el('pcNote');
  const pcNum = el('pcNum');
  const pausedOverlay = el('pausedOverlay');
  const finalEmoji = el('finalEmoji');
  const finalTitle = el('finalTitle');
  const finalList = el('finalList');
  const outSub = el('outSub');
  const netPill = el('netPill');
  const gamepadBadge = el('gamepadBadge');
  const playerAttribution = el('playerAttribution');

  function setNetPill(on) { if (netPill) netPill.hidden = !on; }

  const VIEWS = ['wait', 'play', 'out', 'final'];
  let currentView = 'wait';
  function showView(name) {
    currentView = name;
    for (let i = 0; i < VIEWS.length; i++) {
      const v = el('view-' + VIEWS[i]);
      if (v) v.classList.toggle('active', VIEWS[i] === name);
    }
    // Credit only belongs on the pre-game lobby wait. The 'wait' view is reused
    // for the countdown and between-round recaps, so hide it by default here
    // and let enterWaiting() turn it back on.
    if (playerAttribution) playerAttribution.hidden = true;
    // Let go of everything whenever the controller leaves the screen, so a
    // round ending mid-press can't leave a fighter walking or charging.
    if (name !== 'play') { releaseStick(true); releaseButtons(); }
    document.body.classList.toggle('playing', name === 'play');
    updateChrome();
  }

  // Reactions are gated on the PHASE (the wait view is reused mid-game), never
  // just the view: lobby, between-round results and the final standings.
  let phase = 'LOBBY';
  let roundOver = false;
  let hostPresent = true;
  let reactionsMuted = false;
  let kicked = false;
  function reactionsOpen() {
    if (kicked) return false;
    if (phase === 'LOBBY') return currentView === 'wait';
    if (phase === 'FINAL') return currentView === 'final';
    return phase === 'PLAYING' && roundOver && currentView === 'wait';
  }
  function updateChrome() {
    const on = reactionsOpen() && !reactionsMuted && hostPresent;
    const bar = el('reactionBar');
    if (bar) bar.hidden = !on;
    document.body.classList.toggle('reactions-on', on);
  }

  // ---------- Local state ----------
  let me = null;
  let roster = [];
  let gamePoints = {};
  let roundsToWin = 3;
  let alive = true;
  let paused = false;
  let live = false;
  let hud = { dmg: 0, item: '', glove: false };

  function vibrate(pattern) {
    if (!('vibrate' in navigator)) return;
    try { navigator.vibrate(pattern); } catch (e) { /* some browsers throw when backgrounded */ }
  }

  function colorOf(id) {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i].color;
    return '#ffffff';
  }
  function nameOf(id) {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i].name;
    return 'Player';
  }
  /** A name inside a sentence gets its own color so it reads as a person. */
  function nameSpan(id) {
    const s = document.createElement('span');
    s.className = 'pname';
    s.textContent = nameOf(id);
    s.style.color = colorOf(id);
    return s;
  }
  function setSentence(target, parts) {
    target.innerHTML = '';
    parts.forEach(function (p) { target.appendChild(typeof p === 'string' ? document.createTextNode(p) : p); });
  }

  function applyIdentity() {
    if (!me) return;
    const seat = typeof me.seat === 'number' ? me.seat : 0;
    const color = me.color || FALLBACK_COLORS[seat % FALLBACK_COLORS.length];
    document.body.style.setProperty('--pc', color);
    nameEl.textContent = me.name || 'Player';
    updateScore();
  }

  /** Rounds won as pips: one per round needed, lit for each round won. */
  function updateScore() {
    if (!scoreEl) return;
    if (!me) { scoreEl.innerHTML = ''; return; }
    const want = Math.max(1, roundsToWin);
    const have = gamePoints[PID] || 0;
    if (scoreEl.children.length !== want) {
      scoreEl.innerHTML = '';
      for (let i = 0; i < want; i++) {
        const d = document.createElement('span');
        d.className = 'pip';
        scoreEl.appendChild(d);
      }
    }
    for (let i = 0; i < scoreEl.children.length; i++) scoreEl.children[i].classList.toggle('on', i < have);
    scoreEl.setAttribute('aria-label', have + ' of ' + want + ' rounds won');
  }

  function setRoster(list) {
    roster = Array.isArray(list) ? list : [];
    for (let i = 0; i < roster.length; i++) {
      if (roster[i].id === PID) { me = roster[i]; break; }
    }
    applyIdentity();
  }

  // ============================================================
  // HUD (damage % + held item)
  // ============================================================
  function dmgColor(d) {
    if (d < 40) return '#ffffff';
    if (d < 80) return '#ffe14f';
    if (d < 120) return '#ff9a3d';
    return '#ff3b30';
  }
  function setHud(next, animate) {
    const prev = hud;
    hud = {
      dmg: typeof next.dmg === 'number' ? next.dmg : prev.dmg,
      item: typeof next.item === 'string' ? next.item : prev.item,
      glove: typeof next.glove === 'boolean' ? next.glove : prev.glove,
    };
    hudDmg.textContent = hud.dmg + '%';
    hudDmg.style.color = dmgColor(hud.dmg);
    hudItem.textContent = (hud.glove ? '🥊' : '') + (ITEM_ICONS[hud.item] || '');
    actIcon.textContent = ITEM_ICONS[hud.item] || (hud.glove ? '🥊' : '👊');
    actBtn.classList.toggle('has-item', !!hud.item);
    if (animate) {
      if (hud.dmg > prev.dmg) {
        hudDmg.classList.remove('bump'); void hudDmg.offsetWidth; hudDmg.classList.add('bump');
        vibrate(hud.dmg - prev.dmg >= 10 ? [30, 30, 50] : 25);
      }
      if ((hud.item && hud.item !== prev.item) || (hud.glove && !prev.glove)) vibrate(15);
    }
  }

  // ============================================================
  // Networking
  // ============================================================
  const socket = io('/ragdollrumble', { transports: ['polling', 'websocket'] });

  function bailToJoin(keepName) {
    if (keepName) {
      const n = localStorage.getItem('ragdollrumble.playerName');
      if (n) localStorage.setItem('ragdollrumble.rejoinName', n);
    }
    localStorage.removeItem('ragdollrumble.playerId');
    localStorage.removeItem('ragdollrumble.playerName');
    window.location.replace('/ragdollrumble/join');
  }

  socket.on('connect', function () {
    setNetPill(false);
    socket.emit('player:reconnect', { playerId: PID }, function (res) {
      if (!res || !res.ok) return bailToJoin(true);
      if (res.player && res.player.name) localStorage.setItem('ragdollrumble.playerName', res.player.name);
      reactionsMuted = !!res.reactionsMuted;
      hostPresent = res.hostPresent !== false;
      phase = res.phase || phase;
      if (res.lobby) applyLobby(res.lobby);
      if (res.match) applyMatchSnapshot(res.match);
      else if (res.phase === 'LOBBY') enterWaiting();
      // The socket that carried the last input is gone, so whatever the thumb
      // is holding has to be stated again on the new one.
      resendInput();
    });
  });

  socket.on('disconnect', function () { setNetPill(true); });
  socket.io.on('reconnect_attempt', function () { setNetPill(true); });

  socket.on('state:hostPresence', function (p) { hostPresent = !(p && p.present === false); updateChrome(); });
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); updateChrome(); });

  // ---------------- Reactions ----------------
  const REACTION_COOLDOWN_MS = 5000;
  const reactionBar = el('reactionBar');
  const reactionCooldown = el('reactionCooldown');
  const reactionBtns = reactionBar ? Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn')) : [];
  let reactionUntil = 0, cooldownRaf = null;
  function startCooldown() {
    if (cooldownRaf) cancelAnimationFrame(cooldownRaf);
    function tick() {
      const left = reactionUntil - Date.now();
      if (left <= 0) {
        reactionBtns.forEach(function (b) { b.disabled = false; });
        if (reactionCooldown) reactionCooldown.hidden = true;
        cooldownRaf = null;
        return;
      }
      reactionBtns.forEach(function (b) { b.disabled = true; });
      if (reactionCooldown) { reactionCooldown.hidden = false; reactionCooldown.textContent = Math.ceil(left / 1000) + 's'; }
      cooldownRaf = requestAnimationFrame(tick);
    }
    tick();
  }
  if (reactionBar) {
    reactionBar.addEventListener('pointerdown', function (e) {
      const btn = e.target.closest('.reaction-btn');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      const idx = parseInt(btn.dataset.reaction, 10);
      if (isNaN(idx)) return;
      reactionUntil = Date.now() + REACTION_COOLDOWN_MS;
      startCooldown();
      socket.emit('player:reaction', { index: idx }, function (res) {
        if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
          reactionUntil = Date.now() + res.retryInMs;
          startCooldown();
        }
      });
    });
  }

  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') {
      kicked = true;
      waitTitle.textContent = 'Removed from the game';
      waitSub.textContent = 'The host removed you. Sending you back…';
      showView('wait');
      setTimeout(function () { bailToJoin(true); }, 1400);
    }
  });

  // A reset wipes the roster server-side, so this phone is no longer in the
  // game — send it back to join instead of leaving a stale "You're in!".
  socket.on('state:reset', function () { bailToJoin(true); });

  socket.on('state:lobby', function (l) { applyLobby(l); });

  function applyLobby(l) {
    if (!l) return;
    if (l.players) setRoster(l.players);
    if (typeof l.roundsToWin === 'number') roundsToWin = l.roundsToWin;
    updateScore();
    if (l.phase === 'LOBBY' && currentView !== 'wait') enterWaiting();
  }

  function enterWaiting() {
    phase = 'LOBBY';
    roundOver = false;
    waitTitle.textContent = "You're in!";
    waitSub.innerHTML = '<span class="pulse-dot"></span>Waiting for the host to start…';
    showView('wait');
    if (playerAttribution) playerAttribution.hidden = false;
  }

  // ---- Match lifecycle ----
  socket.on('m:start', function (p) {
    phase = 'PLAYING';
    roundOver = false;
    if (p && p.roster) setRoster(p.roster);
    if (p && typeof p.roundsToWin === 'number') roundsToWin = p.roundsToWin;
    gamePoints = {};
    waitTitle.textContent = 'Get ready!';
    waitSub.innerHTML = '<span class="pulse-dot"></span>The first round is starting…';
    updateScore();
    showView('wait');
  });

  socket.on('m:roundStart', function (p) {
    phase = 'PLAYING';
    roundOver = false;
    alive = true;
    live = false;
    paused = false;
    if (p && typeof p.roundsToWin === 'number') roundsToWin = p.roundsToWin;
    const mine = p && p.hud && p.hud[PID];
    setHud(mine || { dmg: 0, item: '', glove: false }, false);
    updateScore();
    pausedOverlay.hidden = true;
    pcNote.textContent = 'Round ' + ((p && p.round) || 1);
    pcNum.textContent = '…';
    countOverlay.hidden = false;
    showView('play');
  });

  socket.on('m:countdown', function (p) {
    if (roundOver) { roundOver = false; updateChrome(); }
    if (!alive) return;
    countOverlay.hidden = false;
    pcNote.textContent = (p && p.note) || 'Get ready';
    const n = p && p.n;
    pcNum.textContent = (n === 0 || n === 'GO') ? 'GO!' : String(n);
    pcNum.style.animation = 'none';
    void pcNum.offsetWidth;
    pcNum.style.animation = '';
    vibrate(10);
  });

  socket.on('m:play', function () {
    live = true;
    paused = false;
    countOverlay.hidden = true;
    pausedOverlay.hidden = true;
    resendInput();
  });

  socket.on('m:pause', function () {
    paused = true;
    pausedOverlay.hidden = false;
  });

  socket.on('m:resume', function (p) {
    paused = false;
    live = !!(p && p.live);
    pausedOverlay.hidden = true;
    resendInput();
  });

  socket.on('m:hud', function (p) {
    if (!p || p.id !== PID) return;
    setHud(p, true);
  });

  socket.on('m:eliminated', function (p) {
    if (!p || p.id !== PID) return;
    alive = false;
    live = false;
    vibrate([60, 40, 120]);
    if (p.by && p.by !== PID) setSentence(outSub, ['Launched by ', nameSpan(p.by), '. Watch the big screen — the round\'s still going.']);
    else outSub.textContent = 'Watch the big screen — the round\'s still going.';
    showView('out');
  });

  socket.on('m:roundEnd', function (p) {
    live = false;
    paused = false;
    roundOver = true;
    if (!p) return;
    gamePoints = p.gamePoints || gamePoints;
    if (typeof p.roundsToWin === 'number') roundsToWin = p.roundsToWin;
    updateScore();
    const won = p.winnerId === PID;
    if (won) vibrate([20, 50, 20, 50, 60]);
    if (won) waitTitle.textContent = 'You won the round! 🎉';
    else if (p.winnerId) setSentence(waitTitle, [nameSpan(p.winnerId), ' won the round']);
    else waitTitle.textContent = 'Round over';
    waitSub.innerHTML = '<span class="pulse-dot"></span>Next round coming up…';
    showView('wait');
  });

  socket.on('m:end', function (p) {
    phase = 'FINAL';
    roundOver = false;
    live = false;
    if (!p) return;
    gamePoints = p.gamePoints || gamePoints;
    showFinal(p.winnerIds || []);
  });

  function showFinal(winners) {
    const iWon = winners.indexOf(PID) !== -1;
    updateScore();
    finalEmoji.textContent = iWon ? '🏆' : '🥊';
    if (iWon) finalTitle.textContent = winners.length > 1 ? 'You tied for the win!' : 'You win!';
    else if (winners.length) {
      const parts = [];
      const shown = winners.length > 3 ? winners.slice(0, 2) : winners;
      const more = winners.length - shown.length;
      shown.forEach(function (id, i) { if (i) parts.push(i === shown.length - 1 && !more ? ' & ' : ', '); parts.push(nameSpan(id)); });
      if (more) parts.push(' & ' + more + ' more');
      parts.push(winners.length > 1 ? ' win!' : ' wins!');
      setSentence(finalTitle, parts);
    } else finalTitle.textContent = 'Game over';
    renderStandings(finalList, winners);
    showView('final');
  }

  function renderStandings(target, winners) {
    if (!target) return;
    const list = roster.slice().sort(function (a, b) {
      return (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0) || a.seat - b.seat;
    });
    target.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const row = document.createElement('div');
      row.className = 'out-row' + (r.id === PID ? ' me' : '') + (winners && winners.indexOf(r.id) !== -1 ? ' win' : '');
      const dot = document.createElement('span');
      dot.className = 'out-dot';
      dot.style.background = r.color || colorOf(r.id);
      const nm = document.createElement('span');
      nm.className = 'out-name';
      nm.textContent = r.name + (r.isBot ? ' 🤖' : '');
      const gp = document.createElement('span');
      gp.className = 'out-gp';
      gp.textContent = (gamePoints[r.id] || 0) + '/' + roundsToWin;
      row.appendChild(dot); row.appendChild(nm); row.appendChild(gp);
      target.appendChild(row);
    }
  }

  /** Rebuild the controller from a mid-match reconnect snapshot. */
  function applyMatchSnapshot(m) {
    setRoster(m.roster || []);
    gamePoints = m.gamePoints || {};
    roundsToWin = typeof m.roundsToWin === 'number' ? m.roundsToWin : roundsToWin;
    paused = !!m.paused;
    live = !!m.live;
    alive = !(m.alive && m.alive[PID] === false);
    setHud((m.hud && m.hud[PID]) || { dmg: 0, item: '', glove: false }, false);
    updateScore();

    roundOver = !!m.roundOver;
    if (m.winnerIds && m.winnerIds.length) {
      phase = 'FINAL';
      return showFinal(m.winnerIds);
    }
    phase = 'PLAYING';
    if (roundOver) {
      waitTitle.textContent = 'Round over';
      waitSub.innerHTML = '<span class="pulse-dot"></span>Next round coming up…';
      return showView('wait');
    }
    if (!alive) {
      outSub.textContent = 'Watch the big screen — the round\'s still going.';
      return showView('out');
    }
    countOverlay.hidden = live;
    pausedOverlay.hidden = !paused;
    if (!live) { pcNote.textContent = 'Round ' + (m.round || 1); pcNum.textContent = '…'; }
    showView('play');
  }

  // ============================================================
  // Input state + sending
  // ============================================================
  const DEADZONE = 0.18;
  const SEND_MS = 50;           // ~20 Hz upstream for stick motion
  // Input is change-driven, so re-assert it this often: a packet dropped on a
  // bad link (or thrown away before the round went live) self-corrects within a
  // few frames instead of stranding the fighter.
  const REASSERT_MS = 300;
  const REST_REASSERT_MS = 2000;
  let vx = 0, vy = 0;
  let jumpHeld = false, actHeld = false;
  let jp = 0, ap = 0;           // press counters (wrap at 256)
  let sent = { x: NaN, y: NaN, b: -1, jp: -1, ap: -1 };
  let lastSend = 0;
  let lastChange = 0;
  let sendTimer = null;

  function canSteer() { return alive && currentView === 'play'; }

  function bits() { return (jumpHeld ? 1 : 0) | (actHeld ? 2 : 0); }

  /** Stick motion is throttled; button changes always go out immediately. */
  function queueSend() {
    const now = Date.now();
    const buttonsChanged = bits() !== sent.b || jp !== sent.jp || ap !== sent.ap;
    const resting = vx === 0 && vy === 0;
    if (!buttonsChanged && !resting && Math.abs(vx - sent.x) < 0.03 && Math.abs(vy - sent.y) < 0.03) return;
    const wait = SEND_MS - (now - lastSend);
    if (!buttonsChanged && wait > 0) {
      if (sendTimer) return;
      sendTimer = setTimeout(function () { sendTimer = null; flushSend(); }, wait);
      return;
    }
    flushSend();
  }
  function flushSend() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    const b = bits();
    if (vx === sent.x && vy === sent.y && b === sent.b && jp === sent.jp && ap === sent.ap) return;
    sent = { x: vx, y: vy, b: b, jp: jp, ap: ap };
    lastSend = Date.now();
    socket.emit('in', { x: Math.round(vx * 100) / 100, y: Math.round(vy * 100) / 100, b: b, jp: jp, ap: ap });
  }
  /** Send the current state again, ignoring the de-duplication. */
  function resendInput() {
    sent = { x: NaN, y: NaN, b: -1, jp: -1, ap: -1 };
    lastSend = 0;
    flushSend();
  }
  setInterval(function () {
    if (!socket.connected || currentView !== 'play') return;
    if (Date.now() - lastSend < REASSERT_MS) return;
    const active = vx !== 0 || vy !== 0 || jumpHeld || actHeld;
    if (!active && Date.now() - lastChange > REST_REASSERT_MS) return;
    resendInput();
  }, REASSERT_MS);

  function setVec(nx, ny) {
    if (nx !== vx || ny !== vy) lastChange = Date.now();
    vx = nx; vy = ny;
  }

  // ============================================================
  // Thumbstick
  // ============================================================
  let stickId = null;
  const zonePointers = new Map();
  let originX = 0, originY = 0;
  let radius = 70;

  function measureRadius() {
    const r = stickBase.getBoundingClientRect();
    if (r.width) radius = r.width * 0.42;
  }
  /** Layout changed (e.g. the browser bar slid): keep the drawn base on the held origin. */
  function relayoutStick() {
    measureRadius();
    if (stickId === null) return;
    placeBase(originX, originY);
  }
  window.addEventListener('resize', relayoutStick);
  window.addEventListener('orientationchange', relayoutStick);
  measureRadius();

  function setKnob(px, py) {
    stickKnob.style.transform = 'translate(-50%, -50%) translate(' + px + 'px, ' + py + 'px)';
  }

  function updateVector(clientX, clientY) {
    let dx = clientX - originX;
    let dy = clientY - originY;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) { dx = (dx / dist) * radius; dy = (dy / dist) * radius; }
    setKnob(dx, dy);
    const nx = dx / radius, ny = dy / radius;
    if (Math.hypot(nx, ny) < DEADZONE) setVec(0, 0); else setVec(nx, ny);
    queueSend();
  }

  /** Drive the stick from an already-normalised vector (used by the gamepad). */
  function applyVector(nx, ny) {
    const mag = Math.hypot(nx, ny);
    if (mag > 1) { nx /= mag; ny /= mag; }
    if (mag < DEADZONE) setVec(0, 0); else setVec(nx, ny);
    setKnob(vx * radius, vy * radius);
    queueSend();
  }

  /**
   * Anchor the stick to a pointer at (x, y): the visible base jumps under the
   * finger and the origin is pinned to it, so the stick always starts exactly
   * where the thumb landed.
   */
  function placeBase(x, y) {
    const zone = stickZone.getBoundingClientRect();
    const half = stickBase.getBoundingClientRect().width / 2;
    const bx = Math.min(Math.max(x, zone.left + half), zone.right - half);
    const by = Math.min(Math.max(y, zone.top + half), zone.bottom - half);
    stickBase.style.position = 'absolute';
    stickBase.style.left = (bx - zone.left - half) + 'px';
    stickBase.style.top = (by - zone.top - half) + 'px';
  }
  function anchorStick(id, x, y) {
    stickId = id;
    placeBase(x, y);
    originX = x; originY = y;
    stickBase.classList.add('active');
    measureRadius();
    updateVector(x, y);
  }

  // Once a thumb holds the stick, it owns it until that thumb lifts: no other
  // finger can steal it and nothing re-centres it. On touch screens the stick
  // follows Touch events (by touch identifier) rather than Pointer events —
  // browsers fire `pointercancel` mid-hold (multi-touch, gesture heuristics)
  // and then stop reporting that finger, which used to kill or re-centre the
  // stick under a thumb that never left the glass. A mouse/pen uses pointers.
  function stickFree() { return stickId === null; }

  /** Start steering with a new contact at (x, y) — only if the stick is free. */
  function takeStick(id, x, y) {
    zonePointers.set(id, { x: x, y: y });
    if (!canSteer() || !stickFree()) return false;
    anchorStick(id, x, y);
    return true;
  }
  /** A contact moved: steer if it's the one holding the stick. */
  function dragStick(id, x, y) {
    const tracked = zonePointers.get(id);
    if (tracked) { tracked.x = x; tracked.y = y; }
    if (stickId !== id) return false;
    updateVector(x, y);
    return true;
  }
  /** A contact lifted: if it held the stick, hand it to a finger still resting in the zone. */
  function dropStick(id) {
    zonePointers.delete(id);
    if (stickId !== id) return;
    const next = zonePointers.entries().next();
    if (!next.done && canSteer()) {
      const [nid, pos] = next.value;
      anchorStick(nid, pos.x, pos.y);
      return;
    }
    releaseStick(true);
  }

  // ---- Touch screens: Touch events ----
  const TOUCH = 't';   // touch ids are namespaced so they can't collide with pointer ids
  stickZone.addEventListener('touchstart', function (e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      takeStick(TOUCH + t.identifier, t.clientX, t.clientY);
    }
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', function (e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      dragStick(TOUCH + t.identifier, t.clientX, t.clientY);
    }
  }, { passive: true });
  function touchGone(e) {
    for (let i = 0; i < e.changedTouches.length; i++) dropStick(TOUCH + e.changedTouches[i].identifier);
    reconcileTouches(e);
  }
  /** Every touch event lists all fingers still down: drop any we lost track of. */
  function reconcileTouches(e) {
    if (!e.touches) return;
    const live = {};
    for (let i = 0; i < e.touches.length; i++) live[TOUCH + e.touches[i].identifier] = true;
    zonePointers.forEach(function (_, id) { if (String(id).charAt(0) === TOUCH && !live[id]) dropStick(id); });
  }
  window.addEventListener('touchend', touchGone);
  window.addEventListener('touchcancel', touchGone);
  window.addEventListener('touchstart', reconcileTouches, { passive: true });

  // ---- Mouse / pen: Pointer events ----
  function isTouchPointer(e) { return e.pointerType === 'touch'; }
  stickZone.addEventListener('pointerdown', function (e) {
    if (isTouchPointer(e)) return;
    if (takeStick(e.pointerId, e.clientX, e.clientY)) e.preventDefault();
  });
  // Move/end listeners live on WINDOW: a pointer at full deflection routinely
  // leaves the stick zone, and its pointerup must still release the stick.
  window.addEventListener('pointermove', function (e) {
    if (isTouchPointer(e)) return;
    if (dragStick(e.pointerId, e.clientX, e.clientY)) e.preventDefault();
  }, { passive: false });
  window.addEventListener('pointerup', function (e) { if (!isTouchPointer(e)) dropStick(e.pointerId); endButtonPointer(e); });
  window.addEventListener('pointercancel', function (e) { if (!isTouchPointer(e)) dropStick(e.pointerId); endButtonPointer(e); });

  function releaseStick(force, e) {
    if (!force && (!e || stickId !== e.pointerId)) return;
    stickId = null;
    zonePointers.clear();
    stickBase.classList.remove('active');
    stickBase.style.position = '';
    stickBase.style.left = '';
    stickBase.style.top = '';
    setKnob(0, 0);
    if (vx !== 0 || vy !== 0 || sent.x !== 0 || sent.y !== 0) {
      setVec(0, 0);
      flushSend();
    }
  }

  // Backstop for browsers that drop the end of a touch under multi-touch: when
  // the last finger leaves the glass nothing can still be held.
  window.addEventListener('touchend', function (e) {
    if (e.touches && e.touches.length === 0) { if (stickId !== null) releaseStick(true); releaseButtons(); }
  });
  window.addEventListener('touchcancel', function (e) {
    if (e.touches && e.touches.length === 0) { if (stickId !== null) releaseStick(true); releaseButtons(); }
  });
  // Losing focus (a notification, a system sheet) doesn't lift a thumb, so a
  // touch-held stick keeps going — its touchend/touchcancel still arrives. Only
  // a mouse-held stick (whose button-up could be missed) lets go on blur.
  window.addEventListener('blur', function () {
    if (stickId !== null && String(stickId).charAt(0) !== TOUCH) releaseStick(true);
    releaseButtons();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { releaseStick(true); releaseButtons(); }
  });

  // ============================================================
  // JUMP / ACTION buttons
  // ============================================================
  // Each button tracks every finger on it; it's held while any of them is down.
  const btnPointers = { jump: new Set(), act: new Set() };
  let actDownAt = 0;
  let chargeRaf = null;

  function setButton(which, down) {
    if (which === 'jump') {
      if (down && !jumpHeld) { jp = (jp + 1) & 255; vibrate(8); }
      jumpHeld = down;
      jumpBtn.classList.toggle('pressed', down);
    } else {
      if (down && !actHeld) { ap = (ap + 1) & 255; actDownAt = performance.now(); vibrate(12); startChargeRing(); }
      actHeld = down;
      actBtn.classList.toggle('pressed', down);
      if (!down) stopChargeRing();
    }
    lastChange = Date.now();
    queueSend();
  }

  function startChargeRing() {
    if (chargeRaf) cancelAnimationFrame(chargeRaf);
    // Items are used on the press, so there's nothing to charge.
    if (hud.item) return;
    function tick() {
      if (!actHeld) return;
      const held = performance.now() - actDownAt;
      const k = held < CHARGE_START_MS ? 0 : Math.min(1, (held - CHARGE_START_MS) / CHARGE_FULL_MS);
      chargeRing.style.strokeDashoffset = String(100 - k * 100);
      actBtn.classList.toggle('charging', k > 0);
      actBtn.classList.toggle('charged', k >= 1);
      chargeRaf = requestAnimationFrame(tick);
    }
    chargeRaf = requestAnimationFrame(tick);
  }
  function stopChargeRing() {
    if (chargeRaf) { cancelAnimationFrame(chargeRaf); chargeRaf = null; }
    chargeRing.style.strokeDashoffset = '100';
    actBtn.classList.remove('charging', 'charged');
  }

  function bindButton(btn, which) {
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (!canSteer()) return;
      btnPointers[which].add(e.pointerId);
      setButton(which, true);
    });
    // Suppress the synthesised click so a tap never fires twice.
    btn.addEventListener('click', function (e) { e.preventDefault(); });
  }
  bindButton(jumpBtn, 'jump');
  bindButton(actBtn, 'act');

  function endButtonPointer(e) {
    ['jump', 'act'].forEach(function (w) {
      if (btnPointers[w].delete(e.pointerId) && btnPointers[w].size === 0) setButton(w, false);
    });
  }
  function releaseButtons() {
    btnPointers.jump.clear(); btnPointers.act.clear();
    if (jumpHeld) setButton('jump', false);
    if (actHeld) setButton('act', false);
  }

  // ============================================================
  // Bluetooth / USB gamepad
  // ============================================================
  // A controller paired to the phone drives the same stick and buttons the
  // touch pad does. Standard layout: left stick / D-pad move, A (bottom face)
  // jumps, the other face buttons and shoulders are ACTION.
  const GP_DEADZONE = 0.3;
  let gpIndex = null;
  let gpJump = false, gpAct = false;
  let gpSteering = false;

  function anyGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    for (let i = 0; i < pads.length; i++) { if (pads[i]) return true; }
    return false;
  }
  function activeGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    if (gpIndex !== null && pads[gpIndex]) return pads[gpIndex];
    for (let i = 0; i < pads.length; i++) { if (pads[i]) { gpIndex = i; return pads[i]; } }
    return null;
  }
  function mapGamepad(gp) {
    const a = gp.axes || [];
    const b = gp.buttons || [];
    const down = function (i) { const btn = b[i]; return !!(btn && (btn.pressed || btn.value > 0.5)); };
    let ax = a.length > 0 ? (a[0] || 0) : 0;
    let ay = a.length > 1 ? (a[1] || 0) : 0;
    if (Math.abs(ax) < GP_DEADZONE) ax = 0;
    if (Math.abs(ay) < GP_DEADZONE) ay = 0;
    if (down(14)) ax = -1; else if (down(15)) ax = 1;
    if (down(12)) ay = -1; else if (down(13)) ay = 1;
    return { x: ax, y: ay, jump: down(0), act: down(1) || down(2) || down(3) || down(5) || down(7) };
  }
  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    const gp = activeGamepad();
    if (!gp) return;
    const m = mapGamepad(gp);
    const ok = canSteer();
    if (m.jump !== gpJump) { gpJump = m.jump; if (ok || !m.jump) setButton('jump', m.jump && ok); }
    if (m.act !== gpAct) { gpAct = m.act; if (ok || !m.act) setButton('act', m.act && ok); }
    // A thumb on the touch stick always wins.
    if (stickId !== null) { gpSteering = false; return; }
    const pushing = m.x !== 0 || m.y !== 0;
    if (!pushing && !gpSteering) return;
    if (!ok) { if (gpSteering) { gpSteering = false; applyVector(0, 0); } return; }
    gpSteering = pushing;
    applyVector(m.x, m.y);
  }
  function setGamepadBadge(on) {
    if (gamepadBadge) gamepadBadge.hidden = !on;
    document.body.classList.toggle('has-gamepad', !!on);
  }
  window.addEventListener('gamepadconnected', function (e) { gpIndex = e.gamepad.index; setGamepadBadge(true); });
  window.addEventListener('gamepaddisconnected', function (e) {
    if (gpIndex === e.gamepad.index) {
      gpIndex = null;
      if (gpSteering) { gpSteering = false; applyVector(0, 0); }
      releaseButtons();
    }
    setGamepadBadge(anyGamepad());
  });
  if (anyGamepad()) setGamepadBadge(true);
  pollGamepad();

  // ---------- Boot ----------
  setHud(hud, false);
  showView('wait');
  // Resume countdown from the host: the pause cover shows the 3-2-1.
  (function () {
    const cover = document.getElementById('pausedOverlay');
    if (!cover) return;
    const title = cover.querySelector('.pc-note');
    const sub = cover.querySelector('.pc-sub');
    const titleText = title ? title.textContent : '';
    const subText = sub ? sub.textContent : '';
    function reset() {
      cover.classList.remove('resuming');
      if (title) title.textContent = titleText;
      if (sub) sub.textContent = subText;
    }
    socket.on('m:resumeCount', function (d) {
      const n = d && Number(d.n);
      if (!(n > 0)) { reset(); return; }
      cover.classList.add('resuming');
      if (title) { title.textContent = n; title.style.animation = 'none'; void title.offsetWidth; title.style.animation = ''; }
      if (sub) sub.textContent = 'Get ready…';
    });
    socket.on('m:resume', reset);
    socket.on('m:pause', reset);
  })();
})();
