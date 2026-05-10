// ================= IMPORTS =================
const { Telegraf, Input } = require('telegraf');
const {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ================= ERROR HANDLERS =================
process.on('unhandledRejection', (reason) => {
  console.log('❌ UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
  console.log('❌ UNCAUGHT EXCEPTION:', err);
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Bot Running');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on ${PORT}`);
});

// ================= CONFIG =================
const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  'YOUR_BOT_TOKEN';

const ADMIN_ID =
  parseInt(process.env.ADMIN_ID) || 123456789;

const AUTH_FOLDER = 'auth_info';

// ================= VARIABLES =================
let sock = null;
let isConnected = false;
let qrTimeout = null;
let reconnecting = false;

// ================= TELEGRAM BOT =================
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  timeout: 60000,
});

const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    agent,
    webhookReply: false,
  },
});

// ================= VERSION =================
async function getBaileysVersionSafe() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch {
    return [2, 2413, 1];
  }
}

// ================= DISCONNECT =================
async function disconnectWA() {
  try {
    if (sock?.ws) {
      await sock.ws.close();
    }
  } catch {}

  sock = null;
  isConnected = false;

  if (qrTimeout) {
    clearTimeout(qrTimeout);
    qrTimeout = null;
  }
}

// ================= CREATE CONNECTION =================
async function createWhatsAppConnection(ctx = null) {

  try {

    if (isConnected) {
      if (ctx) {
        await ctx.reply('✅ WhatsApp already connected');
      }
      return;
    }

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_FOLDER);

    const version = await getBaileysVersionSafe();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),

      browser: Browsers.macOS('Safari'),

      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,

      markOnlineOnConnect: false,
      syncFullHistory: false,

      retryRequestDelayMs: 250,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {

      const {
        connection,
        qr,
        lastDisconnect
      } = update;

      // ================= QR =================
      if (qr) {

        if (global.sendingQR) {
          return;
        }

        global.sendingQR = true;

        console.log('📱 QR Generated');

        try {

          const qrPath =
            path.join(
              __dirname,
              `qr_${Date.now()}.png`
            );

          await QRCode.toFile(qrPath, qr, {
            width: 400,
            margin: 1,
          });

          let success = false;

          for (let i = 1; i <= 3; i++) {

            try {

              await bot.telegram.sendDocument(
                ctx.chat.id,
                Input.fromLocalFile(qrPath),
                {
                  caption:
                    `📲 Scan QR (${i}/3)\n\n` +
                    `WhatsApp > Linked Devices > Link Device`,
                }
              );

              success = true;

              console.log('✅ QR Sent');

              break;

            } catch (err) {

              console.log(`❌ Attempt ${i} Failed`);

              console.log(err.message);

              await delay(4000);
            }
          }

          // fallback photo
          if (!success) {

            try {

              await bot.telegram.sendPhoto(
                ctx.chat.id,
                Input.fromLocalFile(qrPath),
                {
                  caption: '📲 Scan QR',
                }
              );

            } catch {

              await ctx.reply(
                '❌ Telegram network issue.\nSend /connect again.'
              );
            }
          }

          // cleanup
          try {
            fs.unlinkSync(qrPath);
          } catch {}

        } catch (err) {

          console.log('❌ QR ERROR');

          console.log(err);

        } finally {

          global.sendingQR = false;
        }

        // timeout
        if (qrTimeout) {
          clearTimeout(qrTimeout);
        }

        qrTimeout = setTimeout(async () => {

          if (!isConnected) {

            try {
              await ctx.reply(
                '❌ QR expired.\nSend /connect again.'
              );
            } catch {}

            await disconnectWA();
          }

        }, 60000);
      }

      // ================= CONNECTED =================
      if (connection === 'open') {

        isConnected = true;

        if (qrTimeout) {
          clearTimeout(qrTimeout);
          qrTimeout = null;
        }

        console.log('✅ WhatsApp Connected');

        try {
          if (ctx) {
            await ctx.reply(
              '✅ WhatsApp connected successfully'
            );
          }
        } catch {}
      }

      // ================= CLOSED =================
      if (connection === 'close') {

        isConnected = false;

        const reason =
          lastDisconnect?.error?.output?.statusCode;

        console.log('❌ Connection Closed');

        console.log('Reason:', reason);

        sock = null;

        // logged out
        if (reason === DisconnectReason.loggedOut) {

          console.log('⚠️ Logged out');

          try {
            fs.rmSync(AUTH_FOLDER, {
              recursive: true,
              force: true,
            });
          } catch {}

          return;
        }

        // reconnect
        if (!reconnecting) {

          reconnecting = true;

          console.log('🔄 Reconnecting in 5 sec');

          setTimeout(async () => {

            try {

              await createWhatsAppConnection(ctx);

            } catch (err) {

              console.log(err);

            } finally {

              reconnecting = false;
            }

          }, 5000);
        }
      }
    });

  } catch (err) {

    console.log('❌ GLOBAL ERROR');

    console.log(err);

    sock = null;
    isConnected = false;
  }
}

// ================= AUTO CONNECT =================
(async () => {

  if (fs.existsSync(AUTH_FOLDER)) {

    console.log('🔄 Existing auth found');

    await createWhatsAppConnection();

  } else {

    console.log('ℹ️ No auth found');
  }

})();

// ================= COMMANDS =================
bot.start(async (ctx) => {

  await ctx.reply(
    '🤖 WhatsApp Checker Bot Ready\n\n' +
    '/connect - Connect WhatsApp\n' +
    '/status - Bot Status'
  );
});

bot.command('connect', async (ctx) => {

  if (isConnected) {
    return ctx.reply(
      '✅ WhatsApp already connected'
    );
  }

  await ctx.reply(
    '🔄 Generating QR...'
  );

  await createWhatsAppConnection(ctx);
});

bot.command('status', async (ctx) => {

  await ctx.reply(
    `📱 WhatsApp: ${
      isConnected
        ? '✅ Connected'
        : '❌ Disconnected'
    }\n\n` +
    `⏰ Uptime: ${
      Math.floor(process.uptime() / 60)
    } mins\n` +
    `💾 RAM: ${
      Math.round(
        process.memoryUsage().rss /
        1024 /
        1024
      )
    } MB`
  );
});

// ================= NUMBER EXTRACT =================
function extractNumbers(text) {

  return Array.from(
    new Set(
      (text.match(/\+?\d{10,15}/g) || [])
        .map(n => {

          const clean =
            n.replace(/\D/g, '');

          if (clean.length === 10) {
            return '+1' + clean;
          }

          if (
            clean.length === 11 &&
            clean.startsWith('1')
          ) {
            return '+' + clean;
          }

          return '+' + clean;
        })
    )
  );
}

// ================= CHECKER =================
async function checkNumbers(ctx, numbers) {

  if (!sock || !isConnected) {
    return ctx.reply(
      '❌ WhatsApp not connected'
    );
  }

  const msg =
    await ctx.reply(
      `⚡ Checking ${numbers.length} numbers...`
    );

  const results =
    await Promise.allSettled(

      numbers.map(async (num) => {

        try {

          const clean =
            num.replace(/\D/g, '');

          const res =
            await sock.onWhatsApp(clean);

          const exists =
            Array.isArray(res) &&
            res[0]?.exists;

          return {
            num,
            exists
          };

        } catch {

          return {
            num,
            exists: null
          };
        }
      })
    );

  const valid = [];
  const invalid = [];

  results.forEach(r => {

    if (r.status !== 'fulfilled') {
      return;
    }

    if (r.value.exists) {
      valid.push(r.value.num);
    } else {
      invalid.push(r.value.num);
    }
  });

  try {
    await ctx.deleteMessage(msg.message_id);
  } catch {}

  let text = '';

  if (valid.length) {
    text +=
      `🚫 Lal Baba (${valid.length})\n` +
      valid.join('\n') +
      '\n\n';
  }

  if (invalid.length) {
    text +=
      `✅ Fresh (${invalid.length})\n` +
      invalid.join('\n');
  }

  if (!text) {
    text = '❌ No results';
  }

  await ctx.reply(text);
}

// ================= TEXT =================
bot.on('text', async (ctx) => {

  const text =
    ctx.message.text.trim();

  if (text.startsWith('/')) {
    return;
  }

  const numbers =
    extractNumbers(text);

  if (!numbers.length) {

    return ctx.reply(
      '❌ No valid numbers found'
    );
  }

  await checkNumbers(
    ctx,
    numbers.slice(0, 500)
  );
});

// ================= KEEP ALIVE =================
async function pingServer() {

  try {

    const url =
      `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;

    await fetch(url);

    console.log('🔄 Keep Alive Ping');

  } catch {}
}

setInterval(() => {
  pingServer();
}, 5 * 60 * 1000);

// ================= START BOT =================
bot.launch()
  .then(() => {

    console.log('🤖 BOT STARTED');
    console.log('⚡ FAST MODE ENABLED');

  })
  .catch(console.log);
