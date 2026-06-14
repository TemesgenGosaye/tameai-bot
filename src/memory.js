// In-memory conversation store
// Each chatId maps to an array of Gemini-formatted history objects
const store = new Map();

const MAX_HISTORY = 20; // max messages per user

/**
 * Get conversation history for a chat, formatted for Gemini
 */
function getHistory(chatId) {
  return store.get(chatId) || [];
}

/**
 * Add a user/assistant exchange to history
 */
function addToHistory(chatId, userMessage, assistantReply) {
  if (!store.has(chatId)) {
    store.set(chatId, []);
  }

  const history = store.get(chatId);

  history.push(
    { role: 'user',  parts: [{ text: userMessage }] },
    { role: 'model', parts: [{ text: assistantReply }] }
  );

  // Trim to last MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    store.set(chatId, history.slice(-MAX_HISTORY));
  }
}

/**
 * Clear history for a chat (on /start or /reset)
 */
function clearHistory(chatId) {
  store.delete(chatId);
}

/**
 * Get total number of active sessions (for monitoring)
 */
function getSessionCount() {
  return store.size;
}

module.exports = { getHistory, addToHistory, clearHistory, getSessionCount };
