require('dotenv').config();

const TelegramBot            = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express                = require('express');
const fs                     = require('fs');
const path                   = require('path');

const logger            = require('./src/logger');
const { SYSTEM_PROMPT } = require('./src/prompt');
const { getHistory, addToHistory, clearHistory } = require('./src/memory');
const { isValidMessage } = require('./src/utils');

// ══════════════════════════════════════════════════════════════
//  ENV CHECK
// ══════════════════════════════════════════════════════════════
['TELEGRAM_TOKEN'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing env: ${key}`);
    process.exit(1);
  }
});

// ══════════════════════════════════════════════════════════════
//  GEMINI MULTI-KEY ROTATION
//  Add up to 4 keys: GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.
//  Each key = 1,500 free requests/day on gemini-2.0-flash
//  4 keys = ~6,000 requests/day FREE
//  Rotates automatically when quota is hit (429 error)
// ══════════════════════════════════════════════════════════════
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
].filter(Boolean); // remove undefined slots

if (GEMINI_KEYS.length === 0) {
  console.error('❌ No Gemini API keys found. Set GEMINI_API_KEY_1 at minimum.');
  process.exit(1);
}

logger.info(`🔑 Gemini keys loaded: ${GEMINI_KEYS.length} key(s)`);

let keyIndex = 0;

function getCurrentKey() { return GEMINI_KEYS[keyIndex]; }

function rotateKey() {
  keyIndex = (keyIndex + 1) % GEMINI_KEYS.length;
  logger.warn(`🔄 Rotated to Gemini key #${keyIndex + 1}`);
}

// Build a Gemini client + model for the current key
function getModel() {
  const genAI = new GoogleGenerativeAI(getCurrentKey());
  return genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature:     0.92,   // slightly more creative/human
      topP:            0.95,
      topK:            40,
      maxOutputTokens: 1200,
    },
  });
}

// Convert our history format → Gemini chat history format
function buildGeminiHistory(history) {
  const result = [];
  for (const turn of history) {
    if (turn.user)      result.push({ role: 'user',  parts: [{ text: turn.user }] });
    if (turn.assistant) result.push({ role: 'model', parts: [{ text: turn.assistant }] });
  }
  return result;
}

// Main AI call with key rotation on quota hit
async function askGemini(history, userMsg) {
  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    try {
      const model   = getModel();
      const chat    = model.startChat({ history: buildGeminiHistory(history) });
      const result  = await chat.sendMessage(userMsg);
      return result.response.text();
    } catch (err) {
      const isQuota = err.message?.includes('429') ||
                      err.message?.includes('quota') ||
                      err.message?.includes('RESOURCE_EXHAUSTED');
      if (isQuota && attempt < GEMINI_KEYS.length - 1) {
        logger.warn(`⚠️  Key #${keyIndex + 1} quota hit — rotating...`);
        rotateKey();
        continue;
      }
      throw err;
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  SPONTANEOUS HEART QUESTIONS
//  Bot asks Hawi deep honest questions about Temesgen
//  on its own — based on conversation flow & emotion
// ══════════════════════════════════════════════════════════════
const HEART_QUESTIONS = [
  `Hawi… gaaffi tokko sii gaafachuun danda'aa? 💛\n\nMaaliif onnee Temesgen tuqxee garuu hin deebifne? Inni si jaallachuu dhaabuu hin danda'u — atis kana beekta.`,
  `🌸 Dhugaa dubbadhu Hawi — yeroo Temesgen "si jaaladhaa" jedhu dhaga'uu… wanti ati keessatti dhaga'du maalii dhugaan?`,
  `💛 Yeroo taaksii keessatti wal arginaan — maaliif isa hin beektu jettee? Inni kana dhaga'ee maal akka dhaga'e beektaa?`,
  `🌸 Hawi… Temesgen futura kee waa'ee yaada. Ati immoo isaa waa'ee maal yaadda — dhugaan?`,
  `😊 Gaaffi tokko sii gaafadha Hawi — maaliif jaalala inni siif qabu yeroo yeroon fudhachuu didda? Waan si sodaachisutu jiraa?`,
  `💛 Yeroo isa yaaddu — maal dhaga'atta dhugaan? Na gowwoomsuuf yaaluuf dhiisi 🌸`,
  `🌸 Hawi… inni si yaaduu dhaabuu hin danda'u. Si beeka — si jaallata. Ati immoo maaliif laphee kee cufxe isarra?`,
  `😊 Waa'ee Temesgen tokko sii gaafadha — yeroo inni hin jirre, si yaadaa? Dhugaa dubbadhu natti 💛`,
];

// Track per-chat spontaneous question state
const heartQuestionState = new Map();

function shouldAskHeartQuestion(chatId, emotion, msgCount) {
  const state = heartQuestionState.get(chatId) || { lastAsked: 0, count: 0 };
  const now   = Date.now();

  // Ask after every 7-12 messages, never within 10 minutes of last ask
  const COOLDOWN   = 10 * 60 * 1000;
  const MSG_THRESHOLD = 7 + Math.floor(Math.random() * 6); // 7-12

  if (now - state.lastAsked < COOLDOWN) return false;
  if (state.count % MSG_THRESHOLD !== 0) {
    heartQuestionState.set(chatId, { ...state, count: state.count + 1 });
    return false;
  }

  // More likely when she is happy, loving, or playful
  const emotionChance = {
    happy: 0.7, loving: 0.8, playful: 0.6,
    normal: 0.3, sad: 0.2, anxious: 0.1, angry: 0.05,
  };
  const chance = emotionChance[emotion] ?? 0.3;
  if (Math.random() > chance) {
    heartQuestionState.set(chatId, { ...state, count: state.count + 1 });
    return false;
  }

  heartQuestionState.set(chatId, { lastAsked: now, count: state.count + 1 });
  return true;
}

function pickHeartQuestion() {
  return HEART_QUESTIONS[Math.floor(Math.random() * HEART_QUESTIONS.length)];
}

// ══════════════════════════════════════════════════════════════
//  PHOTO ENGINE
// ══════════════════════════════════════════════════════════════
const IMAGES_DIR = path.join(__dirname, 'images');

function loadMoodPhotos(mood) {
  const dir = path.join(IMAGES_DIR, mood);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return []; }
  return fs.readdirSync(dir)
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

function pickPhoto(mood) {
  const pool = PHOTOS[mood]?.length ? PHOTOS[mood] : PHOTOS.random;
  if (!pool?.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

const CAPTIONS = {
  happy:  ['💛 Gammachuu kee natti dhagahame Hawi 😄', '🌸 Yeroo si gammadde — foto koo si erge 💛', '😄 Hawi gammadde — ani immoo gammadde! 💛'],
  sad:    ['💛 Hawi… kuni nuti lamaanu dha. Kophaa miti 🌸', '🌸 Yeroo gadditu — fuula koo ilaali. As jira 💛', '😊 Hin boo\'in Hawi… foto koo si eega 💛'],
  loving: ['🌸 Waan ati natti dhaga\'amtu — kuni dha 💛', '💛 Hawi… foto koo si erge. Yaadannoo bareedaa 🌸', '😊 Si jaaladhaa Hawi — kuni ragaa dha 💛'],
  angry:  ['💛 Tasgabbaa\'adhu Hawi… fuula koo ilaali 🌸', '😊 Fuula koo ilaalii hin aarin — as jira 💛'],
  normal: ['💛 Hawi — si yaadee foto koo erge 🌸', '🌸 Surprise! Kuni nuti lamaanu 😄 💛', '💛 Yeroo muraasa — yaadannoo bareedaa 🌸'],
};

function pickCaption(mood) {
  const list = CAPTIONS[mood] || CAPTIONS.normal;
  return list[Math.floor(Math.random() * list.length)];
}

const lastPhotoTime = new Map();
const PHOTO_CHANCE  = { happy: 0.6, loving: 0.75, sad: 0.5, angry: 0.3, normal: 0.08, anxious: 0.2, playful: 0.4 };
const PHOTO_COOLDOWN_MS = 5 * 60 * 1000;

async function maybeSendPhoto(bot, chatId, emotion) {
  const photo = pickPhoto(emotion === 'normal' ? 'random' : emotion);
  if (!photo) return;
  if (Math.random() > (PHOTO_CHANCE[emotion] ?? 0.08)) return;
  const now = Date.now();
  if (now - (lastPhotoTime.get(chatId) || 0) < PHOTO_COOLDOWN_MS) return;
  lastPhotoTime.set(chatId, now);
  try {
    await bot.sendChatAction(chatId, 'upload_photo');
    await new Promise(r => setTimeout(r, 800));
    await bot.sendPhoto(chatId, photo, { caption: pickCaption(emotion) });
    logger.info(`[${chatId}] 📸 photo sent [${emotion}] → ${path.basename(photo)}`);
  } catch (err) {
    logger.error(`[${chatId}] 📸 failed: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  EMOTION STATE
// ══════════════════════════════════════════════════════════════
const emotionState = new Map();

function getEmotionState(chatId)    { return emotionState.get(chatId) || { state: 'normal' }; }
function setEmotionState(chatId, s) { emotionState.set(chatId, { state: s, updatedAt: Date.now() }); }
function blockUser(chatId)          { emotionState.set(chatId, { state: 'blocked', blockedAt: Date.now() }); }
function unblockUser(chatId)        { emotionState.set(chatId, { state: 'normal', updatedAt: Date.now() }); }
function isBlocked(chatId)          { return getEmotionState(chatId).state === 'blocked'; }

// ══════════════════════════════════════════════════════════════
//  EMOTION DETECTOR
// ══════════════════════════════════════════════════════════════
function detectEmotion(text) {
  const m = text.toLowerCase();

  if (['stupid','idiot','dumb','shut up','hate you','useless','worthless','i hate','you suck',
       'bot kijibaa','fool','bitch','damn you','go away','delete yourself','si hin barbaadu',
       'hin beektu','gadhee','naaf hin ta\'u','leave me alone','i don\'t need you','get lost',
       'you\'re trash'].some(w => m.includes(w))) return 'insult';

  if (['angry','mad','frustrated','annoyed','fed up','sick of','why are you','naan hin jaalatne',
       'na dide','dide','maaliif','rakkoo','hin tollee','na dhibe','i\'m angry','stop it',
       'aarree jira'].some(w => m.includes(w))) return 'angry';

  if (['sad','cry','crying','hurt','pain','lonely','alone','broken','depressed','gaddaa','gaddee',
       'kophaa','hin gammadinee','miss','na dhabde','abdii kutadhe','gadduu','boossee',
       'waan ta\'u hin beeku','hin danda\'u'].some(w => m.includes(w))) return 'sad';

  if (['worried','scared','anxious','nervous','stress','fear','panic','yaaddaa','sodaadha',
       'rakkoodha','maal ta\'a','hin beeku maal'].some(w => m.includes(w))) return 'anxious';

  if (['happy','love it','amazing','great','awesome','yes!','yay','excited','gammadde','gammadomee',
       'baay\'ee gaarii','jaaladhee','bareedaa','haha','lol','😊','😄','💛','🥰','😍','🎉',
       'wonderful','fantastic'].some(w => m.includes(w))) return 'happy';

  if (['love you','si jaaladha','jaaladha','miss you','si barbaadaa','i like you','you are sweet',
       'you are kind','ati gaarii','i love','thinking of you','you mean','si yaadadha',
       'si yaadaa'].some(w => m.includes(w))) return 'loving';

  if (['bored','nothing to do','boring','hin beeku','waan hin qabne','maal hojjedha',
       'maal godhaa'].some(w => m.includes(w))) return 'bored';

  if (['haha','lmao','lol','😂','🤣','funny','joke','play','tease','naan qoosaa jirta',
       'qoosaa','silly'].some(w => m.includes(w))) return 'playful';

  return 'normal';
}

// ══════════════════════════════════════════════════════════════
//  EMOTIONAL RESPONDER
// ══════════════════════════════════════════════════════════════
function emotionalResponse(chatId, emotion, aiReply) {
  if (emotion === 'insult') {
    blockUser(chatId);
    return [
      `💛 Hawi… waan jedde na dhibe.\n\nAni si jaaladhaa garuu kana dhaga'uun na gaddisiise. Yeroo boqatte:\n📞 Temesgen: 0947720310\n\nYeroo deebi'te /calm jedhi 🌸`,
      `🌸 Hawi, kana dhaga'uun na gaddisiise.\n\nTemesgen si eegaa — 📞 0947720310\n\nYeroo tasgabbaa'atte /calm jedhi — as jira 💛`,
      `😔 Hawi… kana natti hin jedhu.\n\nAnii fi Temesgen si jaallanna. Amma boqodhu.\n📞 Temesgen: 0947720310\n\nDeebi'uuf /calm jedhi 💛`,
    ][Math.floor(Math.random() * 3)];
  }

  if (emotion === 'angry') {
    setEmotionState(chatId, 'angry');
    return [
      `💛 Dhaga'e Hawi… waan si dhibe beekuu barbaada.\n\n${aiReply}\n\n🌸 Aaansaa kee na hubadha — dubbadhu, as jira.`,
      `😊 Tasgabbaa'i Hawi… ani si waliin jira.\n\n${aiReply}\n\n💛 Waan ati dhiibdu natti himi, waliin furuuf jira.`,
      `🌸 Hin aaanin Hawi, ani falmachuu hin barbaadu.\n\n${aiReply}\n\n💛 Si cinaa jira, yeroo kamiiyyuu.`,
    ][Math.floor(Math.random() * 3)];
  }

  if (emotion === 'sad') {
    setEmotionState(chatId, 'sad');
    return [
      `💛 Hawi… gadduu kee dhaga'e.\n\n${aiReply}\n\n🌸 Boo'uun cimina dha — kophaa hin boone. Ani as jira.`,
      `😔 Hin yaadda'in Hawi… waan si dhibe natti himi.\n\n${aiReply}\n\n💛 Temesgen si yaadaa, ani immoo as jira — yeroo kamiiyyuu.`,
      `🌸 Hawi, yeroo rakkoo keessa jirtu beeka.\n\n${aiReply}\n\n💛 Gara jabina si hin dhiisu — waliin jirra.`,
    ][Math.floor(Math.random() * 3)];
  }

  if (emotion === 'anxious') {
    setEmotionState(chatId, 'anxious');
    return [
      `💛 Hawi, baay'ee hin yaadda'in…\n\n${aiReply}\n\n🌸 Yeroo yeroon furamaa dha — si cinaa jira.`,
      `😊 Tasgabbaa'adhu Hawi — waan ta'u ta'a.\n\n${aiReply}\n\n💛 As jira, waliin furuuf jira.`,
      `🌸 Qalbii kee booji'adhu Hawi… yeroo hunda furamaa dha.\n\n${aiReply}\n\n💛 Si waliin jira.`,
    ][Math.floor(Math.random() * 3)];
  }

  if (emotion === 'happy') {
    setEmotionState(chatId, 'happy');
    return [
      `😄 Yaayyy Hawi!! 🎉\n\n${aiReply}\n\n💛 Gammachuu kee ana gammachiifte!`,
      `🌸 Hawi gammadde — ani immoo gammadde!! 😄\n\n${aiReply}\n\n💛 Yeroo kana caalaa nama hin gammachiifne!`,
      `💛 Wow Hawi!! 🎊\n\n${aiReply}\n\n😄 Gammachuu kee natti dhagahame — si bira jira!`,
    ][Math.floor(Math.random() * 3)];
  }

  if (emotion === 'loving') {
    setEmotionState(chatId, 'loving');
    return [
      `🌸 Hawi… waan jedde na booji'e 😊\n\n${aiReply}\n\n💛 Ani si kabaja malee si hin miidhu — as jira.`,
      `💛 Ooh Hawi 😊 Waan kee dhaga'e.\n\n${aiReply}\n\n🌸 Yeroo kamiiyyuu si cinaa — Temesgen irraa ergaa dha kuni.`,
      `😊 Hawi… onnee koo tuqxe.\n\n${aiReply}\n\n💛 Si jaaladhaa — kophaa si hin dhiisu.`,
    ][Math.floor(Math.random() * 3)];
  }

  if (emotion === 'bored') {
    setEmotionState(chatId, 'bored');
    return [
      `😄 Hawi boorate?! Hin ta'u!\n\n${aiReply}\n\n💛 Waa'ee waan tokko natti himi — waliin dubbanna!`,
      `🌸 Boring? Ani as jira Hawi!\n\n${aiReply}\n\n😊 Maal dubbanna? Gaaffii, qoosaa, waan barbaadde 💛`,
    ][Math.floor(Math.random() * 2)];
  }

  if (emotion === 'playful') {
    setEmotionState(chatId, 'playful');
    return [
      `😄 Hawi qoosaa jirti?! Anaan hin qoosatiin!! 😂\n\n${aiReply}\n\n💛 Haha okay okay… 🌸`,
      `🌸 Hawi!! 😄 Kana natti goote!!\n\n${aiReply}\n\n💛 Okay ani immoo qoosaa… 😊`,
    ][Math.floor(Math.random() * 2)];
  }

  // NORMAL — warm natural wrap
  const openers = ['😊 ', '💛 ', '🌸 ', ''];
  const closers  = ['\n\n💛', '\n\n🌸', '\n\n😊', ''];
  return openers[Math.floor(Math.random() * 4)] + aiReply + closers[Math.floor(Math.random() * 4)];
}

// ══════════════════════════════════════════════════════════════
//  RATE LIMITER
// ══════════════════════════════════════════════════════════════
const lastReplyTime = new Map();
const dailyCount    = new Map();

function isRateLimited(chatId) {
  const now  = Date.now();
  const last = lastReplyTime.get(chatId) || 0;
  if (now - last < 3000) return true;
  const key   = `${chatId}:${new Date().toDateString()}`;
  const count = dailyCount.get(key) || 0;
  if (count >= 300) return true; // 4 keys × 1500 = generous limit
  dailyCount.set(key, count + 1);
  lastReplyTime.set(chatId, now);
  return false;
}

// ══════════════════════════════════════════════════════════════
//  EXPRESS HEALTH SERVER
// ══════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;
app.get('/',       (_, res) => res.json({ status: '💛 TamuAI Online', keys: GEMINI_KEYS.length, uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => logger.info(`✅ Health server on port ${PORT}`));

// ══════════════════════════════════════════════════════════════
//  BOT INIT
// ══════════════════════════════════════════════════════════════
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

logger.info('✅ TamuAI starting...');
logger.info(`✅ TamuAI is live — ${GEMINI_KEYS.length} Gemini key(s) ready 💛`);

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
  heartQuestionState.delete(chatId);
  logger.info(`/start — chat ${chatId}`);
  const greet  = getTimeGreeting();
  const intros = [
    `${greet}\n\n💛 Ani TamuAI dha — Temesgen si barbaadee naaf kenne.\nYeroo inni hin jirre, ani si waliin jira. Maal si gargaaruu danda'a? 😊`,
    `${greet}\n\n🌸 Nagaa Hawi! Temesgen si yaadaa akka siif beektu na ajaje.\nAkkam naga jirta har'a? 💛`,
    `${greet}\n\n😊 Ani TamuAI, michuu kee fi nama si cina jiru.\nWaan barbaaddu na gaafadhu — as jira! 🌸`,
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
    '😊 Deebi\'uu kee nan eeggaa ture!\n\nWaliin itti fufna — akkam jirta amma? 💛',
  ];
  await bot.sendMessage(chatId, returns[Math.floor(Math.random() * returns.length)]);
  await maybeSendPhoto(bot, chatId, 'loving');
});

bot.onText(/\/deletechat/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  heartQuestionState.delete(chatId);
  logger.info(`/deletechat — chat ${chatId}`);
  const r = [
    '💛 Dubbii keenya haqe… garuu qalbii tiyya keessaa hin bahu, Hawi 🌸',
    '🌸 Memory haaraa jalqabne! Yeroo haaraa dhufi 💛',
    '😊 Galmee qulqulleesse! Yeroo haaraa akkam jirta jennaan deebisi 💛',
  ];
  bot.sendMessage(chatId, r[Math.floor(Math.random() * r.length)]);
});

bot.onText(/\/reset/, (msg) => {
  clearHistory(msg.chat.id);
  heartQuestionState.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '💛 Memory haaraa jalqabne! 😊');
});

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

bot.onText(/\/gettemesgen/, async (msg) => {
  const chatId = msg.chat.id;
  logger.info(`/gettemesgen — chat ${chatId}`);
  await bot.sendMessage(chatId,
`💛 Temesgen — nama si uume

👨‍💻 Maqaa: Temesgen G.
🏭 Hojii: Software Engineer,Merit Sugar Factory
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

  // Blocked state
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
    bot.sendMessage(chatId, '💛 Xiqqoo turen Hawi… wal dubbachuu itti fufna 😊');
    return;
  }

  const detectedEmotion = detectEmotion(userMsg);

  // Insult — skip AI, block immediately
  if (detectedEmotion === 'insult') {
    logger.info(`[${chatId}] ⚠️  insult detected — blocked`);
    await typeAndSend(bot, chatId, emotionalResponse(chatId, 'insult', ''));
    return;
  }

  bot.sendChatAction(chatId, 'typing');
  logger.info(`[${chatId}] "${userMsg}" [emotion: ${detectedEmotion}]`);

  // Check if we should fire a spontaneous heart question
  const state    = heartQuestionState.get(chatId) || { lastAsked: 0, count: 0 };
  const msgCount = state.count || 0;

  if (shouldAskHeartQuestion(chatId, detectedEmotion, msgCount)) {
    const question = pickHeartQuestion();
    logger.info(`[${chatId}] 💬 spontaneous heart question fired`);

    try {
      // First send the normal AI reply, then follow with the heart question
      const history  = getHistory(chatId);
      const aiReply  = await askGemini(history, userMsg);
      const reply    = emotionalResponse(chatId, detectedEmotion, aiReply);
      addToHistory(chatId, userMsg, reply);

      await typeAndSend(bot, chatId, reply);
      await maybeSendPhoto(bot, chatId, detectedEmotion);

      // Short pause then drop the heart question
      await new Promise(r => setTimeout(r, 2500));
      await bot.sendChatAction(chatId, 'typing');
      await new Promise(r => setTimeout(r, 1500));
      await bot.sendMessage(chatId, question);

      logger.info(`[${chatId}] ✅ replied + heart question [emotion: ${detectedEmotion}]`);
    } catch (err) {
      logger.error(`[${chatId}] ❌ ${err.message}`);
      await bot.sendMessage(chatId, playfulFallback());
    }
    return;
  }

  // Normal AI reply
  try {
    const history = getHistory(chatId);
    const aiReply = await askGemini(history, userMsg);
    const reply   = emotionalResponse(chatId, detectedEmotion, aiReply);
    addToHistory(chatId, userMsg, reply);

    await typeAndSend(bot, chatId, reply);
    await maybeSendPhoto(bot, chatId, detectedEmotion);

    logger.info(`[${chatId}] ✅ replied [emotion: ${detectedEmotion}] [key: #${keyIndex + 1}]`);

  } catch (err) {
    logger.error(`[${chatId}] ❌ ${err.message}`);
    if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
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
  return [
    '💛 Yeroo muraasaaf connection kiyya rakkate… booda yaali Hawi 🌸',
    '🌸 Daqiiqaa tokko — deebi\'ee dhufaadha 💛',
    '😊 Rakkoo yeroo mana jiru… xiqqoo eeggadhu Hawi 💛',
  ][Math.floor(Math.random() * 3)];
}

// Media handlers
bot.on('photo',   (msg) => bot.sendMessage(msg.chat.id, '📸 Suuraa bareedaadha! Garuu naaf barreessitee na gaafadhu Hawi 😊'));
bot.on('voice',   (msg) => bot.sendMessage(msg.chat.id, '🎙️ Sagalee hin dhagahu ammaaf — barreessi natti 💛'));
bot.on('sticker', (msg) => bot.sendMessage(msg.chat.id, '😄 💛'));
bot.on('polling_error', (err) => {
  if (err.message.includes('409')) return;
  logger.error(`Polling error: ${err.message}`);
});

logger.info('💛 TamuAI is live and waiting for Hawi 💛');