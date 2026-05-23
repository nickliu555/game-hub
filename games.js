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
        description: 'Players each get the same shuffled puzzle queue of 4 numbers. Combine numbers with +, −, ×, ÷ to reach exactly 24. The faster you solve, the more points you earn. Highest total score when time runs out wins.',
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
];

module.exports = games;
