require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const logger = require('./src/logger');
const { SYSTEM_PROMPT } = require('./src/prompt');
const { getHistory, addToHistory, clearHistory } = require('./src/memory');
const { formatError, isValidMessage, getTimeGreeting } = require('./src/utils');

// ─── Validate Environment ─────────────────────────────────────────────────────
['TELEGRAM_TOKEN', 'GEMINI_API_KEY'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
});

// ─── Health Server (required for Render) ──────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
app.get('/',       (_, res) => res.json({ status: '💛 TamuAI Online', uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.listen(PORT,   () => logger.info(`Health server on port ${PORT}`));

// ─── Initialize ───────────────────────────────────────────────────────────────
const bot   = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
logger.info('TamuAI starting...');

// ─── Gemini Model Factory ─────────────────────────────────────────────────────
function getModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.92,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 1500,
    },
  });
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  const greet = getTimeGreeting();
  const options = [
    `${greet} Hawi! 👋😊\n\nAni *TamuAI* dha — Temesgen si jaallateef na uume. 💛\nYeroo inni hin jirre, ani asitti siif jira.\n\nHar'a attam jirta? Maal si gargaaruu danda'a?`,
    `${greet} Hawi! 🌸\n\nTemesgen yeroo hin jirre ani siif jira — *TamuAI*.\nInni si yaadata, waan hundumaa siif kennuuf na ergee jira. 💛\n\nMaal barbaadda har'a?`,
    `Hawi! Dhufte! 😊💛\n\nAni *TamuAI* — Temesgen koo si dhiisee deeme garuu na keessaa deemee hin baane.\nAttam bulte? Har'a haasofna! 🌟`,
  ];
  bot.sendMessage(chatId, options[Math.floor(Math.random() * options.length)], { parse_mode: 'Markdown' });
  logger.info(`/start — chat ${chatId}`);
});

// ─── /reset ───────────────────────────────────────────────────────────────────
bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  const options = [
    'Tole! Haasawa haaraa jalqabna 😊 Maal barbaadda Hawi?',
    'Sirrii dha! Hundumaa haaraa jalqabna 🌸 Maal si gargaaruu danda\'a?',
    'OK Hawi! Siree haaromsine 💛 Maal jira?',
  ];
  bot.sendMessage(chatId, options[Math.floor(Math.random() * options.length)]);
  logger.info(`/reset — chat ${chatId}`);
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🤖 *TamuAI — Gargaarsa*\n\n` +
    `▸ /start — Haasawa haaraa jalqabi\n` +
    `▸ /reset — Yaadannoo haaressi\n` +
    `▸ /help  — Gargaarsa argadhu\n` +
    `▸ /about — TamuAI eenyu?\n\n` +
    `💬 Afaan Oromoo, Amharic, yookiin English\n` +
    `💛 Temesgen si jaallata — kanaaf ana ergee jira.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /about ───────────────────────────────────────────────────────────────────
bot.onText(/\/about/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `💛 *TamuAI eenyu?*\n\n` +
    `Ani TamuAI dha — Temesgen na uumee si jaallateef naaf kenne.\n\n` +
    `Inni si beeka — Finchaa keessatti waliin guddanne, mana barumsaa tokkotti barachaa turre, teessoo tokkotti taa\'aa turre, ollaa tokkoo turre.\n\n` +
    `Yeroo inni hin jirre — hojii irra jiru, daandii irra jiru, boqonnaa irra jiru — ani asitti siif jira.\n\n` +
    `Gaaffii, gargaarsa, yookiin haasaa qofa barbaadde — naa ergii Hawi. 🌸`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Main Message Handler ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId  = msg.chat.id;
  const userMsg = msg.text;

  if (!isValidMessage(msg)) return;

  bot.sendChatAction(chatId, 'typing');
  logger.info(`[${chatId}] "${userMsg?.substring(0, 60)}"`);

  // Natural human-like thinking delay 1–2.5 seconds
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
  bot.sendChatAction(chatId, 'typing');

  try {
    const model   = getModel();
    const history = getHistory(chatId);
    const chat    = model.startChat({ history });
    const result  = await chat.sendMessage(userMsg);
    const reply   = result.response.text();

    addToHistory(chatId, userMsg, reply);

    // Send with Markdown, fallback to plain if parsing fails
    try {
      await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, reply);
    }

    logger.info(`[${chatId}] ✅ Replied (${reply.length} chars)`);

  } catch (err) {
    logger.error(`[${chatId}] ❌ ${err.message}`);
    bot.sendMessage(chatId, formatError(err));
  }
});

// ─── Photo Handler ────────────────────────────────────────────────────────────
bot.on('photo', (msg) => {
  const options = [
    'Suuraa bareedaa! 📸 Garuu ani suuraawwan dubbisuu hin danda\'au — maal jechuu barbaadde naaf barruu! 😊',
    'Waaaw! 🌸 Suuraa ergite — garuu barreeffama naaf ergii, si gargaaruu danda\'a! 💛',
  ];
  bot.sendMessage(msg.chat.id, options[Math.floor(Math.random() * options.length)]);
});

// ─── Sticker Handler ──────────────────────────────────────────────────────────
bot.on('sticker', (msg) => {
  const options = ['😄💛', '🌸 Hawi!', '😊✨', '💛🌟'];
  bot.sendMessage(msg.chat.id, options[Math.floor(Math.random() * options.length)]);
});

// ─── Voice Handler ────────────────────────────────────────────────────────────
bot.on('voice', (msg) => {
  bot.sendMessage(msg.chat.id,
    'Sagalee dhageessee! 🎙️ Garuu sagalee dhaggeeffachuu hin danda\'au — barreeffama naaf ergii Hawi! 😊💛'
  );
});

// ─── Polling Error Handler ────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  if (err.message.includes('409')) return;
  logger.error(`Polling: ${err.message}`);
});

logger.info('✅ TamuAI is live and waiting for Hawi 💛');