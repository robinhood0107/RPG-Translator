(function attach(root) {
  class WindowTextAdapter {
    static install(scope, translator) {
      if (!scope || !scope.Window_Base || !scope.Window_Base.prototype) return false;
      const prototype = scope.Window_Base.prototype;
      if (prototype.__rpgTranslatorWindowTextInstalled) return true;
      wrapTextMethod(prototype, 'drawText', scope, translator);
      wrapTextMethod(prototype, 'drawTextEx', scope, translator);
      prototype.__rpgTranslatorWindowTextInstalled = true;
      return true;
    }
  }

  function wrapTextMethod(prototype, name, scope, translator) {
    const original = prototype[name];
    if (typeof original !== 'function') return;
    prototype[name] = function translatedWindowText(text, ...rest) {
      const translated = translateText(translator, scope, text, this, name);
      return original.call(this, translated, ...rest);
    };
  }

  function translateText(translator, scope, text, surface, slotKey) {
    const request = {
        engine: overlay(scope).engine || 'unknown',
        sourceLanguage: overlay(scope).sourceLanguage,
        targetLanguage: overlay(scope).targetLanguage,
        text,
        surface,
        adapter: 'window-text',
        kind: slotKey,
        slotKey,
      };
    const translated = translator && typeof translator.translateText === 'function'
      ? translator.translateText(request)
      : translator && typeof translator.translate === 'function'
        ? translator.translate(request)
        : null;
    return translated || text;
  }

  function overlay(scope) {
    return scope.RPGTranslatorOverlay || {};
  }

  publish(root, { WindowTextAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
