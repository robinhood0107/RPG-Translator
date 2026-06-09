(function attach(root) {
  class BitmapTextAdapter {
    static install(scope, index) {
      if (!scope || !scope.Bitmap || !scope.Bitmap.prototype) return false;
      const prototype = scope.Bitmap.prototype;
      if (prototype.__rpgTranslatorBitmapTextInstalled) return true;
      const originalDrawText = prototype.drawText;
      if (typeof originalDrawText !== 'function') return false;
      prototype.drawText = function translatedBitmapText(text, ...rest) {
        return originalDrawText.call(this, translateText(index, scope, text), ...rest);
      };
      prototype.__rpgTranslatorBitmapTextInstalled = true;
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

  publish(root, { BitmapTextAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
