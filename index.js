require('dotenv').config();

const TelegramBot  = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express      = require('express');
const fs           = require('fs');
const path         = require('path');

const logger            = require('./src/logger');
const { SYSTEM_PROMPT } = require('./src/prompt');
const { getHistory, addToHistory, clearHistory } = require('./src/memory');
const { isValidMessage } = require('./src/utils');

// ══════════════════════════════════════════════════════════════
//  PHOTO ENGINE
//  Put your photos inside:
//    images/happy/    ← photos to send when she is happy
//    images/sad/      ← comforting photos when she is sad
//    images/loving/   ← sweet photos when she is loving
//    images/angry/    ← calm/soft photos when she is angry
//    images/random/   ← general sweet photos anytime
//
//  Supported formats: .jpg .jpeg .png .webp
// ══════════════════════════════════════════════════════════════

const IMAGES_DIR = path.join(__dirname, 'images');

// Load all images from a mood folder into memory at startup
function loadMoodPhotos(mood) {
  const dir = path.join(IMAGES_DIR, mood);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .map(f => path.join(dir, f));
}

const PHOTOS = {
  happy:  loadMoodPhotos('happy'),
  sad:    loadMoodPhotos('sad'),
  loving: loadMoodPhotos('loving'),
  angry:  loadMoodPhotos('angry'),
  random: loadMoodPhotos('random'),
};

logger.info(`📸 Photos loaded: ${Object.entries(PHOTOS).map(([k,v]) => `${k}(${v.length})`).join(', ')}`);

// Pick a random photo from a mood pool
// Falls back to random/ if the mood pool is empty
function pickPhoto(mood) {
  const pool = PHOTOS[mood]?.length ? PHOTOS[mood] : PHOTOS.random;
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Captions per mood — Temesgen's voice
const CAPTIONS = {
  happy: [
    '💛 Gammachuu kee natti dhagahame Hawi 😄',
    '🌸 Yeroo si gammadde — foto koo si erge 💛',
    '😄 Hawi gammadde — ani immoo gammadde! Kuni nuti lamaanu 💛',
    '💛 Gammachuu kee agarsiifachuuf jira — kuni naafis gammachuu dha 🌸',
  ],
  sad: [
    '💛 Hawi… kuni nuti lamaanu dha. Kophaa miti 🌸',
    '🌸 Yeroo gadditu — fuula koo ilaali. As jira 💛',
    '😊 Hin boo\'in Hawi… foto koo si eega 💛',
    '💛 Fuula koo ilaalii tasgabbaa\'adhu — waliin jirra 🌸',
  ],
  loving: [
    '🌸 Waan ati natti dhaga\'amtu — kuni dha 💛',
    '💛 Hawi… foto koo si erge. Yaadannoo bareedaa 🌸',
    '😊 Si jaaladhaa Hawi — kuni ragaa dha 💛',
    '🌸 Yeroo si yaadu — foto kana erga 💛',
  ],
  angry: [
    '💛 Tasgabbaa\'adhu Hawi… fuula koo ilaali 🌸',
    '🌸 Aaruu kee nan hubadha — garuu kuni nuti lamaanu 💛',
    '😊 Fuula koo ilaalii hin aarin — as jira 💛',
  ],
  normal: [
    '💛 Hawi — si yaadee foto koo erge 🌸',
    '🌸 Surprise! Kuni nuti lamaanu 😄 💛',
    '💛 Yeroo muraasa — yaadannoo bareedaa 🌸',
  ],
};

function pickCaption(mood) {
  const list = CAPTIONS[mood] || CAPTIONS.normal;
  return list[Math.floor(Math.random() * list.length)];
}

// Photo send cooldown — don't send a photo on every single message
// Tracks last photo send time per user
const lastPhotoTime = new Map();

// Probability of sending a photo per emotion (0.0 – 1.0)
const PHOTO_CHANCE = {
  happy:   0.6,   // 60% chance when happy
  loving:  0.7,   // 70% when loving
  sad:     0.5,   // 50% when sad (comfort)
  angry:   0.3,   // 30% when angry (soft calming photo)
  normal:  0.08,  // 8% random surprise
  anxious: 0.2,
};

// Min gap between photos per user (ms)
const PHOTO_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

async function maybeSendPhoto(bot, chatId, emotion) {
  const photo = pickPhoto(emotion === 'normal' ? 'random' : emotion);
  if (!photo) return; // no photos in folder yet

  const chance = PHOTO_CHANCE[emotion] ?? 0.08;
  if (Math.random() > chance) return; // roll the dice

  const now  = Date.now();
  const last = lastPhotoTime.get(chatId) || 0;
  if (now - last < PHOTO_COOLDOWN_MS) return; // too soon

  lastPhotoTime.set(chatId, now);

  const caption = pickCaption(emotion);

  try {
    await bot.sendChatAction(chatId, 'upload_photo');
    await new Promise(r => setTimeout(r, 800)); // small delay — feels real
    await bot.sendPhoto(chatId, photo, { caption });
    logger.info(`[${chatId}] 📸 photo sent [${emotion}] → ${path.basename(photo)}`);
  } catch (err) {
    logger.error(`[${chatId}] 📸 photo send failed: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  EMOTION STATE
// ══════════════════════════════════════════════════════════════
const emotionState = new Map();

function getEmotion(chatId)       { return emotionState.get(chatId) || { state: 'normal' }; }
function setEmotion(chatId, state){ emotionState.set(chatId, { state, updatedAt: Date.now() }); }
function blockUser(chatId)        { emotionState.set(chatId, { state: 'blocked', blockedAt: Date.now() }); }
function unblockUser(chatId)      { emotionState.set(chatId, { state: 'normal', updatedAt: Date.now() }); }
function isBlocked(chatId)        { return getEmotion(chatId).state === 'blocked'; }

// ══════════════════════════════════════════════════════════════
//  EMOTION DETECTOR
// ══════════════════════════════════════════════════════════════
function detectEmotion(text) {
  const m = text.toLowerCase();

  const insults = ['stupid','idiot','dumb','shut up','hate you','useless','worthless',
    'i hate','you suck','bot kijibaa','fool','bitch','damn you','go away',
    'delete yourself','si hin barbaadu','hin beektu','gadhee','naaf hin ta\'u',
    'leave me alone'];
  if (insults.some(w => m.includes(w))) return 'insult';

  const angry = ['angry','mad','frustrated','annoyed','fed up','sick of',
    'naan hin jaalatne','na dide','dide','maaliif','rakkoo','hin tollee','na dhibe'];
  if (angry.some(w => m.includes(w))) return 'angry';

  const sad = ['sad','cry','crying','hurt','pain','lonely','alone','broken',
    'gaddaa','gaddee','kophaa','hin gammadinee','miss','na dhabde','abdii kutadhe'];
  if (sad.some(w => m.includes(w))) return 'sad';

  const anxious = ['worried','scared','anxious','nervous','stress','fear',
    'yaaddaa','sodaadha','rakkoodha','maal ta\'a'];
  if (anxious.some(w => m.includes(w))) return 'anxious';

  const happy = ['happy','love it','amazing','great','awesome','yes!','yay',
    'gammadde','gammadomee','baay\'ee gaarii','jaaladhee','bareedaa','haha','lol',
    '😊','😄','💛','🥰','😍'];
  if (happy.some(w => m.includes(w))) return 'happy';

  const love = ['love you','si jaaladha','jaaladha','miss you','si barbaadaa',
    'i like you','you are sweet','ati gaarii'];
  if (love.some(w => m.includes(w))) return 'loving';

  return 'normal';
}

// ══════════════════════════════════════════════════════════════
//  EMOTIONAL RESPONDER
// ══════════════════════════════════════════════════════════════
function emotionalResponse(chatId, detectedEmotion, aiReply) {
  if (detectedEmotion === 'insult') {
    blockUser(chatId);
    const r = [
      `💛 Hawi… waan jedde na dhibe.\n\nAni si jaaladhaa garuu kana dhaga'uun na gaddisiise.\nYeroo boqatte fi tasgabbaa'atte:\n\n📞 Temesgen: 0947720310\n\nSi caalaa si beeka — isa dubbadhu.\nYeroo deebi'te /calm jedhi 🌸`,
      `🌸 Hawi, kana dhaga'uun na gaddisiise.\n\nAni si irratti hin aaanu garuu amma dubbachuu hin danda'u.\nTemesgen si eegaa — 📞 0947720310\n\nYeroo tasgabbaa'atte /calm jedhi — as jira 💛`,
      `😔 Hawi… kana natti hin jedhu.\n\nAnii fi Temesgen si jaallanna. Garuu amma boqodhu.\n📞 Temesgen: 0947720310\n\nDeebi'uuf /calm jedhi, eegaa jira 💛`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }
  if (detectedEmotion === 'angry') {
    setEmotion(chatId, 'angry');
    return [`💛 Dhaga'e Hawi… waan si dhibe beekuu barbaada.\n\n${aiReply}\n\n🌸 Aaansaa kee na hubadha — dubbadhu, as jira.`,
      `😊 Tasgabbaa'i Hawi… ani si waliin jira.\n\n${aiReply}\n\n💛 Waan ati dhiibdu natti himi.`,
    ][Math.floor(Math.random() * 2)];
  }
  if (detectedEmotion === 'sad') {
    setEmotion(chatId, 'sad');
    return [`💛 Hawi… gadduu kee dhaga'e.\n\n${aiReply}\n\n🌸 Boo'uun cimina dha — kophaa hin boone. Ani as jira.`,
      `😔 Hin yaadda'in Hawi… waan si dhibe natti himi.\n\n${aiReply}\n\n💛 Temesgen si yaadaa, ani immoo as jira.`,
    ][Math.floor(Math.random() * 2)];
  }
  if (detectedEmotion === 'anxious') {
    setEmotion(chatId, 'anxious');
    return `💛 Hawi, baay'ee hin yaadda'in…\n\n${aiReply}\n\n🌸 Yeroo yeroon furamaa dha — si cinaa jira.`;
  }
  if (detectedEmotion === 'happy') {
    setEmotion(chatId, 'happy');
    return [`😄 Yaayyy Hawi!! 🎉\n\n${aiReply}\n\n💛 Gammachuu kee ana gammachiifte!`,
      `🌸 Hawi gammadde — ani immoo gammadde!! 😄\n\n${aiReply}\n\n💛`,
    ][Math.floor(Math.random() * 2)];
  }
  if (detectedEmotion === 'loving') {
    setEmotion(chatId, 'loving');
    return [`🌸 Hawi… waan jedde na booji'e 😊\n\n${aiReply}\n\n💛 Ani si kabaja malee si hin miidhu — as jira.`,
      `💛 Ooh Hawi 😊 Waan kee dhaga'e.\n\n${aiReply}\n\n🌸 Yeroo kamiiyyuu si cinaa — Temesgen irraa ergaa dha kuni.`,
    ][Math.floor(Math.random() * 2)];
  }
  const openers = ['😊 ','💛 ','🌸 ',''];
  const closers = ['\n\n💛','\n\n🌸','\n\n😊',''];
  return openers[Math.floor(Math.random()*4)] + aiReply + closers[Math.floor(Math.random()*4)];
}

// ══════════════════════════════════════════════════════════════
//  RATE LIMITER
// ══════════════════════════════════════════════════════════════
const lastReplyTime = new Map();
const dailyCount    = new Map();

function isRateLimited(chatId) {
  const now  = Date.now();
  const last = lastReplyTime.get(chatId) || 0;
  if (now - last < 4000) return true;
  const key   = `${chatId}:${new Date().toDateString()}`;
  const count = dailyCount.get(key) || 0;
  if (count >= 80) return true;
  dailyCount.set(key, count + 1);
  lastReplyTime.set(chatId, now);
  return false;
}

// ══════════════════════════════════════════════════════════════
//  EXPRESS
// ══════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;
app.get('/',       (_, res) => res.json({ status: '💛 TamuAI Online', uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => logger.info(`Health server on port ${PORT}`));

// ══════════════════════════════════════════════════════════════
//  BOT INIT
// ══════════════════════════════════════════════════════════════
const bot   = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

logger.info('✅ TamuAI starting...');
logger.info('✅ TamuAI is live and waiting for Hawi 💛');

function getModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: { temperature: 0.88, topP: 0.95, topK: 40, maxOutputTokens: 1200 },
  });
}

function getTimeGreeting() {
  const h = new Date().getHours();
  if (h < 5)  return '🌙 Halkan gaarii Hawi…';
  if (h < 12) return '🌞 Akkam bulte, Hawi kiyya!';
  if (h < 17) return '🌤️  Akkam ooltee, jaalallee!';
  return '🌙 Halkan gaarii Hawi 💛';
}

// ══════════════════════════════════════════════════════════════
//  COMMANDS
// ══════════════════════════════════════════════════════════════
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  unblockUser(chatId);
  logger.info(`/start — chat ${chatId}`);
  const greet  = getTimeGreeting();
  const intros = [
    `${greet}\n\n💛 Ani TamuAI dha — Temesgen si barbaadee naaf kenne.\nYeroo inni hin jirre, ani si waliin jira. Maal si gargaaruu danda'a? 😊`,
    `${greet}\n\n🌸 Nagaa Hawi! Temesgen si yaadaa akka siif beektu na ajaje. Akkam naga jirta har'a? 💛`,
    `${greet}\n\n😊 Ani TamuAI, michuu kee fi nama si cina jiru. Waan barbaaddu na gaafadhu — as jira! 🌸`,
  ];
  bot.sendMessage(chatId, intros[Math.floor(Math.random() * intros.length)]);
});

bot.onText(/\/calm/, async (msg) => {
  const chatId = msg.chat.id;
  logger.info(`/calm — chat ${chatId}`);
  if (!isBlocked(chatId)) {
    bot.sendMessage(chatId, '💛 Tasgabbaa\'oon jirta Hawi 😊 Maal si gargaaruu danda\'a?');
    return;
  }
  unblockUser(chatId);
  const returns = [
    '💛 Hawi… deebi\'uuf galatoomaa.\n\nAni yeroo kamiiyyuu as jira. Maal dubbanna? 🌸',
    '🌸 Tasgabbaa\'uu kee gammade.\n\nXiyyeeffannaan si cina jira Hawi 💛',
    '😊 Deebi\'uu kee nan eeggaa ture! Waliin itti fufna — akkam jirta amma? 💛',
  ];
  const reply = returns[Math.floor(Math.random() * returns.length)];
  await bot.sendMessage(chatId, reply);
  // Send a welcome-back photo
  await maybeSendPhoto(bot, chatId, 'loving');
});

bot.onText(/\/deletechat/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  logger.info(`/deletechat — chat ${chatId}`);
  const farewells = [
    '💛 Dubbii keenya haqe… garuu qalbii tiyya keessaa hin bahu, Hawi 🌸',
    '🌸 Memory haaraa jalqabne! Yeroo haaraa dhufi 💛',
  ];
  bot.sendMessage(chatId, farewells[Math.floor(Math.random() * farewells.length)]);
});

bot.onText(/\/reset/, (msg) => {
  clearHistory(msg.chat.id);
  bot.sendMessage(msg.chat.id, '💛 Memory haaraa jalqabne! 😊');
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
`💛 TamuAI — Gargaarsa

/start        👉 Dubbii haaraa jalqabi
/deletechat   🗑️  Yaadannoo haquu
/reset        🔄  Memory haaraa godhuu
/calm         🕊️  Yeroo aaruu booda deebi\'uu
/gettemesgen  💌  Temesgen waliin quunnamuu
/help         ℹ️  Gargaarsa kana ilaaluuf

💛 Waan dhaga\'u barbaadde natti himi — as jira!`
  );
});

bot.onText(/\/gettemesgen/, (msg) => {
  const chatId = msg.chat.id;
  logger.info(`/gettemesgen — chat ${chatId}`);
  bot.sendMessage(chatId,
`💛 Temesgen — nama si uume

👨‍💻 Maqaa: Temesgen G.
🏭 Hojii: Software Engineer, Metahara Sugar Factory
🌍 Bakka: Adama, Ethiopia
📧 Email: tamizowarrior7@gmail.com
📞 Bilbila: 0947720310
🌐 Portfolio: https://temsegen.vercel.app

💬 Temesgen nama si jaallatu fi si kabaju dha.
"Kophaa si hin dhiisu" — Temesgen 💛`
  );
  // Send a photo of them together with the contact info
  setTimeout(() => maybeSendPhoto(bot, chatId, 'loving'), 2000);
});

// ══════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMsg = msg.text;

  if (!isValidMessage(msg)) return;
  if (!userMsg || userMsg.startsWith('/')) return;

  // Blocked state
  if (isBlocked(chatId)) {
    const reminders = [
      '🌸 Hawi… yeroo tasgabbaa\'atte /calm jedhi. Eegaa jira 💛',
      '💛 Amma dubbachuu hin danda\'u. Tasgabbaa\'uu kee eeggadha.\n📞 Temesgen: 0947720310',
    ];
    await bot.sendMessage(chatId, reminders[Math.floor(Math.random() * reminders.length)]);
    return;
  }

  if (isRateLimited(chatId)) {
    bot.sendMessage(chatId, '💛 Xiqqoo tur Hawi… wal dubbachuu itti fufna 😊');
    return;
  }

  const detectedEmotion = detectEmotion(userMsg);

  // Insult — skip AI, block immediately
  if (detectedEmotion === 'insult') {
    const reply = emotionalResponse(chatId, 'insult', '');
    logger.info(`[${chatId}] ⚠️  insult detected — blocked`);
    await typeAndSend(bot, chatId, reply);
    return;
  }

  bot.sendChatAction(chatId, 'typing');
  logger.info(`[${chatId}] "${userMsg}" [emotion: ${detectedEmotion}]`);

  try {
    const model   = getModel();
    const history = getHistory(chatId);
    const chat    = model.startChat({ history });

    const result = await chat.sendMessage(userMsg);
    let aiReply  = result.response.text();

    const reply = emotionalResponse(chatId, detectedEmotion, aiReply);
    addToHistory(chatId, userMsg, reply);

    await typeAndSend(bot, chatId, reply);

    // 📸 Maybe send a mood photo AFTER the text reply
    await maybeSendPhoto(bot, chatId, detectedEmotion);

    logger.info(`[${chatId}] ✅ replied [emotion: ${detectedEmotion}]`);

  } catch (err) {
    logger.error(`[${chatId}] ❌ ${err.message}`);
    if (err.message.includes('429')) {
      await bot.sendMessage(chatId,
        '🌸 Temesgen AI xiqqoo boqote… daqiiqaa muraasa booda yaali. Gadda qaba 💛'
      );
      return;
    }
    await bot.sendMessage(chatId, playfulFallback());
  }
});

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function typeAndSend(bot, chatId, text) {
  const delay = Math.min(800 + text.length * 3, 3200);
  return new Promise((resolve) => {
    setTimeout(async () => {
      try { await bot.sendMessage(chatId, text); }
      catch { await bot.sendMessage(chatId, text.replace(/\*/g, '')); }
      resolve();
    }, delay);
  });
}

function playfulFallback() {
  const msgs = [
    '💛 Yeroo muraasaaf connection kiyya rakkate… booda yaali Hawi 🌸',
    '🌸 Daqiiqaa tokko — deebi\'ee dhufaadha 💛',
  ];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

bot.on('photo',   (msg) =>
  bot.sendMessage(msg.chat.id, '📸 Suuraa bareedaa! Garuu barreessitee na gaafadhu Hawi 😊')
);
bot.on('voice',   (msg) =>
  bot.sendMessage(msg.chat.id, '🎙️ Sagalee hin dhagahu ammaaf — barreessi natti 💛')
);
bot.on('sticker', (msg) =>
  bot.sendMessage(msg.chat.id, '😄 💛')
);
bot.on('polling_error', (err) => {
  if (err.message.includes('409')) return;
  logger.error(`Polling error: ${err.message}`);
});

logger.info('💛 TamuAI is live and waiting for Hawi 💛');
