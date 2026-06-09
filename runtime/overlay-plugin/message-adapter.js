(function attach(root) {
  class MessageAdapter {
    static install(scope, index) {
      if (!scope || !scope.Window_Message || !scope.Window_Message.prototype) return false;
      const prototype = scope.Window_Message.prototype;
      if (prototype.__rpgTranslatorMessageInstalled) return true;
      const originalStartMessage = prototype.startMessage;
      prototype.startMessage = function startMessageWithTranslation(...args) {
        const message = scope.$gameMessage;
        if (message && Array.isArray(message._texts)) {
          const originalText = readMessageBlock(message);
          const translated = translateText(index, scope, originalText);
          if (
            translated &&
            translated !== originalText &&
            countNewlines(translated) === countNewlines(originalText)
          ) {
            message._texts = translated.split('\n');
          }
        }
        if (typeof originalStartMessage === 'function') {
          return originalStartMessage.apply(this, args);
        }
        return undefined;
      };
      prototype.__rpgTranslatorMessageInstalled = true;
      return true;
    }
  }

  function readMessageBlock(message) {
    if (typeof message.allText === 'function') {
      return String(message.allText() || '');
    }
    return message._texts.map((text) => String(text || '')).join('\n');
  }

  function countNewlines(text) {
    return String(text || '').split('\n').length - 1;
  }

  function translateText(index, scope, text) {
    const translated = index && typeof index.translate === 'function'
      ? index.translate({
        engine: overlay(scope).engine || 'unknown',
        sourceLanguage: overlay(scope).sourceLanguage,
        targetLanguage: overlay(scope).targetLanguage,
        text,
      })
      : null;
    return translated || text;
  }

  function overlay(scope) {
    return scope.RPGTranslatorOverlay || {};
  }

  publish(root, { MessageAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
