/**
 * Returns true only for real text messages (skip commands, stickers, etc.)
 */
function isValidMessage(msg) {
  if (!msg.text) return false;
  if (msg.text.startsWith('/')) return false;
  return true;
}

/**
 * Maps API errors to friendly Afaan Oromoo messages
 */
function formatError(error) {
  const msg = error.message || '';

  if (msg.includes('quota') || msg.includes('429')) {
    return 'Dhifaama  yeroo muraasaaf tajaajilli hin argamu. Daqiiqaa muraasa booda yaali. 🙏';
  }
  if (msg.includes('API_KEY') || msg.includes('401')) {
    return 'Dogoggora sirna keessaa. Temesgen beeksisi. 🔧';
  }
  if (msg.includes('network') || msg.includes('ECONNRESET')) {
    return 'Interneetii rakkoo qaba. Itti aansuun yaali. 📶';
  }

  return 'Dhifaama  yeroo muraasaaf deebi kennuu hin dandeenye. Itti aansuun yaali! 🙏';
}

module.exports = { isValidMessage, formatError };
