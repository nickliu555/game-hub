'use strict';

/**
 * Empire — game state.
 *
 * Empire has no turn engine: a round is just a bag of secret words that the
 * host reveals on the big screen. The state is therefore a plain object plus
 * the projection that clients are allowed to see.
 */

const MAX_BOTS = 10;
const REACTION_COUNT = 6;
const BOT_NAME = 'AI Bot 🤖';

const PHASES = {
    SETUP: 'setup',           // waiting for the host to supply a Groq API key
    SUBMISSION: 'submission', // lobby — players are submitting their words
    PLAYING: 'playing',       // words are locked and revealed on the host screen
};

// Stable for the entire server lifetime — clients compare it against the
// value they stored so a server restart invalidates a stale submission.
const SERVER_GAME_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function createFreshState() {
    // If GROQ_API_KEY env var is set, skip the setup phase
    const envKey = process.env.GROQ_API_KEY || null;
    return {
        phase: envKey ? PHASES.SUBMISSION : PHASES.SETUP,
        groqApiKey: envKey,
        submissions: [],       // [{ playerId, player, word, isBot? }]
        shuffledWords: [],     // randomized once on game start
        round: 1,              // increments on each reset so clients detect it
        category: '',          // optional category set by host
        botCount: 0,           // number of AI decoy words (0–10)
        reactionsMuted: false, // host can mute all player reactions
        gameId: SERVER_GAME_ID, // stable for entire server lifetime
    };
}

const humans = (state) => state.submissions.filter(s => !s.isBot);

// The public projection — never leaks the words or the API key.
function getPublicState(gameState, { playerUrl, hostPresent }) {
    const people = humans(gameState);
    return {
        phase: gameState.phase,
        playerCount: people.length,
        players: people.map(s => ({ id: s.playerId, name: s.player })),
        playerNames: people.map(s => s.player),
        hasApiKey: !!gameState.groqApiKey,
        playerUrl,
        round: gameState.round,
        category: gameState.category,
        botCount: gameState.botCount,
        reactionsMuted: gameState.reactionsMuted,
        gameId: gameState.gameId,
        hostPresent,
    };
}

module.exports = {
    MAX_BOTS,
    REACTION_COUNT,
    BOT_NAME,
    PHASES,
    SERVER_GAME_ID,
    createFreshState,
    getPublicState,
    humans,
};
