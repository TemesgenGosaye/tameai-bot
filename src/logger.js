const LOG_LEVELS = { info: '✅', warn: '⚠️', error: '❌' };

function log(level, message) {
  const timestamp = new Date().toISOString();
  const icon = LOG_LEVELS[level] || 'ℹ️';
  console.log(`[${timestamp}] ${icon} ${message}`);
}

module.exports = {
  info:  (msg) => log('info', msg),
  warn:  (msg) => log('warn', msg),
  error: (msg) => log('error', msg),
};
