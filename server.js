const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const http = require("http");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; 

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

const isProduction = process.env.RENDER || process.env.NODE_ENV === 'production';
const AUTH_FOLDER = isProduction ? path.join('/tmp', 'scorpio_auth') : path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

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
            originalWrite.call(process.stdout, `\x1b[38;5;208m[SCORPIO]\x1b[0m Hybrid Engine Active.\n`);
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
    if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <script src="https://cdn.tailwindcss.com"></script>
                <title>Scorpio Hybrid</title>
                <style>
                    body { background: #020617; color: #f8fafc; }
                    .glass { background: rgba(15, 23, 42, 0.9); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.1); }
                </style>
            </head>
            <body class="flex items-center justify-center min-h-screen p-4">
                <div class="glass p-8 rounded-[2rem] shadow-2xl w-full max-w-md">
                    <h1 class="text-3xl font-black italic tracking-tighter mb-2 text-center">SCORPIO<span class="text-orange-500 text-4xl">.</span></h1>
                    
                    <div id="setup-view">
                        <div id="qr-container" class="bg-white p-3 rounded-2xl inline-block hidden mx-auto"><img id="qrcode" class="w-40 h-40"></div>
                        <p id="st-text" class="text-center text-xs text-slate-500 uppercase tracking-widest animate-pulse">Establishing Secure Link...</p>
                    </div>

                    <div id="dash-view" class="hidden space-y-4">
                        <div class="bg-slate-950/50 p-4 rounded-2xl border border-slate-800 flex justify-between items-center">
                            <div>
                                <p class="text-[9px] text-slate-500 uppercase font-black tracking-widest">Current Protocol</p>
                                <p id="mode-text" class="text-sm font-bold"></p>
                            </div>
                            <div class="text-right">
                                <p class="text-[9px] text-slate-500 uppercase font-black tracking-widest">Views</p>
                                <p id="view-count" class="text-xl font-black italic">0</p>
                            </div>
                        </div>

                        <div class="space-y-2">
                            <label class="text-[10px] text-slate-400 font-bold uppercase ml-1">Emoji Library</label>
                            <div class="flex gap-2">
                                <select id="emoji-list" class="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 outline-none focus:border-orange-500">
                                    <option value="none">🚫 View Only (Silent)</option>
                                    <optgroup label="Popular">
                                        <option value="🔥">🔥 Fire</option><option value="❤️">❤️ Love</option><option value="😂">😂 Laugh</option><option value="🙌">🙌 Hands Up</option>
                                    </optgroup>
                                    <optgroup label="Energy">
                                        <option value="⚡">⚡ Lightning</option><option value="🚀">🚀 Rocket</option><option value="💥">💥 Boom</option><option value="✨">✨ Sparkle</option><option value="💯">💯 100</option>
                                    </optgroup>
                                    <optgroup label="Nature/Animal">
                                        <option value="🦂">🦂 Scorpio</option><option value="🦁">🦁 Lion</option><option value="🦅">🦅 Eagle</option><option value="🌊">🌊 Wave</option><option value="🌙">🌙 Moon</option>
                                    </optgroup>
                                    <optgroup label="Cool">
                                        <option value="🥷">🥷 Shinobi</option><option value="🕶️">🕶️ Stealth</option><option value="💎">💎 Diamond</option><option value="🦾">🦾 Flex</option>
                                    </optgroup>
                                </select>
                                <button onclick="updateEmoji()" class="bg-orange-600 px-4 rounded-xl font-bold text-xs uppercase transition-hover hover:bg-orange-500">Set</button>
                            </div>
                        </div>

                        <button id="toggleBtn" onclick="toggleBot()" class="w-full py-4 rounded-xl font-black text-xs uppercase tracking-tighter transition-all"></button>
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
                            if(lastE !== data.currentEmoji) { document.getElementById('emoji-list').value = data.currentEmoji; lastE = data.currentEmoji; }
                            
                            const modeText = document.getElementById('mode-text');
                            if (data.currentEmoji === 'none') {
                                modeText.innerText = 'STEALTH LURKING';
                                modeText.className = 'text-sm font-bold text-blue-400';
                            } else {
                                modeText.innerText = 'AUTO-REACTING (' + data.currentEmoji + ')';
                                modeText.className = 'text-sm font-bold text-orange-500';
                            }

                            const btn = document.getElementById('toggleBtn');
                            btn.className = data.active ? 'w-full py-4 rounded-xl font-black bg-red-500/10 text-red-500 border border-red-500/20' : 'w-full py-4 rounded-xl font-black bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
                            btn.innerText = data.active ? 'SHUTDOWN SYSTEM' : 'BOOT SYSTEM';
                        } else if (data.qr) {
                            document.getElementById('qr-container').classList.remove('hidden');
                            document.getElementById('qrcode').src = data.qr;
                        }
                    }
                    setInterval(async () => {
                        const r = await fetch('/status');
                        updateDash(await r.json());
                    }, 2000);
                </script>
            </body>
            </html>
        `);
    } else if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: isConnected, qr: qrCodeData, active: settings.active, views: viewsCount, currentEmoji: settings.emoji }));
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

server.listen(PORT, () => { startWhatsApp(); });