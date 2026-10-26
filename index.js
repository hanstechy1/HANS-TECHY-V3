const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require("@whiskeysockets/baileys");
const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // Imeongezwa kwa ajili ya API commands

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let clientSock = null;

// Function ya kuanzisha WhatsApp Bot
async function startHansTechyV2(phoneNum = null, res = null) {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS("Chrome")
    });

    clientSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                startHansTechyV2();
            }
        } else if (connection === 'open') {
            console.log('HANS TECHY V2 successfully connected to WhatsApp!');
        }
    });

    // Handle Pair Code Request bila kukwama
    if (phoneNum && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanedPhone = phoneNum.replace(/[^0-9]/g, '');
                let code = await sock.requestPairingCode(cleanedPhone);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                
                if (res && !res.headersSent) {
                    return res.json({ status: true, code: code });
                }
            } catch (error) {
                console.error("Error getting pairing code:", error);
                if (res && !res.headersSent) {
                    return res.json({ status: false, error: "Failed to generate pairing code. Try again." });
                }
            }
        }, 4000);
    }

    // Messages Listener & Commands (Zisizokuwa na API + Zenye API kwenye Menu)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const messageType = Object.keys(m.message)[0];
        const body = messageType === 'conversation' ? m.message.conversation :
                     messageType === 'extendedTextMessage' ? m.message.extendedTextMessage.text : '';

        const prefix = '.';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const sender = m.key.remoteJid;

        try {
            switch (command) {
                // --- 1. GENERAL & OFFLINE COMMANDS ---
                case 'ping':
                    await sock.sendMessage(sender, { text: 'Pong! 🤖 HANS TECHY V2 is active and running smoothly.' }, { quoted: m });
                    break;

                case 'menu':
                case 'help':
                    await sock.sendMessage(sender, { 
                        text: `*🤖 HANS TECHY V2 MASTER MENU*\n\n` +
                              `👑 *OWNER & SYSTEM*\n` +
                              `• .ping\n• .owner\n• .alive\n• .restart\n• .creator\n\n` +
                              `🛠️ *TOOLS & UTILITIES*\n` +
                              `• .calc [formula]\n• .quote\n• .time\n\n` +
                              `🌐 *API & WEB COMMANDS (Listed)*\n` +
                              `• .weather [city]\n• .lyrics [song]\n• .wiki [query]\n• .translate [text]\n\n` +
                              `_Note: API commands require stable network/external keys._`
                    }, { quoted: m });
                    break;

                case 'owner':
                    await sock.sendMessage(sender, { text: '👑 *Bot Owner:* HANS TECHY\n📞 *Number:* 255686005775' }, { quoted: m });
                    break;

                case 'alive':
                    await sock.sendMessage(sender, { text: '✨ HANS TECHY V2 is online, secure, and ready!' }, { quoted: m });
                    break;

                case 'creator':
                    await sock.sendMessage(sender, { text: '💻 Developed by HANS TECHY (V2 Edition).' }, { quoted: m });
                    break;

                case 'restart':
                    await sock.sendMessage(sender, { text: '🔄 Restarting bot system, please wait...' }, { quoted: m });
                    process.exit(1);
                    break;

                // --- 2. LOCAL UTILITY COMMANDS (Zisizotumia API) ---
                case 'calc':
                    if (args.length === 0) return await sock.sendMessage(sender, { text: 'Please provide a math formula, e.g., .calc 5+5' }, { quoted: m });
                    try {
                        let result = eval(args.join(' '));
                        await sock.sendMessage(sender, { text: `🧮 Result: ${result}` }, { quoted: m });
                    } catch (e) {
                        await sock.sendMessage(sender, { text: '❌ Invalid calculation formula.' }, { quoted: m });
                    }
                    break;

                case 'quote':
                    const quotes = [
                        "Success is not final; failure is not fatal: It is the courage to continue that counts.",
                        "Hard things will happen to us. We will recover. We will learn. We will grow.",
                        "Believe you can and you're halfway there."
                    ];
                    let randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                    await sock.sendMessage(sender, { text: `💬 *Quote:* "${randomQuote}"` }, { quoted: m });
                    break;

                // --- 3. API COMMANDS (Zilizopo kwenye Menu na zimewekewa ulinzi) ---
                case 'weather':
                    await sock.sendMessage(sender, { text: '☁️ Weather API feature is listed in menu. (Requires active weather endpoint connection).' }, { quoted: m });
                    break;

                case 'lyrics':
                    await sock.sendMessage(sender, { text: '🎵 Lyrics search feature is listed in menu.' }, { quoted: m });
                    break;

                case 'wiki':
                    if (args.length === 0) return await sock.sendMessage(sender, { text: 'Please provide a search term, e.g., .wiki Tanzania' }, { quoted: m });
                    let query = args.join(' ');
                    try {
                        let resWiki = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
                        if (resWiki.data && resWiki.data.extract) {
                            await sock.sendMessage(sender, { text: `📖 *Wikipedia (${query}):*\n\n${resWiki.data.extract}` }, { quoted: m });
                        } else {
                            await sock.sendMessage(sender, { text: '❌ No information found on Wikipedia.' }, { quoted: m });
                        }
                    } catch (err) {
                        await sock.sendMessage(sender, { text: '❌ Failed to fetch data from Wikipedia API.' }, { quoted: m });
                    }
                    break;

                default:
                    break;
            }
        } catch (err) {
            console.error("Command Execution Error:", err);
        }
    });
}

// Web Route ya Pairing
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) {
        return res.json({ status: false, error: 'Phone number is required' });
    }
    
    if (!clientSock || !clientSock.authState.creds.registered) {
        await startHansTechyV2(phone, res);
    } else {
        try {
            let cleanedPhone = phone.replace(/[^0-9]/g, '');
            let code = await clientSock.requestPairingCode(cleanedPhone);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            return res.json({ status: true, code: code });
        } catch (err) {
            return res.json({ status: false, error: 'Failed to generate code.' });
        }
    }
});

// Anzisha Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startHansTechyV2();
});
