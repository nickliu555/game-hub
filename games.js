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
];

module.exports = games;
