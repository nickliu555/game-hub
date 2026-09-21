(function () {
  'use strict';

  // ============================================================
  // Hearts — phone controller.
  //
  // The phone holds the one thing the host screen must never see: this
  // player's hand. It arrives only via `you:hand` (unicast) or the
  // `player:reconnect` ack, and the server re-sends it after every state
  // change so the `legal` list can never go stale.
  //
  // The phone also refuses to offer an illegal card — but that is a courtesy,
  // not the rule. The server validates every play independently.
  // ============================================================

  const PID = localStorage.getItem('hearts.playerId');
  if (!PID) { window.location.replace('/hearts/join'); return; }

  // ---------------- Kill all zoom / scroll / selection behaviour ----------------
  // iOS Safari ignores maximum-scale/user-scalable, and a stray long-press or
  // double-tap while picking cards would eat the input, so block it explicitly:
  // pinch (iOS gesture events + every touch move), double-tap-to-zoom, and the
  // long-press callout.
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

  // ---------------- Card assets ----------------
  function cardSrc(code) {
    const rank = code.slice(0, code.length - 1);
    const ext = (rank === 'J' || rank === 'Q' || rank === 'K') ? '.webp' : '.svg';
    return '/hearts/assets/cards/' + code + ext;
  }
  const SUIT_SYMBOL = { C: '♣', D: '♦', H: '♥', S: '♠' };
  const SUIT_WORD = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
  function cardLabel(code) { return code.slice(0, code.length - 1) + ' of ' + SUIT_WORD[code.slice(-1)]; }
  function cardShort(code) { return code.slice(0, code.length - 1) + SUIT_SYMBOL[code.slice(-1)]; }

  // ---------------- DOM ----------------
  const el = function (id) { return document.getElementById(id); };
  const views = {
    wait: el('pv-wait'),
    pass: el('pv-pass'),
    passed: el('pv-passed'),
    play: el('pv-play'),
    result: el('pv-result'),
  };
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
    // The attribution footer only belongs on the waiting/lobby screen.
    currentView = name;
  }
  let currentView = 'wait';

  const pSeat = el('pSeat');
  const pName = el('pName');
  const pScore = el('pScore');
  const waitTitle = el('waitTitle');
  const waitSub = el('waitSub');

  const passDirText = el('passDirText');
  const passHint = el('passHint');
  const passFan = el('passFan');
  const passBtn = el('passBtn');
  const swapIcon = el('swapIcon');
  const swapTitle = el('swapTitle');
  const swapSub = el('swapSub');
  const swapFan = el('swapFan');

  const mTrick = el('mTrick');
  const mHearts = el('mHearts');
  const mPoints = el('mPoints');
  const playBanner = el('playBanner');
  const playHint = el('playHint');
  const playFan = el('playFan');
  const playBtn = el('playBtn');

  const resultEmoji = el('resultEmoji');
  const resultTitle = el('resultTitle');
  const resultSub = el('resultSub');
  const resultRows = el('resultRows');

  const connOverlay = el('pConnOverlay');
  const toastEl = el('pToast');

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; toastTimer = null; }, 2400);
  }

  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (_) {} }
  }

  // ---------------- State ----------------
  let myName = localStorage.getItem('hearts.playerName') || '';
  let mySeat = null;
  let hand = null;         // latest `you:hand` payload
  let picks = [];          // cards selected to pass
  let armed = null;        // card lifted, awaiting the confirm tap
  let publicPhase = 'LOBBY';
  let lastHandEnd = null;

  pName.textContent = myName;

  // ---------------- Rendering ----------------
  function renderTop() {
    if (mySeat) { pSeat.textContent = mySeat; pSeat.dataset.seat = mySeat; }
    pName.textContent = myName;
    if (hand && typeof hand.total === 'number' && publicPhase !== 'LOBBY') {
      pScore.textContent = hand.total + ' pts';
    } else {
      pScore.textContent = '';
    }
  }

  /**
   * Build a fan of tappable cards.
   * @param {HTMLElement} container
   * @param {string[]} cards
   * @param {(code:string)=>{state:string,label:string}} decorate
   */
  function renderFan(container, cards, decorate, onTap) {
    // Squeezing 13 cards into one row leaves a sliver too thin to read or aim
    // at, so a big hand is dealt over two rows instead — that buys back both
    // card size and overlap.
    const rowCount = cards.length > 7 ? 2 : 1;
    const perRow = Math.ceil(cards.length / rowCount);

    // Rebuilding the fan reloads every <img> and restarts every transition, so
    // the whole hand flashes when only one card's selection changed. Reuse the
    // buttons whenever the cards themselves haven't moved.
    let btns = Array.prototype.slice.call(container.querySelectorAll('.hand-card'));
    const reuse = btns.length === cards.length
      && container.querySelectorAll('.fan-row').length === rowCount
      && btns.every(function (b, i) { return b.dataset.card === cards[i]; });

    if (!reuse) {
      container.innerHTML = '';
      const rows = [];
      for (let i = 0; i < rowCount; i++) {
        const row = document.createElement('div');
        row.className = 'fan-row';
        rows.push(row);
        container.appendChild(row);
      }
      btns = cards.map(function (code, i) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hand-card';
        btn.dataset.card = code;
        const img = document.createElement('img');
        img.src = cardSrc(code);
        img.alt = '';
        img.draggable = false;
        btn.appendChild(img);
        // pointerdown, not click: the double-tap-zoom guard swallows some clicks.
        btn.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          btn._onTap(code);
        });
        rows[Math.floor(i / perRow)].appendChild(btn);
        return btn;
      });
    }

    btns.forEach(function (btn, i) {
      const code = cards[i];
      btn._onTap = onTap;
      const d = decorate ? decorate(code) : {};
      btn.classList.toggle('picked', d.state === 'picked');
      btn.classList.toggle('armed', d.state === 'armed');
      btn.classList.toggle('illegal', d.state === 'illegal');
      if (d.pick) btn.dataset.pick = d.pick;
      else delete btn.dataset.pick;
      btn.setAttribute('aria-label', cardLabel(code) + (d.label ? ' — ' + d.label : ''));
    });

    fitFan(container, cards.length);
  }

  /**
   * A 13-card hand cannot fit a phone at full card width, so the fan overlaps.
   * Both the overlap AND the card size are computed from the real container
   * box rather than hard-coded: a fixed overlap spills the last cards off the
   * right edge at 13 cards, and a fixed card size wastes most of the screen at
   * 5. Cards grow to fill the space available and only shrink once the width
   * genuinely runs out.
   */
  function fitFan(container, count) {
    if (!count) return;
    const area = container.parentElement;
    if (!area) return;
    const rowCount = container.querySelectorAll('.fan-row').length || 1;
    const perRow = Math.ceil(count / rowCount);
    // Measured rather than hard-coded: the paddings change with the viewport
    // media queries, and guessing them either overflows or wastes space.
    const fcs = getComputedStyle(container);
    const acs = getComputedStyle(area);
    const padX = parseFloat(fcs.paddingLeft) + parseFloat(fcs.paddingRight)
      + parseFloat(acs.paddingLeft) + parseFloat(acs.paddingRight);
    const padY = parseFloat(fcs.paddingTop) + parseFloat(fcs.paddingBottom)
      + parseFloat(acs.paddingTop) + parseFloat(acs.paddingBottom);
    const gap = parseFloat(fcs.rowGap) || 0;
    const avail = area.clientWidth - padX;
    const availH = area.clientHeight - padY - (rowCount - 1) * gap;
    if (avail <= 0 || availH <= 0) return;
    // Also guards the ResizeObserver against feeding itself.
    const sig = avail + ':' + availH + ':' + count + ':' + rowCount;
    if (container._fitSig === sig) return;
    container._fitSig = sig;

    const MIN_VISIBLE = 20;         // absolute floor for a card's corner index
    const VISIBLE_FRACTION = 0.32;  // …and a share of the card, so big cards keep big slivers
    const MAX_CARD = 128;
    const MIN_CARD = 44;

    // The widest card that still leaves every other card a readable sliver…
    const byWidth = perRow > 1 ? avail - (perRow - 1) * MIN_VISIBLE : avail;
    const byFan = perRow > 1 ? avail / (1 + (perRow - 1) * VISIBLE_FRACTION) : avail;
    // …and the tallest that fits its row (cards are 1.4× as tall as wide).
    const byHeight = (availH / rowCount) / 1.4;

    let cardW = Math.max(MIN_CARD, Math.floor(Math.min(MAX_CARD, byWidth, byFan, byHeight)));

    let overlap = perRow > 1 ? (avail - cardW) / (perRow - 1) : cardW;
    if (overlap > cardW * 0.62) overlap = cardW * 0.62;   // don't fan out sparsely
    if (overlap < MIN_VISIBLE) overlap = MIN_VISIBLE;

    container.style.setProperty('--card-w', cardW + 'px');
    container.style.setProperty('--overlap', overlap.toFixed(2) + 'px');
  }

  // Re-fit on rotation / resize.
  let fitTimer = null;
  window.addEventListener('resize', function () {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(function () {
      [passFan, playFan].forEach(function (c) {
        const n = c.querySelectorAll('.hand-card').length;
        if (n) fitFan(c, n);
      });
    }, 120);
  });

  // A fan is usually built while its view is still hidden, so the first measure
  // reads a zero-sized box; re-fit the moment the area actually gets a size.
  if (typeof ResizeObserver === 'function') {
    const fanObserver = new ResizeObserver(function (entries) {
      entries.forEach(function (e) {
        const c = e.target.querySelector('.hand-fan');
        const n = c ? c.querySelectorAll('.hand-card').length : 0;
        if (n) fitFan(c, n);
      });
    });
    [passFan, playFan].forEach(function (c) {
      if (c.parentElement) fanObserver.observe(c.parentElement);
    });
  }

  // ---- Passing ----
  function renderPass() {
    const to = hand.passTo;
    passDirText.textContent = '3 cards';
    if (to) {
      passDirText.appendChild(document.createTextNode(' to '));
      const who = document.createElement('span');
      who.className = 'pname turn-name';
      who.dataset.seat = to.seat;
      who.textContent = to.name;
      passDirText.appendChild(who);
    }
    passHint.textContent = picks.length === 3
      ? 'Ready to pass — tap a card to swap it out'
      : 'Tap ' + (3 - picks.length) + ' more card' + (3 - picks.length === 1 ? '' : 's');

    renderFan(passFan, hand.hand, function (code) {
      const i = picks.indexOf(code);
      return i >= 0 ? { state: 'picked', pick: String(i + 1), label: 'selected to pass' } : {};
    }, togglePick);

    passBtn.disabled = picks.length !== 3;
    passBtn.classList.toggle('ready', picks.length === 3);
    passBtn.textContent = picks.length === 3
      ? 'Pass ' + picks.map(cardShort).join(' · ')
      : 'Choose ' + (3 - picks.length) + ' more';
    show('pass');
  }

  function togglePick(code) {
    const i = picks.indexOf(code);
    if (i >= 0) picks.splice(i, 1);
    else {
      if (picks.length >= 3) { toast('Tap a selected card to swap it out.'); buzz(30); return; }
      picks.push(code);
    }
    buzz(12);
    renderPass();
  }

  passBtn.addEventListener('click', function () {
    if (picks.length !== 3) return;
    passBtn.disabled = true;
    socket.emit('player:pass', { cards: picks.slice() }, function (res) {
      if (!res || !res.ok) {
        passBtn.disabled = false;
        toast(passError(res && res.reason));
        return;
      }
      picks = [];
      buzz(40);
    });
  });
  function passError(reason) {
    return {
      'need-three': 'Pick exactly 3 cards.',
      'duplicate-card': 'Pick 3 different cards.',
      'not-in-hand': 'That card is not in your hand — reloading.',
      'already-passed': "You've already passed.",
      'not-passing': 'Too late — the cards are already on their way.',
    }[reason] || 'Could not pass. Try again.';
  }

  /** Shared screen for "cards away" and "cards received". */
  function renderSwap(icon, title, sub, cards, from) {
    swapIcon.textContent = icon;
    swapTitle.textContent = title;
    swapSub.textContent = '';
    if (from) {
      swapSub.appendChild(document.createTextNode('Three cards from '));
      const who = document.createElement('span');
      who.className = 'pname swap-from';
      who.dataset.seat = from.seat;
      who.textContent = from.name;
      swapSub.appendChild(who);
    } else {
      swapSub.textContent = sub;
    }
    swapFan.innerHTML = '';
    (cards || []).forEach(function (code) {
      const img = document.createElement('img');
      img.src = cardSrc(code);
      img.alt = cardLabel(code);
      img.draggable = false;
      swapFan.appendChild(img);
    });
    show('passed');
  }

  // ---- Playing ----
  function renderPlay() {
    mTrick.textContent = hand.trickNumber;
    mHearts.textContent = hand.heartsBroken ? '♥ broken' : '♥ not broken';
    mHearts.classList.toggle('broken', !!hand.heartsBroken);
    mPoints.textContent = (hand.handPoints > 0 ? '+' + hand.handPoints : String(hand.handPoints)) + ' this hand';
    mPoints.classList.toggle('scoring', hand.handPoints > 0);
    mPoints.classList.toggle('bonus', hand.handPoints < 0);

    const yourTurn = !!hand.yourTurn;
    playBanner.textContent = '';
    if (yourTurn) {
      playBanner.textContent = 'Your turn!';
    } else if (hand.turnName) {
      const who = document.createElement('span');
      who.className = 'pname turn-name';
      if (hand.turnSeat) who.dataset.seat = hand.turnSeat;
      who.textContent = hand.turnName;
      playBanner.appendChild(document.createTextNode('Waiting for '));
      playBanner.appendChild(who);
      playBanner.appendChild(document.createTextNode('…'));
    } else {
      playBanner.textContent = 'Waiting for the table…';
    }
    playBanner.classList.toggle('your-turn', yourTurn);

    if (yourTurn && hand.reason) { playHint.textContent = hand.reason; playHint.classList.add('warn'); }
    else if (yourTurn) { playHint.textContent = 'Tap a card, then press Play'; playHint.classList.remove('warn'); }
    else { playHint.textContent = ''; playHint.classList.remove('warn'); }

    const legal = hand.legal || [];
    // The armed card must still be playable after any state change.
    if (armed && (!yourTurn || legal.indexOf(armed) < 0)) armed = null;

    renderFan(playFan, hand.hand, function (code) {
      if (!yourTurn) return {};
      if (legal.indexOf(code) < 0) return { state: 'illegal', label: 'not playable' };
      if (code === armed) return { state: 'armed', label: 'ready to play' };
      return {};
    }, armCard);

    if (!yourTurn) {
      playBtn.disabled = true;
      playBtn.classList.remove('ready');
      playBtn.textContent = 'Waiting…';
    } else if (armed) {
      playBtn.disabled = false;
      playBtn.classList.add('ready');
      playBtn.textContent = 'Play ' + cardShort(armed);
    } else {
      playBtn.disabled = true;
      playBtn.classList.remove('ready');
      playBtn.textContent = 'Tap a card';
    }
    show('play');
  }

  function armCard(code) {
    if (!hand || !hand.yourTurn) return;
    if ((hand.legal || []).indexOf(code) < 0) return;
    // Tapping the armed card again only deselects it — the Play button is the
    // one and only way to commit, so a stray double tap can't throw a card away.
    armed = armed === code ? null : code;
    buzz(12);
    renderPlay();
  }

  playBtn.addEventListener('click', commitPlay);

  function commitPlay() {
    if (!armed || !hand || !hand.yourTurn) return;
    const card = armed;
    armed = null;
    playBtn.disabled = true;
    playBtn.textContent = 'Playing…';
    socket.emit('player:play', { card: card }, function (res) {
      if (!res || !res.ok) {
        toast(playError(res && res.reason));
        buzz(60);
        // The server re-sends `you:hand` on a rejection, which re-renders us.
        return;
      }
      buzz(30);
    });
  }
  function playError(reason) {
    return {
      'not-your-turn': "It's not your turn yet.",
      'illegal-card': "You can't play that card right now.",
      'not-in-hand': 'That card is no longer in your hand.',
      'not-playing': 'The trick has already moved on.',
    }[reason] || 'Could not play that card.';
  }

  // ---- Hand / game result ----
  function renderHandEnd(s) {
    lastHandEnd = s;
    const rows = (s.rows || []).slice().sort(function (a, b) { return a.total - b.total; });
    const me = rows.find(function (r) { return r.playerId === PID; });

    if (s.moonShooterId === PID) {
      resultEmoji.textContent = '🌙';
      resultTitle.textContent = 'You shot the moon!';
      resultSub.textContent = 'Everyone else takes 26.';
    } else if (s.moonShooterId) {
      resultEmoji.textContent = '💥';
      resultTitle.textContent = s.moonShooterName + ' shot the moon';
      resultSub.textContent = 'That is 26 points for you.';
    } else if (me && me.delta <= 0) {
      resultEmoji.textContent = '😎';
      // Low score wins, so a negative delta is good — but "gained" would contradict
      // the −3 printed in this player's own row below.
      resultTitle.textContent = me.delta < 0 ? '−' + (-me.delta) + ' points' : 'Clean hand!';
      resultSub.textContent = 'Hand ' + s.handNumber + ' complete.';
    } else {
      resultEmoji.textContent = me && me.delta >= 13 ? '😬' : '♥️';
      resultTitle.textContent = me ? '+' + me.delta + ' points' : 'Hand over';
      resultSub.textContent = 'Hand ' + s.handNumber + ' complete.';
    }

    resultRows.innerHTML = '';
    rows.forEach(function (r) { resultRows.appendChild(resultRow(r.seat, r.name, r.total, r.delta, r.playerId === PID)); });
    show('result');
  }

  function renderFinal(s) {
    const won = (s.winnerIds || []).indexOf(PID) >= 0;
    resultEmoji.textContent = won ? '🏆' : '🫡';
    if (won) {
      resultTitle.textContent = (s.winnerIds.length > 1) ? 'You share the win!' : 'You win!';
      resultSub.textContent = 'Lowest score takes it.';
    } else {
      const names = s.winnerNames || [];
      resultTitle.textContent = names.length ? names.join(' & ') + ' won' : 'Game over';
      resultSub.textContent = 'Better luck next hand.';
    }
    resultRows.innerHTML = '';
    (s.standings || []).forEach(function (r) {
      resultRows.appendChild(resultRow(r.seat, r.name, r.total, null, r.playerId === PID));
    });
    show('result');
    if (won) buzz([40, 60, 40, 60, 120]);
  }

  function resultRow(seat, name, total, delta, isMe) {
    const row = document.createElement('div');
    row.className = 'result-row' + (isMe ? ' is-me' : '');
    const s = document.createElement('span');
    s.className = 'rr-seat'; s.dataset.seat = seat; s.textContent = seat;
    const n = document.createElement('span');
    n.className = 'rr-name pname'; n.textContent = name;
    const sc = document.createElement('span');
    sc.className = 'rr-score';
    sc.textContent = total;
    if (delta !== null && delta !== undefined) {
      const d = document.createElement('span');
      d.className = 'rr-delta ' + (delta > 0 ? 'plus' : (delta < 0 ? 'minus' : ''));
      d.textContent = delta > 0 ? '+' + delta : String(delta);
      sc.appendChild(d);
    }
    row.appendChild(s); row.appendChild(n); row.appendChild(sc);
    return row;
  }

  // ---- Waiting screen ----
  function renderWait(title, sub) {
    waitTitle.textContent = title;
    waitSub.textContent = sub;
    show('wait');
  }

  /** Pick the right screen from the private hand plus the public phase. */
  function route() {
    renderTop();
    if (publicPhase === 'LOBBY') { renderWait("You're in!", 'Waiting for the host to deal…'); return; }
    if (publicPhase === 'FINAL') return;             // renderFinal owns the view
    if (publicPhase === 'HAND_END') return;          // renderHandEnd owns the view
    if (!hand) { renderWait('Dealing…', 'Your cards are on the way.'); return; }

    if (publicPhase === 'DEAL') { renderWait('Dealing…', 'Your cards are on the way.'); return; }
    if (publicPhase === 'PASS') {
      if (hand.passed) {
        renderSwap('✓', 'Cards away', 'Waiting for everyone else to pass…', hand.myPass);
      } else {
        renderPass();
      }
      return;
    }
    if (publicPhase === 'EXCHANGE') {
      const from = hand.receivedFrom;
      // You receive from the opposite way round to the way you passed.
      const dirWord = {
        left: 'the seat counter-clockwise from you',
        right: 'the seat clockwise from you',
        across: 'the player across from you',
      }[hand.passDirection] || 'another player';
      renderSwap('🎁', 'You received', from ? null : 'Three cards from ' + dirWord + '.', hand.received, from);
      return;
    }
    renderPlay();     // TRICK and TRICK_END both show the hand
  }

  // ---------------- Socket ----------------
  const socket = io('/hearts', { transports: ['polling', 'websocket'] });

  function goRejoin() {
    localStorage.removeItem('hearts.playerId');
    if (myName) localStorage.setItem('hearts.rejoinName', myName);
    window.location.replace('/hearts/join');
  }

  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: PID }, function (res) {
      if (!res || !res.ok) { goRejoin(); return; }
      connOverlay.hidden = true;
      myName = res.player.name;
      mySeat = res.player.seat;
      localStorage.setItem('hearts.playerName', myName);
      publicPhase = res.phase;
      if (res.myHand) { hand = res.myHand; picks = []; armed = null; }
      // A reconnect mid-scoreboard should land on the scoreboard.
      if (res.handEnd) { renderTop(); renderHandEnd(res.handEnd); return; }
      if (res.final) { renderTop(); renderFinal(res.final); return; }
      route();
    });
  });

  socket.on('disconnect', function () { connOverlay.hidden = false; });

  // The one event that carries cards — always unicast, never broadcast.
  socket.on('you:hand', function (h) {
    if (!h) return;
    const prev = hand;
    hand = h;
    // A fresh deal clears anything we had staged.
    if (!prev || prev.handNumber !== h.handNumber) { picks = []; armed = null; }
    if (!h.passed && prev && prev.passed) picks = [];
    publicPhase = h.phase;
    route();
  });

  function setPhase(phase) {
    publicPhase = phase;
    route();
  }
  socket.on('state:lobby', function () { hand = null; setPhase('LOBBY'); });
  socket.on('state:deal', function () { setPhase('DEAL'); });
  socket.on('state:pass', function () { setPhase('PASS'); });
  socket.on('state:exchange', function () { setPhase('EXCHANGE'); });
  socket.on('state:table', function () { setPhase('TRICK'); });
  socket.on('state:trickEnd', function () { setPhase('TRICK_END'); });
  socket.on('state:handEnd', function (s) {
    publicPhase = 'HAND_END';
    armed = null; picks = [];
    renderTop();
    renderHandEnd(s);
  });
  socket.on('state:final', function (s) {
    publicPhase = 'FINAL';
    renderTop();
    renderFinal(s);
  });

  socket.on('state:heartsBroken', function () {
    if (currentView === 'play') { toast('Hearts have been broken! 💔'); buzz([20, 40, 20]); }
  });

  socket.on('state:reset', function () { goRejoin(); });
  socket.on('player:rejected', function () { goRejoin(); });
})();
