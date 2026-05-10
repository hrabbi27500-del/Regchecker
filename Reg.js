// checker_super_fast.js - ULTRA FAST WhatsApp Checker
const { Telegraf } = require('telegraf');
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
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Running\n');
});
server.listen(PORT);

const BOT_TOKEN = process.env.BOT_TOKEN || '6224828344:AAHUAHnOSaB5DUGfCtg9QqCWnNkDBRhxQE0';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 5624278091;
const AUTH_FOLDER = 'auth_info';
const USER_DATA_FILE = 'users.json';

let sock = null;
let isConnected = false;
let qrTimeout = null;
let allowedUsers = new Set();
let pendingUsers = new Set();
let userNames = new Map();

function loadUsers() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = fs.readFileSync(USER_DATA_FILE, 'utf8');
      const users = JSON.parse(data);
      allowedUsers = new Set(users.allowedUsers || [ADMIN_ID]);
      pendingUsers = new Set(users.pendingUsers || []);
      userNames = new Map(users.userNames || []);
    } else {
      allowedUsers = new Set([ADMIN_ID]);
    }
  } catch (error) {
    allowedUsers = new Set([ADMIN_ID]);
  }
}

function saveUsers() {
  const data = {
    allowedUsers: Array.from(allowedUsers),
    pendingUsers: Array.from(pendingUsers),
    userNames: Array.from(userNames)
  };
  fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
}

function isUserAllowed(userId) {
  return allowedUsers.has(userId);
}

loadUsers();

async function getBaileysVersionSafe() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch {
    return [2, 2209, 1];
  }
}

async function disconnectWA() {
  if (sock) {
    try { await sock.ws.close(); } catch {}
    sock = null;
  }
  isConnected = false;
  if (qrTimeout) clearTimeout(qrTimeout);
}

async function createWhatsAppConnection(ctx = null) {
  try {
    if (isConnected) {
      if (ctx) await ctx.reply('✅ Already connected!');
      return;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const version = await getBaileysVersionSafe();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Safari'),
      keepAliveIntervalMs: 30000,
      printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, qr, lastDisconnect } = u;

      if (qr && ctx) {
        try {
          // Try image
          const qrBuffer = await QRCode.toBuffer(qr, { width: 250 });
          await ctx.replyWithPhoto({ source: qrBuffer }, { caption: '📲 Scan QR' });
        } catch {
          try {
            // Fallback: text QR
            const qrText = await QRCode.toString(qr, { type: 'utf8' });
            await ctx.reply(`📲 Scan:\n\`\`\`\n${qrText}\n\`\`\``, { parse_mode: 'Markdown' });
          } catch {
            await ctx.reply('❌ QR failed. Check console.');
          }
        }
        
        if (qrTimeout) clearTimeout(qrTimeout);
        qrTimeout = setTimeout(() => {
          if (!isConnected) disconnectWA();
        }, 90000);
      }

      if (connection === 'open') {
        isConnected = true;
        if (qrTimeout) clearTimeout(qrTimeout);
        if (ctx) await ctx.reply('✅ WhatsApp Connected! Send numbers to check.');
      }

      if (connection === 'close') {
        isConnected = false;
        if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
        setTimeout(() => createWhatsAppConnection(ctx), 10000);
      }
    });
  } catch (e) {
    if (ctx) await ctx.reply('❌ Connection failed');
    isConnected = false;
  }
}

// Auto connect
if (fs.existsSync(AUTH_FOLDER)) {
  createWhatsAppConnection();
}

const bot = new Telegraf(BOT_TOKEN);

// Middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from.id;
  if (ctx.message?.text?.startsWith('/start')) return next();
  if (userId === ADMIN_ID) return next();
  if (!isUserAllowed(userId)) {
    await ctx.reply('❌ Not authorized. Wait for admin approval.');
    if (!pendingUsers.has(userId)) {
      pendingUsers.add(userId);
      saveUsers();
      await bot.telegram.sendMessage(ADMIN_ID, `New user: ${ctx.from.first_name}\nID: ${userId}`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Allow', callback_data: `allow_${userId}` },
          { text: '❌ Deny', callback_data: `deny_${userId}` }
        ]]}
      });
    }
    return;
  }
  await next();
});

// Callbacks
bot.on('callback_query', async (ctx) => {
  if (ctx.callbackQuery.from.id !== ADMIN_ID) return ctx.answerCbQuery('Admin only');
  const data = ctx.callbackQuery.data;
  
  if (data.startsWith('allow_')) {
    const userId = parseInt(data.split('_')[1]);
    allowedUsers.add(userId);
    pendingUsers.delete(userId);
    saveUsers();
    await ctx.answerCbQuery('✅ Allowed');
    await ctx.editMessageText(`✅ User ${userId} allowed`);
    await bot.telegram.sendMessage(userId, '✅ Access granted! Send /connect');
  } else if (data.startsWith('deny_')) {
    const userId = parseInt(data.split('_')[1]);
    pendingUsers.delete(userId);
    saveUsers();
    await ctx.answerCbQuery('❌ Denied');
    await ctx.editMessageText(`❌ User ${userId} denied`);
  }
});

// Commands
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  if (userId === ADMIN_ID) {
    await ctx.reply(`👋 Admin\n/connect - Link WhatsApp\n/users - Manage\n/stats - Status`);
  } else if (isUserAllowed(userId)) {
    await ctx.reply(`👋 Welcome! Send /connect then numbers to check.`);
  } else {
    await ctx.reply(`👋 ${ctx.from.first_name}, request sent to admin.`);
    if (!pendingUsers.has(userId)) {
      pendingUsers.add(userId);
      saveUsers();
      await bot.telegram.sendMessage(ADMIN_ID, `New: ${ctx.from.first_name}\nID: ${userId}`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Allow', callback_data: `allow_${userId}` },
          { text: '❌ Deny', callback_data: `deny_${userId}` }
        ]]}
      });
    }
  }
});

bot.command('connect', async (ctx) => {
  if (!isUserAllowed(ctx.from.id) && ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Unauthorized');
  if (isConnected) return ctx.reply('✅ Already connected');
  await ctx.reply('🔄 Connecting...');
  await createWhatsAppConnection(ctx);
});

bot.command('qr', async (ctx) => {
  if (!isUserAllowed(ctx.from.id) && ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Unauthorized');
  if (isConnected) return ctx.reply('✅ Already connected');
  await disconnectWA();
  await createWhatsAppConnection(ctx);
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Admin only');
  const users = Array.from(allowedUsers).filter(id => id !== ADMIN_ID);
  const pending = Array.from(pendingUsers);
  let msg = `✅ Allowed: ${users.length}\n⏳ Pending: ${pending.length}\n`;
  await ctx.reply(msg);
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Admin only');
  await ctx.reply(`📊 WhatsApp: ${isConnected ? '✅' : '❌'}\n👥 Users: ${allowedUsers.size - 1}\n⏳ Pending: ${pendingUsers.size}`);
});

bot.command('status', async (ctx) => {
  await ctx.reply(`WhatsApp: ${isConnected ? '✅ Connected' : '❌ Disconnected'}\nYour ID: ${ctx.from.id}`);
});

// Number checker
function extractNumbers(text) {
  const matches = text.match(/[\+]?[1]?[-\s\.]?[(]?(\d{3})[)]?[-\s\.]?(\d{3})[-\s\.]?(\d{4})|\d{10,15}/g) || [];
  return [...new Set(matches.map(n => {
    const clean = n.replace(/\D/g, '');
    if (clean.length === 10) return '+1' + clean;
    if (clean.length === 11 && clean.startsWith('1')) return '+' + clean;
    return '+' + clean;
  }))].filter(n => n.length >= 12);
}

async function checkNumbers(ctx, numbers) {
  if (!isConnected || !sock) return ctx.reply('❌ Send /connect first');
  
  const msg = await ctx.reply(`⚡ Checking ${numbers.length} numbers...`);
  const results = [];
  
  for (let i = 0; i < numbers.length; i += 50) {
    const batch = numbers.slice(i, i + 50);
    const promises = batch.map(async (num) => {
      try {
        const res = await sock.onWhatsApp(num.replace(/\D/g, ''));
        const exists = res?.[0]?.exists === true;
        return { num, exists };
      } catch {
        return { num, exists: null };
      }
    });
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }
  
  await ctx.deleteMessage(msg.message_id).catch(() => {});
  
  const lal = results.filter(r => r.exists === true).map(r => r.num);
  const fresh = results.filter(r => r.exists === false).map(r => r.num);
  
  if (lal.length) await ctx.reply(`🚫 Registered (${lal.length}):\n${lal.join('\n')}`);
  if (fresh.length) await ctx.reply(`✅ Fresh (${fresh.length}):\n${fresh.join('\n')}`);
  if (!lal.length && !fresh.length) await ctx.reply('❌ No valid numbers');
}

bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const nums = extractNumbers(ctx.message.text);
  if (nums.length === 0) return ctx.reply('❌ No valid numbers found');
  await checkNumbers(ctx, nums.slice(0, 500));
});

bot.launch();
console.log('✅ Bot started');
