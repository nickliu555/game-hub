require('dotenv').config();
const express = require('express');
const path = require('path');
const os = require('os');
const http = require('http');
const games = require('./games');
const mountEmpire = require('./server/empire');
const mountTrivia = require('./server/trivia');
const mountTwentyFour = require('./server/twentyfour');
const mountHerdMind = require('./server/herdmind');
const mountHearts = require('./server/hearts');
const mountCatClash = require('./server/catclash');
const mountBoggle = require('./server/noggle');
const mountSoccerHead = require('./server/soccerhead');
const mountShootBall = require('./server/shootball');
const mountRankFive = require('./server/rankfive');
const mountMazeChomp = require('./server/mazechomp');
const mountBombBrawl = require('./server/bombbrawl');
const mountCamo = require('./server/camo');
const mountNockey = require('./server/nockey');
const mountStackingRoyale = require('./server/stackingroyale');
const app = express();

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Hub & Games API ────────────────────────────────────────

// Serve the hub page at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'hub.html'));
});

// Games registry API
app.get('/api/games', (req, res) => {
    res.json(games);
});

app.get('/api/games/:id', (req, res) => {
    const game = games.find(g => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
});

// ─── Trivia Game Routes ─────────────────────────────────────
app.get('/trivia/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'trivia', 'host.html'));
});
app.get('/trivia/play', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'trivia', 'player.html'));
});
app.get('/trivia/join', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'trivia', 'join.html'));
});

// ─── Compute LAN IP once at startup ─────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}
const LOCAL_IP = getLocalIP();

// ─── Start server ───────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);

// Build the public base URL once — both games need it for QR generation.
const getPublicBaseUrl = () => {
    if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    return `http://${LOCAL_IP}:${PORT}`;
};

// Mount the Empire secret-word party game (Socket.IO namespace + page routes).
mountEmpire(app, httpServer, { getPublicBaseUrl });

// Mount the Trivia game (Socket.IO namespace + REST endpoints).
mountTrivia(app, httpServer, { getPublicBaseUrl });

// Mount the "24" math game (Socket.IO namespace + REST endpoints + page routes).
mountTwentyFour(app, httpServer, { getPublicBaseUrl });

// Mount the "Herd Mind" game (Socket.IO namespace + REST endpoints + page routes).
mountHerdMind(app, httpServer, { getPublicBaseUrl });
mountHearts(app, httpServer, { getPublicBaseUrl });

// Mount the "Category Clash" Scattergories-style game (Socket.IO namespace + REST + page routes).
mountCatClash(app, httpServer, { getPublicBaseUrl });

// Mount the Boggle word game (Socket.IO namespace + REST endpoints + page routes).
mountBoggle(app, httpServer, { getPublicBaseUrl });

// Mount the Soccer Head arcade-soccer game (Socket.IO namespace + REST + page routes).
mountSoccerHead(app, httpServer, { getPublicBaseUrl });

// Mount the Shoot Ball turn-based flick-soccer game (Socket.IO namespace + REST + page routes).
mountShootBall(app, httpServer, { getPublicBaseUrl });

// Mount the Rank Five co-op guessing game (Socket.IO namespace + REST + page routes).
mountRankFive(app, httpServer, { getPublicBaseUrl });

// Mount the Maze Chomp arcade game (Socket.IO namespace + REST + page routes).
mountMazeChomp(app, httpServer, { getPublicBaseUrl });

// Mount the Bomb Brawl bomber battle (Socket.IO namespace + REST + page routes).
mountBombBrawl(app, httpServer, { getPublicBaseUrl });

// Mount the Camo hidden-role word game (Socket.IO namespace + REST + page routes).
mountCamo(app, httpServer, { getPublicBaseUrl });

// Mount the Nockey disc-hockey game (Socket.IO namespace + REST + page routes).
mountNockey(app, httpServer, { getPublicBaseUrl });
mountStackingRoyale(app, httpServer, { getPublicBaseUrl });

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  🎮 Game Hub');
    console.log('═══════════════════════════════════════════');
    if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`  Live at: ${process.env.RENDER_EXTERNAL_URL}`);
    } else {
        console.log(`  Hub:            http://localhost:${PORT}`);
    }
    console.log('═══════════════════════════════════════════');
    console.log('');
});
