const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const http = require("http");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");

// --- LOG FILTRATION ---
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
    const message = chunk.toString();
    if (["Closing session", "SessionEntry", "Buffer"].some(k => message.includes(k))) return true;
    return originalWrite.call(process.stdout, chunk, encoding, callback);
};

// --- PERSISTENCE LOGIC ---
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = { emoji: "✅", active: true };

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
        saveSettings();
    }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

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
        browser: ["Scorpio-Bot", "Chrome", "1.0.0"],
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
            originalWrite.call(process.stdout, `\x1b[38;5;208m[SCORPIO]\x1b[0m Engine Online.\n`);
        }
        if (connection === 'close') {
            isConnected = false;
            if ((lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startWhatsApp, 5000);
            } else {
                if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                setTimeout(startWhatsApp, 2000);
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!settings.active) return;
        for (const msg of messages) {
            if (msg.key.remoteJid === "status@broadcast" && !msg.key.fromMe) {
                const participant = msg.key.participant || msg.participant;
                try {
                    await sock.sendReceipt("status@broadcast", participant, [msg.key.id], "read");
                    await delay(2000);
                    await sock.sendMessage("status@broadcast", { react: { text: settings.emoji, key: msg.key } }, { statusJidList: [participant] });
                    viewsCount++;
                } catch (e) {}
            }
        }
    });
}

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
                <title>Scorpio Bot | Control</title>
                <style>
                    body { background: #020617; }
                    .bg-mesh { background-image: radial-gradient(at 0% 0%, rgba(249, 115, 22, 0.15) 0, transparent 50%), radial-gradient(at 100% 100%, rgba(30, 64, 175, 0.15) 0, transparent 50%); }
                    .glass { background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
                    select::-webkit-scrollbar { width: 8px; }
                    select::-webkit-scrollbar-track { background: #020617; }
                    select::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
                </style>
            </head>
            <body class="bg-mesh flex items-center justify-center min-h-screen text-slate-200 p-6">
                <div class="glass p-8 rounded-[2.5rem] shadow-2xl w-full max-w-md text-center border-t border-white/5">
                    <div class="mb-8">
                        <div class="inline-block p-3 rounded-2xl bg-slate-900 mb-4 border border-slate-800"><span class="text-3xl">🦂</span></div>
                        <h1 class="text-3xl font-black text-white italic uppercase tracking-tighter">SCORPIO<span class="text-orange-500">BOT</span></h1>
                    </div>

                    <div id="setup-view">
                        <div id="qr-container" class="bg-white p-4 rounded-3xl inline-block hidden shadow-xl shadow-orange-500/10"><img id="qrcode" class="w-44 h-44"></div>
                        <p id="st-text" class="text-sm text-slate-400 mt-6 font-medium animate-pulse">Initializing Interface...</p>
                    </div>

                    <div id="dash-view" class="hidden space-y-6">
                        <div class="flex items-center justify-between bg-slate-900/60 p-5 rounded-3xl border border-slate-800">
                            <div class="text-left">
                                <p class="text-[10px] text-slate-500 uppercase font-black">System</p>
                                <div class="flex items-center mt-1">
                                    <div id="status-dot" class="w-2.5 h-2.5 rounded-full mr-2"></div>
                                    <p id="bot-status" class="font-bold text-xs uppercase"></p>
                                </div>
                            </div>
                            <div class="text-right border-l border-slate-800 pl-5">
                                <p class="text-[10px] text-slate-500 uppercase font-black">Hits</p>
                                <p id="view-count" class="text-2xl font-black text-white italic mt-1">0</p>
                            </div>
                        </div>

                        <div class="bg-slate-900/40 p-5 rounded-3xl border border-slate-800/50">
                            <p class="text-[10px] text-slate-400 uppercase font-black mb-3 text-left">Reaction Protocol</p>
                            <div class="flex gap-2">
                                <select id="emoji-list" class="flex-1 bg-slate-950 text-white rounded-xl px-4 py-3 outline-none border border-slate-800 focus:border-orange-500/50 text-lg">
                                    <optgroup label="System" class="bg-slate-900 text-slate-500">
                                        <option value="✅">✅ Done</option>
                                        <option value="✔">✔ Check</option>
                                        <option value="🆗">🆗 OK</option>
                                        <option value="🎯">🎯 Target</option>
                                    </optgroup>
                                    <optgroup label="Vibes" class="bg-slate-900 text-slate-500">
                                        <option value="🔥">🔥 Fire</option>
                                        <option value="⚡">⚡ Speed</option>
                                        <option value="🚀">🚀 Launch</option>
                                        <option value="🌟">🌟 Star</option>
                                        <option value="💯">💯 Real</option>
                                        <option value="✨">✨ Magic</option>
                                        <option value="💥">💥 Boom</option>
                                    </optgroup>
                                    <optgroup label="Attitude" class="bg-slate-900 text-slate-500">
                                        <option value="🦂">🦂 Scorpio</option>
                                        <option value="👀">👀 Seen</option>
                                        <option value="🕶️">🕶️ Stealth</option>
                                        <option value="🦾">🦾 Flex</option>
                                        <option value="👑">👑 King</option>
                                        <option value="💎">💎 Diamond</option>
                                        <option value="🥷">🥷 Shinobi</option>
                                    </optgroup>
                                    <optgroup label="Love & Respect" class="bg-slate-900 text-slate-500">
                                        <option value="❤️">❤️ Red Heart</option>
                                        <option value="🧡">🧡 Orange</option>
                                        <option value="🖤">🖤 Black</option>
                                        <option value="🫡">🫡 Salute</option>
                                        <option value="🙌">🙌 Hands Up</option>
                                        <option value="🤝">🤝 Deal</option>
                                    </optgroup>
                                    <optgroup label="Elements" class="bg-slate-900 text-slate-500">
                                        <option value="🌙">🌙 Moon</option>
                                        <option value="🌊">🌊 Wave</option>
                                        <option value="🍀">🍀 Luck</option>
                                        <option value="🪐">🪐 Saturn</option>
                                    </optgroup>
                                </select>
                                <button id="setEmojiBtn" onclick="updateEmoji()" class="bg-orange-600 hover:bg-orange-500 text-white px-5 rounded-xl font-black text-xs uppercase transition-all">Set</button>
                            </div>
                        </div>
                        
                        <button id="toggleBtn" onclick="toggleBot()" class="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg active:scale-95">SYNCING...</button>
                    </div>
                </div>

                <script>
                    let hasSyncedOnce = false;

                    async function updateEmoji() {
                        const btn = document.getElementById('setEmojiBtn');
                        const emoji = document.getElementById('emoji-list').value;
                        btn.innerText = '...';
                        await fetch('/set-emoji?emoji=' + encodeURIComponent(emoji));
                        setTimeout(() => { btn.innerText = 'SET'; }, 500);
                    }

                    async function toggleBot() {
                        const r = await fetch('/toggle');
                        const d = await r.json();
                        updateDash(d);
                    }

                    function updateDash(data) {
                        const setupView = document.getElementById('setup-view');
                        const dashView = document.getElementById('dash-view');
                        const btn = document.getElementById('toggleBtn');
                        const dot = document.getElementById('status-dot');
                        const emojiList = document.getElementById('emoji-list');

                        if (data.connected) {
                            setupView.classList.add('hidden');
                            dashView.classList.remove('hidden');
                            document.getElementById('view-count').innerText = data.views;

                            if (!hasSyncedOnce) {
                                emojiList.value = data.currentEmoji;
                                hasSyncedOnce = true;
                            }
                            
                            if (data.active) {
                                document.getElementById('bot-status').innerText = 'Online';
                                document.getElementById('bot-status').className = 'text-emerald-400';
                                dot.className = 'w-2.5 h-2.5 rounded-full mr-2 bg-emerald-500 animate-pulse';
                                btn.className = 'w-full py-5 rounded-2xl font-black bg-red-500/10 text-red-500 border border-red-500/20';
                                btn.innerText = 'Kill Engine';
                            } else {
                                document.getElementById('bot-status').innerText = 'Standby';
                                document.getElementById('bot-status').className = 'text-slate-500';
                                dot.className = 'w-2.5 h-2.5 rounded-full mr-2 bg-slate-600';
                                btn.className = 'w-full py-5 rounded-2xl font-black bg-emerald-500/10 text-emerald-500 border border-emerald-500/20';
                                btn.innerText = 'Resume Engine';
                            }
                        } else if (data.qr) {
                            document.getElementById('qr-container').classList.remove('hidden');
                            document.getElementById('qrcode').src = data.qr;
                            document.getElementById('st-text').innerText = 'Scan to Authorize';
                        }
                    }

                    setInterval(async () => {
                        const r = await fetch('/status');
                        const d = await r.json();
                        updateDash(d);
                    }, 3000);
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: isConnected, active: settings.active, views: viewsCount, currentEmoji: settings.emoji }));
    } else if (url.pathname === "/set-emoji") {
        const newEmoji = url.searchParams.get("emoji");
        if (newEmoji) {
            settings.emoji = newEmoji;
            saveSettings();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { startWhatsApp(); });