const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const http = require("http");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const axios = require("axios");

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MY_URL = "https://scorpiocontrol.onrender.com";

const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
    const message = chunk.toString();
    if (["Closing session", "SessionEntry", "Buffer"].some(k => message.includes(k))) return true;
    return originalWrite.call(process.stdout, chunk, encoding, callback);
};

// --- PERSISTENCE ---
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = { emoji: "none", active: true };
if (fs.existsSync(SETTINGS_FILE)) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { saveSettings(); }
}
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

let qrCodeData = null; 
let isConnected = false;
let viewsCount = 0;
let lastPulseTime = "WAITING...";

const isProduction = process.env.RENDER || process.env.NODE_ENV === 'production';
const AUTH_FOLDER = isProduction ? path.join('/tmp', 'scorpio_auth') : path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

// --- ANTI-SLEEP HEARTBEAT ---
function startHeartbeat() {
    setInterval(async () => {
        try {
            // Internal loop to keep the process warm
            await axios.get(`${MY_URL}/cron-pulse`);
        } catch (e) {
            originalWrite.call(process.stdout, `[HEARTBEAT] Internal pulse check.\n`);
        }
    }, 600000); 
}

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Scorpio-V4", "Chrome", "1.0.0"],
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodeData = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            console.clear();
            originalWrite.call(process.stdout, `\x1b[38;5;208m[SCORPIO]\x1b[0m Hybrid Engine Active @ ${MY_URL}\n`);
            startHeartbeat(); 
        }
        if (connection === 'close') {
            isConnected = false;
            if ((lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(startWhatsApp, 5000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!settings.active) return;
        for (const msg of messages) {
            if (msg.key.remoteJid === "status@broadcast" && !msg.key.fromMe) {
                const participant = msg.key.participant || msg.participant;
                try {
                    await sock.sendReceipt("status@broadcast", participant, [msg.key.id], "read");
                    viewsCount++;
                    if (settings.emoji !== "none") {
                        await sock.sendMessage("status@broadcast", { react: { text: settings.emoji, key: msg.key } }, { statusJidList: [participant] });
                    }
                } catch (e) {}
            }
        }
    });
}

// --- SERVER & DASHBOARD ---
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // FIX: Optimized for cron-job.org to prevent "Output too large"
    if (req.url === "/cron-pulse") {
        lastPulseTime = new Date().toLocaleTimeString();
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 1 });
        res.end("1"); 
        return;
    }

    if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <script src="https://cdn.tailwindcss.com"></script>
                <title>Scorpio Control</title>
                <style>
                    body { background: #020617; color: #f8fafc; font-family: sans-serif; }
                    .glass { background: rgba(15, 23, 42, 0.9); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.1); }
                    .glow { box-shadow: 0 0 30px rgba(249, 115, 22, 0.15); }
                    select option { background: #0f172a; color: white; }
                    .qr-frame { background: white; padding: 12px; border-radius: 24px; display: flex; justify-content: center; align-items: center; }
                </style>
            </head>
            <body class="flex items-center justify-center min-h-screen p-4">
                <div class="glass p-8 rounded-[2.5rem] shadow-2xl w-full max-w-md glow text-center">
                    <h1 class="text-3xl font-black italic tracking-tighter mb-6">SCORPIO<span class="text-orange-500 text-4xl">.</span></h1>
                    
                    <div id="setup-view" class="flex flex-col items-center">
                        <div id="qr-container" class="hidden mb-6">
                            <div class="qr-frame">
                                <img id="qrcode" class="w-56 h-56" alt="Scan QR">
                            </div>
                        </div>
                        <p id="st-text" class="text-[10px] text-slate-500 uppercase tracking-widest animate-pulse font-bold">Initializing Engine...</p>
                    </div>

                    <div id="dash-view" class="hidden space-y-4">
                        <div class="grid grid-cols-2 gap-3">
                            <div class="bg-slate-950/50 p-4 rounded-2xl border border-slate-800 text-left">
                                <p class="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-1">Status</p>
                                <p id="mode-text" class="text-xs font-black"></p>
                            </div>
                            <div class="bg-slate-950/50 p-4 rounded-2xl border border-slate-800 text-right">
                                <p class="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-1">Views</p>
                                <p id="view-count" class="text-xl font-black italic">0</p>
                            </div>
                        </div>

                        <div class="space-y-2 text-left">
                            <label class="text-[9px] text-slate-500 font-bold uppercase ml-1">Reaction Module</label>
                            <div class="flex gap-2">
                                <select id="emoji-list" class="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 text-sm outline-none focus:border-orange-500">
                                    <option value="none">🚫 Silent Lurk</option>
                                    <optgroup label="Fire & Energy">
                                        <option value="🔥">🔥 Fire</option><option value="⚡">⚡ Lightning</option><option value="💥">💥 Explosion</option><option value="✨">✨ Sparkles</option><option value="💯">💯 100</option><option value="🚀">🚀 Rocket</option>
                                    </optgroup>
                                    <optgroup label="Love & Hearts">
                                        <option value="❤️">❤️ Red Heart</option><option value="🧡">🧡 Orange Heart</option><option value="🖤">🖤 Black Heart</option><option value="💘">💘 Love Bolt</option><option value="🌹">🌹 Rose</option>
                                    </optgroup>
                                    <optgroup label="Animals & Power">
                                        <option value="🦁">🦁 Lion</option><option value="🦅">🦅 Eagle</option><option value="🦂">🦂 Scorpio</option><option value="🐉">🐉 Dragon</option><option value="🦾">🦾 Power Arm</option><option value="🥷">🥷 Shinobi</option>
                                    </optgroup>
                                    <optgroup label="Classic Reacts">
                                        <option value="😂">😂 Laughing</option><option value="🙌">🙌 Hands Up</option><option value="🫡">🫡 Salute</option><option value="👀">👀 Looking</option><option value="✅">✅ Verified</option><option value="💎">💎 Diamond</option>
                                    </optgroup>
                                    <optgroup label="Nature">
                                        <option value="🌊">🌊 Wave</option><option value="🌙">🌙 Moon</option><option value="🌵">🌵 Cactus</option><option value="🍃">🍃 Leaves</option>
                                    </optgroup>
                                </select>
                                <button onclick="updateEmoji()" class="bg-orange-600 px-4 rounded-xl font-bold text-[10px] uppercase hover:bg-orange-500 transition-colors">Apply</button>
                            </div>
                        </div>

                        <button id="toggleBtn" onclick="toggleBot()" class="w-full py-4 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all mt-2"></button>
                        
                        <div class="pt-4 border-t border-slate-800 text-center">
                            <p class="text-[8px] text-slate-500 uppercase tracking-[0.3em]">Last Heartbeat: <span id="pulse-time" class="text-orange-400">WAITING</span></p>
                        </div>
                    </div>
                </div>

                <script>
                    let lastE = "";
                    async function updateEmoji() {
                        const e = document.getElementById('emoji-list').value;
                        await fetch('/set-emoji?emoji=' + encodeURIComponent(e));
                    }
                    async function toggleBot() { await fetch('/toggle'); }
                    function updateDash(data) {
                        if (data.connected) {
                            document.getElementById('setup-view').classList.add('hidden');
                            document.getElementById('dash-view').classList.remove('hidden');
                            document.getElementById('view-count').innerText = data.views;
                            document.getElementById('pulse-time').innerText = data.lastPulse;
                            if(lastE !== data.currentEmoji) { document.getElementById('emoji-list').value = data.currentEmoji; lastE = data.currentEmoji; }
                            
                            const modeText = document.getElementById('mode-text');
                            modeText.innerText = data.active ? 'OPERATIONAL' : 'STANDBY';
                            modeText.className = data.active ? 'text-xs font-black text-orange-500' : 'text-xs font-black text-slate-500';

                            const btn = document.getElementById('toggleBtn');
                            btn.className = data.active ? 'w-full py-4 rounded-xl font-black bg-red-500/10 text-red-500 border border-red-500/20' : 'w-full py-4 rounded-xl font-black bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
                            btn.innerText = data.active ? 'TERMINATE SESSION' : 'INITIALIZE SESSION';
                        } else if (data.qr) {
                            document.getElementById('qr-container').classList.remove('hidden');
                            document.getElementById('qrcode').src = data.qr;
                            document.getElementById('st-text').innerText = "SCAN QR TO AUTHORIZE";
                            document.getElementById('st-text').classList.remove('animate-pulse');
                        }
                    }
                    setInterval(async () => {
                        try {
                            const r = await fetch('/status');
                            updateDash(await r.json());
                        } catch(e) {}
                    }, 3000);
                </script>
            </body>
            </html>
        `);
    } else if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
            connected: isConnected, 
            qr: qrCodeData, 
            active: settings.active, 
            views: viewsCount, 
            currentEmoji: settings.emoji,
            lastPulse: lastPulseTime 
        }));
    } else if (req.url === "/toggle") {
        settings.active = !settings.active;
        saveSettings();
        res.end(JSON.stringify({ success: true }));
    } else if (url.pathname === "/set-emoji") {
        const newEmoji = url.searchParams.get("emoji");
        if (newEmoji) { settings.emoji = newEmoji; saveSettings(); }
        res.end(JSON.stringify({ success: true }));
    }
});

server.listen(PORT, () => { 
    startWhatsApp(); 
});