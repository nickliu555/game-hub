(function () {
  'use strict';

  // ============================================================
  // Spades — phone controller.
  //
  // The phone holds the one thing the host screen must never see: this
  // player's hand. It arrives only via `you:hand` (unicast) or the
  // `player:reconnect` ack, and only once the player has chosen to look at it
  // — until then the server withholds the cards so Blind Nil is a real bet.
  //
  // The phone also refuses to offer an illegal card or bid — but that is a
  // courtesy, not the rule. The server validates everything independently.
  // ============================================================

  const PID = localStorage.getItem('spades.playerId');
  if (!PID) { window.location.replace('/spades/join'); return; }

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
  // The card art is shared with Hearts.
  function cardSrc(code) {
    const rank = code.slice(0, code.length - 1);
    const ext = (rank === 'J' || rank === 'Q' || rank === 'K') ? '.webp' : '.svg';
    return '/hearts/assets/cards/' + code + ext;
  }
  const SUIT_SYMBOL = { C: '♣', D: '♦', H: '♥', S: '♠' };
  const SUIT_WORD = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
  function cardLabel(code) { return code.slice(0, code.length - 1) + ' of ' + SUIT_WORD[code.slice(-1)]; }
  function cardShort(code) { return code.slice(0, code.length - 1) + SUIT_SYMBOL[code.slice(-1)]; }
  const TEAM_LABEL = { red: 'Red', blue: 'Blue' };

  // ---------------- DOM ----------------
  const el = function (id) { return document.getElementById(id); };
  const views = {
    wait: el('pv-wait'),
    bid: el('pv-bid'),
    play: el('pv-play'),
    result: el('pv-result'),
  };
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
    // The attribution footer belongs to the lobby only — the waiting view is
    // reused for "Dealing…" once the game is under way.
    if (attribution) attribution.hidden = !(name === 'wait' && publicPhase === 'LOBBY');
    if (name !== 'play' && name !== 'bid') document.body.classList.remove('my-turn');
    currentView = name;
    updateEmoteState();
  }
  let currentView = 'wait';

  const pSeat = el('pSeat');
  const pName = el('pName');
  const pScore = el('pScore');
  const waitTitle = el('waitTitle');
  const waitSub = el('waitSub');
  const waitCard = views.wait.querySelector('.wait-card');

  const bidBoard = el('bidBoard');
  const bidBanner = el('bidBanner');
  const bidFan = el('bidFan');
  const bidFacedown = el('bidFacedown');
  const facedownNote = el('facedownNote');
  const bidGrid = el('bidGrid');
  const blindBtn = el('blindBtn');
  const revealBtn = el('revealBtn');
  const bidBtn = el('bidBtn');

  const mTrick = el('mTrick');
  const mSpades = el('mSpades');
  const mTeam = el('mTeam');
  const playBanner = el('playBanner');
  const playFan = el('playFan');
  const playBtn = el('playBtn');

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

  // The team tag + partner line live on the waiting card, under the subtitle.
  const teamTag = document.createElement('div');
  teamTag.className = 'team-tag';
  teamTag.hidden = true;
  const partnerLine = document.createElement('p');
  partnerLine.className = 'partner-line';
  partnerLine.hidden = true;
  waitCard.appendChild(teamTag);
  waitCard.appendChild(partnerLine);

  const TOAST_FADE_MS = 280;
  let toastTimer = null;
  let toastFadeTimer = null;
  function toast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    if (toastFadeTimer) clearTimeout(toastFadeTimer);
    toastEl.classList.remove('leaving');
    toastEl.textContent = msg;
    toastEl.hidden = false;
    // Replay the entrance when a toast replaces one that's already up.
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


  // ---------------- State ----------------
  let myName = localStorage.getItem('spades.playerName') || '';
  let mySeat = null;
  let myTeam = null;
  let partnerName = null;
  let partnerSeat = null;
  let hand = null;         // latest `you:hand` payload
  let armed = null;        // card lifted, awaiting the Play button
  let bidPick = null;      // bid selected in the grid, awaiting the Bid button
  let blindArmed = false;  // first tap on Blind Nil — the second commits
  // An unconfirmed first tap quietly reverts after a few seconds.
  const ARM_TIMEOUT_MS = 4000;
  let blindArmTimer = null;
  function clearBlindArm() {
    if (blindArmTimer) { clearTimeout(blindArmTimer); blindArmTimer = null; }
    blindArmed = false;
  }
  // …and so does a tap anywhere other than the armed button.
  document.addEventListener('pointerdown', function (e) {
    if (!blindArmed || (e.target.closest && e.target.closest('#blindBtn'))) return;
    clearBlindArm();
    if (hand && publicPhase === 'BID') renderBid();
  }, true);
  let busy = false;        // a reveal / bid is in flight
  let publicPhase = 'LOBBY';
  let hostPresent = true;
  let reactionsMutedByHost = false;

  pName.textContent = myName;

  // ---------------- Rendering ----------------
  function renderTop() {
    if (mySeat) { pSeat.textContent = mySeat; pSeat.dataset.seat = mySeat; }
    pName.textContent = myName;
    if (hand && typeof hand.teamScore === 'number' && publicPhase !== 'LOBBY') {
      pScore.textContent = 'Team: ' + hand.teamScore;
    } else {
      pScore.textContent = '';
    }
  }

  function nameSpan(name, seat, team) {
    const s = document.createElement('span');
    s.className = 'pname turn-name';
    if (seat) s.dataset.seat = seat;
    if (team) s.dataset.team = team;
    s.textContent = name;
    return s;
  }

  /**
   * Where to break a big hand into two rows, or 0 to keep it on one. Splitting
   * by index tears whichever suit straddles the middle across both rows, so the
   * break lands on a suit boundary instead — the one leaving the shortest long
   * row. A single-suit hand has no boundary and stays on one row.
   */
  function suitBreak(cards) {
    // Squeezing 13 cards into one row leaves a sliver too thin to read or aim
    // at, so a big hand is dealt over two rows — that buys back card size and
    // overlap. The hand arrives grouped by suit from the server.
    if (cards.length <= 7) return 0;
    let best = 0;
    let bestLongest = Infinity;
    for (let i = 1; i < cards.length; i++) {
      if (cards[i].slice(-1) === cards[i - 1].slice(-1)) continue;
      const longest = Math.max(i, cards.length - i);
      if (longest < bestLongest) { bestLongest = longest; best = i; }
    }
    return best;
  }

  /**
   * Build a fan of tappable cards.
   * @param {HTMLElement} container
   * @param {string[]} cards
   * @param {(code:string)=>{state:string,label:string}} decorate
   */
  function renderFan(container, cards, decorate, onTap) {
    const breakAt = suitBreak(cards);
    const rowCount = breakAt ? 2 : 1;

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
        rows[breakAt && i >= breakAt ? 1 : 0].appendChild(btn);
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
    const rowEls = container.querySelectorAll('.fan-row');
    const rowCount = rowEls.length || 1;
    // Rows break on a suit boundary, so they are uneven — size everything from
    // the longest one or it spills off the edge.
    let perRow = count;
    for (let i = 0; i < rowEls.length; i++) {
      perRow = i ? Math.max(perRow, rowEls[i].children.length) : rowEls[i].children.length;
    }
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
    const sig = avail + ':' + availH + ':' + count + ':' + rowCount + ':' + perRow;
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
      [bidFan, playFan].forEach(function (c) {
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
    [bidFan, playFan].forEach(function (c) {
      if (c.parentElement) fanObserver.observe(c.parentElement);
    });
  }

  // ---- Bidding ----
  function bidText(s) {
    if (s.bid === null || s.bid === undefined) return null;
    if (s.nil) return s.blind ? 'Blind Nil' : 'Nil';
    return String(s.bid);
  }

  function renderBidBoard(seats, turnPlayerId) {
    bidBoard.innerHTML = '';
    (seats || []).forEach(function (s) {
      const cell = document.createElement('div');
      cell.className = 'bb-cell' + (s.playerId === turnPlayerId ? ' is-turn' : '') + (s.playerId === PID ? ' is-me' : '');
      const pip = document.createElement('span');
      pip.className = 'bb-pip'; pip.dataset.team = s.team; pip.textContent = s.seat;
      const name = document.createElement('span');
      name.className = 'bb-name pname'; name.dataset.team = s.team;
      name.textContent = s.playerId === PID ? 'You' : s.name;
      const bid = document.createElement('span');
      const text = bidText(s);
      bid.className = 'bb-bid' + (text === null ? ' pending' : '') + (s.nil ? ' nil' : '');
      bid.textContent = text === null ? (s.playerId === turnPlayerId ? '…' : '—') : text;
      cell.appendChild(pip); cell.appendChild(name); cell.appendChild(bid);
      bidBoard.appendChild(cell);
    });
  }

  function buildBidGrid() {
    if (bidGrid.childElementCount) return;
    for (let n = 0; n <= 13; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bid-opt' + (n === 0 ? ' nil' : '');
      b.dataset.bid = String(n);
      b.textContent = n === 0 ? 'Nil' : String(n);
      b.setAttribute('aria-label', n === 0 ? 'Bid Nil' : 'Bid ' + n);
      bidGrid.appendChild(b);
    }
  }
  buildBidGrid();

  function renderBid() {
    const seats = hand.seats || [];
    const turn = seats.find(function (s) { return s.seat === hand.bidTurnSeat; });
    renderBidBoard(seats, turn ? turn.playerId : null);

    const yourTurn = !!hand.yourBidTurn;
    document.body.classList.toggle('my-turn', yourTurn);
    bidBanner.textContent = '';
    bidBanner.classList.toggle('your-turn', yourTurn);
    if (yourTurn) {
      bidBanner.textContent = hand.revealed ? 'Your bid!' : 'Your bid — cards face down';
    } else if (hand.bid !== null && hand.bid !== undefined) {
      bidBanner.appendChild(document.createTextNode('You bid '));
      const strong = document.createElement('strong');
      strong.textContent = hand.nil ? (hand.blind ? 'Blind Nil' : 'Nil') : String(hand.bid);
      bidBanner.appendChild(strong);
    } else if (hand.bidTurnName) {
      bidBanner.appendChild(document.createTextNode('Waiting for '));
      bidBanner.appendChild(nameSpan(hand.bidTurnName, hand.bidTurnSeat, turn && turn.team));
      bidBanner.appendChild(document.createTextNode(' to bid…'));
    } else {
      bidBanner.textContent = 'Bidding…';
    }

    if (hand.revealed) {
      bidFacedown.hidden = true;
      bidFan.hidden = false;
      renderFan(bidFan, hand.hand, null, function () {});
    } else {
      bidFan.hidden = true;
      bidFan.innerHTML = '';
      bidFacedown.hidden = false;
      facedownNote.textContent = hand.canBlindNil
        ? 'Bid Blind Nil now for ±200 — or look at your cards and bid normally.'
        : 'Keep them face down to keep a Blind Nil bid open on your turn.';
    }

    const canBid = yourTurn && hand.revealed;
    if (!canBid) bidPick = null;
    if (!hand.canBlindNil) clearBlindArm();

    revealBtn.hidden = hand.revealed;
    revealBtn.disabled = busy;
    blindBtn.hidden = !hand.canBlindNil;
    blindBtn.disabled = busy;
    blindBtn.classList.toggle('armed', blindArmed);
    blindBtn.textContent = blindArmed ? 'Tap again to bid Blind Nil' : 'Bid Blind Nil (±200)';

    bidGrid.hidden = !canBid;
    Array.prototype.forEach.call(bidGrid.children, function (b) {
      b.classList.toggle('on', bidPick !== null && Number(b.dataset.bid) === bidPick);
    });
    bidBtn.hidden = !canBid;
    bidBtn.disabled = busy || bidPick === null;
    bidBtn.classList.toggle('ready', bidPick !== null);
    bidBtn.textContent = bidPick === null ? 'Pick a bid' : (bidPick === 0 ? 'Bid Nil' : 'Bid ' + bidPick);
    show('bid');
  }

  function onTapEl(node, fn) {
    node.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      fn(e);
    });
  }

  onTapEl(bidGrid, function (e) {
    const b = e.target.closest('.bid-opt');
    if (!b || !hand || !hand.yourBidTurn || !hand.revealed || busy) return;
    const n = Number(b.dataset.bid);
    bidPick = bidPick === n ? null : n;
    buzz(10);
    renderBid();
  });

  onTapEl(revealBtn, function () {
    if (busy || !hand || hand.revealed) return;
    busy = true;
    clearBlindArm();
    revealBtn.disabled = true;
    socket.emit('player:reveal', {}, function (res) {
      busy = false;
      if (!res || !res.ok) { toast('Could not turn your cards over.'); renderBid(); return; }
      buzz(15);
      // The server follows up with `you:hand`, now carrying the cards.
    });
  });

  onTapEl(blindBtn, function () {
    if (busy || !hand || !hand.canBlindNil) return;
    if (!blindArmed) {
      blindArmed = true;
      blindArmTimer = setTimeout(function () {
        blindArmTimer = null;
        blindArmed = false;
        if (hand && publicPhase === 'BID') renderBid();
      }, ARM_TIMEOUT_MS);
      buzz(20);
      renderBid();
      return;
    }
    clearBlindArm();
    busy = true;
    blindBtn.disabled = true;
    socket.emit('player:bid', { blind: true }, function (res) {
      busy = false;
      blindArmed = false;
      if (!res || !res.ok) { toast(bidError(res && res.reason)); buzz(60); renderBid(); return; }
      buzz([30, 40, 60]);
    });
  });

  onTapEl(bidBtn, function () {
    if (busy || bidPick === null || !hand || !hand.yourBidTurn) return;
    const bid = bidPick;
    busy = true;
    bidBtn.disabled = true;
    bidBtn.textContent = 'Bidding…';
    socket.emit('player:bid', { bid: bid }, function (res) {
      busy = false;
      if (!res || !res.ok) { toast(bidError(res && res.reason)); buzz(60); if (hand) renderBid(); return; }
      bidPick = null;
      buzz(30);
    });
  });

  function bidError(reason) {
    return {
      'not-your-turn': "It's not your turn to bid.",
      'not-bidding': 'Bidding is already over.',
      'already-bid': "You've already bid.",
      'already-looked': "You've seen your cards — Blind Nil is off the table.",
      'not-looked': 'Look at your cards before bidding.',
      'bad-bid': 'Pick a bid from Nil to 13.',
    }[reason] || 'Could not place that bid.';
  }

  // ---- Playing ----
  function renderPlay() {
    mTrick.textContent = hand.trickNumber;
    mSpades.textContent = hand.spadesBroken ? '♠ broken' : '♠ not broken';
    mSpades.classList.toggle('broken', !!hand.spadesBroken);

    mTeam.textContent = 'Team ' + hand.teamTricks + '/' + hand.teamBid;
    mTeam.classList.remove('made', 'over');
    if (hand.teamTricks > hand.teamBid) mTeam.classList.add('over');
    else if (hand.teamTricks === hand.teamBid) mTeam.classList.add('made');

    const yourTurn = !!hand.yourTurn;
    // The phone is face-down on the table between turns, so the whole top bar
    // lights up rather than only the banner changing.
    document.body.classList.toggle('my-turn', yourTurn);
    playBanner.textContent = '';
    if (yourTurn) {
      playBanner.textContent = 'Your turn!';
    } else if (hand.turnName) {
      const turn = (hand.seats || []).find(function (s) { return s.seat === hand.turnSeat; });
      playBanner.appendChild(document.createTextNode('Waiting for '));
      playBanner.appendChild(nameSpan(hand.turnName, hand.turnSeat, turn && turn.team));
      playBanner.appendChild(document.createTextNode('…'));
    } else {
      playBanner.textContent = 'Waiting for the table…';
    }
    playBanner.classList.toggle('your-turn', yourTurn);


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

  // pointerdown, not click: the double-tap-zoom guard can swallow a quick second tap's click.
  onTapEl(playBtn, commitPlay);

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
  function signed(n) { return n > 0 ? '+' + n : (n < 0 ? '−' + (-n) : '0'); }

  function teamDetail(r) {
    const parts = [];
    if (r.contract > 0 || !r.players.every(function (p) { return p.nil; })) {
      parts.push('Bid ' + r.contract + ' · took ' + r.won + (r.made ? '' : ' (missed)'));
    }
    r.players.forEach(function (p) {
      if (p.nil) parts.push(p.name + ' ' + (p.blind ? 'Blind Nil' : 'Nil') + (p.nilMade ? ' ✓' : ' ✗'));
    });
    if (r.bagsThisHand) parts.push(r.bagsThisHand + (r.bagsThisHand === 1 ? ' bag' : ' bags'));
    if (r.bagPenalty) parts.push('bag penalty ' + signed(r.bagPenalty));
    return parts.join(' · ');
  }

  function teamRow(team, names, detail, total, delta, mine) {
    const row = document.createElement('div');
    row.className = 'result-row' + (mine ? ' is-me' : '');
    const s = document.createElement('span');
    s.className = 'rr-seat'; s.dataset.team = team; s.textContent = team === 'red' ? 'R' : 'B';
    const n = document.createElement('span');
    n.className = 'rr-name';
    const t = document.createElement('span');
    t.className = 'rr-team'; t.dataset.team = team; t.textContent = 'Team ' + TEAM_LABEL[team];
    const who = document.createElement('span');
    who.className = 'pname'; who.dataset.team = team; who.textContent = names.join(' & ');
    n.appendChild(t); n.appendChild(who);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'rr-detail'; d.textContent = detail;
      n.appendChild(d);
    }
    row.appendChild(s); row.appendChild(n);
    if (delta !== null && delta !== undefined) {
      const d = document.createElement('span');
      d.className = 'rr-delta ' + (delta > 0 ? 'plus' : (delta < 0 ? 'minus' : ''));
      d.textContent = signed(delta);
      row.appendChild(d);
    }
    const sc = document.createElement('span');
    sc.className = 'rr-score';
    sc.textContent = total;
    row.appendChild(sc);
    return row;
  }

  function renderHandEnd(s) {
    const results = s.results || {};
    const mine = results[myTeam];
    const me = mine && mine.players.find(function (p) { return p.playerId === PID; });

    if (s.gameOver) {
      const won = s.winnerTeam === myTeam;
      resultEmoji.textContent = won ? '🏆' : '😔';
      resultTitle.textContent = won ? 'Your team wins!' : 'Team ' + TEAM_LABEL[s.winnerTeam] + ' wins';
      resultSub.textContent = 'Final hand complete.';
    } else if (me && me.nil) {
      resultEmoji.textContent = me.nilMade ? '🎯' : '💥';
      resultTitle.textContent = (me.blind ? 'Blind Nil' : 'Nil') + (me.nilMade ? ' made! ' : ' busted ') + signed(me.nilPoints);
      resultSub.textContent = '';
    } else if (mine) {
      resultEmoji.textContent = mine.made ? '✅' : '❌';
      resultTitle.textContent = mine.made ? 'Bid made!' : 'Bid missed';
      resultSub.textContent = signed(mine.delta) + ' for your team.';
    } else {
      resultEmoji.textContent = '♠️';
      resultTitle.textContent = 'Hand over';
      resultSub.textContent = '';
    }

    resultRows.innerHTML = '';
    resultRows.classList.remove('no-delta');
    ['red', 'blue'].sort(function (a, b) { return a === myTeam ? -1 : (b === myTeam ? 1 : 0); }).forEach(function (t) {
      const r = results[t];
      if (!r) return;
      resultRows.appendChild(teamRow(t, r.players.map(function (p) { return p.name; }), teamDetail(r), r.total, r.delta, t === myTeam));
    });
    show('result');
    if (s.gameOver && s.winnerTeam === myTeam) buzz([40, 60, 40, 60, 120]);
  }

  function renderFinal(s) {
    const won = s.winnerTeam === myTeam;
    resultEmoji.textContent = won ? '🏆' : '🫡';
    if (won) {
      resultTitle.textContent = 'Your team wins!';
      resultSub.textContent = s.reason === 'floor' ? 'The other team sank to ' + s.losingScore + '.' : 'First to ' + s.targetScore + '.';
    } else if (s.winnerLabel) {
      resultTitle.textContent = 'Team ' + s.winnerLabel + ' wins';
      resultSub.textContent = 'Better luck next game.';
    } else {
      resultTitle.textContent = 'Game over';
      resultSub.textContent = '';
    }
    resultRows.innerHTML = '';
    resultRows.classList.add('no-delta');
    (s.standings || []).forEach(function (r) {
      resultRows.appendChild(teamRow(r.team, r.players.map(function (p) { return p.name; }),
        r.bags ? r.bags + (r.bags === 1 ? ' bag' : ' bags') : '', r.score, null, r.team === myTeam));
    });
    show('result');
    if (won) buzz([40, 60, 40, 60, 120]);
  }

  // ---- Waiting screen ----
  function renderWait(title, sub) {
    waitTitle.textContent = title;
    waitSub.textContent = sub;
    teamTag.hidden = !myTeam;
    if (myTeam) {
      teamTag.dataset.team = myTeam;
      teamTag.textContent = (myTeam === 'red' ? '🔴' : '🔵') + ' Team ' + TEAM_LABEL[myTeam];
    }
    partnerLine.textContent = '';
    partnerLine.hidden = !myTeam;
    if (myTeam) {
      if (partnerName) {
        partnerLine.appendChild(document.createTextNode('Your partner is '));
        const who = nameSpan(partnerName, partnerSeat, myTeam);
        who.classList.remove('turn-name');
        partnerLine.appendChild(who);
      } else {
        partnerLine.textContent = 'Waiting for a partner to join…';
      }
    }
    show('wait');
  }

  /** Pick the right screen from the private hand plus the public phase. */
  function route() {
    renderTop();
    if (publicPhase === 'LOBBY') { renderWait("You're in!", 'Waiting for the host to deal…'); return; }
    if (publicPhase === 'FINAL') return;             // renderFinal owns the view
    if (publicPhase === 'HAND_END') return;          // renderHandEnd owns the view
    if (!hand || publicPhase === 'DEAL') { renderWait('Dealing…', 'Your cards are coming — face down.'); return; }
    if (publicPhase === 'BID') { renderBid(); return; }
    renderPlay();     // TRICK and TRICK_END both show the hand
  }

  /** Team, seat and partner from a lobby snapshot (the host can move us). */
  function adoptLobby(l) {
    const me = l && l.players && l.players.filter(function (p) { return p.id === PID; })[0];
    if (!me) return;
    if (me.seat) mySeat = me.seat;
    if (me.team) myTeam = me.team;
    const mate = l.players.filter(function (p) { return p.team === me.team && p.id !== PID; })[0];
    partnerName = mate ? mate.name : null;
    partnerSeat = mate ? mate.seat : null;
  }

  /** The same facts from a private hand snapshot, mid-game. */
  function adoptHand(h) {
    if (h.team) myTeam = h.team;
    if (h.seat) mySeat = h.seat;
    if (h.partner) { partnerName = h.partner.name; partnerSeat = h.partner.seat; }
  }

  // ---------------- Socket ----------------
  const socket = io('/spades', { transports: ['polling', 'websocket'] });

  function goRejoin() {
    localStorage.removeItem('spades.playerId');
    if (myName) localStorage.setItem('spades.rejoinName', myName);
    window.location.replace('/spades/join');
  }

  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: PID }, function (res) {
      if (!res || !res.ok) { goRejoin(); return; }
      connOverlay.hidden = true;
      myName = res.player.name;
      mySeat = res.player.seat;
      myTeam = res.player.team || myTeam;
      hostPresent = res.hostPresent !== false;
      reactionsMutedByHost = !!res.reactionsMuted;
      localStorage.setItem('spades.playerName', myName);
      publicPhase = res.phase;
      busy = false;
      if (res.lobby) adoptLobby(res.lobby);
      if (res.myHand) { hand = res.myHand; adoptHand(hand); armed = null; bidPick = null; clearBlindArm(); }
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
    adoptHand(h);
    // A fresh deal clears anything we had staged.
    if (!prev || prev.handNumber !== h.handNumber) { armed = null; bidPick = null; clearBlindArm(); }
    publicPhase = h.phase;
    route();
  });

  function setPhase(phase) {
    publicPhase = phase;
    route();
  }
  socket.on('state:lobby', function (l) {
    hand = null;
    adoptLobby(l);
    setPhase('LOBBY');
  });
  socket.on('state:deal', function () { setPhase('DEAL'); });
  socket.on('state:bid', function () { setPhase('BID'); });
  socket.on('state:table', function () { setPhase('TRICK'); });
  socket.on('state:trickEnd', function () { setPhase('TRICK_END'); });
  socket.on('state:handEnd', function (s) {
    publicPhase = 'HAND_END';
    armed = null; bidPick = null; clearBlindArm();
    renderTop();
    renderHandEnd(s);
  });
  socket.on('state:final', function (s) {
    publicPhase = 'FINAL';
    renderTop();
    renderFinal(s);
  });

  socket.on('state:spadesBroken', function () {
    if (currentView === 'play') { toast('Spades have been broken! ♠'); buzz([20, 40, 20]); }
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

  // ---------------- Emotes ----------------
  // Must mirror ALLOWED_EMOTES in server/spades/index.js.
  const EMOTES = ['😀', '😂', '😎', '😭', '😡', '👍', '🔥', '💪', '🎉', '😱'];
  // The felt (bidding or a trick) shows a seat bubble; every other screen floats it. The
  // server's ack has the final word.
  const EMOTE_BUBBLE_COOLDOWN_MS = 2500;
  const EMOTE_FLOAT_COOLDOWN_MS = 10 * 1000;
  let emoteUntil = 0;
  let emoteKind = null;     // the kind the running cooldown belongs to
  let emoteCoolTimer = null;

  function onTap(node, fn) {
    node.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      fn(e);
    });
  }

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
  function setEmotePanel(open) {
    emotePanel.hidden = !open;
    emoteToggle.classList.toggle('open', open);
    emoteToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function emoteKindNow() {
    return publicPhase === 'BID' || publicPhase === 'TRICK' || publicPhase === 'TRICK_END' ? 'bubble' : 'float';
  }
  // Mirrors the server: a cooldown only holds within the kind that set it.
  function emoteCooling() {
    return Date.now() < emoteUntil && emoteKind === emoteKindNow();
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

  // A tap anywhere outside the panel closes it.
  document.addEventListener('pointerdown', function (e) {
    if (emotePanel.hidden) return;
    if (e.target.closest('#emotePanel, #emoteToggle')) return;
    setEmotePanel(false);
  });

  updateEmoteState();
})();
