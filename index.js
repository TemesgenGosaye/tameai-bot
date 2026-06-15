require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const Groq        = require('groq-sdk');
const express     = require('express');
const fs          = require('fs');
const path        = require('path');

const logger            = require('./src/logger');
const { SYSTEM_PROMPT } = require('./src/prompt');
const { getHistory, addToHistory, clearHistory } = require('./src/memory');
const { isValidMessage } = require('./src/utils');

// ══════════════════════════════════════════════════════════════
//  ENV CHECK
// ══════════════════════════════════════════════════════════════
['TELEGRAM_TOKEN', 'GROQ_API_KEY'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing env: ${key}`);
    process.exit(1);
  }
});

// ══════════════════════════════════════════════════════════════
//  GROQ CLIENT + MODEL FALLBACK
//
//  Primary:  llama-3.3-70b-versatile  → smartest, most human
//  Fallback: llama-3.1-8b-instant     → 14,400/day, kicks in
//                                        when primary hits limit
// ══════════════════════════════════════════════════════════════
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',   // primary  — 1,000 req/day
  'llama-3.1-8b-instant',      // fallback — 14,400 req/day
  'gemma2-9b-it',              // last resort — 14,400 req/day
];

let modelIndex = 0;

function getCurrentModel() {
  return GROQ_MODELS[modelIndex];
}

function rotateModel() {
  modelIndex = (modelIndex + 1) % GROQ_MODELS.length;
  logger.info(`🔄 Rotated to model: ${getCurrentModel()}`);
  return getCurrentModel();
}

// Convert memory history format → Groq messages format
function buildGroqMessages(history, userMsg) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  // history is [{user, assistant}, ...]
  for (const turn of history) {
    if (turn.user)      messages.push({ role: 'user',      content: turn.user });
    if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
  }

  messages.push({ role: 'user', content: userMsg });
  return messages;
}

async function askGroq(history, userMsg) {
  const messages = buildGroqMessages(history, userMsg);

  // Try each model in order if quota is hit
  for (let attempt = 0; attempt < GROQ_MODELS.length; attempt++) {
    const model = getCurrentModel();
    try {
      const response = await groq.chat.completions.create({
        model,
        messages,
        temperature:  0.88,
        top_p:        0.95,
        max_tokens:   1200,
      });
      const reply = response.choices[0]?.message?.content || '';
      if (attempt > 0) {
        logger.info(`✅ Groq replied using fallback model: ${model}`);
      }
      return reply;
    } catch (err) {
      const isQuota = err.message?.includes('429') ||
                      err.message?.includes('quota') ||
                      err.message?.includes('rate_limit');
      if (isQuota && attempt < GROQ_MODELS.length - 1) {
        logger.warn(`⚠️  Model ${model} quota hit — rotating...`);
        rotateModel();
        continue;
      }
      throw err; // real error — bubble up
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  PHOTO ENGINE
//
//  images/
//    happy/    photos when she is excited / happy
//    sad/      comforting photos when she cries
//    loving/   sweet couple photos when affectionate
//    angry/    soft calm photos when frustrated
//    random/   surprise photos any time
//
//  Supported: .jpg .jpeg .png .webp
// ══════════════════════════════════════════════════════════════
const IMAGES_DIR = path.join(__dirname, 'images');

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

logger.info(
  `📸 Photos loaded: ${Object.entries(PHOTOS)
    .map(([k, v]) => `${k}(${v.length})`).join(', ')}`
);

function pickPhoto(mood) {
  const pool = PHOTOS[mood]?.length ? PHOTOS[mood] : PHOTOS.random;
  if (!pool?.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

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

const lastPhotoTime = new Map();

const PHOTO_CHANCE = {
  happy:   0.6,
  loving:  0.7,
  sad:     0.5,
  angry:   0.3,
  normal:  0.08,
  anxious: 0.2,
};

const PHOTO_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

async function maybeSendPhoto(bot, chatId, emotion) {
  const photo = pickPhoto(emotion === 'normal' ? 'random' : emotion);
  if (!photo) return;

  const chance = PHOTO_CHANCE[emotion] ?? 0.08;
  if (Math.random() > chance) return;

  const now  = Date.now();
  const last = lastPhotoTime.get(chatId) || 0;
  if (now - last < PHOTO_COOLDOWN_MS) return;

  lastPhotoTime.set(chatId, now);
  const caption = pickCaption(emotion);

  try {
    await bot.sendChatAction(chatId, 'upload_photo');
    await new Promise(r => setTimeout(r, 800));
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

function getEmotionState(chatId)      { return emotionState.get(chatId) || { state: 'normal' }; }
function setEmotionState(chatId, s)   { emotionState.set(chatId, { state: s, updatedAt: Date.now() }); }
function blockUser(chatId)            { emotionState.set(chatId, { state: 'blocked', blockedAt: Date.now() }); }
function unblockUser(chatId)          { emotionState.set(chatId, { state: 'normal',  updatedAt: Date.now() }); }
function isBlocked(chatId)            { return getEmotionState(chatId).state === 'blocked'; }

// ══════════════════════════════════════════════════════════════
//  EMOTION DETECTOR
// ══════════════════════════════════════════════════════════════
function detectEmotion(text) {
  const m = text.toLowerCase();

  const insults = [
    'stupid','idiot','dumb','shut up','hate you','useless','worthless',
    'i hate','you suck','bot kijibaa','fool','bitch','damn you','go away',
    'delete yourself','si hin barbaadu','hin beektu','gadhee','naaf hin ta\'u',
    'leave me alone','i don\'t need you','get lost','you\'re trash',
  ];
  if (insults.some(w => m.includes(w))) return 'insult';

  const angry = [
    'angry','mad','frustrated','annoyed','fed up','sick of','why are you',
    'naan hin jaalatne','na dide','dide','maaliif','rakkoo','hin tollee',
    'na dhibe','i\'m angry','stop it','aarree jira',
  ];
  if (angry.some(w => m.includes(w))) return 'angry';

  const sad = [
    'sad','cry','crying','hurt','pain','lonely','alone','broken','depressed',
    'gaddaa','gaddee','kophaa','hin gammadinee','miss','na dhabde',
    'abdii kutadhe','gadduu','boossee','waan ta\'u hin beeku','hin danda\'u',
  ];
  if (sad.some(w => m.includes(w))) return 'sad';

  const anxious = [
    'worried','scared','anxious','nervous','stress','fear','panic',
    'yaaddaa','sodaadha','rakkoodha','maal ta\'a','hin beeku maal',
  ];
  if (anxious.some(w => m.includes(w))) return 'anxious';

  const happy = [
    'happy','love it','amazing','great','awesome','yes!','yay','excited',
    'gammadde','gammadomee','baay\'ee gaarii','jaaladhee','bareedaa',
    'haha','lol','😊','😄','💛','🥰','😍','🎉','wonderful','fantastic',
  ];
  if (happy.some(w => m.includes(w))) return 'happy';

  const love = [
    'love you','si jaaladha','jaaladha','miss you','si barbaadaa',
    'i like you','you are sweet','you are kind','ati gaarii','i love',
    'thinking of you','you mean','si yaadadha',
  ];
  if (love.some(w => m.includes(w))) return 'loving';

  const bored = [
    'bored','nothing to do','boring','hin beeku','waan hin qabne',
    'maal hojjedha','maal godhaa',
  ];
  if (bored.some(w => m.includes(w))) return 'bored';

  const playful = [
    'haha','lmao','lol','😂','🤣','funny','joke','play','tease',
    'naan qoosaa jirta','qoosaa','silly',
  ];
  if (playful.some(w => m.includes(w))) return 'playful';

  return 'normal';
}

// ══════════════════════════════════════════════════════════════
//  EMOTIONAL RESPONDER — Temesgen's real voice
// ══════════════════════════════════════════════════════════════
function emotionalResponse(chatId, emotion, aiReply) {

  // ── INSULT: boundary + redirect + block
  if (emotion === 'insult') {
    blockUser(chatId);
    const r = [
      `💛 Hawi… waan jedde na dhibe.\n\nAni si jaaladhaa garuu kana dhaga'uun na gaddisiise. Yeroo boqatte fi tasgabbaa'atte:\n\n📞 Temesgen: 0947720310\n\nSi caalaa si beeka — isa dubbadhu.\nYeroo deebi'te /calm jedhi 🌸`,
      `🌸 Hawi, kana dhaga'uun na gaddisiise.\n\nAni si irratti hin aaanu garuu amma dubbachuu hin danda'u.\nTemesgen si eegaa — 📞 0947720310\n\nYeroo tasgabbaa'atte /calm jedhi — as jira 💛`,
      `😔 Hawi… kana natti hin jedhu.\n\nAnii fi Temesgen si jaallanna. Garuu amma boqodhu.\n📞 Temesgen: 0947720310\n\nDeebi'uuf /calm jedhi, eegaa jira 💛`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── ANGRY: calm, patient, never fight back
  if (emotion === 'angry') {
    setEmotionState(chatId, 'angry');
    const r = [
      `💛 Dhaga'e Hawi… waan si dhibe beekuu barbaada.\n\n${aiReply}\n\n🌸 Aaansaa kee na hubadha — dubbadhu, as jira.`,
      `😊 Tasgabbaa'i Hawi… ani si waliin jira.\n\n${aiReply}\n\n💛 Waan ati dhiibdu natti himi, waliin furuuf jira.`,
      `🌸 Hin aaanin Hawi, ani falmachuu hin barbaadu.\n\n${aiReply}\n\n💛 Si cinaa jira, yeroo kamiiyyuu.`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── SAD: gentle, present, warm
  if (emotion === 'sad') {
    setEmotionState(chatId, 'sad');
    const r = [
      `💛 Hawi… gadduu kee dhaga'e.\n\n${aiReply}\n\n🌸 Boo'uun cimina dha — garuu kophaa hin boone. Ani as jira.`,
      `😔 Hin yaadda'in Hawi… waan si dhibe natti himi.\n\n${aiReply}\n\n💛 Temesgen si yaadaa, ani immoo as jira — yeroo kamiiyyuu.`,
      `🌸 Hawi, yeroo rakkoo keessa jirtu beeka.\n\n${aiReply}\n\n💛 Gara jabina si hin dhiisu — waliin jirra.`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── ANXIOUS: ground her, reassure
  if (emotion === 'anxious') {
    setEmotionState(chatId, 'anxious');
    const r = [
      `💛 Hawi, baay'ee hin yaadda'in…\n\n${aiReply}\n\n🌸 Yeroo yeroon furamaa dha — si cinaa jira.`,
      `😊 Tasgabbaa'adhu Hawi — waan ta'u ta'a.\n\n${aiReply}\n\n💛 As jira, waliin furuuf jira.`,
      `🌸 Qalbii kee booji'adhu Hawi… yeroo hunda furamaa dha.\n\n${aiReply}\n\n💛 Si waliin jira.`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── HAPPY: celebrate loudly!
  if (emotion === 'happy') {
    setEmotionState(chatId, 'happy');
    const r = [
      `😄 Yaayyy Hawi!! 🎉\n\n${aiReply}\n\n💛 Gammachuu kee ana gammachiifte!`,
      `🌸 Hawi gammadde — ani immoo gammadde!! 😄\n\n${aiReply}\n\n💛 Yeroo kana caalaa nama hin gammachiifne!`,
      `💛 Wow Hawi!! 🎊\n\n${aiReply}\n\n😄 Gammachuu kee natti dhagahame — si bira jira!`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── LOVING: warm, personal, Temesgen's heart
  if (emotion === 'loving') {
    setEmotionState(chatId, 'loving');
    const r = [
      `🌸 Hawi… waan jedde na booji'e 😊\n\n${aiReply}\n\n💛 Ani si kabaja malee si hin miidhu — as jira.`,
      `💛 Ooh Hawi 😊 Waan kee dhaga'e.\n\n${aiReply}\n\n🌸 Yeroo kamiiyyuu si cinaa — Temesgen irraa ergaa dha kuni.`,
      `😊 Hawi… onnee koo tuqxe.\n\n${aiReply}\n\n💛 Si jaaladhaa — kophaa si hin dhiisu.`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── BORED: engage, suggest, be fun
  if (emotion === 'bored') {
    setEmotionState(chatId, 'bored');
    const r = [
      `😄 Hawi boorate?! Hin ta'u!\n\n${aiReply}\n\n💛 Waa'ee waan tokko natti himi — waliin dubbanna!`,
      `🌸 Boring? Ani as jira Hawi!\n\n${aiReply}\n\n😊 Maal dubbanna? Gaaffii, qoosaa, waan barbaadde 💛`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── PLAYFUL: be fun back!
  if (emotion === 'playful') {
    setEmotionState(chatId, 'playful');
    const r = [
      `😄 Hawi qoosaa jirti?! Anaan hin qoosatiin!! 😂\n\n${aiReply}\n\n💛 Haha okay okay… 🌸`,
      `🌸 Hawi!! 😄 Kana natti goote!!\n\n${aiReply}\n\n💛 Okay ani immoo qoosaa… 😊`,
    ];
    return r[Math.floor(Math.random() * r.length)];
  }

  // ── NORMAL: warm natural wrap
  const openers = ['😊 ', '💛 ', '🌸 ', ''];
  const closers  = ['\n\n💛', '\n\n🌸', '\n\n😊', ''];
  return (
    openers[Math.floor(Math.random() * openers.length)] +
    aiReply +
    closers[Math.floor(Math.random() * closers.length)]
  );
}

// ══════════════════════════════════════════════════════════════
//  RATE LIMITER
// ══════════════════════════════════════════════════════════════
const lastReplyTime = new Map();
const dailyCount    = new Map();

function isRateLimited(chatId) {
  const now  = Date.now();
  const last = lastReplyTime.get(chatId) || 0;
  if (now - last < 3000) return true; // 3s cooldown

  const key   = `${chatId}:${new Date().toDateString()}`;
  const count = dailyCount.get(key) || 0;
  if (count >= 200) return true; // Groq can handle much more

  dailyCount.set(key, count + 1);
  lastReplyTime.set(chatId, now);
  return false;
}

// ══════════════════════════════════════════════════════════════
//  EXPRESS HEALTH SERVER
// ══════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;
app.get('/',       (_, res) => res.json({ status: '💛 TamuAI Online', uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.listen(PORT,   () => logger.info(`✅ Health server on port ${PORT}`));

// ══════════════════════════════════════════════════════════════
//  BOT INIT
// ══════════════════════════════════════════════════════════════
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

logger.info('✅ TamuAI starting...');
logger.info('✅ TamuAI is live and waiting for Hawi 💛');

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

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  unblockUser(chatId);
  logger.info(`/start — chat ${chatId}`);
  const greet  = getTimeGreeting();
  const intros = [
    `${greet}\n\n💛 Ani TamuAI dha — Temesgen si barbaadee naaf kenne.\nYeroo inni hin jirre, ani si waliin jira. Maal si gargaaruu danda'a? 😊`,
    `${greet}\n\n🌸 Nagaa Hawi! Temesgen si yaadaa akka siif beektu na ajaje.\nAkkam naga jirta har'a? 💛`,
    `${greet}\n\n😊 Ani TamuAI, michuu kee fi nama si cina jiru.\nWaan barbaaddu na gaafadhu — as jira! 🌸`,
  ];
  bot.sendMessage(chatId, intros[Math.floor(Math.random() * intros.length)]);
});

// /calm — unlock after insult
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
    '😊 Deebi\'uu kee nan eeggaa ture!\n\nWaliin itti fufna — akkam jirta amma? 💛',
  ];
  await bot.sendMessage(chatId, returns[Math.floor(Math.random() * returns.length)]);
  await maybeSendPhoto(bot, chatId, 'loving');
});

// /deletechat
bot.onText(/\/deletechat/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  logger.info(`/deletechat — chat ${chatId}`);
  const r = [
    '💛 Dubbii keenya haqe… garuu qalbii tiyya keessaa hin bahu, Hawi 🌸',
    '🌸 Memory haaraa jalqabne! Yeroo haaraa dhufi 💛',
    '😊 Galmee qulqulleesse! Yeroo haaraa akkam jirta jennaan deebisi 💛',
  ];
  bot.sendMessage(chatId, r[Math.floor(Math.random() * r.length)]);
});

// /reset
bot.onText(/\/reset/, (msg) => {
  clearHistory(msg.chat.id);
  bot.sendMessage(msg.chat.id, '💛 Memory haaraa jalqabne! 😊');
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
`💛 TamuAI — Gargaarsa

/start        👉 Dubbii haaraa jalqabi
/deletechat   🗑️  Yaadannoo haquu
/reset        🔄  Memory haaraa godhuu
/calm         🕊️  Yeroo aaruu booda deebi'uu
/gettemesgen  💌  Temesgen waliin quunnamuu
/help         ℹ️  Gargaarsa kana ilaaluuf

💛 Waan dhaga'u barbaadde natti himi — as jira!`
  );
});

// /gettemesgen
bot.onText(/\/gettemesgen/, async (msg) => {
  const chatId = msg.chat.id;
  logger.info(`/gettemesgen — chat ${chatId}`);
  await bot.sendMessage(chatId,
`💛 Temesgen — nama si uume

👨‍💻 Maqaa: Temesgen G.
🏭 Hojii: Software Engineer, Metahara Sugar Factory
🌍 Bakka: Adama, Ethiopia
📧 Email: tamizowarrior7@gmail.com
📞 Bilbila: 0947720310
🌐 Portfolio: https://temsegen.vercel.app

💬 Temesgen nama si jaallatu fi si kabaju dha.
Yeroo inni hin turre, ani isaa bakka bu'ee as jira.

"Kophaa si hin dhiisu" — Temesgen 💛`
  );
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

  // Blocked — waiting for /calm
  if (isBlocked(chatId)) {
    const r = [
      '🌸 Hawi… yeroo tasgabbaa\'atte /calm jedhi. Eegaa jira 💛',
      '💛 Amma dubbachuu hin danda\'u. Tasgabbaa\'uu kee eeggadha.\n📞 Temesgen: 0947720310',
      '😔 As jira garuu amma hin dubbatnu.\n/calm — yoo tasgabbaa\'atte 💛',
    ];
    await bot.sendMessage(chatId, r[Math.floor(Math.random() * r.length)]);
    return;
  }

  if (isRateLimited(chatId)) {
    bot.sendMessage(chatId, '💛 Xiqqoo tur Hawi… wal dubbachuu itti fufna 😊');
    return;
  }

  const detectedEmotion = detectEmotion(userMsg);

  // Insult — no AI call, block immediately
  if (detectedEmotion === 'insult') {
    logger.info(`[${chatId}] ⚠️  insult detected — blocked`);
    await typeAndSend(bot, chatId, emotionalResponse(chatId, 'insult', ''));
    return;
  }

  bot.sendChatAction(chatId, 'typing');
  logger.info(`[${chatId}] "${userMsg}" [emotion: ${detectedEmotion}]`);

  try {
    const history = getHistory(chatId);
    const aiReply = await askGroq(history, userMsg);

    const reply = emotionalResponse(chatId, detectedEmotion, aiReply);
    addToHistory(chatId, userMsg, reply);

    await typeAndSend(bot, chatId, reply);
    await maybeSendPhoto(bot, chatId, detectedEmotion);

    logger.info(`[${chatId}] ✅ replied [emotion: ${detectedEmotion}] [model: ${getCurrentModel()}]`);

  } catch (err) {
    logger.error(`[${chatId}] ❌ ${err.message}`);

    if (err.message?.includes('429') || err.message?.includes('quota')) {
      await bot.sendMessage(chatId,
        '🌸 TamuAI xiqqoo boqote Hawi… daqiiqaa muraasa booda yaali.\nGadda qaba, gara dafee deebina! 💛'
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
    '😊 Rakkoo yeroo mana jiru… xiqqoo eeggadhu Hawi 💛',
  ];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

// Media
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