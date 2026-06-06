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
          message._texts = message._texts.map((text) => translateText(index, scope, text));
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
