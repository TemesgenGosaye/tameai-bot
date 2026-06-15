require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

const logger = require('./src/logger');
const { SYSTEM_PROMPT } = require('./src/prompt');
const { getHistory, addToHistory, clearHistory } = require('./src/memory');
const { formatError, isValidMessage } = require('./src/utils');

// ─── Greeting ─────────────────────────────
function getTimeGreeting() {
  const hour = new Date().getHours();

  if (hour < 12) return '🌞 Akkam bulte Hawi!';
  if (hour < 17) return '🌤️ Akkam ooltee Hawi!';
  return '🌙 Akkam bultee Hawi!';
}

// ─── ENV CHECK ─────────────────────────────
['TELEGRAM_TOKEN', 'GEMINI_API_KEY'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
});

// ─── EXPRESS SERVER ─────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) =>
  res.json({
    status: '💛 TamuAI Online',
    uptime: Math.floor(process.uptime()) + 's',
  })
);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => logger.info(`Health server running on ${PORT}`));

// ─── BOT INIT ─────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: true,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

logger.info('🚀 TamuAI starting...');
console.log('Gemini Key:', process.env.GEMINI_API_KEY?.slice(0, 10));

// ─── MODEL ─────────────────────────────
function getModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 1200,
    },
  });
}

// ─── COOL DOWN + MEMORY ─────────────────────────────
const lastReplyTime = new Map();

// ─── /start ─────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);

  const greet = getTimeGreeting();

  const messages = [
    `${greet}\n\n💛 Ani TamuAI dha — si gargaaruuf jira.`,
    `${greet}\n\n🌸 Ani yeroo Temesgen hin jirre si waliin jira.`,
    `${greet}\n\n😊 Nagaa Hawi! Maal si gargaaruu danda'a?`,
  ];

  bot.sendMessage(chatId, messages[Math.floor(Math.random() * messages.length)]);
  logger.info(`/start ${chatId}`);
});

// ─── /reset ─────────────────────────────
bot.onText(/\/reset/, (msg) => {
  clearHistory(msg.chat.id);
  bot.sendMessage(msg.chat.id, '💛 Memory haaraa jalqabne!');
});

// ─── /help ─────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🤖 TamuAI Help

/start - jalqabi
/reset - memory haqi
/help - gargaarsa`
  );
});

// ─── MAIN HANDLER (HUMAN + PLAYFUL + SAFE) ─────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMsg = msg.text;

  if (!isValidMessage(msg)) return;

  // 🚫 ignore commands
  if (!userMsg || userMsg.startsWith('/')) return;

  // 🚫 anti spam cooldown
  const now = Date.now();
  const last = lastReplyTime.get(chatId) || 0;
  if (now - last < 3000) return;
  lastReplyTime.set(chatId, now);

  bot.sendChatAction(chatId, 'typing');

  logger.info(`[${chatId}] 💬 ${userMsg}`);

  try {
    const model = getModel();
    const history = getHistory(chatId);
    const chat = model.startChat({ history });

    const result = await chat.sendMessage(userMsg);
    let reply = result.response.text();

    // 💛 HUMAN PERSONALITY LAYER
    reply = enhancePersonality(userMsg, reply);

    addToHistory(chatId, userMsg, reply);

    await typeAndSend(bot, chatId, reply);

    logger.info(`[${chatId}] ✅ replied`);

  } catch (err) {
    logger.error(`[${chatId}] ❌ ${err.message}`);

    await bot.sendMessage(chatId, playfulFallback());
  }
});

// ─── PERSONALITY ENGINE ─────────────────────────────
function enhancePersonality(userMsg, reply) {
  const msg = userMsg.toLowerCase();

  const openers = [
    "😊 Hawi… ",
    "💛 ooh Hawi… ",
    "🌸 dhugaa jettee? ",
    ""
  ];

  const closers = [
    "\n\n💛",
    "\n\n🌸",
    "\n\n😊",
    ""
  ];

  let enhanced = reply;

  if (msg.includes("hi") || msg.includes("hey")) {
    enhanced = "💛 Akkam Hawi 😄\n\n" + reply;
  }

  if (msg.includes("love") || msg.includes("jaaladha")) {
    enhanced =
      "🌸 ooh Hawi… 😊\n\n" +
      reply +
      "\n\n💛 Ani si kabaja malee si hin miidhu 😄";
  }

  if (msg.includes("sad") || msg.includes("lonely")) {
    enhanced =
      "💛 hin yaadda'in Hawi… ani as jira 😊\n\n" +
      reply +
      "\n\n🌸 ati kophaa miti";
  }

  const opener = openers[Math.floor(Math.random() * openers.length)];
  const closer = closers[Math.floor(Math.random() * closers.length)];

  return opener + enhanced + closer;
}

// ─── TYPE SIMULATION ─────────────────────────────
function typeAndSend(bot, chatId, text) {
  const delay = Math.min(1000 + text.length * 4, 3500);

  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        await bot.sendMessage(chatId, text);
      } catch {
        await bot.sendMessage(chatId, text.replace(/\*/g, ''));
      }
      resolve();
    }, delay);
  });
}

// ─── FALLBACK ─────────────────────────────
function playfulFallback() {
  const msgs = [
    "💛 TamuAI xiqqoo boqote… booda yaali 😊",
    "🌸 Ani amma offline fakkaadha… deebi'i booda 💛",
    "💛 connection koo rakkate 😄",
  ];

  return msgs[Math.floor(Math.random() * msgs.length)];
}

// ─── MEDIA HANDLERS ─────────────────────────────
bot.on('photo', (msg) =>
  bot.sendMessage(msg.chat.id, '📸 Suuraa bareedaa! Garuu barreessi 😊')
);

bot.on('voice', (msg) =>
  bot.sendMessage(msg.chat.id, '🎙️ Sagalee hin dhagahu — barreessi 😊')
);

bot.on('sticker', (msg) =>
  bot.sendMessage(msg.chat.id, '😄💛')
);

// ─── ERROR HANDLER ─────────────────────────────
bot.on('polling_error', (err) => {
  if (err.message.includes('409')) return;
  logger.error(`Polling error: ${err.message}`);
});

logger.info('💛 TamuAI is live and ready for Hawi');