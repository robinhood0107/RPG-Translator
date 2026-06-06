(function attach(root) {
  class WindowTextAdapter {
    static install(scope, index) {
      if (!scope || !scope.Window_Base || !scope.Window_Base.prototype) return false;
      const prototype = scope.Window_Base.prototype;
      if (prototype.__rpgTranslatorWindowTextInstalled) return true;
      wrapTextMethod(prototype, 'drawText', scope, index);
      wrapTextMethod(prototype, 'drawTextEx', scope, index);
      prototype.__rpgTranslatorWindowTextInstalled = true;
      return true;
    }
  }

  function wrapTextMethod(prototype, name, scope, index) {
    const original = prototype[name];
    if (typeof original !== 'function') return;
    prototype[name] = function translatedWindowText(text, ...rest) {
      const translated = translateText(index, scope, text);
      return original.call(this, translated, ...rest);
    };
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

  publish(root, { WindowTextAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
