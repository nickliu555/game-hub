// Client-side state machine for the Empire JOIN page (/empire/join).
//
// Responsibilities:
//   • Render the "submit your word" form (the default view).
//   • Render the appropriate non-form view based on the current phase
//     (waiting for host in `setup`, locked out in `playing`).
//   • Render the "removed by host" view if a `player:kicked` event
//     names this player.
//   • As soon as the user submits a word — OR if a prior valid
//     submission is restored from localStorage — redirect to
//     /empire/play.
//
// Pages share `window.Empire` from shared.js for the socket, host-presence,
// easter egg, localStorage helpers, etc.
(function () {
    'use strict';

    // ─── Local page state ──────────────────────────────
    let knownRound = null;
    let knownGameId = null;
    let kickedByHost = false;
    let lastState = null;
    // Set once we've committed to leaving for /empire/play, so a state
    // broadcast landing mid-navigation can't fire a second redirect
    // (which aborts the first).
    let navigatingAway = false;
    // Set true after the first state callback fires so we know what
    // round/game we are about to submit into.
    let stateReady = false;

    document.addEventListener('DOMContentLoaded', init);

    async function init() {
        // Restore name input + pink theme from a prior visit. We
        // intentionally do NOT preload the word input — the user
        // re-types their secret each round. Prefer the current
        // submission's name, but fall back to the long-lived saved
        // name (which survives a reset / new round that cleared the
        // submission record).
        const saved = Empire.getSavedSubmission();
        const savedName = (saved && saved.name) || Empire.getSavedName();
        if (savedName) {
            const nameInput = document.getElementById('playerName');
            if (nameInput) nameInput.value = savedName;
            Empire.checkEasterEgg(savedName);
        }

        Empire.hideAllViews();
        Empire.connect({ onState: render, onKicked: handleKicked });

        wireInputs();
    }

    // Reason codes from the server, turned into something a player can act on.
    const SUBMIT_ERRORS = {
        'host-absent': 'The host has left the game.',
        'wrong-phase': 'Not accepting submissions right now.',
        'missing-fields': 'Enter both your name and word.',
        'reserved-name': 'That name is reserved. Please choose another.',
        'already-submitted': 'You have already submitted a word this round.',
        'word-taken': 'That word is not available. Try another!',
        'rate-limited': 'Too many tries. Please wait a moment and try again.',
        'bad-player-id': 'Something went wrong. Please reload the page.',
        'not-connected': 'Still connecting — try again in a moment.',
        'timeout': 'The server took too long to answer. Try again.',
    };

    function submitErrorMessage(res) {
        if (res && res.reason === 'name-taken') {
            return (res.name || 'That name') + ' is already another player\'s name.';
        }
        return (res && SUBMIT_ERRORS[res.reason]) || 'Could not submit. Please try again.';
    }

    // ─── Render loop ────────────────────────────────────────
    function render(state) {
        if (navigatingAway) return;
        lastState = state;
        Empire.updateHostPresence(state.hostPresent !== false);

        // Track round/gameId so submit() can write the right values.
        // Detect server restart (gameId change) — clear stale local
        // state silently.
        const gameIdMismatch = state.gameId && knownGameId !== null && knownGameId !== state.gameId;
        if (gameIdMismatch) {
            Empire.clearSubmission();
        }
        knownRound = state.round;
        knownGameId = state.gameId || null;
        stateReady = true;

        // If the user got kicked, stay on the kicked screen until the
        // host advances rounds (same flow as before).
        if (kickedByHost) {
            return;
        }

        // If a submission for this exact round+game appears in storage
        // (e.g., the user re-opened /empire/join in a new tab after
        // submitting elsewhere), hop over to /play.
        const saved = Empire.getSavedSubmission();
        if (Empire.isSavedSubmissionFresh(saved, state)) {
            navigatingAway = true;
            window.location.replace('/empire/play');
            return;
        }

        Empire.hideAllViews();

        if (state.phase === 'setup') {
            Empire.showView('viewPlayerWaiting');
            return;
        }

        if (state.phase === 'playing') {
            // Game already running and we never submitted — lock out
            // until the next round.
            Empire.showView('viewPlayerLocked');
            return;
        }

        // Default: submission phase — show the form.
        Empire.showView('viewPlayerSubmit');
        Empire.showCategoryBanner('submit', state.category);
    }

    // ─── Submit handlers ────────────────────────────────────
    async function playerSubmitWord(skipCategoryCheck) {
        const nameInput = document.getElementById('playerName');
        const wordInput = document.getElementById('playerWord');
        const msgEl = document.getElementById('playerSubmitMsg');
        const btn = document.getElementById('btnPlayerSubmit');

        const name = (nameInput.value || '').trim();
        const word = (wordInput.value || '').trim();

        if (!name || !word) {
            Empire.showMsg(msgEl, 'Enter both your name and word.', 'error');
            return;
        }
        if (!stateReady) {
            Empire.showMsg(msgEl, 'Still connecting — try again in a moment.', 'error');
            return;
        }

        document.getElementById('categoryWarningBox').style.display = 'none';
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>Checking...';

        const res = await Empire.emit('player:submit', {
            playerId: Empire.getPlayerId(),
            name: name,
            word: word,
            skipCategoryCheck: !!skipCategoryCheck,
        });

        if (!res || !res.ok) {
            Empire.showMsg(msgEl, submitErrorMessage(res), 'error');
            btn.disabled = false;
            btn.textContent = 'Submit Word';
            return;
        }
        // Category warning (soft) — show "submit anyway" UI.
        if (res.categoryWarning) {
            msgEl.classList.remove('show');
            document.getElementById('categoryWarningText').textContent = res.reason;
            document.getElementById('categoryWarningBox').style.display = 'block';
            document.getElementById('submitBtnRow').style.display = 'none';
            btn.disabled = false;
            btn.textContent = 'Submit Word';
            return;
        }

        Empire.checkEasterEgg(name);
        Empire.saveSubmission({
            round: res.round !== undefined ? res.round : knownRound,
            gameId: res.gameId || knownGameId,
            name: res.name || name,
            word: res.word || word
        });
        // Hand off to the play page — it renders the "done" /
        // "playing" views with the secret card and reactions.
        navigatingAway = true;
        window.location.replace('/empire/play');
    }

    function playerClear() {
        document.getElementById('playerName').value = '';
        document.getElementById('playerWord').value = '';
        document.getElementById('playerSubmitMsg').classList.remove('show');
        document.getElementById('categoryWarningBox').style.display = 'none';
        Empire.checkEasterEgg('');
        document.getElementById('playerName').focus();
    }

    function submitAnyway() {
        document.getElementById('categoryWarningBox').style.display = 'none';
        document.getElementById('submitBtnRow').style.display = '';
        playerSubmitWord(true);
    }

    function dismissCategoryWarning() {
        document.getElementById('categoryWarningBox').style.display = 'none';
        document.getElementById('submitBtnRow').style.display = '';
        document.getElementById('playerWord').focus();
    }

    // ─── Kicked-by-host handling ────────────────────────────
    function handleKicked(data) {
        if (!data || data.playerId !== Empire.getPlayerId()) return;
        kickedByHost = true;
        Empire.clearSubmission();
        Empire.hideAllViews();
        Empire.showView('viewPlayerKicked');
    }

    function rejoinAfterKick() {
        kickedByHost = false;
        Empire.clearSubmission();
        const wordInput = document.getElementById('playerWord');
        if (wordInput) wordInput.value = '';
        const submitMsg = document.getElementById('playerSubmitMsg');
        if (submitMsg) submitMsg.classList.remove('show');
        const submitBtn = document.getElementById('btnPlayerSubmit');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Word'; }
        Empire.hideAllViews();
        // Re-render from the last state the server pushed.
        if (lastState) render(lastState);
    }

    // ─── Input wiring ───────────────────────────────────────
    function wireInputs() {
        const nameInput = document.getElementById('playerName');
        const wordInput = document.getElementById('playerWord');

        // Easter egg fires live as the user types their name.
        if (nameInput) {
            nameInput.addEventListener('input', function () {
                Empire.checkEasterEgg(nameInput.value);
            });
        }

        document.addEventListener('keypress', function (e) {
            if (e.key !== 'Enter') return;
            if (e.target.id === 'playerName') wordInput && wordInput.focus();
            else if (e.target.id === 'playerWord') playerSubmitWord();
        });

        // Editing the word after a category warning dismisses it.
        if (wordInput) {
            wordInput.addEventListener('input', function () {
                const box = document.getElementById('categoryWarningBox');
                if (box && box.style.display !== 'none') {
                    box.style.display = 'none';
                    document.getElementById('submitBtnRow').style.display = '';
                }
            });
        }
    }

    // ─── Expose inline-handler entry points ─────────────────
    window.playerSubmitWord = playerSubmitWord;
    window.playerClear = playerClear;
    window.submitAnyway = submitAnyway;
    window.dismissCategoryWarning = dismissCategoryWarning;
    window.rejoinAfterKick = rejoinAfterKick;
})();
