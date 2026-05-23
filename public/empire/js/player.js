// Client-side state machine for the Empire PLAY page (/empire/play).
//
// This page is the post-join experience: the player has already
// submitted a secret word and is now waiting for the host to start
// the game (or playing it). Responsibilities:
//   • Show the "submitted, waiting" view (phase = submission).
//   • Show the "game started" view (phase = playing).
//   • Detect round resets / new rounds and show a friendly heads-up
//     before bouncing back to /empire/join.
//   • Detect server restarts (gameId change) and silently bounce
//     back to /empire/join.
//   • Render the secret-card reveal + auto-hide.
//   • Withdraw flow (clear submission → /empire/join).
//   • Show the kicked view if a `kicked` SSE event names this player.
//   • Sticky reaction bar (shared logic lives in shared.js).
(function () {
    'use strict';

    // ─── Local page state ───────────────────────────────────
    let submittedWord = '';
    let submittedName = '';
    let knownRound = null;
    let knownGameId = null;
    let lastPhase = null;
    let showingReset = false;
    let resetType = null;   // 'reset' | 'newround'
    let kickedByHost = false;
    // True once we've redirected somewhere so render() stops touching
    // the DOM during the transition.
    let navigatingAway = false;

    document.addEventListener('DOMContentLoaded', init);

    async function init() {
        const saved = Empire.getSavedSubmission();

        // Guard: if there's nothing to "play" with, bounce to /join.
        if (!saved || !saved.name || !saved.word) {
            window.location.replace('/empire/join');
            return;
        }

        submittedName = saved.name;
        submittedWord = saved.word;
        knownRound = (typeof saved.round === 'number') ? saved.round : null;
        knownGameId = saved.gameId || null;

        // Apply easter-egg pink theme + show the player-header name
        // BEFORE the first render so there's no flash.
        Empire.checkEasterEgg(submittedName);
        Empire.setPlayerHeaderName(submittedName);

        Empire.hideAllViews();
        Empire.initReactionBar();

        // Fast path: a quick state fetch decides whether we should
        // even bother subscribing. (e.g., server restarted → /join.)
        try {
            const state = await Empire.fetchState();
            if (state.gameId && knownGameId && state.gameId !== knownGameId) {
                // Server restarted: clear stale local state and bail.
                Empire.clearSubmission();
                window.location.replace('/empire/join');
                return;
            }
        } catch (_) { /* network blip — let SSE take over */ }

        Empire.connectSSE({ onState: render, onKicked: handleKicked });
    }

    // ─── Render loop ────────────────────────────────────────
    function render(state) {
        if (navigatingAway) return;

        Empire.setReactionsMuted(!!state.reactionsMuted);
        Empire.updateHostPresence(state.hostPresent !== false);

        // Stay on the kicked screen until the host advances rounds.
        if (kickedByHost) {
            if (state.round !== knownRound) {
                kickedByHost = false;
                Empire.clearSubmission();
                navigatingAway = true;
                window.location.replace('/empire/join');
            }
            return;
        }

        // Server restart? Silently bounce — the user has no actionable
        // state to preserve.
        const gameIdMismatch = state.gameId && knownGameId !== null && knownGameId !== state.gameId;
        if (gameIdMismatch) {
            Empire.clearSubmission();
            navigatingAway = true;
            window.location.replace('/empire/join');
            return;
        }

        // Same server session, host reset the game or advanced rounds.
        // Show a friendly notification; "OK" / "Let's Go" clears state
        // and sends the player to /join to submit again.
        const roundMismatch = knownRound !== null && state.round !== knownRound;
        if (roundMismatch && !showingReset) {
            showingReset = true;
            // "newround" feels right when a brand-new round picked up
            // from where playing left off, "reset" when the host
            // wiped the game mid-round.
            if (lastPhase === 'playing') {
                resetType = 'newround';
            } else if (state.phase === 'playing') {
                // We just loaded the page and missed the transition;
                // game is already in flight → call it a new round.
                resetType = 'newround';
            } else {
                resetType = 'reset';
            }
        }
        knownRound = state.round;
        knownGameId = state.gameId || null;
        const prevPhase = lastPhase;
        lastPhase = state.phase;

        if (showingReset) {
            Empire.hideAllViews();
            Empire.setReactionBarVisible(false);
            Empire.setAttributionVisible(false);
            Empire.showView(resetType === 'newround' ? 'viewPlayerNewRound' : 'viewPlayerReset');
            return;
        }

        Empire.hideAllViews();

        // Setup with a saved submission is an edge case — the host
        // shouldn't be able to go back to setup without bumping the
        // round, but if it happens, bounce to /join.
        if (state.phase === 'setup') {
            navigatingAway = true;
            window.location.replace('/empire/join');
            return;
        }

        if (state.phase === 'submission') {
            Empire.showView('viewPlayerDone');
            const dpc = document.getElementById('donePlayerCount');
            if (dpc) dpc.textContent = state.playerCount;
            Empire.showCategoryBanner('done', state.category);
            renderSecretCard('Done');
            Empire.setReactionBarVisible(true);
            Empire.setAttributionVisible(true);
            return;
        }

        if (state.phase === 'playing') {
            Empire.showView('viewPlayerGame');
            Empire.showCategoryBanner('game', state.category);
            const gpc = document.getElementById('gamePlayerCount');
            const gpl = document.getElementById('gamePlayerCountLabel');
            if (gpc) gpc.textContent = state.playerCount;
            if (gpl) gpl.textContent = state.playerCount === 1 ? 'player in the game' : 'players in the game';
            // Reset reveal to hidden the first time we enter playing.
            if (prevPhase !== 'playing') resetSecretCard('Game');
            renderSecretCard('Game');
            Empire.setReactionBarVisible(true);
            Empire.setAttributionVisible(false);
            return;
        }
    }

    // ─── Secret card (your word) ────────────────────────────
    const SECRET_REVEAL_MS = 6000;
    const secretHideTimers = {};

    function renderSecretCard(suffix) {
        const wordEl = document.getElementById('secretWord' + suffix);
        if (wordEl) wordEl.textContent = (submittedWord || '').toLowerCase();
    }

    function resetSecretCard(suffix) {
        const card = document.getElementById('secretCard' + suffix);
        if (!card) return;
        card.classList.remove('is-revealed');
        if (secretHideTimers[suffix]) {
            clearTimeout(secretHideTimers[suffix]);
            secretHideTimers[suffix] = null;
        }
    }

    function toggleSecretCard(suffix) {
        const card = document.getElementById('secretCard' + suffix);
        if (!card) return;
        renderSecretCard(suffix);
        card.style.setProperty('--secret-reveal-ms', SECRET_REVEAL_MS + 'ms');
        if (card.classList.contains('is-revealed')) {
            card.classList.remove('is-revealed');
            if (secretHideTimers[suffix]) {
                clearTimeout(secretHideTimers[suffix]);
                secretHideTimers[suffix] = null;
            }
        } else {
            card.classList.add('is-revealed');
            if (secretHideTimers[suffix]) clearTimeout(secretHideTimers[suffix]);
            secretHideTimers[suffix] = setTimeout(function () {
                card.classList.remove('is-revealed');
                secretHideTimers[suffix] = null;
            }, SECRET_REVEAL_MS);
        }
    }

    // ─── Withdraw submission ────────────────────────────────
    async function withdrawSubmission() {
        const btn = document.getElementById('btnChangeWord');
        const msgEl = document.getElementById('withdrawMsg');
        if (btn) btn.disabled = true;
        try {
            const res = await fetch('/api/empire/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player: submittedName })
            });
            const data = await res.json();
            if (!res.ok) {
                Empire.showMsg(msgEl, data.error, 'error');
                if (btn) btn.disabled = false;
                return;
            }
            Empire.clearSubmission();
            navigatingAway = true;
            window.location.replace('/empire/join');
        } catch (e) {
            Empire.showMsg(msgEl, 'Connection error. Check your internet and try again.', 'error');
            if (btn) btn.disabled = false;
        }
    }

    // ─── Reset / new-round dismiss ─────────────────────────
    function dismissReset() {
        showingReset = false;
        Empire.clearSubmission();
        navigatingAway = true;
        window.location.replace('/empire/join');
    }

    // ─── Kicked-by-host handling ───────────────────────────
    function handleKicked(data) {
        const playerName = data && data.player;
        if (!playerName || !submittedName) return;
        if (playerName.toLowerCase() !== submittedName.toLowerCase()) return;
        kickedByHost = true;
        Empire.clearSubmission();
        Empire.hideAllViews();
        Empire.setReactionBarVisible(false);
        Empire.showView('viewPlayerKicked');
    }

    function rejoinAfterKick() {
        kickedByHost = false;
        Empire.clearSubmission();
        navigatingAway = true;
        window.location.replace('/empire/join');
    }

    // ─── Expose inline-handler entry points ─────────────────
    window.toggleSecretCard = toggleSecretCard;
    window.withdrawSubmission = withdrawSubmission;
    window.dismissReset = dismissReset;
    window.rejoinAfterKick = rejoinAfterKick;
})();
