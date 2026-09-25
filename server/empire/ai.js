'use strict';

/**
 * Empire — Groq helpers.
 *
 * Decoy-word generation for the AI Bot, API-key validation, and the two
 * submission gates (similarity against words already in play, and category
 * fit). Every helper fails soft: a network error, a bad key or an
 * unparseable response resolves to a neutral value so a round never stalls
 * on the LLM.
 */

const { GROQ_MODEL, GROQ_CHAT_URL, GROQ_MODELS_URL, logGroqFailure } = require('../groq');

async function generateAiBotWords(existingWords, category, apiKey, count) {
    if (!apiKey || count <= 0) return [];

    const existingList = existingWords.map(w => `"${w}"`).join(', ');
    // Ask for enough candidates to comfortably fill `count` distinct decoys.
    const numCandidates = Math.max(10, count * 2);
    let categoryInstruction;
    if (category) {
        categoryInstruction = `The category for this round is: "${category}". Generate ${numCandidates} words or short phrases that fit this category.`;
    } else {
        categoryInstruction = `There is no category set. Generate ${numCandidates} random interesting words or short phrases that would be fun for a party game.`;
    }

    const prompt = `You are generating decoy word candidates for a party game called "Empire".
Players have each submitted a secret word. You need to generate a list of ${numCandidates} candidate words — ${count} will be randomly selected and mixed in to throw off the other players. The decoys must BLEND IN with the real player words so nobody can tell which ones are fake.

${categoryInstruction}

Real player words already submitted: ${existingList}

STEP 1 — IDENTIFY THE SPECIFIC SUB-GENRE (MOST IMPORTANT STEP):
Ignore the broad category. Instead, look ONLY at the actual player words and identify the NARROW sub-genre, style, era, or theme they share.
For example: if the category is "Albums" but most players picked a hip-hop album → the sub-genre is "hip-hop albums". If the category is "Movies" but most players picked a horror film → the sub-genre is "horror movies". If the category is "Athletes" but most players picked NBA players → the sub-genre is "NBA players".
ALL 10 of your candidates MUST belong to that same narrow sub-genre. Do NOT pick from the broader category — ONLY from the specific cluster the players defined.
If players are picking mainstream → pick mainstream. If players are picking underground/niche → pick underground/niche. Match the popularity level too.

STEP 2 — MAKE SURE EACH CANDIDATE IS TRULY UNIQUE:
This is CRITICAL. Every candidate you generate must be a COMPLETELY DIFFERENT entity from every player word. This means:
- NOT the same person by a different name (e.g., if "Drake" exists, do NOT pick "Drizzy", "Aubrey Graham", or "Champagne Papi")
- NOT a spelling variation (e.g., if "Kanye" exists, do NOT pick "Ye" or "Kanye West")
- NOT the same thing rephrased (e.g., if "golden retriever" exists, do NOT pick "goldie" or "retriever")
- NOT an abbreviation or acronym of an existing word
- NOT a nickname, alias, or stage name that refers to the same entity as any player word
Each candidate must refer to a GENUINELY DIFFERENT entity/concept that happens to fit the same vibe.

STEP 3 — TYPE IT LIKE A HUMAN WOULD:
Use the most common, casual way real people refer to things — the way you'd type it in a group chat, not a Wikipedia article.
- "Chris Hemsworth" NOT "Christopher Hemsworth"
- "Scarlett Johansson" NOT "Scarlett Ingrid Johansson"
- "LeBron" or "LeBron James" NOT "LeBron Raymone James"
- "The Godfather" NOT "The Godfather (1972 film)"
- "golden retriever" NOT "Golden Retriever dog breed"
Match how the PLAYERS are typing — look at their words for cues on formality level. If they wrote "Bron" you can be casual. If they wrote "LeBron James" match that level.

Rules:
- Each candidate must pass ALL THREE tests: blends in with the vibe, is a completely different entity from every player word, and is typed the way a human would
- Keep each to 1-4 words maximum
- Include variety — different picks within the same energy

Respond ONLY with valid JSON (no markdown, no extra text):
{"detected_subgenre": "the specific narrow sub-genre/style/era you identified from the player words", "words": ["word1", "word2", "...up to ${numCandidates} candidates"]}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch(GROQ_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.9,
                max_tokens: 2048,
                reasoning_effort: 'low',
                response_format: { type: 'json_object' },
                seed: Math.floor(Math.random() * 2147483647)
            }),
            signal: controller.signal,
        });

        if (!resp.ok) {
            await logGroqFailure('AI Bot word generation', resp);
            return [];
        }

        const data = await resp.json();
        const text = data.choices[0].message.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return [];
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.detected_subgenre) console.log(`AI Bot detected vibe: "${parsed.detected_subgenre}"`);
        const candidates = (parsed.words || [])
            .map(w => (w || '').trim().toLowerCase())
            .filter(w => w && !existingWords.some(e => e.toLowerCase() === w));
        if (!candidates.length) return [];
        // Shuffle candidates and pick up to `count` distinct decoys (no dupes).
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        const picks = [];
        for (const c of candidates) {
            if (picks.length >= count) break;
            if (!picks.includes(c)) picks.push(c);
        }
        return picks;
    } catch (e) {
        console.error('AI Bot word generation error:', e);
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

async function validateApiKey(key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const resp = await fetch(GROQ_MODELS_URL, {
            headers: { 'Authorization': `Bearer ${key}` },
            signal: controller.signal,
        });
        if (!resp.ok) {
            await logGroqFailure('API key validation', resp);
            return false;
        }
        // A valid key is useless if it can't reach the model we actually call.
        const data = await resp.json();
        const ids = (data.data || []).map(m => m.id);
        if (ids.length && !ids.includes(GROQ_MODEL)) {
            console.error(`API key validation: key is valid but model "${GROQ_MODEL}" is not available to it. Available: ${ids.join(', ')}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error('API key validation error:', e.message);
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

async function checkSimilarity(newWord, existingWords, apiKey) {
    if (!existingWords.length || !apiKey) return null;

    const existingList = existingWords.map(w => `"${w}"`).join(', ');
    const prompt = `You are a word similarity checker for a party game called "Empire". 
Your job is to reject words that are TOO SIMILAR - only reject if they refer to the SAME concept or entity.

New word submitted: "${newWord}"
Existing words: ${existingList}

Check if the new word is similar to ANY of the existing words. ONLY REJECT if:
- Exact match or spelling variation (e.g., "color" vs "colour") → REJECT
- Same root word in a different form - plurals, verb tenses, gerunds, etc. (e.g., "bike" vs "biking", "run" vs "running", "cat" vs "cats", "swim" vs "swimmer", "drive" vs "driving") → REJECT
- Same person/entity with minor variations (e.g., "Kanye" vs "Kanye West", "Taylor" vs "Taylor Swift") → REJECT
- Nicknames, aliases, or stage names referring to the same person/thing (e.g., "Drake" vs "Drizzy", "The Rock" vs "Dwayne Johnson", "MJ" vs "Michael Jordan", "Bey" vs "Beyoncé") → REJECT
- Same concept phrased differently (e.g., "egg roll" and "spring roll" are both types of rolls) → REJECT
- Obvious typos (e.g., "Chirs" vs "Chris") → REJECT
- Abbreviations or acronyms for the same thing (e.g., "NBA" vs "National Basketball Association", "NYC" vs "New York City") → REJECT

DO NOT REJECT if:
- Different people who share a first name (e.g., "Chris Pratt" vs "Chris Hemsworth") → ACCEPT
- Different concepts that happen to share a word (e.g., "hot dog" vs "hot tub") → ACCEPT
- Synonyms that are distinct enough (e.g., "happy" vs "joyful") → ACCEPT

Respond ONLY with valid JSON (no markdown, no extra text):
{"is_similar": true/false, "similar_to": "word or null", "reason": "brief explanation"}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch(GROQ_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 1024,
                reasoning_effort: 'low',
                response_format: { type: 'json_object' }
            }),
            signal: controller.signal,
        });

        if (!resp.ok) {
            await logGroqFailure('Similarity check', resp);
            return null;
        }

        const data = await resp.json();
        const text = data.choices[0].message.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('Similarity check error:', e);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function checkCategoryFit(word, category, apiKey) {
    if (!category || !apiKey) return null;

    const prompt = `You are a category checker for a party game called "Empire".
Players submit a word that should fit a given category.

Category: "${category}"
Word submitted: "${word}"

Be lenient for borderline cases — this is a casual party game, not a strict quiz.
But the word should reasonably belong in the category based on what it is PRIMARILY KNOWN FOR.
Do not stretch to find tenuous connections.

For example:
- "swimmer" for "Occupations" → ACCEPT (professional swimmers exist)
- "runner" for "Occupations" → ACCEPT (people run professionally)
- "pizza" for "Occupations" → REJECT (pizza is a food, not an occupation)
- "cake" for "Movies" → REJECT (not a well-known movie)
- "kanye" for "Athletes" → REJECT (he is primarily a musician, not an athlete)
- "lebron" for "Athletes" → ACCEPT (he is primarily known as an athlete)
- "shaq" for "Actors" → REJECT (he is primarily known as a basketball player)

Respond ONLY with valid JSON (no markdown, no extra text):
{"fits_category": true/false}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch(GROQ_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 1024,
                reasoning_effort: 'low',
                response_format: { type: 'json_object' }
            }),
            signal: controller.signal,
        });

        if (!resp.ok) {
            await logGroqFailure('Category check', resp);
            return null;
        }

        const data = await resp.json();
        const text = data.choices[0].message.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('Category check error:', e);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { generateAiBotWords, validateApiKey, checkSimilarity, checkCategoryFit };
