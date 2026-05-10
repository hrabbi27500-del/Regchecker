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
const path = require('path');
const http = require('http');

// For Render.com health checks
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 WhatsApp Checker Bot is Running!\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const BOT_TOKEN = process.env.BOT_TOKEN || '6224828344:AAHUAHnOSaB5DUGfCtg9QqCWnNkDBRhxQE0';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 5624278091;
const AUTH_FOLDER = 'auth_info';
const USER_DATA_FILE = 'users.json';

let sock = null;
let isConnected = false;
let qrTimeout = null;

// User management system
let allowedUsers = new Set();
let pendingUsers = new Set();
let userNames = new Map();

// Load users from file
function loadUsers() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = fs.readFileSync(USER_DATA_FILE, 'utf8');
      const users = JSON.parse(data);
      allowedUsers = new Set(users.allowedUsers || [ADMIN_ID]);
      pendingUsers = new Set(users.pendingUsers || []);
      userNames = new Map(users.userNames || []);
      console.log(`📊 Loaded ${allowedUsers.size} allowed users and ${pendingUsers.size} pending users`);
    } else {
      allowedUsers = new Set([ADMIN_ID]);
      console.log('ℹ️ No existing user data found. Starting fresh.');
    }
  } catch (error) {
    console.error('❌ Error loading users:', error);
    allowedUsers = new Set([ADMIN_ID]);
    pendingUsers = new Set();
    userNames = new Map();
  }
}

// Save users to file
function saveUsers() {
  try {
    const data = {
      allowedUsers: Array.from(allowedUsers),
      pendingUsers: Array.from(pendingUsers),
      userNames: Array.from(userNames)
    };
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('❌ Error saving users:', error);
  }
}

function storeUserName(userId, name) {
  userNames.set(userId, name);
  saveUsers();
}

function isUserAllowed(userId) {
  return allowedUsers.has(userId);
}

// Load users immediately when bot starts
loadUsers();

// WhatsApp Connection
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
    try { 
      await sock.ws.close(); 
    } catch {}
    sock = null;
  }
  isConnected = false;
  if (qrTimeout) clearTimeout(qrTimeout);
}

// FIXED: Better QR code handling
async function createWhatsAppConnection(ctx = null) {
  try {
    if (isConnected) {
      if (ctx) await ctx.reply('✅ WhatsApp is already connected!');
      return;
    }

    const authExists = fs.existsSync(AUTH_FOLDER);
    console.log(`🔐 Auth folder exists: ${authExists}`);
    
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

      if (qr) {
        console.log('📱 New QR generated');
        
        if (ctx) {
          let qrSent = false;
          
          // METHOD 1: Try to send as photo with smaller size
          try {
            const qrBuffer = await QRCode.toBuffer(qr, { 
              type: 'png',
              width: 250,
              margin: 1,
              errorCorrectionLevel: 'L'
            });
            
            await ctx.replyWithPhoto(
              { source: qrBuffer },
              { 
                caption: '📲 *Scan QR with WhatsApp*\n\n✓ Open WhatsApp → Menu (⋮)\n✓ Linked Devices → Link a Device\n✓ Scan this QR code\n\n⏳ Expires in 90 seconds',
                parse_mode: 'Markdown'
              }
            );
            console.log('✅ QR sent as image');
            qrSent = true;
          } catch (photoError) {
            console.log('Photo method failed:', photoError.message);
          }
          
          // METHOD 2: Send as text-based QR if image fails
          if (!qrSent) {
            try {
              // Generate ASCII QR code (text-based)
              const qrText = await QRCode.toString(qr, { type: 'utf8' });
              await ctx.reply(
                `📲 *Scan this QR Code*\n\n\`\`\`\n${qrText}\n\`\`\`\n\n` +
                `1. Open WhatsApp\n2. Linked Devices\n3. Link a Device\n4. Scan this code\n\n` +
                `⏳ Expires in 90 seconds`,
                { parse_mode: 'Markdown' }
              );
              console.log('✅ QR sent as text');
              qrSent = true;
            } catch (textError) {
              console.log('Text QR failed:', textError.message);
            }
          }
          
          // METHOD 3: Send QR code link
          if (!qrSent) {
            try {
              const qrBase64 = await QRCode.toDataURL(qr, { width: 300 });
              await ctx.reply(
                `📲 *QR Code Link*\n\n[Click here to view QR code](${qrBase64})\n\n` +
                `Or use this code:\n\`${qr.substring(0, 100)}...\`\n\n` +
                `Send /qr to try again if this doesn't work.`,
                { parse_mode: 'Markdown', disable_web_page_preview: true }
              );
              console.log('✅ QR sent as link');
              qrSent = true;
            } catch (linkError) {
              console.log('Link method failed:', linkError.message);
            }
          }
          
          // Final fallback
          if (!qrSent) {
            await ctx.reply(
              '❌ *Failed to generate QR code*\n\n' +
              'Please try:\n' +
              '1. Send /qr command\n' +
              '2. Or check server console for QR code\n\n' +
              'The QR code is printed in the terminal/console of the server.',
              { parse_mode: 'Markdown' }
            );
          }
        }
        
        // Clear previous timeout
        if (qrTimeout) clearTimeout(qrTimeout);
        
        // Set timeout for QR expiration
        qrTimeout = setTimeout(() => {
          if (!isConnected) {
            console.log('⏰ QR code expired');
            if (ctx) {
              ctx.reply('⏰ QR code expired. Please send /connect again.')
                .catch(e => console.log('Cannot send expiry message'));
            }
            disconnectWA();
          }
        }, 90000);
      }

      if (connection === 'open') {
        isConnected = true;
        if (qrTimeout) clearTimeout(qrTimeout);
        console.log('✅ WhatsApp connected!');
        if (ctx) {
          await ctx.reply('✅ *WhatsApp Connected Successfully!*\n\nNow you can send phone numbers to check.\n\n📞 Example:\n7828124894\n+18257976152', { parse_mode: 'Markdown' });
        }
      }

      if (connection === 'close') {
        isConnected = false;
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔌 WhatsApp disconnected. Reason: ${reason}`);
        
        if (reason === DisconnectReason.loggedOut) {
          if (ctx) await ctx.reply('❌ Logged out from WhatsApp. Send /connect again.');
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            console.log('🗑️ Auth folder cleared due to logout');
          } catch (error) {}
          sock = null;
        } else {
          console.log('🔁 WhatsApp disconnected, reconnecting in 10 seconds...');
          sock = null;
          await delay(10000);
          await createWhatsAppConnection(ctx);
        }
      }
    });
  } catch (e) {
    console.error('Connection error:', e);
    if (ctx) await ctx.reply('❌ Failed to connect WhatsApp. Please try /connect again.');
    isConnected = false;
    sock = null;
  }
}

// Auto reconnect if auth exists
(async () => {
  if (fs.existsSync(AUTH_FOLDER)) {
    console.log('🔄 Auth found → auto-connecting WhatsApp...');
    await createWhatsAppConnection();
  } else {
    console.log('ℹ️ No auth found. Use /connect first time.');
  }
})();

// Telegram Bot
const bot = new Telegraf(BOT_TOKEN);

// Middleware to check user access
bot.use(async (ctx, next) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'Unknown User';
  
  if (!userNames.has(userId)) {
    storeUserName(userId, userName);
  }
  
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start')) {
    return next();
  }
  
  if (userId === ADMIN_ID) {
    return next();
  }
  
  if (!isUserAllowed(userId)) {
    if (ctx.message) {
      await ctx.reply('❌ You are not authorized to use this bot. Please wait for admin approval.');
      
      if (!pendingUsers.has(userId)) {
        pendingUsers.add(userId);
        saveUsers();
        
        const userInfo = `🆕 New User Request:\n\n👤 Name: ${userName}\n🆔 ID: ${userId}\n📱 Username: @${ctx.from.username || 'N/A'}`;
        
        try {
          await bot.telegram.sendMessage(
            ADMIN_ID, 
            userInfo,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Allow User', callback_data: `allow_${userId}` },
                    { text: '❌ Deny User', callback_data: `deny_${userId}` }
                  ]
                ]
              }
            }
          );
        } catch (error) {
          console.error('Error notifying admin:', error);
        }
      }
    }
    return;
  }
  
  await next();
});

// Handle callback queries
bot.on('callback_query', async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const adminId = ctx.callbackQuery.from.id;
  
  if (adminId !== ADMIN_ID) {
    return ctx.answerCbQuery('❌ Only admin can use this!');
  }
  
  if (callbackData.startsWith('allow_')) {
    const userId = parseInt(callbackData.split('_')[1]);
    allowedUsers.add(userId);
    pendingUsers.delete(userId);
    saveUsers();
    
    await ctx.answerCbQuery('✅ User allowed!');
    await ctx.editMessageText(`✅ User ${userNames.get(userId) || userId} has been allowed to use the bot.`);
    
    try {
      await bot.telegram.sendMessage(userId, '🎉 Your access has been approved by admin! You can now use the bot.\n\nSend /connect to link WhatsApp and then send numbers to check.');
    } catch (error) {
      console.error('Error notifying user:', error);
    }
    
  } else if (callbackData.startsWith('deny_')) {
    const userId = parseInt(callbackData.split('_')[1]);
    pendingUsers.delete(userId);
    allowedUsers.delete(userId);
    saveUsers();
    
    await ctx.answerCbQuery('❌ User denied!');
    await ctx.editMessageText(`❌ User ${userNames.get(userId) || userId} has been denied access.`);
    
    try {
      await bot.telegram.sendMessage(userId, '❌ Your access request has been denied by admin.');
    } catch (error) {
      console.error('Error notifying user:', error);
    }
  } else if (callbackData.startsWith('toggle_')) {
    const userId = parseInt(callbackData.split('_')[1]);
    const userName = userNames.get(userId) || `User ${userId}`;
    
    if (allowedUsers.has(userId)) {
      allowedUsers.delete(userId);
      await ctx.answerCbQuery('❌ User access removed!');
      await ctx.editMessageText(`❌ ${userName}'s access has been disabled.`);
      
      try {
        await bot.telegram.sendMessage(userId, '❌ Your access to the bot has been disabled by admin.');
      } catch (error) {
        console.error('Error notifying user:', error);
      }
    } else {
      allowedUsers.add(userId);
      pendingUsers.delete(userId);
      await ctx.answerCbQuery('✅ User access granted!');
      await ctx.editMessageText(`✅ ${userName}'s access has been enabled.`);
      
      try {
        await bot.telegram.sendMessage(userId, '🎉 Your access to the bot has been enabled by admin.');
      } catch (error) {
        console.error('Error notifying user:', error);
      }
    }
    saveUsers();
  }
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'User';
  
  if (userId === ADMIN_ID) {
    await ctx.reply(
      `👋 Welcome Admin ${userName}!\n\n` +
      `📋 Available Commands:\n` +
      `/connect - Link WhatsApp\n` +
      `/users - Manage users\n` +
      `/pending - Show pending requests\n` +
      `/stats - Show bot statistics\n` +
      `/status - Check bot status\n\n` +
      `💾 Data Status: ${fs.existsSync(USER_DATA_FILE) ? 'Persisted' : 'Fresh'}\n` +
      `🔐 WhatsApp: ${fs.existsSync(AUTH_FOLDER) ? 'Linked' : 'Not Linked'}`
    );
  } else if (isUserAllowed(userId)) {
    await ctx.reply(
      `👋 Welcome back ${userName}!\n\n` +
      `📝 How to use:\n` +
      `1. Send /connect to link WhatsApp (first time only)\n` +
      `2. After connection, send numbers to check\n` +
      `3. You can send multiple numbers at once\n\n` +
      `⚡ SUPER FAST CHECKING ENABLED\n` +
      `📞 Supported formats:\n` +
      `7828124894\n` +
      `+18257976152\n` +
      `+1 (902) 912-2670\n` +
      `8257862503, 8733638775`
    );
  } else {
    await ctx.reply(
      `👋 Welcome ${userName}!\n\n` +
      `📨 Your access request has been sent to admin.\n` +
      `Please wait for approval. You will be notified when approved.\n\n` +
      `⏳ Status: Waiting for admin approval...`
    );
    
    if (!pendingUsers.has(userId)) {
      pendingUsers.add(userId);
      storeUserName(userId, userName);
      
      const userInfo = `🆕 New User Request:\n\n👤 Name: ${userName}\n🆔 ID: ${userId}\n📱 Username: @${ctx.from.username || 'N/A'}`;
      
      try {
        await bot.telegram.sendMessage(
          ADMIN_ID, 
          userInfo,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Allow User', callback_data: `allow_${userId}` },
                  { text: '❌ Deny User', callback_data: `deny_${userId}` }
                ]
              ]
            }
          }
        );
      } catch (error) {
        console.error('Error notifying admin:', error);
      }
    }
  }
});

// FIXED: Manual QR command as fallback
bot.command('qr', async (ctx) => {
  if (!isUserAllowed(ctx.from.id) && ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Unauthorized');
  }
  
  if (isConnected) {
    return ctx.reply('✅ WhatsApp is already connected!');
  }
  
  await ctx.reply('🔄 Generating QR code... Please wait.');
  
  // Force disconnect and reconnect to generate new QR
  await disconnectWA();
  await createWhatsAppConnection(ctx);
});

bot.command('connect', async (ctx) => {
  if (!isUserAllowed(ctx.from.id) && ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ You are not authorized to use this bot. Wait for admin approval.');
  }
  
  if (isConnected) {
    return ctx.reply('✅ WhatsApp is already connected! You can send numbers to check now.');
  }
  
  await ctx.reply('🔄 Connecting to WhatsApp... Please wait.');
  await createWhatsAppConnection(ctx);
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Admin only command!');
  }
  
  const allowedList = Array.from(allowedUsers).filter(id => id !== ADMIN_ID);
  const pendingList = Array.from(pendingUsers);

  if (allowedList.length === 0 && pendingList.length === 0) {
    return ctx.reply('👥 No users found.');
  }

  let message = `👥 User Management\n\n`;
  
  if (allowedList.length > 0) {
    message += `✅ Allowed Users (${allowedList.length}):\n`;
    allowedList.forEach(userId => {
      const userName = userNames.get(userId) || `User ${userId}`;
      message += `• ${userName} (ID: ${userId})\n`;
    });
    message += `\n`;
  }
  
  if (pendingList.length > 0) {
    message += `⏳ Pending Requests (${pendingList.length}):\n`;
    pendingList.forEach(userId => {
      const userName = userNames.get(userId) || `User ${userId}`;
      message += `• ${userName} (ID: ${userId})\n`;
    });
  }

  const keyboard = [];
  
  allowedList.forEach(userId => {
    const userName = userNames.get(userId) || `User ${userId}`;
    keyboard.push([
      { 
        text: `❌ Disable ${userName}`, 
        callback_data: `toggle_${userId}` 
      }
    ]);
  });
  
  pendingList.forEach(userId => {
    const userName = userNames.get(userId) || `User ${userId}`;
    keyboard.push([
      { text: `✅ Allow ${userName}`, callback_data: `allow_${userId}` },
      { text: `❌ Deny ${userName}`, callback_data: `deny_${userId}` }
    ]);
  });

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

bot.command('pending', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Admin only command!');
  }
  
  const pendingList = Array.from(pendingUsers).slice(0, 20);

  if (pendingList.length === 0) {
    return ctx.reply('✅ No pending user requests.');
  }

  let message = `⏳ Pending Requests: ${pendingList.length}\n\n`;
  const keyboard = [];

  for (const userId of pendingList) {
    const userName = userNames.get(userId) || `User ${userId}`;
    message += `👤 ${userName}\n🆔 ${userId}\n\n`;
    
    keyboard.push([
      { text: `✅ Allow ${userName}`, callback_data: `allow_${userId}` },
      { text: `❌ Deny ${userName}`, callback_data: `deny_${userId}` }
    ]);
  }

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Admin only command!');
  }
  
  const stats = {
    totalUsers: allowedUsers.size - 1,
    pendingUsers: pendingUsers.size,
    whatsappStatus: isConnected ? 'Connected' : 'Disconnected',
    authExists: fs.existsSync(AUTH_FOLDER),
    userDataExists: fs.existsSync(USER_DATA_FILE),
    uptime: Math.floor(process.uptime() / 60) + ' minutes'
  };
  
  await ctx.reply(
    `📊 Bot Statistics:\n\n` +
    `👥 Allowed Users: ${stats.totalUsers}\n` +
    `⏳ Pending Requests: ${stats.pendingUsers}\n` +
    `📱 WhatsApp: ${stats.whatsappStatus}\n` +
    `🔐 Auth: ${stats.authExists ? 'Exists' : 'Not Found'}\n` +
    `💾 User Data: ${stats.userDataExists ? 'Persisted' : 'Not Found'}\n` +
    `⏰ Uptime: ${stats.uptime}\n` +
    `🖥️ Server: Render.com`
  );
});

bot.command('status', async (ctx) => {
  const statusMessage = `
🤖 Bot Status:

📱 WhatsApp: ${isConnected ? '✅ Connected' : '❌ Disconnected'}
⏰ Uptime: ${Math.floor(process.uptime() / 60)} minutes
💾 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB
👥 Allowed Users: ${allowedUsers.size - 1}
⏳ Pending Requests: ${pendingUsers.size}
🔐 Auth Persisted: ${fs.existsSync(AUTH_FOLDER) ? '✅ Yes' : '❌ No'}
💾 Data Persisted: ${fs.existsSync(USER_DATA_FILE) ? '✅ Yes' : '❌ No'}
🔗 Server: Render.com
🆔 Your ID: ${ctx.from.id}
  `;
  
  await ctx.reply(statusMessage);
});

// ULTRA FAST Number checking function
function extractNumbers(text) {
  const numbers = Array.from(
    new Set(
      (text.match(/[\+]?[1]?[-\s\.]?[(]?(\d{3})[)]?[-\s\.]?(\d{3})[-\s\.]?(\d{4})|\d{10,15}/g) || []).map((n) => {
        const cleanDigits = n.replace(/\D/g, '');
        
        if (cleanDigits.length === 10) {
          return '+1' + cleanDigits;
        }
        else if (cleanDigits.length === 11 && cleanDigits.startsWith('1')) {
          return '+' + cleanDigits;
        }
        else {
          return '+' + cleanDigits;
        }
      })
    )
  );
  
  return numbers.filter(n => n.length >= 12);
}

// BATCH PROCESSING for super fast checking
async function checkNumbersSuperFast(ctx, numbers) {
  if (!isConnected || !sock) {
    return ctx.reply('❌ WhatsApp is not connected. Please send /connect first.');
  }

  const processingMsg = await ctx.reply(`⚡ Checking ${numbers.length} numbers...\n\n⏳ Estimated time: 1-2 seconds`);

  // Prepare all numbers in batches
  const results = [];
  const batchSize = 200; // Increased batch size
  
  // Process all numbers in parallel using Promise.allSettled
  const chunks = [];
  for (let i = 0; i < numbers.length; i += batchSize) {
    chunks.push(numbers.slice(i, i + batchSize));
  }
  
  // Process chunks in parallel
  const chunkPromises = chunks.map(async (chunk) => {
    const promises = chunk.map(async (num) => {
      try {
        const clean = num.replace(/\D/g, '');
        const res = await sock.onWhatsApp(clean);
        const exists = Array.isArray(res) && res.length > 0 && res[0]?.exists === true;
        return { num, exists };
      } catch (error) {
        return { num, exists: null };
      }
    });
    
    const settled = await Promise.allSettled(promises);
    return settled.map(p => p.status === 'fulfilled' ? p.value : { num: 'error', exists: null });
  });
  
  // Wait for all chunks to complete
  const chunkResults = await Promise.all(chunkPromises);
  chunkResults.forEach(chunk => results.push(...chunk));

  // Categorize results
  const lalBaba = results.filter((r) => r.exists === true).map((r) => r.num);
  const fresh = results.filter((r) => r.exists === false).map((r) => r.num);
  const errorNums = results.filter((r) => r.exists === null).map((r) => r.num);

  try {
    await ctx.deleteMessage(processingMsg.message_id);
  } catch (error) {}

  // Send results in a clean format
  const resultMessages = [];
  
  if (lalBaba.length > 0) {
    resultMessages.push(`🚫 Lal Baba (${lalBaba.length}):\n${lalBaba.join('\n')}`);
  }
  
  if (fresh.length > 0) {
    resultMessages.push(`✅ Fresh (${fresh.length}):\n${fresh.join('\n')}`);
  }
  
  if (errorNums.length > 0) {
    resultMessages.push(`⚠️ Errors (${errorNums.length}):\n${errorNums.join('\n')}`);
  }
  
  // Send all results at once
  if (resultMessages.length > 0) {
    await ctx.reply(resultMessages.join('\n\n'));
  } else {
    await ctx.reply('❌ No valid numbers found.');
  }
}

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  
  if (text.startsWith('/')) return;
  
  const nums = extractNumbers(text);
  if (nums.length === 0) {
    return ctx.reply('❌ No valid numbers found in your message.\n\n📞 Supported formats:\n7828124894\n+18257976152\n+1 (902) 912-2670');
  }
  
  // Limit to 500 numbers for speed
  const numbersToCheck = nums.slice(0, 500);
  
  if (numbersToCheck.length !== nums.length) {
    await ctx.reply(`⚠️ Limiting to first 500 numbers for speed. (Total: ${nums.length})`);
  }
  
  await checkNumbersSuperFast(ctx, numbersToCheck);
});

// Start bot
bot.launch().then(() => {
  console.log('🤖 Bot started successfully on Render!');
  console.log('⚡ SUPER FAST CHECKING ENABLED');
  console.log('📱 Bot is ready to receive messages');
  console.log('💾 User data loaded:', allowedUsers.size, 'allowed users');
  console.log('🔐 WhatsApp auth exists:', fs.existsSync(AUTH_FOLDER));
}).catch(err => {
  console.error('❌ Bot failed to start:', err);
});

// Enhanced keep-alive system
const KEEP_ALIVE_URL = `https://${process.env.RENDER_SERVICE_NAME || 'whatsapp-checker-bot'}.onrender.com`;

async function pingServer() {
  try {
    const response = await fetch(KEEP_ALIVE_URL);
    console.log('🔄 Keep-alive ping sent:', response.status);
    return true;
  } catch (error) {
    console.log('⚠️ Keep-alive ping failed');
    return false;
  }
}

// Ping every 5 minutes (less than 15)
setInterval(async () => {
  await pingServer();
}, 5 * 60 * 1000);

// Additional random pings
setInterval(async () => {
  const randomTime = Math.floor(Math.random() * 3 * 60 * 1000) + (2 * 60 * 1000); // 2-5 minutes
  setTimeout(async () => {
    await pingServer();
  }, randomTime);
}, 6 * 60 * 1000);

// Immediate ping on startup
setTimeout(async () => {
  await pingServer();
}, 15000);

console.log('🚀 WhatsApp Number Checker Bot Started!');
console.log('⚡ SUPER FAST MODE: ENABLED');
console.log('🔧 Admin ID:', ADMIN_ID);
