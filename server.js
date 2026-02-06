const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require("@whiskeysockets/baileys");
const http = require("http");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const isProduction = process.env.RENDER || process.env.NODE_ENV === 'production';

// Render uses an ephemeral /tmp directory for writes
const BASE_SESSION_DIR = isProduction ? '/tmp/scorpio_sessions' : path.join(__dirname, 'sessions');

if (!fs.existsSync(BASE_SESSION_DIR)) {
    fs.mkdirSync(BASE_SESSION_DIR, { recursive: true });
}

// Global memory for concurrent sessions
const sessions = new Map();

/**
 * ENGINE: Logic for a single WhatsApp client
 */
async function startSession(sessionId) {
    if (sessions.has(sessionId) && sessions.get(sessionId).sock) return;

    // Initialize session state
    sessions.set(sessionId, { 
        connected: false, 
        qr: null, 
        views: 0, 
        emoji: "none", 
        active: true,
        phoneNumber: null,
        lastPulse: "WAITING...",
        sock: null 
    });

    const sessionFolder = path.join(BASE_SESSION_DIR, sessionId);
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Scorpio Engine", "Chrome", "1.0.0"],
        printQRInTerminal: false
    });

    const session = sessions.get(sessionId);
    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !session.connected) {
            session.qr = await QRCode.toDataURL(qr);
        }

        if (connection === 'open') {
            session.connected = true;
            session.qr = null;
            session.phoneNumber = jidNormalizedUser(sock.user.id).split('@')[0];
            session.lastPulse = new Date().toLocaleTimeString();
            console.log(`[CONNECTED] User: ${session.phoneNumber} | Session: ${sessionId}`);
        }

        if (connection === 'close') {
            session.connected = false;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect && sessions.has(sessionId)) {
                setTimeout(() => {
                    // Refresh session entry and restart
                    const currentEmoji = session.emoji;
                    const currentViews = session.views;
                    sessions.delete(sessionId);
                    startSession(sessionId).then(() => {
                        const newSession = sessions.get(sessionId);
                        if(newSession) {
                            newSession.emoji = currentEmoji;
                            newSession.views = currentViews;
                        }
                    });
                }, 5000);
            } else {
                console.log(`[LOGOUT] Session ${sessionId} removed.`);
                sessions.delete(sessionId);
                if (fs.existsSync(sessionFolder)) fs.rmSync(sessionFolder, { recursive: true, force: true });
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!session.connected || !session.active) return;

        for (const msg of messages) {
            if (msg.key.remoteJid === "status@broadcast" && !msg.key.fromMe) {
                const participant = msg.key.participant || msg.participant;
                try {
                    await sock.sendReceipt("status@broadcast", participant, [msg.key.id], "read");
                    session.views++;
                    if (session.emoji !== "none") {
                        await sock.sendMessage("status@broadcast", { react: { text: session.emoji, key: msg.key } }, { statusJidList: [participant] });
                    }
                } catch (e) {}
            }
        }
    });
}

// --- SERVER LOGIC ---
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sid");

    // Keep-alive route for Cron-jobs
    if (url.pathname === "/cron-pulse") {
        res.writeHead(200);
        return res.end("PULSE_OK");
    }

    // API: Get Status
    if (url.pathname === "/api/status" && sessionId) {
        if (!sessions.has(sessionId)) startSession(sessionId);
        const s = sessions.get(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            connected: s.connected,
            qr: s.qr,
            views: s.views,
            emoji: s.emoji,
            active: s.active,
            phoneNumber: s.phoneNumber,
            lastPulse: s.lastPulse
        }));
    }

    // API: Toggle Start/Stop
    if (url.pathname === "/api/toggle" && sessionId) {
        if (sessions.has(sessionId)) sessions.get(sessionId).active = !sessions.get(sessionId).active;
        res.writeHead(200); return res.end("OK");
    }

    // API: Set Emoji
    if (url.pathname === "/api/set-emoji" && sessionId) {
        const emoji = url.searchParams.get("emoji");
        if (sessions.has(sessionId)) sessions.get(sessionId).emoji = emoji;
        res.writeHead(200); return res.end("OK");
    }

    // UI DASHBOARD
    if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.tailwindcss.com"></script>
    <title>Scorpio Concurrent</title>
    <style>
        body { background: #020617; color: white; font-family: sans-serif; }
        .glass { background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.1); }
        .qr-bg { background: white; padding: 12px; border-radius: 1.5rem; display: inline-block; }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="glass p-8 rounded-[3rem] w-full max-w-md text-center shadow-2xl">
        <h1 class="text-3xl font-black italic tracking-tighter mb-8">SCORPIO<span class="text-orange-500 text-4xl">.</span></h1>

        <div id="setup-view">
            <div id="qr-container" class="hidden mb-6">
                <div class="qr-bg"><img id="qrcode" class="w-52 h-52"></div>
            </div>
            <p id="st-text" class="text-[10px] text-slate-500 uppercase tracking-widest animate-pulse font-bold">Initializing Engine...</p>
        </div>

        <div id="dash-view" class="hidden space-y-6">
            <div class="grid grid-cols-2 gap-3">
                <div class="bg-slate-900/50 p-4 rounded-2xl border border-white/5 text-left">
                    <p class="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">Engine</p>
                    <p id="mode-text" class="text-xs font-black uppercase"></p>
                </div>
                <div class="bg-slate-900/50 p-4 rounded-2xl border border-white/5 text-right">
                    <p class="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">Status Views</p>
                    <p id="view-count" class="text-2xl font-black italic text-orange-500">0</p>
                </div>
            </div>

            <div class="space-y-2 text-left">
                <label class="text-[9px] text-slate-500 font-black uppercase ml-1">Reaction Core</label>
                <div class="flex gap-2">
                    <select id="emoji-list" class="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 text-sm outline-none focus:border-orange-500 transition-all">
                        <option value="none">🚫 Ghost Mode</option>
                        <optgroup label="Popular">
                            <option value="🔥">🔥 Fire</option><option value="⚡">⚡ Lightning</option><option value="💯">💯 100%</option>
                        </optgroup>
                        <optgroup label="Love">
                            <option value="❤️">❤️ Heart</option><option value="🌹">🌹 Rose</option><option value="✨">✨ Sparkles</option>
                        </optgroup>
                        <optgroup label="Power">
                            <option value="🦁">🦁 Lion</option><option value="🦂">🦂 Scorpio</option><option value="🥷">🥷 Shinobi</option>
                        </optgroup>
                        <optgroup label="Classic">
                            <option value="😂">😂 Laugh</option><option value="🫡">🫡 Salute</option><option value="✅">✅ Verified</option>
                        </optgroup>
                    </select>
                    <button onclick="updateEmoji()" class="bg-orange-600 px-6 rounded-xl font-black text-[10px] uppercase hover:bg-orange-500 transition-all">Save</button>
                </div>
            </div>

            <button id="toggleBtn" onclick="toggleBot()" class="w-full py-4 rounded-2xl font-black text-[11px] uppercase tracking-widest transition-all"></button>
            
            <div class="pt-4 border-t border-white/5 flex justify-between items-center px-1">
                <p class="text-[8px] text-slate-600 font-bold uppercase tracking-widest">Account: <span id="user-phone" class="text-slate-400"></span></p>
                <p class="text-[8px] text-slate-600 font-bold uppercase tracking-widest">Pulse: <span id="pulse-time" class="text-orange-500/50"></span></p>
            </div>
        </div>
    </div>

    <script>
        // Use Persistent Browser-based Session ID
        let sid = localStorage.getItem('sc_sid') || ('sc_' + Math.random().toString(36).substr(2, 9));
        localStorage.setItem('sc_sid', sid);

        async function updateEmoji() {
            const e = document.getElementById('emoji-list').value;
            await fetch('/api/set-emoji?sid=' + sid + '&emoji=' + encodeURIComponent(e));
        }

        async function toggleBot() { await fetch('/api/toggle?sid=' + sid); }

        async function poll() {
            try {
                const r = await fetch('/api/status?sid=' + sid);
                const d = await r.json();

                if (d.connected) {
                    document.getElementById('setup-view').classList.add('hidden');
                    document.getElementById('dash-view').classList.remove('hidden');
                    document.getElementById('view-count').innerText = d.views;
                    document.getElementById('pulse-time').innerText = d.lastPulse;
                    document.getElementById('user-phone').innerText = "+" + d.phoneNumber;
                    
                    const mt = document.getElementById('mode-text');
                    mt.innerText = d.active ? 'Operational' : 'Standby';
                    mt.className = d.active ? 'text-xs font-black text-emerald-400' : 'text-xs font-black text-slate-500';

                    const btn = document.getElementById('toggleBtn');
                    btn.className = d.active ? 'bg-red-500/10 text-red-500 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
                    btn.innerText = d.active ? 'STOP BOT' : 'START BOT';
                } else if (d.qr) {
                    document.getElementById('qr-container').classList.remove('hidden');
                    document.getElementById('qrcode').src = d.qr;
                    document.getElementById('st-text').innerText = "SCAN QR TO LINK";
                }
            } catch(e) {}
        }
        setInterval(poll, 3000);
        poll();
    </script>
</body>
</html>
        `);
    }
});

server.listen(PORT, () => {
    console.log(`\x1b[36m[SCORPIO ENGINE]\x1b[0m Running on port ${PORT}`);
    console.log(`\x1b[33m[INFO]\x1b[0m Sessions stored in: ${BASE_SESSION_DIR}`);
});