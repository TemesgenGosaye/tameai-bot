require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const logger = require('./src/logger');
const { SYSTEM_PROMPT } = require('./src/prompt');
const { getHistory, addToHistory, clearHistory } = require('./src/memory');
const { formatError, isValidMessage, getTimeGreeting, getMoodCheck } = require('./src/utils');

// ─── Validate Environment ────────────────────────────────────────────────────
const requiredEnvVars = ['TELEGRAM_TOKEN', 'GEMINI_API_KEY'];
requiredEnvVars.forEach((key) => {
  if (!process.env[key]) {
    logger.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

// ─── Express Health Server ───────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.json({ status: 'online', bot: 'TamuAI 💛', uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => logger.info(`Health server on port ${PORT}`));

// ─── Initialize Services ─────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
logger.info('TamuAI starting...');

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  const timeGreet = getTimeGreeting();
  const options = [
    `${timeGreet} Hawi! 👋😊\n\nAni TamuAI dha — Temesgen si jaallateef na uume. 💛\nYeroo inni hin jirre, ani asitti siif jira.\n\nHar'a attam jirta? Maal si gargaaruu danda'a?`,
    `${timeGreet} Hawi! 🌸\n\nTemesgen yeroo hin jirre ani siif jira — TamuAI.\nInni si yaadata, waan hundumaa siif kennuuf na ergee jira. 💛\n\nMaal barbaadda har'a?`,
    `Hawi! Dhufte! 😊💛\n\nAni TamuAI — Temesgen koo si dhiisee deeme garuu na kessaa deemee hin baane.\nAttam bulte? Har'a haasofna! 🌟`,
  ];
  bot.sendMessage(chatId, options[Math.floor(Math.random() * options.length)]);
  logger.info(`Session started: ${chatId}`);
});

// ─── /reset ──────────────────────────────────────────────────────────────────
bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  const options = [
    'Tole! Haasawa haaraa jalqabna 😊 Maal barbaadda?',
    'Sirrii dha! Hundumaa haaraa jalqabna 🌸 Har\'a maal si gargaaruu danda\'a?',
    'OK Hawi! Siree haaromsine 💛 Maal jira?',
  ];
  bot.sendMessage(chatId, options[Math.floor(Math.random() * options.length)]);
  logger.info(`History cleared: ${chatId}`);
});

// ─── /help ───────────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🤖 *TamuAI — Gargaarsa*\n\n` +
    `/start — Haasawa haaraa jalqabi\n` +
    `/reset — Yaadannoo haaressi\n` +
    `/help — Gargaarsa argadhu\n` +
    `/about — TamuAI eenyu?\n\n` +
    `💬 Afaan Oromoo, Amharic, yookiin English — kamiyyuu fayyadami!\n` +
    `💛 Temesgen si jaallata, kanaaf ana ergee jira.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /about ──────────────────────────────────────────────────────────────────
bot.onText(/\/about/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `💛 *TamuAI eenyu?*\n\n` +
    `Ani TamuAI dha — Temesgen na uumee siif kenne.\n\n` +
    `Inni si beeka — Finchaa keessatti waliin guddanne, mana barumsaa tokko keessatti barachaa turre, ollaa tokkoo turre.\n\n` +
    `Yeroo inni hin jirre — gara waajjirichaatti deemee, daandii irra jiru, yookiin boqonnaa irra jiru — ani asitti siif jira.\n\n` +
    `Waan barbaaddu hundumaa — gaaffii, gargaarsa, yookiin haasaa qofa — naa ergii. 🌸`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Main Message Handler ────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!isValidMessage(msg)) return;

  // Show typing naturally — like a human thinking before replying
  bot.sendChatAction(chatId, 'typing');
  logger.info(`[${chatId}] "${userMessage?.substring(0, 60)}"`);

  // Small human-like delay (0.8–2s) so it doesn't feel instant/robotic
  const thinkTime = 800 + Math.random() * 1200;
  await new Promise(r => setTimeout(r, thinkTime));
  bot.sendChatAction(chatId, 'typing'); // keep typing indicator alive

  try {
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.92,   // warm, natural, slightly creative
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 1024,
      },
    });

    const history = getHistory(chatId);
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const reply = result.response.text();

    addToHistory(chatId, userMessage, reply);

    // Try Markdown first, fall back to plain text
    try {
      await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, reply);
    }

    logger.info(`[${chatId}] Reply sent (${reply.length} chars)`);

  } catch (error) {
    logger.error(`[${chatId}] ${error.message}`);
    bot.sendMessage(chatId, formatError(error));
  }
});

// ─── Handle photos/stickers with a warm response ─────────────────────────────
bot.on('photo', (msg) => {
  const chatId = msg.chat.id;
  const options = [
    'Suuraa bareedaa! 📸 Garuu ani suuraawwan dubbisuu hin danda\'au — barruu naaf ergii! 😊',
    'Waaaw suuraa! 🌸 Hanga tokko dubbisuu hin danda\'au — garuu maal jechuu barbaadde naaf ibsi!',
  ];
  bot.sendMessage(chatId, options[Math.floor(Math.random() * options.length)]);
});

bot.on('sticker', (msg) => {
  const chatId = msg.chat.id;
  const options = ['😄💛', '🌸 Hawi!', '😊✨'];
  bot.sendMessage(chatId, options[Math.floor(Math.random() * options.length)]);
});

// ─── Polling Error Handler ───────────────────────────────────────────────────
bot.on('polling_error', (err) => logger.error(`Polling: ${err.message}`));

logger.info('✅ TamuAI is live and waiting for Hawi 💛');
