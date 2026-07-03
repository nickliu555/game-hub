const games = [
    {
        id: 'empire',
        name: 'Empire',
        tagline: 'Guess who said what',
        emoji: '👑',
        color: '#2d0808',
        playerCount: '2–20+',
        duration: '10–30 min',
        description: 'Players secretly submit a word, then try to figure out which word belongs to each person. Bluff, deduce, and conquer!',
        rules: [
            'The host sets up the game on a shared screen (TV, laptop, etc.)',
            'Each player joins on their phone and submits a secret word',
            'Optionally, the host can set a category (e.g. "Movies", "Athletes")',
            'Once everyone has submitted, the host starts the game',
            'All words are revealed (shuffled) — but not who wrote them',
            'Players take turns guessing which word belongs to which person',
            'If you guess correctly, that player joins your "empire"',
            'Last player standing wins!'
        ],
        hostPath: '/empire/host',
        playPath: '/empire/play',
    },
    {
        id: 'trivia',
        name: 'Trivia',
        tagline: 'Fast-paced multiple-choice party quiz',
        emoji: '🧠',
        color: '#46178F',
        playerCount: '1–50+',
        duration: '5–15 min',
        description: 'Players join on their phones and race to answer multiple-choice trivia questions. Faster correct answers earn more points. Questions come live from the Open Trivia Database.',
        rules: [
            'The host opens the game on a shared screen (TV, laptop, etc.)',
            'Players scan the QR code on their phones and enter a name',
            'Host picks category, difficulty, number of questions, and time per question',
            'Each question shows 4 colored answer tiles labeled A, B, C, D',
            'Tap the tile you think is correct — faster answers earn more points',
            'After each question, see the bar chart and Top 5 leaderboard',
            'After the final question, the podium reveals the top 3'
        ],
        hostPath: '/trivia/host',
        playPath: '/trivia/play',
    },
    {
        id: 'twentyfour',
        name: '24',
        tagline: 'Race to 24 with four numbers and four operations',
        emoji: '🔢',
        color: '#F97316',
        playerCount: '1–20+',
        duration: '1–5 min',
        description: 'Combine four numbers with +, −, ×, ÷ to reach exactly 24. Play Sprint (solve your own stream of puzzles for points before time runs out) or Race (everyone gets the same problem and the first to solve it wins the point — first to the target score wins).',
        rules: [
            'The host opens the game on a shared screen (TV, laptop, etc.)',
            'Players scan the QR code on their phones and enter a name',
            'Host picks difficulty (easy / medium / hard / any) and round length',
            'When the round starts, everyone gets the same shuffled queue of puzzles',
            'Tap a number, an operator, then another number to combine them — repeat until one tile is left',
            'When that final tile equals 24, you score and the next puzzle appears',
            'The faster you solve, the more points you earn — stuck puzzles can be Skipped for a small penalty',
            'When the timer hits zero, the highest total score wins'
        ],
        hostPath: '/twentyfour/host',
        playPath: '/twentyfour/play',
        // Solo practice mode — pick a difficulty and solve unlimited puzzles
        // with a running timer and a "Give Up" reveal. Surfaced as a secondary
        // link on the hub card so it doesn't compete with the host CTA.
        practicePath: '/twentyfour/practice?from=hub',
    },
    {
        id: 'herdmind',
        name: 'Herd Mind',
        tagline: 'Match the herd, dodge the Pink Cow',
        emoji: '🐄',
        color: '#8B5E4C',
        playerCount: '3–20+',
        duration: '10–20 min',
        description: 'Everyone answers the same open question on their phone. Score by giving the MOST POPULAR answer — match the herd! Give a one-of-a-kind answer and you\'re stuck with the Pink Cow… and you can\'t win while you\'re holding it.',
        rules: [
            'The host opens the game on a shared screen (TV, laptop, etc.)',
            'Players scan the QR code on their phones and enter a name',
            'Each round a question appears — everyone secretly types an answer before the timer ends',
            'Everyone who gives the most popular answer earns a point — match the herd!',
            'Give a completely unique answer and you\'re landed with the Pink Cow 🐄',
            'You can\'t win while holding the Pink Cow — pass it on by making someone else the odd one out',
            'First to the target score (without the cow) wins the herd!'
        ],
        hostPath: '/herdmind/host',
        playPath: '/herdmind/play',
    },
];

module.exports = games;
