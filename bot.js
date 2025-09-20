const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const readline = require('readline');
const fs = require('fs');
const axios = require('axios');
const pino =require('pino');

// --- MEMUAT KONFIGURASI ---
let config, NOMOR_BOT, ID_GRUP_TARGET;
try {
    config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    NOMOR_BOT = config.nomor_bot;
    ID_GRUP_TARGET = config.id_grup;
} catch (error) {
    console.warn("Peringatan: File config.json tidak ditemukan atau tidak valid.");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// --- FUNGSI UTAMA ---
async function main() {
    console.log('[BOT TUNGGAL] Mempersiapkan koneksi...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_bot');
    
    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '22.04.4'],
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Koneksi terputus, mencoba menghubungkan kembali: ${shouldReconnect}`);
            if (shouldReconnect) main();
        } else if (connection === 'open') {
            console.log('==================== BOT BERHASIL TERHUBUNG ====================');
            console.log('Bot sekarang aktif.');
            rl.close();
        }
    });
    
    if (!sock.authState.creds.registered) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log('[BOT TUNGGAL] Sesi tidak ditemukan, meminta pairing code...');
        try {
            const nomorUntukPairing = NOMOR_BOT || await rl.question('Masukkan nomor WhatsApp Anda untuk bot (format: 628...): ');
            const code = await sock.requestPairingCode(nomorUntukPairing);
            console.log(`==================== [BOT TUNGGAL] ====================`);
            console.log(`PAIRING CODE ANDA: ${code}`);
            console.log('Buka WhatsApp > Setelan > Perangkat Tertaut > Tautkan dengan nomor telepon.');
            console.log(`====================================================`);
        } catch (error) {
            console.error('Gagal meminta pairing code.', error);
            rl.close();
        }
    } else {
        rl.close();
    }

    sock.ev.on('creds.update', saveCreds);

    // --- LOGIKA UTAMA BOT DENGAN PARSER PERINTAH ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderJid = msg.key.remoteJid;
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!ID_GRUP_TARGET || senderJid !== ID_GRUP_TARGET || !messageText) return;

        let command = null;
        let url = '';

        // Parsing perintah dan URL
        if (messageText.startsWith('/video ')) {
            command = 'video';
            url = messageText.substring(7).trim();
        } else if (messageText.startsWith('/musik ')) {
            command = 'musik';
            url = messageText.substring(7).trim();
        } else if (messageText.includes('tiktok.com/')) {
            // Default ke video jika tidak ada perintah
            command = 'video';
            url = messageText;
        }

        // Jika tidak ada URL yang valid, hentikan proses
        if (!command || !url.includes('tiktok.com/')) return;
        
        console.log(`[GRUP] Perintah "${command}" terdeteksi. Memproses dengan API TikWM...`);
        await sock.sendMessage(ID_GRUP_TARGET, { text: '`Sabar ya, sedang memproses permintaanmu... ⏳`' }, { quoted: msg });
        
        const mediaData = await downloadTikTok(url, command);
        
        if (mediaData.success) {
            if (mediaData.type === 'video') {
                console.log(`[GRUP] Video berhasil diunduh. Mengirim ke grup...`);
                await sock.sendMessage(ID_GRUP_TARGET, {
                    video: { url: mediaData.url },
                    caption: mediaData.caption
                });
            } else if (mediaData.type === 'musik') {
                console.log(`[GRUP] Musik berhasil diunduh. Mengirim ke grup...`);
                await sock.sendMessage(ID_GRUP_TARGET, {
                    audio: { url: mediaData.url },
                    mimetype: 'audio/mp4' // Kirim sebagai audio
                });
            }
        } else {
            await sock.sendMessage(ID_GRUP_TARGET, { text: `⚠️ ${mediaData.message}` }, { quoted: msg });
        }
    });
}

// --- FUNGSI HELPER YANG DIPERBARUI UNTUK VIDEO & MUSIK ---
async function downloadTikTok(url, type = 'video') {
    const TIKWM_API_URL = 'https://tikwm.com/api/';
    try {
        const formData = new URLSearchParams();
        formData.append('url', url);
        formData.append('hd', '1');

        const response = await axios.post(TIKWM_API_URL, formData);
        
        if (response.data && response.data.code === 0 && response.data.data) {
            const mediaInfo = response.data.data;
            const caption = `*${mediaInfo.author.nickname}*\n\n${mediaInfo.title}`;

            if (type === 'video' && mediaInfo.play) {
                return { success: true, type: 'video', url: mediaInfo.play, caption: caption };
            }
            if (type === 'musik' && mediaInfo.music) {
                return { success: true, type: 'musik', url: mediaInfo.music, caption: caption };
            }
            
            // Jika tipe yang diminta tidak tersedia
            return { success: false, message: `Gagal, format ${type} tidak tersedia untuk video ini.` };
        }
        
        return { success: false, message: response.data.msg || 'Gagal mendapatkan data dari TikWM.' };
    } catch (error) {
        console.error('[DOWNLOADER] Gagal menghubungi API TikWM:', error.message);
        return { success: false, message: 'Terjadi kesalahan saat terhubung ke server TikWM.' };
    }
}

main().catch(err => console.error("Gagal menjalankan bot:", err));
