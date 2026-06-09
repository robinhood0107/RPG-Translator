(function attach(root) {
  class BitmapTextAdapter {
    static install(scope, translator) {
      if (!scope || !scope.Bitmap || !scope.Bitmap.prototype) return false;
      const prototype = scope.Bitmap.prototype;
      if (prototype.__rpgTranslatorBitmapTextInstalled) return true;
      const originalDrawText = prototype.drawText;
      if (typeof originalDrawText !== 'function') return false;
      prototype.drawText = function translatedBitmapText(text, ...rest) {
        return originalDrawText.call(this, translateText(translator, scope, text, this), ...rest);
      };
      prototype.__rpgTranslatorBitmapTextInstalled = true;
      return true;
    }
  }

  function translateText(translator, scope, text, surface) {
    const request = {
        engine: overlay(scope).engine || 'unknown',
        sourceLanguage: overlay(scope).sourceLanguage,
        targetLanguage: overlay(scope).targetLanguage,
        text,
        surface,
        adapter: 'bitmap-text',
        kind: 'drawText',
        slotKey: 'bitmap-drawText',
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

  publish(root, { BitmapTextAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
