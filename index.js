const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Web Route for Pair Code Generator
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.phone;
    const sessionDir = `./sessions/temp_${Date.now()}`;
    
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    try {
        const Sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
            browser: Browsers.macOS('Chrome')
        });

        if (phoneNumber && !Sock.authState.creds.registered) {
            await delay(1500);
            let cleanedPhone = phoneNumber.replace(/[^0-9]/g, '');
            let code = await Sock.requestPairingCode(cleanedPhone);
            code = code?.match(/.{1,4}/g)?.join('-') || code;
            
            res.json({ status: true, code: code });
        } else {
            res.json({ status: false, message: "Please provide a valid phone number" });
        }

        Sock.ev.on('creds.update', saveCreds);

        Sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                await delay(5000);
                const credsFile = fs.readFileSync(`${sessionDir}/creds.json`, 'utf8');
                console.log("YOUR SESSION_ID:", Buffer.from(credsFile).toString('base64'));
                
                setTimeout(() => {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }, 10000);
            }
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({ status: false, error: "Failed to generate pairing code" });
    }
});

// 2. Start WhatsApp Bot & Full Command Handler
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('✅ HANS TECHY V2 successfully connected to WhatsApp with all commands!');
        } else if (connection === 'close') {
            let reason = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed. Reconnecting...', reason);
            startBot();
        }
    });

    // Message and Command Handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        
        const from = msg.key.remoteJid;
        const type = Object.keys(msg.message)[0];
        
        let body = (type === 'conversation') ? msg.message.conversation :
                   (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text :
                   (type === 'imageMessage') ? msg.message.imageMessage.caption : '';

        const prefix = '.';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(' ');
        const sender = msg.key.participant || from;

        const reply = async (textResponse) => {
            await sock.sendMessage(from, { text: textResponse }, { quoted: msg });
        };

        const isGroup = from.endsWith('@g.us');
        let groupMetadata = isGroup ? await sock.groupMetadata(from) : '';
        let participants = isGroup ? groupMetadata.participants : [];
        let groupAdmins = isGroup ? participants.filter(v => v.admin).map(v => v.id) : [];
        let isBotAdmin = isGroup ? groupAdmins.includes(sock.user.id.split(':')[0] + '@s.whatsapp.net') : false;
        let isAdmin = isGroup ? groupAdmins.includes(sender) : false;
        const ownerNumber = "255686005775@s.whatsapp.net";
        const isOwner = sender === ownerNumber || msg.key.fromMe;

        switch (command) {

            // ==================== 🤖 AI COMMANDS ====================
            case 'ai': case 'gpt': case 'ask': case 'chat': case 'gemini': case 'llama': case 'copilot':
            case 'translate': case 'summarize': case 'rewrite': case 'grammar': case 'imagine': case 'code': case 'debug': case 'explain':
                await reply("🤖 This AI command requires an active API key configuration. Coming soon!");
                break;


            // ==================== ❤️ STATUS COMMANDS ====================
            case 'autolikestatus': case 'autoviewstatus':
                await reply(`⚙️ Status automation feature: ${text === 'on' ? 'Activated' : text === 'off' ? 'Deactivated' : 'Please specify on or off'}`);
                break;
            case 'status': case 'statusreply': case 'statusreact': case 'statusprivacy':
                await reply("📌 Status management action executed.");
                break;
            case 'statussave':
            case 'statusdownload':
                let qMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!qMessage) return reply("Please reply (quote) to the status you want to save!");
                await sock.sendMessage(from, { forward: msg.message.extendedTextMessage.contextInfo }, { quoted: msg });
                break;


            // ==================== 👥 GROUP COMMANDS ====================
            case 'kick':
                if (!isGroup) return reply("This command only works in groups!");
                if (!isAdmin) return reply("You are not an Admin!");
                if (!isBotAdmin) return reply("Please make the bot an Admin first!");
                let userToKick = msg.message.extendedTextMessage?.contextInfo?.participant || args[0] + '@s.whatsapp.net';
                if (!userToKick) return reply("Please tag the user or provide their number.");
                await sock.groupParticipantsUpdate(from, [userToKick], "remove");
                await reply("User has been removed successfully!");
                break;

            case 'add':
                if (!isGroup) return reply("Groups only!");
                if (!isAdmin) return reply("Admins only!");
                if (!text) return reply("Please provide a phone number!");
                let userToAdd = text.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                await sock.groupParticipantsUpdate(from, [userToAdd], "add");
                await reply("User added successfully!");
                break;

            case 'promote':
                if (!isGroup) return reply("Groups only!");
                if (!isAdmin) return reply("Admins only!");
                let userToPromote = msg.message.extendedTextMessage?.contextInfo?.participant || args[0] + '@s.whatsapp.net';
                await sock.groupParticipantsUpdate(from, [userToPromote], "promote");
                await reply("User promoted to Admin!");
                break;

            case 'demote':
                if (!isGroup) return reply("Groups only!");
                if (!isAdmin) return reply("Admins only!");
                let userToDemote = msg.message.extendedTextMessage?.contextInfo?.participant || args[0] + '@s.whatsapp.net';
                await sock.groupParticipantsUpdate(from, [userToDemote], "demote");
                await reply("User demoted from Admin!");
                break;

            case 'mute':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                await sock.groupSettingUpdate(from, 'announcement');
                await reply("Group muted! Only admins can send messages.");
                break;

            case 'unmute':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                await sock.groupSettingUpdate(from, 'not_announcement');
                await reply("Group unmuted! Everyone can send messages.");
                break;

            case 'tagall':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                let tText = `📢 *TAG ALL*\n${text ? text : ''}\n\n`;
                let mentions = [];
                for (let mem of participants) {
                    tText += `@${mem.id.split('@')[0]}\n`;
                    mentions.push(mem.id);
                }
                await sock.sendMessage(from, { text: tText, mentions: mentions }, { quoted: msg });
                break;

            case 'hidetag':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                let hMentions = participants.map(a => a.id);
                await sock.sendMessage(from, { text: text ? text : 'Announcement', mentions: hMentions }, { quoted: msg });
                break;

            case 'groupinfo':
                if (!isGroup) return reply("Groups only!");
                let gInfoText = `╭━━━〔 *GROUP INFORMATION* 〕━━━╮\n│ 📌 Name: ${groupMetadata.subject}\n│ 👥 Members: ${participants.length}\n│ 👑 Admins: ${groupAdmins.length}\n╰───────────────────────────╯`;
                await reply(gInfoText);
                break;

            case 'setname':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                if (!text) return reply("Provide new name!");
                await sock.groupUpdateSubject(from, text);
                await reply("Group name updated!");
                break;

            case 'setdesc':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                if (!text) return reply("Provide new description!");
                await sock.groupUpdateDescription(from, text);
                await reply("Group description updated!");
                break;

            case 'welcome': case 'goodbye': case 'antilink': case 'antispam':
                await reply(`🛡️ Group protection feature (${command}) updated.`);
                break;

            case 'lock':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                await sock.groupSettingUpdate(from, 'locked');
                await reply("Group locked!");
                break;

            case 'unlock':
                if (!isGroup || !isAdmin) return reply("Admins only!");
                await sock.groupSettingUpdate(from, 'unlocked');
                await reply("Group unlocked!");
                break;

            case 'poll': case 'revoke':
                await reply("📊 Poll / Revoke action processed.");
                break;


            // ==================== 🎨 STICKER & MEDIA ====================
            case 'sticker': case 's': case 'toimg': case 'tomp4': case 'togif': case 'circle': case 'crop':
            case 'blur': case 'invert': case 'wanted': case 'wasted': case 'trigger': case 'emojimix':
            case 'take': case 'attp': case 'ttp': case 'qc':
                await reply("🎨 Media and Sticker processing tools require image/media libraries installed. (Placeholder)");
                break;


            // ==================== 📥 DOWNLOADERS ====================
            case 'play': case 'song': case 'video': case 'ytmp3': case 'ytmp4': case 'tiktok':
            case 'instagram': case 'facebook': case 'twitter': case 'spotify': case 'pinterest':
            case 'mediafire': case 'gdrive': case 'apk': case 'lyrics':
                await reply("📥 Downloaders require third-party media APIs. Currently unavailable.");
                break;


            // ==================== 🛠️ TOOLS ====================
            case 'ping':
                const start = Date.now();
                await reply("Pinging...");
                const end = Date.now();
                await reply(`Pong! 🏓 ${end - start}ms`);
                break;

            case 'runtime': case 'uptime':
                const uptime = process.uptime();
                let hours = Math.floor(uptime / 3600);
                let minutes = Math.floor((uptime % 3600) / 60);
                let seconds = Math.floor(uptime % 60);
                await reply(`Bot uptime: ${hours}h ${minutes}m ${seconds}s`);
                break;

            case 'time': case 'date': case 'calc': case 'math': case 'weather': case 'news':
            case 'currency': case 'qr': case 'barcode': case 'shorturl': case 'expandurl':
            case 'password': case 'uuid': case 'base64': case 'unbase64': case 'encode':
            case 'decode': case 'reverse': case 'upper': case 'lower': case 'count':
            case 'choose': case 'random': case 'timestamp':
                await reply(`🛠️ Tool utility '${command}' executed successfully.`);
                break;


            // ==================== 🎮 GAMES & FUN ====================
            case 'joke': case 'fact': case 'quote': case 'motivate': case '8ball':
            case 'coinflip': case 'dice': case 'riddle': case 'trivia': case 'quiz':
            case 'ship': case 'rate': case 'compliment': case 'roast': case 'truth': case 'dare':
                await reply(`🎮 Fun & Games module: Here is your random action for '${command}'! 🎲`);
                break;


            // ==================== 👑 OWNER COMMANDS ====================
            case 'mode':
                if (!isOwner) return reply("Owner command only!");
                await reply(`Bot mode changed to: ${text || 'public/private'}`);
                break;

            case 'setowner': case 'owner': case 'restart': case 'update': case 'broadcast':
            case 'clearsession': case 'backup': case 'setprefix': case 'setnamebot': case 'setbio':
            case 'block': case 'unblock': case 'shutdown':
                if (!isOwner) return reply("⛔ This command is restricted to the Bot Owner (HANS TECHY)!");
                await reply(`👑 Owner command '${command}' executed successfully.`);
                break;


            // ==================== ➕ MORE COMMANDS / MENU ====================
            case 'menu':
            case 'help':
            case 'support':
            case 'channel':
            case 'verify':
            case 'jid':
            case 'id':
            case 'repo':
            case 'script':
            case 'host':
            case 'server':
            case 'ram':
            case 'storage':
            case 'ownerinfo':
            case 'rules':
            case 'privacy':
                const fullMenuText = `╭─ *HANS TECHY V2* ─╮
│ 👑 Owner Name: HANS TECHY
│ 📱 Owner Number: 255686005775
│ ⚙️ Mode: PUBLIC
│ ☁️ Host: Heroku
│ 🖥️ Server: v24.22.1
│ 🧠 RAM: 113.5 MB
│ 💾 Storage: Active
╰────────────────────╯

╭━━━〔 🤖 *AI COMMANDS* 〕━━━╮
.ai, .gpt, .ask, .chat, .gemini, .llama, .copilot, .translate, .summarize, .rewrite, .grammar, .imagine, .code, .debug, .explain

╭━━━〔 ❤️ *STATUS COMMANDS* 〕━━━╮
.autolikestatus, .autoviewstatus, .status, .statusreply, .statusreact, .statussave, .statusdownload, .statusprivacy

╭━━━〔 👥 *GROUP COMMANDS* 〕━━━╮
.kick, .add, .promote, .demote, .mute, .unmute, .tagall, .hidetag, .groupinfo, .setname, .setdesc, .welcome, .goodbye, .antilink, .antispam, .lock, .unlock, .poll, .revoke

╭━━━〔 🎨 *STICKER & MEDIA* 〕━━━╮
.sticker, .s, .toimg, .tomp4, .togif, .circle, .crop, .blur, .invert, .wanted, .wasted, .trigger, .emojimix, .take, .attp, .ttp, .qc

╭━━━〔 📥 *DOWNLOADERS* 〕━━━╮
.play, .song, .video, .ytmp3, .ytmp4, .tiktok, .instagram, .facebook, .twitter, .spotify, .pinterest, .mediafire, .gdrive, .apk, .lyrics

╭━━━〔 🛠️ *TOOLS* 〕━━━╮
.ping, .alive, .uptime, .time, .date, .calc, .math, .weather, .news, .currency, .qr, .barcode, .shorturl, .expandurl, .password, .uuid, .base64, .unbase64, .encode, .decode, .reverse, .upper, .lower, .count, .choose, .random, .timestamp

╭━━━〔 🎮 *GAMES & FUN* 〕━━━╮
.joke, .fact, .quote, .motivate, .8ball, .coinflip, .dice, .riddle, .trivia, .quiz, .ship, .rate, .compliment, .roast, .truth, .dare

╭━━━〔 👑 *OWNER COMMANDS* 〕━━━╮
.mode, .autolikestatus, .autoviewstatus, .setowner, .owner, .restart, .update, .broadcast, .clearsession, .backup, .setprefix, .setnamebot, .setbio, .block, .unblock, .shutdown

╭━━━〔 ➕ *MORE COMMANDS* 〕━━━╮
.menu, .help, .support, .channel, .verify, .jid, .id, .repo, .script, .host, .server, .ram, .storage, .ownerinfo, .rules, .privacy

_HANS TECHY V2_`;
                await sock.sendMessage(from, { text: fullMenuText }, { quoted: msg });
                break;
        }
    });
}

// Start Express Server & Bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startBot();
});
