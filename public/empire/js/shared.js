// Shared client-side utilities for the Empire player pages
// (join.html + player.html). Exposed as `window.Empire`.
//
// All Empire player pages talk to the same `/empire` Socket.IO namespace,
// share the same easter-egg pink theme, the same host-absent overlay, the
// same localStorage submission record, and the same reaction-bar cooldown.
// Centralizing those concerns here keeps join.js / player.js focused on
// their own state machines.
(function (global) {
    'use strict';

    const Empire = {};

    // ─── Submission persistence ─────────────────────────────
    // localStorage key holding the player's current submission for the
    // active round. Shape: { round, gameId, name, word }.
    Empire.SUBMISSION_KEY = 'empire_submitted';
    // Separate, long-lived key for just the player's name. This
    // outlives clearSubmission() (which fires on reset / new round /
    // kick / server restart) so /join can always pre-fill the name the
    // player last used.
    Empire.NAME_KEY = 'empire_player_name';

    Empire.getSavedSubmission = function () {
        try {
            const raw = localStorage.getItem(Empire.SUBMISSION_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || typeof data !== 'object') return null;
            return data;
        } catch (_) {
            return null;
        }
    };

    Empire.saveSubmission = function (data) {
        try {
            localStorage.setItem(Empire.SUBMISSION_KEY, JSON.stringify(data));
        } catch (_) { /* quota / disabled storage — ignore */ }
        // Mirror the name into its own key so it survives a later
        // clearSubmission().
        if (data && data.name) Empire.saveName(data.name);
    };

    Empire.clearSubmission = function () {
        try { localStorage.removeItem(Empire.SUBMISSION_KEY); } catch (_) {}
    };

    // ─── Player-name persistence (survives clearSubmission) ──
    Empire.saveName = function (name) {
        try {
            const n = (name || '').trim();
            if (n) localStorage.setItem(Empire.NAME_KEY, n);
        } catch (_) { /* quota / disabled storage — ignore */ }
    };

    Empire.getSavedName = function () {
        try { return localStorage.getItem(Empire.NAME_KEY) || ''; }
        catch (_) { return ''; }
    };

    // True when the saved submission still belongs to the current
    // server session AND the current round. Used by both pages to
    // decide whether to redirect.
    Empire.isSavedSubmissionFresh = function (saved, state) {
        if (!saved || !state) return false;
        if (saved.gameId && state.gameId && saved.gameId !== state.gameId) return false;
        if (saved.round !== state.round) return false;
        return true;
    };

    // ─── Player identity ────────────────────────────────────
    // A stable per-device id, minted client-side. The server keys the
    // roster off this rather than the display name, so a reconnecting
    // phone gets its own submission back and nobody can withdraw or
    // kick someone else by guessing their name.
    Empire.PLAYER_ID_KEY = 'empire.playerId';

    function uuid() {
        if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : ((r & 0x3) | 0x8);
            return v.toString(16);
        });
    }

    Empire.getPlayerId = function () {
        try {
            let id = localStorage.getItem(Empire.PLAYER_ID_KEY);
            if (!id) {
                id = uuid();
                localStorage.setItem(Empire.PLAYER_ID_KEY, id);
            }
            return id;
        } catch (_) {
            // Private mode / disabled storage — fall back to a per-tab id.
            if (!Empire._memPlayerId) Empire._memPlayerId = uuid();
            return Empire._memPlayerId;
        }
    };

    Empire.clearPlayerId = function () {
        try { localStorage.removeItem(Empire.PLAYER_ID_KEY); } catch (_) {}
        Empire._memPlayerId = null;
    };

    // ─── Socket connection ──────────────────────────────────
    // Callers pass { onState, onKicked }. Returns the socket.
    Empire.socket = null;

    Empire.connect = function (handlers) {
        const onState  = (handlers && handlers.onState)  || function () {};
        const onKicked = (handlers && handlers.onKicked) || function () {};
        const onReady  = (handlers && handlers.onReady)  || function () {};

        const socket = global.io('/empire', { transports: ['polling', 'websocket'] });
        Empire.socket = socket;

        socket.on('state:update', onState);
        socket.on('player:kicked', onKicked);
        socket.on('connect', function () { onReady(socket); });
        return socket;
    };

    // Promise wrapper around an emit-with-ack. Always resolves — a dead
    // socket or a missing ack surfaces as { ok: false } rather than a
    // rejected promise the caller has to guard.
    Empire.emit = function (event, payload) {
        return new Promise(function (resolve) {
            if (!Empire.socket) return resolve({ ok: false, reason: 'not-connected' });
            let settled = false;
            const done = function (res) {
                if (settled) return;
                settled = true;
                resolve(res || { ok: false, reason: 'no-ack' });
            };
            setTimeout(function () { done({ ok: false, reason: 'timeout' }); }, 30000);
            Empire.socket.emit(event, payload || {}, done);
        });
    };

    // ─── Host-presence overlay ──────────────────────────────
    // Toggles the #hostAbsentOverlay element. Both pages include it.
    Empire.updateHostPresence = function (present) {
        const ov = document.getElementById('hostAbsentOverlay');
        if (ov) ov.classList.toggle('show', !present);
    };

    // ─── Easter egg: pink theme for certain names ──────────
    const EASTER_EGG_NAMES = ['carly', 'carshi', 'carcar'];
    Empire.checkEasterEgg = function (name) {
        const n = (name || '').toLowerCase().trim();
        if (EASTER_EGG_NAMES.includes(n)) {
            document.body.classList.add('pink-theme');
        } else {
            document.body.classList.remove('pink-theme');
        }
    };

    // ─── Generic message helper ────────────────────────────
    Empire.showMsg = function (el, text, type) {
        if (!el) return;
        el.className = 'msg ' + (type || '') + ' show';
        el.textContent = text;
    };

    // ─── Player header name ────────────────────────────────
    Empire.setPlayerHeaderName = function (name) {
        const el = document.getElementById('playerHeaderName');
        if (el) el.textContent = name || '';
    };

    // ─── Reaction bar ──────────────────────────────────────
    // Cooldown between consecutive reactions, in ms, persisted to
    // localStorage so it survives page navigation between /join
    // and /play.
    const REACTION_COOLDOWN_MS = 10 * 1000;
    const REACTION_LS_KEY = 'empire.lastReactionAt';
    let reactionUntilMs = 0;
    let reactionCountdownTimer = null;
    let reactionsMutedByHost = false;
    let reactionsInitialized = false;

    function eachReactionBar(fn) {
        document.querySelectorAll('.empire-reaction-bar').forEach(fn);
    }

    function updateReactionButtonState() {
        const now = Date.now();
        const onCooldown = now < reactionUntilMs;
        const disabled = onCooldown || reactionsMutedByHost;
        eachReactionBar(function (bar) {
            bar.querySelectorAll('.reaction-btn').forEach(function (b) { b.disabled = disabled; });
            const cd = bar.querySelector('.empire-reaction-cooldown');
            if (!cd) return;
            if (reactionsMutedByHost) {
                cd.hidden = false;
                cd.textContent = 'Reactions paused by host';
            } else if (onCooldown) {
                cd.hidden = false;
                cd.textContent = Math.ceil((reactionUntilMs - now) / 1000) + 's';
            } else {
                cd.hidden = true;
            }
        });
    }

    function startReactionCountdown() {
        if (reactionCountdownTimer) clearInterval(reactionCountdownTimer);
        updateReactionButtonState();
        reactionCountdownTimer = setInterval(function () {
            if (Date.now() >= reactionUntilMs) {
                clearInterval(reactionCountdownTimer);
                reactionCountdownTimer = null;
            }
            updateReactionButtonState();
        }, 250);
    }

    async function sendReaction(index) {
        const res = await Empire.emit('player:reaction', { index });
        if (res && !res.ok && res.reason === 'muted') {
            // Host muted reactions mid-tap — reflect locally so the
            // button feedback updates immediately.
            reactionsMutedByHost = true;
            updateReactionButtonState();
        }
        if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
            reactionUntilMs = Date.now() + res.retryInMs;
            startReactionCountdown();
        }
    }

    // Sets up the document-level click delegate exactly once. Safe to
    // call from any page; pages without an `.empire-reaction-bar`
    // element simply have no bars to act on.
    Empire.initReactionBar = function () {
        if (reactionsInitialized) return;
        reactionsInitialized = true;

        // Restore cooldown left over from a prior reaction (possibly
        // on the other page).
        const stored = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
        if (stored) {
            const elapsed = Date.now() - stored;
            if (elapsed < REACTION_COOLDOWN_MS) {
                reactionUntilMs = stored + REACTION_COOLDOWN_MS;
            } else {
                try { localStorage.removeItem(REACTION_LS_KEY); } catch (_) {}
            }
        }
        if (Date.now() < reactionUntilMs) startReactionCountdown();

        document.addEventListener('click', function (e) {
            const btn = e.target.closest('.empire-reaction-bar .reaction-btn');
            if (!btn || btn.disabled) return;
            const index = parseInt(btn.dataset.reaction, 10);
            if (isNaN(index)) return;
            const now = Date.now();
            reactionUntilMs = now + REACTION_COOLDOWN_MS;
            try { localStorage.setItem(REACTION_LS_KEY, String(now)); } catch (_) {}
            startReactionCountdown();
            sendReaction(index);
        });
    };

    // Allows the render loop to push the host's mute state in.
    Empire.setReactionsMuted = function (muted) {
        reactionsMutedByHost = !!muted;
        updateReactionButtonState();
    };

    Empire.setReactionBarVisible = function (visible) {
        const bar = document.getElementById('globalReactionBar');
        if (!bar) return;
        bar.classList.toggle('is-visible', !!visible);
        document.body.classList.toggle('has-reaction-bar', !!visible);
    };

    // Attribution credit visibility. Shown only during the "submission"
    // (waiting-for-game-to-start) phase — hidden once the game is
    // playing so it doesn't compete with the player's secret card.
    Empire.setAttributionVisible = function (visible) {
        const el = document.getElementById('playerAttribution');
        if (el) el.hidden = !visible;
    };

    // ─── View helpers ──────────────────────────────────────
    // Hides every element whose id starts with "view".
    Empire.hideAllViews = function () {
        document.querySelectorAll('[id^="view"]').forEach(function (el) {
            el.style.display = 'none';
        });
    };

    // Shows a view by id. Player views use flex column layout (so they
    // fill vertical space and push the reaction bar to the bottom);
    // everything else falls back to block.
    Empire.showView = function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = id.indexOf('viewPlayer') === 0 ? 'flex' : 'block';
    };

    // ─── Category chip helper ──────────────────────────────
    // Each view that wants to show the round category gives the chip
    // and value elements ids of the form `<prefix>CategoryChip` /
    // `<prefix>CategoryValue`.
    Empire.showCategoryBanner = function (prefix, category) {
        const chip = document.getElementById(prefix + 'CategoryChip');
        const value = document.getElementById(prefix + 'CategoryValue');
        if (!chip || !value) return;
        if (category) {
            value.textContent = category;
            chip.style.display = 'inline-flex';
        } else {
            chip.style.display = 'none';
        }
    };

    global.Empire = Empire;
})(window);
