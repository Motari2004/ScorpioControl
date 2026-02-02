const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const http = require("http");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");

// --- LOG FILTRATION ---
const hideLogs = ["Closing session", "SessionEntry", "Buffer"];
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
    const message = chunk.toString();
    if (hideLogs.some(keyword => message.includes(keyword))) return true;
    return originalWrite.call(process.stdout, chunk, encoding, callback);
};

let qrCodeData = null; 
let isConnected = false;
let botActive = true; 
let viewsCount = 0;

// 🔄 HYBRID AUTH LOGIC (Detects Render vs Local)
const isProduction = process.env.RENDER || process.env.NODE_ENV === 'production';
const AUTH_FOLDER = isProduction 
    ? path.join('/tmp', 'scorpio_auth') 
    : path.join(__dirname, 'auth_info');

const REACTION_EMOJI = "✅";

if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

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
            const location = isProduction ? "Cloud Server" : "Local Machine";
            originalWrite.call(process.stdout, `\x1b[38;5;208m[SCORPIO]\x1b[0m Engine Online (${location}).\n`);
        }
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 5000);
            } else {
                if (fs.existsSync(AUTH_FOLDER)) {
                    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                }
                setTimeout(startWhatsApp, 2000);
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!botActive) return;
        for (const msg of messages) {
            if (msg.key.remoteJid === "status@broadcast" && !msg.key.fromMe) {
                const participant = msg.key.participant || msg.participant;
                try {
                    await sock.sendReceipt("status@broadcast", participant, [msg.key.id], "read");
                    await delay(2500);
                    await sock.sendMessage("status@broadcast", {
                        react: { text: REACTION_EMOJI, key: msg.key }
                    }, { statusJidList: [participant] });
                    viewsCount++;
                    originalWrite.call(process.stdout, `\x1b[38;5;208m[SCORPIO]\x1b[0m Intercepted: ${msg.pushName || 'Target'}\n`);
                } catch (e) {}
            }
        }
    });
}

// 🌐 PREMIUM TAILWIND FRONTEND
const server = http.createServer((req, res) => {
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
                    .glass { background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.05); }
                    @keyframes pulse-slow { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.1); } }
                    .animate-pulse-slow { animation: pulse-slow 3s infinite; }
                </style>
            </head>
            <body class="bg-mesh flex items-center justify-center min-h-screen text-slate-200 p-6">
                <div class="glass p-10 rounded-[2.5rem] shadow-2xl w-full max-w-md text-center border-t border-slate-700/50">
                    <div class="mb-8">
                        <div class="inline-block p-3 rounded-2xl bg-slate-900 mb-4 border border-slate-800 shadow-inner">
                            <span class="text-3xl">🦂</span>
                        </div>
                        <h1 class="text-4xl font-black tracking-tighter text-white uppercase italic">
                            SCORPIO<span class="text-orange-500">BOT</span>
                        </h1>
                        <p class="text-[10px] uppercase tracking-[0.3em] text-slate-500 font-bold mt-1">Status Automation Protocol</p>
                    </div>

                    <div id="setup-view" class="space-y-6">
                        <div id="qr-container" class="bg-white p-6 rounded-3xl inline-block hidden shadow-2xl shadow-orange-500/10">
                            <img id="qrcode" class="w-44 h-44">
                        </div>
                        <p id="st-text" class="text-sm text-slate-400 font-medium">Synchronizing with mainframe...</p>
                    </div>

                    <div id="dash-view" class="hidden space-y-8">
                        <div class="flex items-center justify-between bg-slate-900/50 p-6 rounded-3xl border border-slate-800">
                            <div class="text-left">
                                <p class="text-[10px] text-slate-500 uppercase font-black mb-1">System State</p>
                                <div class="flex items-center">
                                    <div id="status-dot" class="w-2.5 h-2.5 rounded-full mr-2 animate-pulse-slow"></div>
                                    <p id="bot-status" class="font-bold text-sm tracking-wide"></p>
                                </div>
                            </div>
                            <div class="text-right border-l border-slate-800 pl-6">
                                <p class="text-[10px] text-slate-500 uppercase font-black mb-1">Intercepts</p>
                                <p id="view-count" class="text-2xl font-black text-white italic">0</p>
                            </div>
                        </div>
                        
                        <button id="toggleBtn" onclick="toggleBot()" class="w-full py-5 rounded-2xl font-black text-sm uppercase tracking-widest transition-all duration-300 transform active:scale-95 shadow-xl hover:shadow-2xl cursor-pointer">
                            CONNECTING...
                        </button>
                    </div>
                    <p class="mt-8 text-[9px] text-slate-600 font-bold tracking-widest uppercase">Environment: ${isProduction ? 'Production' : 'Development'}</p>
                </div>

                <script>
                    async function toggleBot() {
                        const r = await fetch('/toggle');
                        const d = await r.json();
                        updateDash(d);
                    }

                    function updateDash(data) {
                        const setupView = document.getElementById('setup-view');
                        const dashView = document.getElementById('dash-view');
                        const stText = document.getElementById('st-text');
                        const btn = document.getElementById('toggleBtn');
                        const qrContainer = document.getElementById('qr-container');
                        const dot = document.getElementById('status-dot');

                        if (data.connected) {
                            setupView.classList.add('hidden');
                            dashView.classList.remove('hidden');
                            document.getElementById('view-count').innerText = data.views;
                            
                            if (data.active) {
                                document.getElementById('bot-status').innerText = 'ACTIVE ENGINE';
                                document.getElementById('bot-status').className = 'text-emerald-400 font-bold';
                                dot.className = 'w-2.5 h-2.5 rounded-full mr-2 animate-pulse-slow bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]';
                                btn.className = 'w-full py-5 rounded-2xl font-black transition-all bg-gradient-to-br from-rose-500 via-red-600 to-orange-700 text-white shadow-lg shadow-red-900/40 hover:brightness-110 border-t border-white/10 cursor-pointer';
                                btn.innerText = 'PAUSE ENGINE';
                            } else {
                                document.getElementById('bot-status').innerText = 'SYSTEM STANDBY';
                                document.getElementById('bot-status').className = 'text-slate-400 font-bold';
                                dot.className = 'w-2.5 h-2.5 rounded-full mr-2 bg-slate-600';
                                btn.className = 'w-full py-5 rounded-2xl font-black transition-all bg-gradient-to-br from-emerald-500 via-teal-600 to-cyan-700 text-white shadow-lg shadow-emerald-900/40 hover:brightness-110 border-t border-white/10 cursor-pointer';
                                btn.innerText = 'RESUME ENGINE';
                            }
                        } else if (data.qr) {
                            qrContainer.classList.remove('hidden');
                            document.getElementById('qrcode').src = data.qr;
                            stText.innerText = 'Awaiting Authorization...';
                        }
                    }

                    setInterval(async () => {
                        const r = await fetch('/status');
                        const d = await r.json();
                        updateDash(d);
                    }, 2000);
                </script>
            </body>
            </html>
        `);
    } else if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: isConnected, qr: qrCodeData, active: botActive, views: viewsCount }));
    } else if (req.url === "/toggle") {
        botActive = !botActive;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: isConnected, active: botActive, views: viewsCount }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.clear();
    startWhatsApp();
});