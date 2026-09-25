'use strict';

/**
 * Empire — Socket.IO namespace (`/empire`) + page routes.
 *
 * Empire is a "secret word" party game: everyone submits a word from their
 * phone, the host reveals the shuffled pile on the big screen, and the table
 * works out who wrote what. The server therefore owns very little logic — a
 * phase, a list of submissions, and the reveal gates.
 */

const path = require('path');
const { Server } = require('socket.io');

const {
    MAX_BOTS,
    REACTION_COUNT,
    BOT_NAME,
    PHASES,
    createFreshState,
    getPublicState,
} = require('./game');
const { generateAiBotWords, validateApiKey, checkSimilarity, checkCategoryFit } = require('./ai');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public', 'empire');

const HOST_ROOM = 'hosts';
const HOST_GRACE_MS = 5000;
const REACTION_COOLDOWN_MS = 10 * 1000;
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
// Per-socket submission throttle, replacing the old per-IP express rate limit.
const SUBMIT_WINDOW_MS = 60 * 1000;
const SUBMIT_MAX_PER_WINDOW = 10;

const MAX_NAME_LEN = 50;
const MAX_WORD_LEN = 150;
const MAX_CATEGORY_LEN = 100;

function mountEmpire(app, httpServer, opts) {
    const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

    let gameState = createFreshState();

    // ─── Page routes ────────────────────────────────────────

    const pub = (f) => path.join(PUBLIC_DIR, f);
    app.get('/empire/host', (_req, res) => res.sendFile(pub('host.html')));
    // Entry point for players — submit form, "waiting for host", "game in
    // progress" lock screen, kicked view.
    app.get('/empire/join', (_req, res) => res.sendFile(pub('join.html')));
    // Post-join — done/playing views, reactions, secret card, reset/new-round
    // notifications, kicked view. Players land here after a submission.
    app.get('/empire/play', (_req, res) => res.sendFile(pub('player.html')));

    // ─── Socket.IO namespace ────────────────────────────────

    // One Socket.IO Server is shared by every game on this http server.
    // Creating a second one would break WebSocket upgrades app-wide.
    if (!httpServer._triviaIo) {
        httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
    }
    const ns = httpServer._triviaIo.of('/empire');

    // ─── Host presence ──────────────────────────────────────

    let hostCount = 0;
    let lastHostSeenAt = 0;
    let hostGraceTimer = null;
    // Set true when the host explicitly clicks Hub, so players see the
    // "no host" overlay immediately instead of after the grace window.
    // Cleared the next time a host actually opens the host page.
    let hostLeftIntentionally = false;

    // The host is "present" if a host socket is connected, OR one dropped
    // within the grace window (covers refreshes and brief blips).
    function isHostPresent() {
        if (hostLeftIntentionally) return false;
        if (hostCount > 0) return true;
        return lastHostSeenAt > 0 && (Date.now() - lastHostSeenAt) < HOST_GRACE_MS;
    }

    function publicState() {
        return getPublicState(gameState, {
            playerUrl: `${getPublicBaseUrl()}/empire/join`,
            hostPresent: isHostPresent(),
        });
    }

    function broadcast() {
        ns.emit('state:update', publicState());
    }

    // ─── Inactivity auto-reset (60 min) ─────────────────────

    let lastActivity = Date.now();
    function touchActivity() { lastActivity = Date.now(); }

    const inactivityTimer = setInterval(() => {
        if (Date.now() - lastActivity >= INACTIVITY_RESET_MS) {
            const nextRound = gameState.round + 1;
            gameState = createFreshState();
            gameState.round = nextRound;
            touchActivity();
            broadcast();
            console.log('Empire auto-reset after 60 minutes of inactivity.');
        }
    }, 60 * 1000);
    if (inactivityTimer.unref) inactivityTimer.unref();

    // ─── Shared helpers ─────────────────────────────────────

    const lastReactionAt = new Map();

    function findByPlayerId(pid) {
        return gameState.submissions.find(s => !s.isBot && s.playerId === pid) || null;
    }

    // Preserves the API key and starts the next round in the lobby.
    function startNextRound() {
        const key = gameState.groqApiKey;
        const nextRound = gameState.round + 1;
        gameState = createFreshState();
        gameState.groqApiKey = key;
        gameState.phase = PHASES.SUBMISSION;
        gameState.round = nextRound;
        lastReactionAt.clear();
    }

    ns.on('connection', (socket) => {
        let role = null;      // 'host' | 'player'
        let playerId = null;
        let submitTimes = [];

        // Every fresh socket gets a snapshot immediately, so a page can
        // render without waiting for the next broadcast.
        socket.emit('state:update', publicState());

        function requireHost(ack) {
            if (role !== 'host') { ack && ack({ ok: false, reason: 'not-host' }); return false; }
            return true;
        }

        // ─── Host ───────────────────────────────────────────

        socket.on('host:auth', (_payload, ack) => {
            // Idempotent — the host page re-emits this to refresh its
            // snapshot after an action, which must not double-count.
            if (role === 'host') {
                return ack && ack({ ok: true, state: publicState() });
            }
            role = 'host';
            socket.join(HOST_ROOM);
            if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
            const wasAbsent = !isHostPresent();
            hostLeftIntentionally = false;
            hostCount += 1;
            lastHostSeenAt = Date.now();
            ack && ack({ ok: true, state: publicState() });
            // Tell the players the host is back.
            if (wasAbsent) broadcast();
        });

        socket.on('host:set-key', async ({ key } = {}, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            const clean = (key || '').trim();
            if (!clean) return ack && ack({ ok: false, reason: 'missing-key' });
            const valid = await validateApiKey(clean);
            if (!valid) return ack && ack({ ok: false, reason: 'invalid-key' });
            gameState.groqApiKey = clean;
            gameState.phase = PHASES.SUBMISSION;
            ack && ack({ ok: true });
            broadcast();
        });

        socket.on('host:category', ({ category } = {}, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            gameState.category = (category || '').trim().slice(0, MAX_CATEGORY_LEN);
            ack && ack({ ok: true, category: gameState.category });
            broadcast();
        });

        socket.on('host:ai-bot', ({ count } = {}, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            if (gameState.phase !== PHASES.SUBMISSION) {
                return ack && ack({ ok: false, reason: 'wrong-phase' });
            }
            let n = parseInt(count, 10);
            if (!Number.isFinite(n)) n = 0;
            gameState.botCount = Math.max(0, Math.min(MAX_BOTS, n));
            ack && ack({ ok: true, botCount: gameState.botCount });
            broadcast();
        });

        socket.on('host:reactions-muted', ({ muted } = {}, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            gameState.reactionsMuted = !!muted;
            ack && ack({ ok: true, reactionsMuted: gameState.reactionsMuted });
            broadcast();
        });

        // Removes a player's submission. They can rejoin with the same name
        // from their phone, matching Trivia's UX.
        socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            if (gameState.phase !== PHASES.SUBMISSION) {
                return ack && ack({ ok: false, reason: 'wrong-phase' });
            }
            const idx = gameState.submissions.findIndex(s => !s.isBot && s.playerId === pid);
            if (idx === -1) return ack && ack({ ok: false, reason: 'unknown-player' });
            const removed = gameState.submissions.splice(idx, 1)[0];
            lastReactionAt.delete(removed.playerId);
            ns.emit('player:kicked', { playerId: removed.playerId, player: removed.player });
            ack && ack({ ok: true });
            broadcast();
        });

        socket.on('host:start', async (_payload, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            if (gameState.submissions.length < 2) {
                return ack && ack({ ok: false, reason: 'need-players' });
            }

            // Generate AI Bot decoy words if requested (before shuffling).
            let aiWarning = null;
            if (gameState.botCount > 0) {
                try {
                    const aiWords = await generateAiBotWords(
                        gameState.submissions.map(s => s.word),
                        gameState.category,
                        gameState.groqApiKey,
                        gameState.botCount
                    );
                    for (const aiWord of aiWords) {
                        gameState.submissions.push({ playerId: null, player: BOT_NAME, word: aiWord, isBot: true });
                    }
                    if (aiWords.length) {
                        console.log(`AI Bot words generated (${aiWords.length}/${gameState.botCount}): ${aiWords.map(w => `"${w}"`).join(', ')}`);
                    } else {
                        console.warn('AI Bot word generation returned none, proceeding without bots.');
                        aiWarning = 'AI Bot words could not be generated, so the round started without them. Check the server log and your Groq API key.';
                    }
                } catch (e) {
                    console.error('AI Bot word generation failed, proceeding without bots:', e.message);
                    aiWarning = 'AI Bot words could not be generated, so the round started without them. Check the server log and your Groq API key.';
                }
            }

            gameState.phase = PHASES.PLAYING;
            // Fisher-Yates shuffle for uniform randomness.
            const arr = gameState.submissions.map(s => s.word);
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            gameState.shuffledWords = arr;
            ack && ack({ ok: true, aiWarning });
            broadcast();
        });

        // The shuffled pile, with no names attached.
        socket.on('host:words', (_payload, ack) => {
            if (!requireHost(ack)) return;
            if (gameState.phase !== PHASES.PLAYING) {
                return ack && ack({ ok: false, reason: 'not-started' });
            }
            ack && ack({ ok: true, words: gameState.shuffledWords });
        });

        // The big reveal — who wrote what.
        socket.on('host:attribution', (_payload, ack) => {
            if (!requireHost(ack)) return;
            if (gameState.phase !== PHASES.PLAYING) {
                return ack && ack({ ok: false, reason: 'not-started' });
            }
            ack && ack({
                ok: true,
                attribution: gameState.submissions.map(s => ({
                    player: s.player, word: s.word, isBot: !!s.isBot,
                })),
            });
        });

        socket.on('host:reset', (_payload, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            startNextRound();
            ack && ack({ ok: true });
            broadcast();
        });

        // Back to the API key setup screen, unless the env var supplies one.
        socket.on('host:full-reset', (_payload, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            const nextRound = gameState.round + 1;
            gameState = createFreshState();
            gameState.round = nextRound;
            lastReactionAt.clear();
            ack && ack({ ok: true });
            broadcast();
        });

        // The host leaving via the Hub button resets the game AND flips
        // host-presence to false immediately (skipping the grace window), so
        // every player sees the "no host" overlay before the host's tab has
        // even navigated away.
        socket.on('host:leave', (_payload, ack) => {
            if (!requireHost(ack)) return;
            touchActivity();
            startNextRound();
            hostLeftIntentionally = true;
            if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
            ack && ack({ ok: true });
            broadcast();
        });

        // ─── Players ────────────────────────────────────────

        socket.on('player:submit', async ({ playerId: pid, name, word, skipCategoryCheck } = {}, ack) => {
            touchActivity();
            if (!pid || typeof pid !== 'string') return ack && ack({ ok: false, reason: 'bad-player-id' });
            if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
            if (gameState.phase !== PHASES.SUBMISSION) {
                return ack && ack({ ok: false, reason: 'wrong-phase' });
            }

            // Per-socket throttle (the old per-IP express rate limit).
            const now = Date.now();
            submitTimes = submitTimes.filter(t => now - t < SUBMIT_WINDOW_MS);
            if (submitTimes.length >= SUBMIT_MAX_PER_WINDOW) {
                return ack && ack({ ok: false, reason: 'rate-limited' });
            }
            submitTimes.push(now);

            const cleanName = (name || '').trim().slice(0, MAX_NAME_LEN);
            const cleanWord = (word || '').trim().toLowerCase().slice(0, MAX_WORD_LEN);
            if (!cleanName || !cleanWord) return ack && ack({ ok: false, reason: 'missing-fields' });

            // Block the reserved bot name.
            const flat = cleanName.toLowerCase().replace(/\s+/g, ' ');
            if (flat === BOT_NAME.toLowerCase() || flat === 'ai bot') {
                return ack && ack({ ok: false, reason: 'reserved-name' });
            }

            // Someone else already took this name.
            const nameTaken = gameState.submissions.some(s =>
                s.playerId !== pid && s.player.toLowerCase() === cleanName.toLowerCase());
            if (nameTaken) {
                const display = cleanName.charAt(0).toUpperCase() + cleanName.slice(1).toLowerCase();
                return ack && ack({ ok: false, reason: 'name-taken', name: display });
            }

            // This player already has a word in the pile.
            if (findByPlayerId(pid)) return ack && ack({ ok: false, reason: 'already-submitted' });

            // Exact duplicate word.
            if (gameState.submissions.some(s => s.word === cleanWord)) {
                return ack && ack({ ok: false, reason: 'word-taken' });
            }

            // LLM similarity check against the words already in play.
            const existingWords = gameState.submissions.map(s => s.word);
            const sim = await checkSimilarity(cleanWord, existingWords, gameState.groqApiKey);
            if (sim && sim.is_similar) {
                console.log(`Similarity rejection: "${cleanWord}" too similar to "${sim.similar_to}" (reason: ${sim.reason || 'n/a'})`);
                return ack && ack({ ok: false, reason: 'word-taken' });
            }

            // LLM category fit check — a soft warning, not a hard reject.
            if (gameState.category && !skipCategoryCheck) {
                const fit = await checkCategoryFit(cleanWord, gameState.category, gameState.groqApiKey);
                if (fit && !fit.fits_category) {
                    return ack && ack({
                        ok: true,
                        categoryWarning: true,
                        reason: `"${cleanWord}" doesn't typically fall under "${gameState.category}".`,
                    });
                }
            }

            // The phase can change while the LLM calls are in flight.
            if (gameState.phase !== PHASES.SUBMISSION) {
                return ack && ack({ ok: false, reason: 'wrong-phase' });
            }

            gameState.submissions.push({ playerId: pid, player: cleanName, word: cleanWord });
            role = 'player';
            playerId = pid;
            ack && ack({ ok: true, name: cleanName, word: cleanWord, round: gameState.round, gameId: gameState.gameId });
            broadcast();
        });

        // Re-attaches a returning phone and hands back everything it needs to
        // re-render, without touching the roster.
        socket.on('player:reconnect', ({ playerId: pid } = {}, ack) => {
            if (!pid || typeof pid !== 'string') return ack && ack({ ok: false, reason: 'bad-player-id' });
            role = 'player';
            playerId = pid;
            const mine = findByPlayerId(pid);
            ack && ack({
                ok: true,
                submitted: !!mine,
                player: mine ? { id: mine.playerId, name: mine.player, word: mine.word } : null,
                state: publicState(),
            });
        });

        // A player changing their mind before the game starts.
        socket.on('player:withdraw', ({ playerId: pid } = {}, ack) => {
            touchActivity();
            const id = pid || playerId;
            if (!id) return ack && ack({ ok: false, reason: 'bad-player-id' });
            if (gameState.phase !== PHASES.SUBMISSION) {
                return ack && ack({ ok: false, reason: 'wrong-phase' });
            }
            const idx = gameState.submissions.findIndex(s => !s.isBot && s.playerId === id);
            if (idx === -1) return ack && ack({ ok: false, reason: 'not-found' });
            gameState.submissions.splice(idx, 1);
            ack && ack({ ok: true });
            broadcast();
        });

        socket.on('player:reaction', ({ index } = {}, ack) => {
            const id = playerId;
            if (!id) return ack && ack({ ok: false, reason: 'not-joined' });
            if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
            if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
                return ack && ack({ ok: false, reason: 'bad-index' });
            }
            // Reactions belong to the lobby and the table talk, nowhere else.
            if (gameState.phase !== PHASES.SUBMISSION && gameState.phase !== PHASES.PLAYING) {
                return ack && ack({ ok: false, reason: 'phase-closed' });
            }
            if (gameState.reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });

            const now = Date.now();
            const last = lastReactionAt.get(id) || 0;
            if (now - last < REACTION_COOLDOWN_MS) {
                return ack && ack({ ok: false, reason: 'cooldown', retryInMs: REACTION_COOLDOWN_MS - (now - last) });
            }
            lastReactionAt.set(id, now);
            ack && ack({ ok: true });
            ns.to(HOST_ROOM).emit('host:reaction', { index });
        });

        // ─── Disconnect ─────────────────────────────────────

        socket.on('disconnect', () => {
            // A player dropping is normal on mobile and never costs them
            // their place — only the host's absence is tracked.
            if (role !== 'host') return;
            hostCount = Math.max(0, hostCount - 1);
            lastHostSeenAt = Date.now();
            if (hostCount > 0) return;
            if (hostGraceTimer) clearTimeout(hostGraceTimer);
            hostGraceTimer = setTimeout(() => {
                hostGraceTimer = null;
                broadcast(); // players now see hostPresent=false → overlay
            }, HOST_GRACE_MS);
        });
    });
}

module.exports = mountEmpire;
