(function () {
  'use strict';

  // ============================================================
  // Egyptian Ratscrew — phone controller.
  //
  // Top half: SLAP. Bottom half: flip your top card onto the pile, lit only
  // when it's your turn and the last card has had its 2 s on the pile.
  // Nothing is private (every deck is face down), so the phone renders from
  // the same table snapshot the host gets; the server validates every move.
  // ============================================================

  const PID = localStorage.getItem('ratscrew.playerId');
  if (!PID) { window.location.replace('/ratscrew/join'); return; }

  // ---------------- Kill all zoom / scroll / selection behaviour ----------------
  // iOS Safari ignores maximum-scale/user-scalable, and a stray long-press or
  // double-tap would eat the input, so block it explicitly: pinch (iOS gesture
  // events + every touch move), double-tap-to-zoom, and the long-press callout.
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      // Swallow every move, not just multi-touch: once iOS has started a pinch
      // the follow-up events are no longer cancelable, so the first one has to
      // die too. Opt specific regions back in by selector.
      if (!e.cancelable) return;
      if (e.target && e.target.closest && e.target.closest('.scrollable-region, .result-rows')) return;
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
    window.addEventListener('scroll', function () { window.scrollTo(0, 0); }, { passive: true });
  }());

  const FACE_WORD = { J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
  const PATTERN_WORD = { double: 'Double', sandwich: 'Sandwich', flush: 'Flush' };

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function nameSpan(name, seat) {
    const s = document.createElement('span');
    s.className = 'pname';
    if (seat) s.dataset.seat = seat;
    s.textContent = name;
    return s;
  }
  /** Fill `el` with text, elements and { name, seat } name spans. */
  function fillLine(el, parts) {
    el.textContent = '';
    parts.forEach(function (p) {
      if (p == null) return;
      if (typeof p === 'string') el.appendChild(document.createTextNode(p));
      else if (p.nodeType) el.appendChild(p);
      else el.appendChild(nameSpan(p.name, p.seat));
    });
  }

  // ---------------- DOM ----------------
  const el = function (id) { return document.getElementById(id); };
  const views = {
    wait: el('pv-wait'),
    game: el('pv-game'),
    out: el('pv-out'),
    result: el('pv-result'),
  };
  let currentView = 'wait';
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
    // The attribution footer belongs to the lobby only — the waiting view is
    // reused for "Dealing…" once the game is under way.
    if (attribution) attribution.hidden = !(name === 'wait' && publicPhase === 'LOBBY');
    if (name !== 'game') document.body.classList.remove('my-turn');
    currentView = name;
    updateEmoteState();
  }

  const pSeat = el('pSeat');
  const pName = el('pName');
  const pScore = el('pScore');
  const waitTitle = el('waitTitle');
  const waitSub = el('waitSub');

  const slapBtn = el('slapBtn');
  const slapSub = el('slapSub');
  const msPile = el('msPile');
  const msStatus = el('msStatus');
  const playBtn = el('playBtn');
  const pzCount = el('pzCount');
  const playLabel = el('playLabel');
  const playSub = el('playSub');
  const playTimer = el('playTimer');
  const playTimerFill = el('playTimerFill');
  const slapFlash = el('slapFlash');
  const sfTitle = el('sfTitle');
  const sfSub = el('sfSub');

  const outTitle = el('outTitle');
  const outSub = el('outSub');
  const resultEmoji = el('resultEmoji');
  const resultTitle = el('resultTitle');
  const resultSub = el('resultSub');
  const resultRows = el('resultRows');

  const connOverlay = el('pConnOverlay');
  const toastEl = el('pToast');
  const emoteToggle = el('emoteToggle');
  const emotePanel = el('emotePanel');
  const emoteGrid = el('emoteGrid');
  const attribution = el('playerAttribution');

  const TOAST_FADE_MS = 280;
  let toastTimer = null;
  let toastFadeTimer = null;
  function toast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    if (toastFadeTimer) clearTimeout(toastFadeTimer);
    toastEl.classList.remove('leaving');
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.style.animation = 'none';
    void toastEl.offsetWidth;
    toastEl.style.animation = '';
    toastTimer = setTimeout(function () {
      toastTimer = null;
      toastEl.classList.add('leaving');
      toastFadeTimer = setTimeout(function () {
        toastFadeTimer = null;
        toastEl.hidden = true;
        toastEl.classList.remove('leaving');
      }, TOAST_FADE_MS);
    }, 2400);
  }

  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (_) {} }
  }

  /**
   * Bind to pointerdown, not click: the double-tap-zoom guard swallows a quick
   * second click, which would eat a real tap.
   */
  function onTap(node, fn) {
    node.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      fn(e);
    });
  }
  function press(node) {
    node.classList.remove('pressed');
    void node.offsetWidth;
    node.classList.add('pressed');
    setTimeout(function () { node.classList.remove('pressed'); }, 150);
  }

  // ---------------- State ----------------
  let myName = localStorage.getItem('ratscrew.playerName') || '';
  let mySeat = null;
  let publicPhase = 'LOBBY';
  let table = null;          // latest table snapshot
  let hostPresent = true;
  let reactionsMutedByHost = false;
  let clockOffset = 0;
  let unlockTimer = null;
  let lastTurnMine = false;
  let playSending = false;
  let lastSlapSent = 0;

  pName.textContent = myName;

  function serverNow() { return Date.now() + clockOffset; }
  function seatOf(pid) {
    const s = table && table.seats.find(function (x) { return x.playerId === pid; });
    return s || null;
  }
  function who(pid) {
    const s = seatOf(pid);
    return s ? { name: s.name, seat: s.seat } : { name: '?', seat: null };
  }
  function meSeat() { return seatOf(PID); }

  // ---------------- Rendering ----------------
  function renderTop() {
    if (mySeat) pSeat.dataset.seat = mySeat;
    pName.textContent = myName;
    const m = meSeat();
    if (publicPhase === 'PLAYING' && m && !m.out) pScore.textContent = plural(m.count, 'card');
    else if (publicPhase === 'PLAYING' && m && m.out) pScore.textContent = ordinal(m.place);
    else pScore.textContent = '';
  }

  function renderWait(title, sub) {
    waitTitle.textContent = title;
    waitSub.textContent = sub;
    show('wait');
  }

  function setTimerBar(remaining, total) {
    if (remaining <= 0 || !total) {
      playTimer.classList.remove('on');
      playTimerFill.style.transition = 'none';
      playTimerFill.style.width = '0%';
      return;
    }
    playTimer.classList.add('on');
    playTimerFill.style.transition = 'none';
    playTimerFill.style.width = Math.min(100, 100 * remaining / total) + '%';
    void playTimerFill.offsetWidth;
    playTimerFill.style.transition = 'width ' + remaining + 'ms linear';
    playTimerFill.style.width = '0%';
  }

  /** Can this phone slap right now? Returns null when yes, else why not. */
  function slapBlock(s, m) {
    if (s.ending) return 'Game over';
    if (!m || m.count === 0) return 'No cards to slap with';
    if (!s.pileCount) return 'Nothing on the pile yet';
    if (s.claim && s.claim.reason === 'slap') return 'Pile taken';
    if (s.slapped) return s.slapped.byId === PID ? 'You slapped this card' : (who(s.slapped.byId).name + ' slapped this card');
    return null;
  }

  function renderGame() {
    const s = table;
    const m = meSeat();
    if (!s || !m) return;
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
    const now = serverNow();

    // ---- SLAP ----
    const block = slapBlock(s, m);
    slapBtn.classList.toggle('off', !!block);
    slapSub.textContent = block || (s.flush ? 'Double · Sandwich · Flush' : 'Double · Sandwich');

    // ---- Middle strip ----
    fillLine(msPile, ['Pile ', (function () { const b = document.createElement('strong'); b.textContent = String(s.pileCount); return b; }())]);
    let status = [];
    if (s.challenge && !s.ending) {
      const f = document.createElement('span');
      f.className = 'ms-face';
      f.textContent = FACE_WORD[s.challenge.rank] + '!';
      status = s.turnPlayerId === PID
        ? [f, ' ' + plural(s.challenge.left, 'try', 'tries') + ' left']
        : [f, ' ', who(s.turnPlayerId), ': ' + plural(s.challenge.left, 'try', 'tries')];
    } else if (s.claim && !s.ending) {
      status = s.claim.byId === PID ? ['The pile is yours!'] : [who(s.claim.byId), ' takes the pile'];
    }
    fillLine(msStatus, status);

    // ---- PLAY ----
    pzCount.textContent = m.count;
    playBtn.classList.toggle('empty', m.count === 0);
    const mine = s.turnPlayerId === PID && !s.claim && !s.ending;
    const remaining = mine ? s.nextPlayAt - now : 0;
    const ready = mine && remaining <= 40 && m.count > 0;
    playBtn.classList.toggle('ready', ready);
    playBtn.classList.toggle('locked', mine && !ready);
    playBtn.classList.toggle('idle', !mine);
    document.body.classList.toggle('my-turn', mine);

    if (s.ending) {
      fillLine(playLabel, s.winnerId === PID ? ['You win!'] : [who(s.winnerId), ' wins!']);
      fillLine(playSub, ['Game over']);
      setTimerBar(0);
    } else if (mine && ready) {
      fillLine(playLabel, [s.challenge ? 'Play a face card!' : 'Play a card']);
      fillLine(playSub, [s.challenge ? plural(s.challenge.left, 'try', 'tries') + ' left · tap to flip' : 'Tap to flip your top card']);
      setTimerBar(0);
    } else if (mine) {
      fillLine(playLabel, [s.cardsPlayed === 0 ? 'You go first' : "You're up next"]);
      fillLine(playSub, [s.cardsPlayed === 0 ? 'Dealing the cards…' : 'Look at the pile — slap if you see it!']);
      setTimerBar(remaining, s.cardsPlayed === 0 ? remaining : s.playLockMs);
      unlockTimer = setTimeout(function () { unlockTimer = null; buzz(15); route(); }, remaining);
    } else if (s.claim) {
      if (s.claim.byId === PID) fillLine(playLabel, ['The pile is yours!']);
      else fillLine(playLabel, [who(s.claim.byId), ' takes the pile']);
      fillLine(playSub, [s.claim.byId === PID ? "You'll play next" : '']);
      setTimerBar(0);
    } else if (m.count === 0) {
      fillLine(playLabel, ['Out of cards']);
      fillLine(playSub, ['Hoping your face card wins the pile…']);
      setTimerBar(0);
    } else if (s.turnPlayerId) {
      fillLine(playLabel, [who(s.turnPlayerId), "'s turn"]);
      fillLine(playSub, [s.waitingOn ? 'Waiting for them to come back…' : 'Watch the pile and get ready to slap']);
      setTimerBar(0);
    } else {
      fillLine(playLabel, ['Wait…']);
      fillLine(playSub, ['']);
      setTimerBar(0);
    }

    // A buzz the moment it becomes your turn, so you look down.
    if (mine && !lastTurnMine) buzz([30, 40, 30]);
    lastTurnMine = mine;
    show('game');
  }

  function renderOut() {
    const m = meSeat();
    outTitle.textContent = m && m.place ? "You're out in " + ordinal(m.place) : "You're out";
    outSub.textContent = 'Nice game! Keep an eye on the table.';
    show('out');
  }

  function renderFinal(f) {
    const mine = (f.standings || []).find(function (r) { return r.playerId === PID; });
    const won = f.winnerId === PID;
    resultEmoji.textContent = won ? '🏆' : '🫡';
    resultSub.textContent = '';
    if (won) {
      resultTitle.textContent = 'You win!';
      resultSub.textContent = 'You took all 52 cards.';
    } else {
      resultTitle.textContent = mine && mine.place ? 'You finished ' + ordinal(mine.place) : 'Game over';
      if (f.winnerName) {
        const champ = (f.standings || []).find(function (r) { return r.playerId === f.winnerId; });
        fillLine(resultSub, [{ name: f.winnerName, seat: champ && champ.seat }, ' took all 52 cards.']);
      }
    }
    resultRows.innerHTML = '';
    (f.standings || []).forEach(function (r) {
      const row = document.createElement('div');
      row.className = 'result-row' + (r.playerId === PID ? ' is-me' : '');
      row.dataset.seat = r.seat;
      const place = document.createElement('span');
      place.className = 'rr-seat'; place.textContent = ordinal(r.place || 1);
      const n = document.createElement('span');
      n.className = 'rr-name pname'; n.textContent = r.name;
      const sc = document.createElement('span');
      sc.className = 'rr-score';
      sc.textContent = r.playerId === f.winnerId ? 'Winner' : plural(r.goodSlaps, 'slap');
      row.appendChild(place); row.appendChild(n); row.appendChild(sc);
      resultRows.appendChild(row);
    });
    document.body.classList.remove('my-turn');
    show('result');
    if (won) buzz([40, 60, 40, 60, 120]);
  }

  /** Pick the right screen from the public phase and this player's seat. */
  function route() {
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
    renderTop();
    if (publicPhase === 'LOBBY') { renderWait("You're in!", 'Waiting for the host to deal…'); return; }
    if (publicPhase === 'FINAL') return;             // renderFinal owns the view
    const m = meSeat();
    if (!table || !m) { renderWait('Dealing…', 'Your cards are on the way.'); return; }
    if (m.out && !table.ending) { renderOut(); return; }
    renderGame();
  }

  // ---------------- Slap feedback ----------------
  let flashTimer = null;
  function flash(kind, title, subParts) {
    if (flashTimer) clearTimeout(flashTimer);
    slapFlash.className = 'slap-flash ' + kind;
    sfTitle.textContent = title;
    fillLine(sfSub, subParts || []);
    slapFlash.hidden = false;
    slapFlash.style.animation = 'none';
    void slapFlash.offsetWidth;
    slapFlash.style.animation = '';
    flashTimer = setTimeout(function () { slapFlash.hidden = true; flashTimer = null; }, 1400);
  }

  onTap(slapBtn, function () {
    if (!table || publicPhase !== 'PLAYING') return;
    if (slapBlock(table, meSeat())) return;
    const now = Date.now();
    if (now - lastSlapSent < 250) return;   // one slap per tap, however the finger bounces
    lastSlapSent = now;
    press(slapBtn);
    buzz(25);
    socket.emit('player:slap', {}, function (res) {
      if (!res) return;
      if (!res.ok) return;
      if (res.result === 'good') {
        buzz([60, 40, 60]);
        flash('good', 'Got it!', [(PATTERN_WORD[res.pattern] || 'Slap') + ' · +' + plural(res.count, 'card')]);
      } else if (res.result === 'bad') {
        buzz(220);
        flash('bad', 'Bad slap!', ['You paid ' + plural(res.burned, 'card') + ' to ', who(res.toId)]);
      } else if (res.result === 'late') {
        if (res.good === false) flash('late', 'Already slapped', [who(res.byId), ' slapped this card first']);
        else flash('late', 'Too slow!', [who(res.byId), ' got there first']);
      }
    });
  });

  onTap(playBtn, function () {
    if (!table || playSending) return;
    if (!playBtn.classList.contains('ready')) {
      if (playBtn.classList.contains('locked')) buzz(8);
      return;
    }
    press(playBtn);
    buzz(18);
    playSending = true;
    // Optimistic: dim at once so a second tap can't send a second card.
    playBtn.classList.remove('ready');
    playBtn.classList.add('idle');
    socket.emit('player:play', {}, function (res) {
      playSending = false;
      if (res && !res.ok && res.reason === 'too-soon') renderGame();
    });
  });

  // ---------------- Socket ----------------
  const socket = io('/ratscrew', { transports: ['polling', 'websocket'] });

  function goRejoin() {
    localStorage.removeItem('ratscrew.playerId');
    if (myName) localStorage.setItem('ratscrew.rejoinName', myName);
    window.location.replace('/ratscrew/join');
  }

  function applyTable(s) {
    if (!s) return;
    table = s;
    publicPhase = s.phase;
    if (typeof s.serverNow === 'number') clockOffset = s.serverNow - Date.now();
    const m = meSeat();
    if (m) mySeat = m.seat;
  }

  socket.on('connect', function () {
    playSending = false;
    socket.emit('player:reconnect', { playerId: PID }, function (res) {
      if (!res || !res.ok) { goRejoin(); return; }
      connOverlay.hidden = true;
      myName = res.player.name;
      mySeat = res.player.seat;
      hostPresent = res.hostPresent !== false;
      reactionsMutedByHost = !!res.reactionsMuted;
      localStorage.setItem('ratscrew.playerName', myName);
      publicPhase = res.phase;
      if (res.table) applyTable(res.table);
      if (res.final) { if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; } renderTop(); renderFinal(res.final); return; }
      route();
    });
  });

  socket.on('disconnect', function () { connOverlay.hidden = false; });

  socket.on('state:lobby', function (l) {
    publicPhase = (l && l.phase) || 'LOBBY';
    if (publicPhase === 'LOBBY') { table = null; lastTurnMine = false; }
    // The host can drag players into new seats in the lobby.
    const mine = l && l.players && l.players.filter(function (p) { return p.id === PID; })[0];
    if (mine && mine.seat) mySeat = mine.seat;
    if (publicPhase === 'LOBBY') route();
  });
  socket.on('state:table', function (s) {
    applyTable(s);
    route();
    updateEmoteState();
  });
  socket.on('state:final', function (f) {
    publicPhase = 'FINAL';
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
    renderTop();
    renderFinal(f);
  });

  socket.on('state:reset', function () { goRejoin(); });
  socket.on('player:rejected', function () { goRejoin(); });

  socket.on('state:hostPresence', function (p) {
    hostPresent = !!(p && p.present);
    updateEmoteState();
  });
  socket.on('state:reactionsMuted', function (p) {
    reactionsMutedByHost = !!(p && p.muted);
    updateEmoteState();
  });

  // ---------------- Emotes (lobby and final standings only) ----------------
  // Must mirror ALLOWED_EMOTES in server/ratscrew/index.js.
  const EMOTES = ['😀', '😂', '😎', '😭', '😡', '👍', '🔥', '💪', '🎉', '😱'];
  // On the table it's a seat bubble; lobby and final float it. The server's ack has the final word.
  const EMOTE_BUBBLE_COOLDOWN_MS = 2500;
  const EMOTE_FLOAT_COOLDOWN_MS = 5 * 1000;
  let emoteUntil = 0;
  let emoteKind = null;     // the kind the running cooldown belongs to
  let emoteCoolTimer = null;

  EMOTES.forEach(function (e) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote-btn';
    b.textContent = e;
    b.dataset.emote = e;
    emoteGrid.appendChild(b);
  });

  function emotesAllowed() {
    return hostPresent && !reactionsMutedByHost;
  }
  function emoteKindNow() { return publicPhase === 'PLAYING' ? 'bubble' : 'float'; }
  // Mirrors the server: a cooldown only holds within the kind that set it.
  function emoteCooling() { return Date.now() < emoteUntil && emoteKind === emoteKindNow(); }
  function setEmotePanel(open) {
    emotePanel.hidden = !open;
    emoteToggle.classList.toggle('open', open);
    emoteToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function updateEmoteState() {
    const ok = emotesAllowed();
    emoteToggle.hidden = !ok;
    if (!ok) setEmotePanel(false);
    emoteToggle.classList.toggle('cooling', emoteCooling());
  }
  function coolFor(ms, kind) {
    emoteUntil = Date.now() + ms;
    emoteKind = kind;
    if (emoteCoolTimer) clearTimeout(emoteCoolTimer);
    emoteCoolTimer = setTimeout(updateEmoteState, ms);
    updateEmoteState();
  }

  onTap(emoteToggle, function () {
    if (!emotesAllowed() || emoteCooling()) return;
    buzz(8);
    setEmotePanel(emotePanel.hidden);
  });

  onTap(emoteGrid, function (e) {
    const b = e.target.closest('.emote-btn');
    if (!b || !emotesAllowed()) return;
    setEmotePanel(false);
    const kind = emoteKindNow();
    coolFor(kind === 'bubble' ? EMOTE_BUBBLE_COOLDOWN_MS : EMOTE_FLOAT_COOLDOWN_MS, kind);
    buzz(15);
    socket.emit('player:emote', { e: b.dataset.emote }, function (res) {
      if (res && res.ok && res.cooldownMs) coolFor(res.cooldownMs, res.kind);
      else if (res && res.reason === 'cooldown' && res.retryInMs) coolFor(res.retryInMs, kind);
    });
  });

  // A tap anywhere outside the panel closes it — and only closes it, so it can
  // never land as a slap or a play underneath.
  document.addEventListener('pointerdown', function (e) {
    if (emotePanel.hidden) return;
    if (e.target.closest('#emotePanel, #emoteToggle')) return;
    e.preventDefault();
    e.stopPropagation();
    setEmotePanel(false);
  }, true);

  updateEmoteState();
})();
