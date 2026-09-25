// ─── State ──────────────────────────────────────────
let wordsLoaded = false;
let attributionLoaded = false;
let hearWords = [];
let hearIndex = 0;
let hearActive = false;
let hearPaused = false;
let hearTimeout = null;
const CATEGORIES = [
    'Movies', 'Books', 'Celebrities', 'Musicians', 'Albums',
    'Superheroes', 'Animals', 'Villains', 'Sea Creatures', 'TV Shows',
    'Occupations', 'Cities', 'Countries', 'Sports Teams', 'Restaurants',
    'Food', 'Drinks', 'Brands', 'Video Games', 'Songs',
    'Actors', 'Fictional Characters', 'Colleges', 'Historical Figures', 'Athletes',
    "Card Games", "Mythical Creatures"
];
let currentCategory = '';

// ─── Timer State ────────────────────────────────
let timerDuration = 30;
let timerRemaining = 30;
let timerInterval = null;
let timerRunning = false;
// Final-countdown beeps are pre-scheduled on the AudioContext clock so
// the first beep isn't delayed by audio graph cold-start (which made
// the 5->4 gap shorter than the rest).
let scheduledBeepNodes = [];
let finalBeepsScheduled = false;

// Pick the best available English voice for browser TTS
let cachedVoice = null;
function getBestVoice() {
    if (cachedVoice) return cachedVoice;
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    // Prefer high-quality/enhanced voices by name (varies by OS)
    const preferred = [
        'Samantha', 'Karen', 'Daniel',                    // macOS
        'Google UK English Female', 'Google US English',  // Chrome
        'Microsoft Zira', 'Microsoft David',              // Windows
    ];
    for (const name of preferred) {
        const v = voices.find(v => v.name.includes(name));
        if (v) { cachedVoice = v; return v; }
    }
    // Fallback: any en voice
    cachedVoice = voices.find(v => v.lang && v.lang.startsWith('en')) || null;
    return cachedVoice;
}
// Preload voices (some browsers load async)
if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => { cachedVoice = null; getBestVoice(); };
}
let editingCategory = false;
const MAX_BOTS = 10;
let botCount = 0;
let spinnerPlayers = [];
let spinnerDone = false;
let knownHostGameId = null;
let knownHostRound = null;

// ─── Screen Wake Lock (keep TV screen awake) ────────
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Screen Wake Lock acquired');
            wakeLock.addEventListener('release', () => {
                console.log('Screen Wake Lock released');
            });
        }
    } catch (err) {
        console.warn('Wake Lock request failed:', err.message);
    }
}

// Re-acquire wake lock when tab becomes visible again
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        requestWakeLock();
    }
});

// ─── Ding sound for new player joins ────────────
let lastPlayerCount = -1;
let lastHostPhase = null;
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}
// Unlock AudioContext on first user interaction so dings can play
document.addEventListener('click', () => getAudioCtx(), { once: true });
function playDing() {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') return; // Audio not unlocked yet, skip
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
}
function playTrumpet() {
    const ctx = getAudioCtx();
    const t = ctx.currentTime;

    // Royal trumpet fanfare — Bb major charge pattern
    const notes = [
        { freq: 466.16, start: 0,     dur: 0.12 },  // Bb4 (pickup)
        { freq: 587.33, start: 0.13,  dur: 0.12 },  // D5
        { freq: 698.46, start: 0.26,  dur: 0.12 },  // F5
        { freq: 932.33, start: 0.40,  dur: 0.22 },  // Bb5 (peak)
        { freq: 698.46, start: 0.65,  dur: 0.10 },  // F5 (grace)
        { freq: 932.33, start: 0.78,  dur: 0.55 },  // Bb5 (sustained finale)
    ];

    // Master compressor to glue it together
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-20, t);
    compressor.ratio.setValueAtTime(6, t);
    compressor.attack.setValueAtTime(0.003, t);
    compressor.release.setValueAtTime(0.15, t);
    compressor.connect(ctx.destination);

    notes.forEach((n, i) => {
        const isFinale = i === notes.length - 1;
        const peak = isFinale ? 0.22 : 0.20;

        // Harmonics layered for a brassy, rich timbre
        const harmonics = [
            { mult: 1,   vol: 1.0,  type: 'sawtooth' },
            { mult: 2,   vol: 0.5,  type: 'square'   },
            { mult: 3,   vol: 0.25, type: 'sine'     },
            { mult: 4,   vol: 0.12, type: 'sawtooth' },
        ];
        harmonics.forEach(h => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(compressor);
            osc.type = h.type;
            osc.frequency.setValueAtTime(n.freq * h.mult, t + n.start);

            const g = peak * h.vol;
            // Sharp brass attack → sustain → decay
            gain.gain.setValueAtTime(0, t + n.start);
            gain.gain.linearRampToValueAtTime(g, t + n.start + 0.012);
            gain.gain.setValueAtTime(g * 0.8, t + n.start + 0.04);
            if (isFinale) {
                // Vibrato on the held final note
                const lfo = ctx.createOscillator();
                const lfoGain = ctx.createGain();
                lfo.frequency.setValueAtTime(5.5, t + n.start);
                lfoGain.gain.setValueAtTime(4, t + n.start);
                lfo.connect(lfoGain);
                lfoGain.connect(osc.frequency);
                lfo.start(t + n.start + 0.15);
                lfo.stop(t + n.start + n.dur);
                // Slow fade on finale
                gain.gain.setValueAtTime(g * 0.75, t + n.start + n.dur * 0.5);
                gain.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
            } else {
                gain.gain.setValueAtTime(g * 0.7, t + n.start + n.dur * 0.6);
                gain.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
            }
            osc.start(t + n.start);
            osc.stop(t + n.start + n.dur + 0.05);
        });
    });
}

// ─── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    hideAllViews();
    connectSocket();
    requestWakeLock();
});

function hideAllViews() {
    document.querySelectorAll('[id^="view"]').forEach(el => el.style.display = 'none');
}

// ─── Socket.IO (real-time updates) ──────────────────
const REACTION_EMOJIS = ['😂', '🔥', '🎉', '😱', '😭', '😡'];

let socket = null;
let firstRender = true;

function connectSocket() {
    socket = io('/empire', { transports: ['polling', 'websocket'] });

    socket.on('connect', () => {
        // Claim the host role. The ack carries the current state so the
        // screen paints without waiting for the next broadcast, and a
        // reconnect after a blip re-registers host presence.
        socket.emit('host:auth', {}, (res) => {
            if (res && res.ok && res.state) render(res.state);
        });
    });

    socket.on('state:update', render);

    socket.on('host:reaction', ({ index }) => {
        const emoji = REACTION_EMOJIS[index];
        if (emoji) spawnReaction(emoji);
    });
}

// Promise wrapper around an emit-with-ack. Always resolves so callers
// don't need a try/catch around every action.
function send(event, payload) {
    return new Promise((resolve) => {
        if (!socket) return resolve({ ok: false, reason: 'not-connected' });
        let settled = false;
        const done = (res) => {
            if (settled) return;
            settled = true;
            resolve(res || { ok: false, reason: 'no-ack' });
        };
        setTimeout(() => done({ ok: false, reason: 'timeout' }), 30000);
        socket.emit(event, payload || {}, done);
    });
}

const REACTION_MAX_ON_SCREEN = 30;
function spawnReaction(emoji) {
    // Cap concurrent reactions so a flood doesn't crush rendering.
    const existing = document.querySelectorAll('.reaction-float');
    if (existing.length >= REACTION_MAX_ON_SCREEN) {
        existing[0].remove();
    }
    const el = document.createElement('div');
    el.className = 'reaction-float';
    el.textContent = emoji;
    // Random horizontal position across the screen
    el.style.left = (5 + Math.random() * 90) + '%';
    el.style.bottom = '-60px';
    const scale = 0.85 + Math.random() * 0.5;
    el.style.fontSize = (36 * scale) + 'px';
    el.style.animationDuration = (3.0 + Math.random() * 1.2) + 's';
    el.addEventListener('animationend', () => el.remove());
    document.body.appendChild(el);
}

async function fetchState() {
    const res = await send('host:auth');
    if (res && res.ok && res.state) render(res.state);
}

function resetHostCachedState() {
    wordsLoaded = false;
    attributionLoaded = false;
    hearWords = [];
    hearIndex = 0;
    stopHear();
    spinnerPlayers = [];
    spinnerDone = false;
    lastPlayerCount = -1;
    currentCategory = '';
    editingCategory = false;
    lastHostPhase = null;
    // Clear cached DOM content
    document.getElementById('wordsGrid').innerHTML = '';
    document.getElementById('attributionContainer').innerHTML = '';
    document.getElementById('wordsDisplay').classList.remove('show');
    document.getElementById('attributionDisplay').classList.remove('show');
    document.getElementById('hearDisplay').classList.remove('show');
    document.querySelectorAll('.toggle-button').forEach(b => b.classList.remove('active'));
    document.getElementById('qrCode').innerHTML = '';
    // Clear spinner overlay
    document.getElementById('spinnerOverlay').classList.remove('show');
    document.getElementById('spinnerName').style.color = '';
    // Reset timer
    timerStop();
    timerRemaining = timerDuration;
    timerUpdateDisplay();
    document.getElementById('btnTimerPlay').textContent = 'Start';
    document.getElementById('btnTimerFsPlay').textContent = 'Start';
    document.getElementById('timerDisplayPanel').classList.remove('show', 'urgent', 'expired');
    document.getElementById('btnTimer').classList.remove('active');
    document.getElementById('btnTimer').textContent = '⏰ Timer';
    document.getElementById('timerScreenFlash').className = 'timer-screen-flash';
    closeTimerFullscreen();
    closeHearFullscreen();
    // Close fullscreen overlay if open
    closeFullscreen();
}

function render(state) {
    if (firstRender) {
        firstRender = false;
        // Signal to the iris transition (if any) that the page is
        // rendered with real state.
        if (window.Iris && typeof window.Iris.ready === 'function') {
            window.Iris.ready();
        }
    }
    // Detect server restart or round change — clear all cached game data
    const gameIdChanged = knownHostGameId !== null && state.gameId && state.gameId !== knownHostGameId;
    const roundChanged = knownHostRound !== null && state.round !== knownHostRound;
    if (gameIdChanged || roundChanged) {
        resetHostCachedState();
    }
    knownHostGameId = state.gameId || null;
    knownHostRound = state.round;

    // Reflect server-side reactionsMuted on the topbar button
    updateReactionsBtn(!!state.reactionsMuted);

    const prevPhase = lastHostPhase;
    lastHostPhase = state.phase;
    hideAllViews();

    if (state.phase === 'setup' || !state.hasApiKey) {
        show('viewSetup');
        return;
    }
    if (state.phase === 'submission') {
        show('viewHostSubmission');
        // Play ding when a new player joins
        if (lastPlayerCount >= 0 && state.playerCount > lastPlayerCount) {
            playDing();
        }
        lastPlayerCount = state.playerCount;
        document.getElementById('hostPlayerCount').textContent = state.playerCount;
        // Update player names list
        const namesInner = document.getElementById('playerNamesInner');
        namesInner.innerHTML = '';
        const roster = state.players || [];
        roster.forEach(p => {
            const chip = document.createElement('span');
            chip.className = 'player-chip';
            chip.textContent = p.name;
            chip.title = 'Click to remove';
            chip.addEventListener('click', () => kickPlayer(p.id, p.name));
            namesInner.appendChild(chip);
        });
        const url = state.playerUrl || location.origin;
        document.getElementById('playerUrl').textContent = url;
        const qrContainer = document.getElementById('qrCode');
        if (!qrContainer.hasChildNodes()) {
            new QRCode(qrContainer, {
                text: url,
                width: 420,
                height: 420,
                colorDark: '#d4a844',
                colorLight: '#1c1c1c',
                correctLevel: QRCode.CorrectLevel.M
            });
        }
        currentCategory = state.category || '';
        if (!editingCategory) {
            updateCategoryDisplay();
        }
        // Sync AI Bot count
        botCount = Math.max(0, Math.min(MAX_BOTS, parseInt(state.botCount, 10) || 0));
        renderBotStepper();
        return;
    }
    if (state.phase === 'playing') {
        // Reset game view state when first entering playing phase
        if (prevPhase !== 'playing') {
            wordsLoaded = false;
            attributionLoaded = false;
            hearWords = [];
            hearIndex = 0;
            stopHear();
            spinnerPlayers = [];
            spinnerDone = false;
            document.getElementById('wordsGrid').innerHTML = '';
            document.getElementById('attributionContainer').innerHTML = '';
            document.getElementById('wordsDisplay').classList.remove('show');
            document.getElementById('attributionDisplay').classList.remove('show');
            document.getElementById('hearDisplay').classList.remove('show');
            document.querySelectorAll('.toggle-button').forEach(b => b.classList.remove('active'));
            document.getElementById('spinnerOverlay').classList.remove('show');
            document.getElementById('spinnerName').style.color = '';
        }
        show('viewHostGame');
        // Stage context chips (players, category)
        const ctxPlayers = document.getElementById('ctxPlayers');
        if (ctxPlayers) ctxPlayers.textContent = `${state.playerCount} player${state.playerCount === 1 ? '' : 's'}`;
        const cat = state.category || '';
        const ctxCat = document.getElementById('ctxCategory');
        if (ctxCat) {
            if (cat) { ctxCat.textContent = `📂 ${cat}`; ctxCat.style.display = ''; }
            else { ctxCat.style.display = 'none'; }
        }
        return;
    }
}

function show(id) {
    document.getElementById(id).style.display = 'block';
}

// ─── Host Actions ───────────────────────────────────

async function saveApiKey() {
    const key = document.getElementById('inputApiKey').value.trim();
    const msgEl = document.getElementById('setupMsg');
    if (!key) {
        showMsg(msgEl, 'Please enter an API key.', 'error');
        return;
    }
    const res = await send('host:set-key', { key });
    if (!res.ok) {
        showMsg(msgEl, res.reason === 'invalid-key'
            ? 'That key was rejected by Groq. Double-check it and try again.'
            : 'Could not save the key. Check your connection.', 'error');
        return;
    }
    fetchState();
}

async function startGame() {
    // Ensure AudioContext is created from user gesture
    getAudioCtx();
    const res = await send('host:start');
    if (!res.ok) {
        showAlert(res.reason === 'need-players'
            ? 'Need at least 2 players to start.'
            : 'Cannot start game.');
        return;
    }
    playTrumpet();
    wordsLoaded = false;
    attributionLoaded = false;
    fetchState();
    if (res.aiWarning) showAlert(res.aiWarning);
}

async function toggleHear() {
    const display = document.getElementById('hearDisplay');
    const btn = document.getElementById('btnHear');

    // Close others if open
    document.getElementById('wordsDisplay').classList.remove('show');
    document.getElementById('btnWords').classList.remove('active');
    document.getElementById('attributionDisplay').classList.remove('show');
    document.getElementById('btnAttribution').classList.remove('active');
    document.getElementById('timerDisplayPanel').classList.remove('show');
    document.getElementById('btnTimer').classList.remove('active');
    timerReset();

    if (!display.classList.contains('show')) {
        // Fetch words if needed
        if (!hearWords.length) {
            const res = await send('host:words');
            hearWords = (res && res.words) || [];
        }
        display.classList.add('show');
        btn.classList.add('active');
        hearIndex = 0;
        hearActive = true;
        hearPaused = false;
        document.getElementById('btnHearPause').textContent = 'Pause';
        document.getElementById('btnHearRestart').style.display = '';
        speakNextWord();
    } else {
        stopHear();
        display.classList.remove('show');
        btn.classList.remove('active');
    }
}

function speakNextWord() {
    if (!hearActive || hearPaused || hearIndex >= hearWords.length) {
        if (hearIndex >= hearWords.length && hearActive) {
            document.getElementById('hearProgress').textContent = `All ${hearWords.length} words read.`;
            document.getElementById('btnHearPause').textContent = 'Play Again';
            document.getElementById('btnHearRestart').style.display = 'none';
            document.getElementById('audioIndicator').classList.remove('active');
            hearActive = false;
            syncHearFullscreen();
        }
        return;
    }

    const word = hearWords[hearIndex];
    document.getElementById('hearProgress').textContent = `Word ${hearIndex + 1} of ${hearWords.length}`;
    document.getElementById('audioIndicator').classList.add('active');
    syncHearFullscreen();

    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    const voice = getBestVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 0.85;
    utterance.pitch = 1;
    utterance.onend = () => {
        hearIndex++;
        if (hearActive && !hearPaused) {
            document.getElementById('audioIndicator').classList.remove('active');
            syncHearFullscreen();
            hearTimeout = setTimeout(() => speakNextWord(), 1000);
        }
    };
    speechSynthesis.speak(utterance);
}

function pauseHear() {
    const btn = document.getElementById('btnHearPause');
    if (hearPaused) {
        hearPaused = false;
        hearActive = true;
        btn.textContent = 'Pause';
        syncHearFullscreen();
        speakNextWord();
    } else if (hearActive) {
        hearPaused = true;
        clearTimeout(hearTimeout);
        speechSynthesis.cancel();
        document.getElementById('audioIndicator').classList.remove('active');
        btn.textContent = 'Resume';
        syncHearFullscreen();
    } else {
        restartHear();
    }
}

function restartHear() {
    clearTimeout(hearTimeout);
    speechSynthesis.cancel();
    hearIndex = 0;
    hearActive = true;
    hearPaused = false;
    document.getElementById('btnHearPause').textContent = 'Pause';
    document.getElementById('btnHearRestart').style.display = '';
    syncHearFullscreen();
    speakNextWord();
}

function stopHear() {
    clearTimeout(hearTimeout);
    speechSynthesis.cancel();
    hearActive = false;
    hearPaused = false;
    hearIndex = 0;
    document.getElementById('audioIndicator').classList.remove('active');
    closeHearFullscreen();
}

async function toggleWords() {
    const display = document.getElementById('wordsDisplay');
    const btn = document.getElementById('btnWords');

    // Close attribution, hear, and timer if open
    document.getElementById('attributionDisplay').classList.remove('show');
    document.getElementById('btnAttribution').classList.remove('active');
    document.getElementById('hearDisplay').classList.remove('show');
    document.getElementById('btnHear').classList.remove('active');
    document.getElementById('timerDisplayPanel').classList.remove('show');
    document.getElementById('btnTimer').classList.remove('active');
    timerReset();
    stopHear();

    if (!display.classList.contains('show') && !wordsLoaded) {
        const res = await send('host:words');
        if (!res.ok) return;
        document.getElementById('wordsGrid').innerHTML =
            res.words.map(w => `<div class="word-chip">${escapeHtml(w)}</div>`).join('');
        wordsLoaded = true;
    }

    display.classList.toggle('show');
    btn.classList.toggle('active');
}

async function toggleAttribution() {
    const display = document.getElementById('attributionDisplay');
    const btn = document.getElementById('btnAttribution');

    if (!display.classList.contains('show')) {
        const confirmed = await showConfirm('Are you sure? This will reveal which word belongs to which player.', 'Reveal');
        if (!confirmed) return;

        // Close words, hear, and timer if open
        document.getElementById('wordsDisplay').classList.remove('show');
        document.getElementById('btnWords').classList.remove('active');
        document.getElementById('hearDisplay').classList.remove('show');
        document.getElementById('btnHear').classList.remove('active');
        document.getElementById('timerDisplayPanel').classList.remove('show');
        document.getElementById('btnTimer').classList.remove('active');
        timerReset();
        stopHear();

        if (!attributionLoaded) {
            const res = await send('host:attribution');
            if (!res.ok) return;
            document.getElementById('attributionContainer').innerHTML =
                res.attribution.map(s => {
                    const isAiBot = s.player === 'AI Bot 🤖';
                    return `
                    <div class="attribution-item${isAiBot ? ' ai-bot' : ''}">
                        <div class="attribution-player">${escapeHtml(s.player)}</div>
                        <div class="attribution-word">${escapeHtml(s.word)}</div>
                    </div>
                `;
                }).join('');
            attributionLoaded = true;
        }
    }

    display.classList.toggle('show');
    btn.classList.toggle('active');
}

async function chooseFirstPlayer() {
    // Fetch player names if we don't have them yet
    if (!spinnerPlayers.length) {
        const res = await send('host:attribution');
        if (!res.ok) return;
        spinnerPlayers = res.attribution.map(s => s.player).filter(p => p !== 'AI Bot 🤖');
    }
    if (spinnerPlayers.length < 2) return;

    const overlay = document.getElementById('spinnerOverlay');
    const nameEl = document.getElementById('spinnerName');
    const resultEl = document.getElementById('spinnerResult');
    const hintEl = document.getElementById('spinnerDismissHint');
    resultEl.classList.remove('visible');
    hintEl.classList.remove('visible');
    nameEl.style.color = '';
    spinnerDone = false;
    overlay.classList.add('show');

    // Pick the winner (crypto-strong)
    const randomBytes = new Uint32Array(1);
    crypto.getRandomValues(randomBytes);
    const winnerIdx = randomBytes[0] % spinnerPlayers.length;
    const winner = spinnerPlayers[winnerIdx];

    // Build a shuffled sequence of names to cycle through
    const totalCycles = 20 + Math.floor(Math.random() * 10);
    const sequence = [];
    for (let c = 0; c < totalCycles; c++) {
        // Build a shuffled copy each time we exhaust the pool
        if (c % spinnerPlayers.length === 0) {
            const shuffled = [...spinnerPlayers];
            for (let s = shuffled.length - 1; s > 0; s--) {
                const rb = new Uint32Array(1);
                crypto.getRandomValues(rb);
                const j = rb[0] % (s + 1);
                [shuffled[s], shuffled[j]] = [shuffled[j], shuffled[s]];
            }
            sequence.push(...shuffled);
        }
    }
    // Trim to exact length and ensure last one isn't the winner (so the final reveal is distinct)
    const spin = sequence.slice(0, totalCycles);
    if (spin[spin.length - 1] === winner) {
        const other = spinnerPlayers.find(p => p !== winner);
        spin[spin.length - 1] = other;
    }

    let i = 0;
    function tick() {
        if (i < spin.length) {
            nameEl.textContent = spin[i];
            i++;
            const progress = i / spin.length;
            const delay = 60 + 300 * Math.pow(progress, 2.5);
            setTimeout(tick, delay);
        } else {
            // Final reveal: show the winner
            nameEl.textContent = winner;
            nameEl.style.color = '#fff';
            resultEl.textContent = `${winner} starts first!`;
            resultEl.classList.add('visible');
            hintEl.classList.add('visible');
            spinnerDone = true;
        }
    }
    tick();
}

function dismissSpinner() {
    if (!spinnerDone) return;
    const overlay = document.getElementById('spinnerOverlay');
    overlay.classList.remove('show');
    document.getElementById('spinnerName').style.color = '';
}

async function resetSubmissions() {
    const confirmed = await showConfirm('This will reset the game and clear all player submissions. Continue?', 'Reset', { danger: true });
    if (!confirmed) return;
    await send('host:reset');
}

async function kickPlayer(playerId, name) {
    const confirmed = await showConfirm(`Remove ${name} from the game?`, 'Kick', { danger: true });
    if (!confirmed) return;
    const res = await send('host:kick', { playerId });
    if (!res.ok) showAlert('Could not remove that player. Please try again.');
}

// Hub button: confirm + reset, then navigate. We use capture-phase so
// we run before the anchor's default navigation.
document.addEventListener('DOMContentLoaded', function () {
    const hubBtn = document.getElementById('empireHubBtn');
    if (hubBtn) {
        hubBtn.addEventListener('click', async function (e) {
            e.preventDefault();
            const origin = { clientX: e.clientX, clientY: e.clientY, currentTarget: hubBtn };
            const confirmed = await showConfirm(
                'Leaving will reset the game and clear all player submissions. Go back to the hub?',
                'Leave & Reset',
                { danger: true }
            );
            if (!confirmed) return;
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                sessionStorage.setItem('hub_fullscreen', '1');
            }
            await send('host:leave');
            if (window.Iris && typeof window.Iris.transitionTo === 'function') {
                window.Iris.transitionTo('/', origin, window.Iris.HUB);
            } else {
                window.location.href = '/';
            }
        });
    }

    // Reactions toggle (mutes/unmutes player reactions server-side).
    const reactionsBtn = document.getElementById('empireReactionsBtn');
    if (reactionsBtn) {
        reactionsBtn.addEventListener('click', async function () {
            const next = !reactionsMutedState;
            const res = await send('host:reactions-muted', { muted: next });
            if (res.ok && typeof res.reactionsMuted === 'boolean') {
                updateReactionsBtn(res.reactionsMuted);
            }
        });
    }
});

// ─── Reactions topbar button state ──────────────────
let reactionsMutedState = false;
function updateReactionsBtn(muted) {
    reactionsMutedState = !!muted;
    const btn = document.getElementById('empireReactionsBtn');
    if (!btn) return;
    if (reactionsMutedState) {
        btn.textContent = '🔕 Reactions: Off';
        btn.classList.add('is-muted');
        btn.title = 'Player reactions are muted — click to allow';
    } else {
        btn.textContent = '🔔 Reactions: On';
        btn.classList.remove('is-muted');
        btn.title = 'Click to mute all player reactions';
    }
}

// ─── Helpers ────────────────────────────────────────

function showMsg(el, text, type) {
    el.className = `msg ${type} show`;
    el.textContent = text;
}

// ─── Category editing ───────────────────────────────

function updateCategoryDisplay() {
    const displayEl = document.getElementById('categoryDisplay');
    if (currentCategory) {
        displayEl.textContent = currentCategory;
    } else {
        displayEl.innerHTML = '<span class="category-placeholder">No category set</span>';
    }
}

function startEditCategory() {
    editingCategory = true;
    document.getElementById('categoryBox').style.display = 'none';
    document.getElementById('categoryEditBox').style.display = 'block';
    const input = document.getElementById('categoryInput');
    input.value = currentCategory;
    input.focus();
}

function finishEditCategory() {
    if (!editingCategory) return;
    editingCategory = false;
    const input = document.getElementById('categoryInput');
    const newCategory = input.value.trim();
    currentCategory = newCategory;
    document.getElementById('categoryEditBox').style.display = 'none';
    document.getElementById('categoryBox').style.display = 'block';
    updateCategoryDisplay();
    send('host:category', { category: newCategory });
}

function randomizeCategory() {
    let pick;
    do {
        pick = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    } while (pick === currentCategory && CATEGORIES.length > 1);
    currentCategory = pick;
    updateCategoryDisplay();
    // If edit mode is open, update the input too
    const input = document.getElementById('categoryInput');
    if (document.getElementById('categoryEditBox').style.display !== 'none') {
        input.value = pick;
    }
    send('host:category', { category: pick });
}

async function changeBotCount(delta) {
    const next = Math.max(0, Math.min(MAX_BOTS, botCount + delta));
    if (next === botCount) return;
    const prev = botCount;
    botCount = next;
    renderBotStepper();
    const res = await send('host:ai-bot', { count: botCount });
    if (!res.ok) {
        // Revert on failure
        botCount = prev;
        renderBotStepper();
    }
}

function renderBotStepper() {
    document.getElementById('botCountValue').textContent = botCount;
    document.getElementById('aiBotToggleRow').classList.toggle('active', botCount > 0);
    document.getElementById('botMinus').disabled = botCount <= 0;
    document.getElementById('botPlus').disabled = botCount >= MAX_BOTS;
}

document.addEventListener('DOMContentLoaded', () => {
    const catInput = document.getElementById('categoryInput');
    catInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finishEditCategory();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            editingCategory = false;
            document.getElementById('categoryEditBox').style.display = 'none';
            document.getElementById('categoryBox').style.display = 'block';
        }
    });
    catInput.addEventListener('blur', () => {
        finishEditCategory();
    });
});

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Game-phase stage controller ──────────────────
// The four stage tools (Timer, Words, Hear, Attribution) toggle a
// `.show` class on their panel. We watch those classes and update
// the stage header (title + ⛶ button) and empty state accordingly.
// This keeps the existing toggle functions untouched.
const STAGE_TOOLS = [
    { id: 'timerDisplayPanel', title: '⏰ Timer', fs: () => openTimerFullscreen() },
    { id: 'wordsDisplay',      title: '👁️ All Words', fs: () => openFullscreen('words') },
    { id: 'hearDisplay',       title: '🔊 Hear All Words', fs: () => openHearFullscreen() },
    { id: 'attributionDisplay',title: '🎭 Words with Names', fs: () => openFullscreen('attribution') },
];
let activeStageFsHandler = null;
function syncStage() {
    const titleEl = document.getElementById('stageTitle');
    const emptyEl = document.getElementById('stageEmpty');
    const fsBtn = document.getElementById('stageFullscreenBtn');
    if (!titleEl || !emptyEl || !fsBtn) return;
    const active = STAGE_TOOLS.find(t => {
        const el = document.getElementById(t.id);
        return el && el.classList.contains('show');
    });
    if (active) {
        titleEl.textContent = active.title;
        emptyEl.style.display = 'none';
        fsBtn.style.display = '';
        activeStageFsHandler = active.fs;
    } else {
        titleEl.textContent = 'Ready';
        emptyEl.style.display = '';
        fsBtn.style.display = 'none';
        activeStageFsHandler = null;
    }
}
function openStageFullscreen() {
    if (typeof activeStageFsHandler === 'function') activeStageFsHandler();
}
// Watch the four stage panels for `.show` class changes — anything
// that toggles them (existing functions, future ones) keeps the
// header in sync without code changes there.
document.addEventListener('DOMContentLoaded', () => {
    const obs = new MutationObserver(() => syncStage());
    STAGE_TOOLS.forEach(t => {
        const el = document.getElementById(t.id);
        if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    syncStage();
});

// ─── Custom Alert Modal ─────────────────────────
// showAlert / showConfirm are provided by /shared/modal.js.

// ─── Fullscreen Word Display ────────────────────

function openFullscreen(mode) {
    const overlay = document.getElementById('fullscreenOverlay');
    const title = document.getElementById('fullscreenTitle');
    const body = document.getElementById('fullscreenBody');

    if (mode === 'words') {
        title.textContent = 'All Words';
        const chips = document.getElementById('wordsGrid').innerHTML;
        body.innerHTML = `<div class="fullscreen-words-grid">${chips}</div>`;
    } else if (mode === 'attribution') {
        title.textContent = 'All Words with Names';
        const items = document.getElementById('attributionContainer').innerHTML;
        body.innerHTML = `<div class="fullscreen-attribution-list">${items}</div>`;
    }

    overlay.classList.add('show');
}

function closeFullscreen() {
    document.getElementById('fullscreenOverlay').classList.remove('show');
}

// ─── Global Page Fullscreen Toggle ────────────────

function togglePageFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
        const el = document.documentElement;
        if (el.requestFullscreen) {
            el.requestFullscreen().catch(() => {});
        } else if (el.webkitRequestFullscreen) {
            el.webkitRequestFullscreen();
        }
    }
}

// Keep the topbar fullscreen button label in sync with state.
function updateFullscreenBtnLabel() {
    const btn = document.getElementById('empireFullscreenBtn');
    if (!btn) return;
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    btn.textContent = isFs ? '⛶ Exit' : '⛶ Fullscreen';
    btn.title = isFs ? 'Exit fullscreen' : 'Toggle fullscreen';
}
document.addEventListener('fullscreenchange', updateFullscreenBtnLabel);
document.addEventListener('webkitfullscreenchange', updateFullscreenBtnLabel);
updateFullscreenBtnLabel();

// Re-enter fullscreen if navigated from hub while fullscreen
if (sessionStorage.getItem('hub_fullscreen') === '1') {
    sessionStorage.removeItem('hub_fullscreen');
    const banner = document.getElementById('fsRestoreBanner');
    banner.classList.add('show');
    banner.addEventListener('click', () => {
        banner.classList.remove('show');
        const el = document.documentElement;
        if (el.requestFullscreen) {
            el.requestFullscreen().catch(() => {});
        } else if (el.webkitRequestFullscreen) {
            el.webkitRequestFullscreen();
        }
    });
}

// ─── Timer Logic ────────────────────────────────

function timerFormatDisplay(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m + ':' + String(s).padStart(2, '0');
}

function timerUpdateDisplay() {
    const el = document.getElementById('timerDisplay');
    const panel = document.getElementById('timerDisplayPanel');
    const fsEl = document.getElementById('timerFsDisplay');
    const formatted = timerFormatDisplay(timerRemaining);
    el.textContent = formatted;
    fsEl.textContent = formatted;
    const urgent = timerRunning && timerRemaining <= 5 && timerRemaining > 0;
    const expired = timerRunning === false && timerRemaining <= 0 && timerInterval === null;
    el.classList.toggle('urgent', urgent);
    el.classList.toggle('expired', expired);
    fsEl.classList.toggle('urgent', urgent);
    fsEl.classList.toggle('expired', expired);
    panel.classList.toggle('urgent', urgent);
    panel.classList.toggle('expired', expired);
}

function timerFlashScreen(mode) {
    const flash = document.getElementById('timerScreenFlash');
    flash.className = 'timer-screen-flash';
    // Force reflow to restart animation
    void flash.offsetWidth;
    flash.classList.add(mode);
    const dur = mode === 'expired' ? 2400 : 200;
    setTimeout(() => flash.className = 'timer-screen-flash', dur);
}

function toggleTimer() {
    const display = document.getElementById('timerDisplayPanel');
    const btn = document.getElementById('btnTimer');

    // Close others if open
    document.getElementById('wordsDisplay').classList.remove('show');
    document.getElementById('btnWords').classList.remove('active');
    document.getElementById('attributionDisplay').classList.remove('show');
    document.getElementById('btnAttribution').classList.remove('active');
    document.getElementById('hearDisplay').classList.remove('show');
    document.getElementById('btnHear').classList.remove('active');
    stopHear();

    const wasActive = btn.classList.contains('active');
    display.classList.toggle('show');
    btn.classList.toggle('active');

    // If toggling off, stop and reset the timer
    if (wasActive) {
        timerReset();
    }
}

function timerSetPreset(secs) {
    timerStop();
    timerDuration = secs;
    timerRemaining = secs;
    timerUpdateDisplay();
    document.getElementById('btnTimerPlay').textContent = 'Start';
    document.getElementById('btnTimerFsPlay').textContent = 'Start';
    document.querySelectorAll('.timer-preset').forEach(b => {
        const parts = b.textContent.split(':');
        const val = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        b.classList.toggle('active', val === secs);
    });
}

function timerStart() {
    if (timerRunning) {
        timerStop();
        document.getElementById('btnTimerPlay').textContent = 'Resume';
        document.getElementById('btnTimerFsPlay').textContent = 'Resume';
        timerUpdateDisplay();
        return;
    }
    if (timerRemaining <= 0) {
        timerRemaining = timerDuration;
    }
    timerRunning = true;
    finalBeepsScheduled = false;
    document.getElementById('btnTimerPlay').textContent = 'Pause';
    document.getElementById('btnTimerFsPlay').textContent = 'Pause';
    timerUpdateDisplay();
    timerInterval = setInterval(() => {
        timerRemaining--;
        timerUpdateDisplay();
        // Pre-schedule the last-5s beeps ~1s early (at the 6s mark) so
        // the first beep isn't late from audio cold-start; they play on
        // the sample-accurate audio clock at even 1s intervals.
        if (timerRemaining <= 6 && timerRemaining > 0 && !finalBeepsScheduled) {
            finalBeepsScheduled = true;
            scheduleFinalBeeps(timerRemaining);
        }
        if (timerRemaining <= 5 && timerRemaining > 0) {
            timerFlashScreen('tick');
        }
        if (timerRemaining <= 0) {
            timerStop();
            timerUpdateDisplay();
            playTimerEnd();
            timerFlashScreen('expired');
            document.getElementById('btnTimerPlay').textContent = 'Restart';
            document.getElementById('btnTimerFsPlay').textContent = 'Restart';
        }
    }, 1000);
}

function timerStop() {
    timerRunning = false;
    clearInterval(timerInterval);
    timerInterval = null;
    cancelFinalBeeps();
}

function timerReset() {
    timerStop();
    timerRemaining = timerDuration;
    timerUpdateDisplay();
    document.getElementById('btnTimerPlay').textContent = 'Start';
    document.getElementById('btnTimerFsPlay').textContent = 'Start';
}

function openHearFullscreen() {
    const overlay = document.getElementById('hearFullscreenOverlay');
    syncHearFullscreen();
    overlay.classList.add('show');
}

function closeHearFullscreen() {
    document.getElementById('hearFullscreenOverlay').classList.remove('show');
}

function syncHearFullscreen() {
    const fsIcon = document.getElementById('hearFsIcon');
    const fsProgress = document.getElementById('hearFsProgress');
    const fsPauseBtn = document.getElementById('btnHearFsPause');
    const fsRestartBtn = document.getElementById('btnHearFsRestart');
    const mainIndicator = document.getElementById('audioIndicator');
    fsIcon.classList.toggle('active', mainIndicator.classList.contains('active'));
    fsProgress.textContent = document.getElementById('hearProgress').textContent;
    fsPauseBtn.textContent = document.getElementById('btnHearPause').textContent;
    fsRestartBtn.style.display = document.getElementById('btnHearRestart').style.display;
}

function openTimerFullscreen() {
    const overlay = document.getElementById('timerFullscreenOverlay');
    timerUpdateDisplay();
    overlay.classList.add('show');
}

function closeTimerFullscreen() {
    document.getElementById('timerFullscreenOverlay').classList.remove('show');
}

// Close fullscreen overlays on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const hearOv = document.getElementById('hearFullscreenOverlay');
        if (hearOv && hearOv.classList.contains('show')) {
            closeHearFullscreen();
            return;
        }
        const timerOv = document.getElementById('timerFullscreenOverlay');
        if (timerOv && timerOv.classList.contains('show')) {
            closeTimerFullscreen();
            return;
        }
        const wordsOv = document.getElementById('fullscreenOverlay');
        if (wordsOv && wordsOv.classList.contains('show')) {
            closeFullscreen();
        }
    }
});

function playTick(secsLeft, atTime) {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') return;
    const t = (typeof atTime === 'number') ? atTime : ctx.currentTime;
    // Match Trivia's last-5s warning sound exactly: a clean 880 Hz
    // sine pip for ticks 5→1, and a louder 1320 Hz pip at 0.
    const isFinal = secsLeft === 0;
    const vol = isFinal ? 1.0 : 0.4 + (5 - secsLeft) * 0.14;
    const freq = isFinal ? 1320 : 880;
    const dur = isFinal ? 0.55 : 0.12;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.setValueAtTime(vol, t + dur - 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    scheduledBeepNodes.push(osc);
}

// Pre-schedule the final beeps (5..1) relative to the current seconds
// remaining, on the sample-accurate audio clock. Cancelled on
// pause/reset/expiry via cancelFinalBeeps().
function cancelFinalBeeps() {
    finalBeepsScheduled = false;
    scheduledBeepNodes.forEach((o) => { try { o.stop(0); o.disconnect(); } catch (_) {} });
    scheduledBeepNodes = [];
}
function scheduleFinalBeeps(remainingNow) {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    for (let s = Math.min(5, remainingNow); s >= 1; s--) {
        const at = now + (remainingNow - s);
        if (at >= now - 0.02) playTick(s, Math.max(now, at));
    }
}

function playTimerEnd() {
    // Match Trivia's time-out sound exactly: the loud final pip
    // produced by playTick(0) — a single 1320 Hz sine, 0.55s,
    // at full volume (no rapid alarm-clock loop).
    playTick(0);
}

document.addEventListener('keypress', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'inputApiKey') saveApiKey();
});
