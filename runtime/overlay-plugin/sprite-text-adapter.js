(function attach(root) {
  class SpriteTextAdapter {
    static install(scope, translator) {
      if (!scope || !scope.Sprite || !scope.Sprite.prototype) return false;
      const prototype = scope.Sprite.prototype;
      if (prototype.__rpgTranslatorSpriteTextInstalled) return true;
      const originalUpdate = prototype.update;
      if (typeof originalUpdate !== 'function') return false;
      prototype.update = function translatedSpriteText(...args) {
        translateGlyphText(this, scope, translator);
        return originalUpdate.apply(this, args);
      };
      prototype.__rpgTranslatorSpriteTextInstalled = true;
      return true;
    }
  }

  function translateGlyphText(sprite, scope, translator) {
    translateField(sprite, '_rpgTranslatorGlyphText', scope, translator, sprite, 'sprite');
    if (sprite && sprite.bitmap) {
      translateField(sprite.bitmap, '_rpgTranslatorGlyphText', scope, translator, sprite.bitmap, 'sprite-bitmap');
    }
  }

  function translateField(target, key, scope, translator, surface, slotKey) {
    if (!target || typeof target[key] !== 'string') return;
    target[key] = translateText(translator, scope, target[key], surface, slotKey);
  }

  function translateText(translator, scope, text, surface, slotKey) {
    const request = {
        engine: overlay(scope).engine || 'unknown',
        sourceLanguage: overlay(scope).sourceLanguage,
        targetLanguage: overlay(scope).targetLanguage,
        text,
        surface,
        adapter: 'sprite-text',
        kind: 'glyph',
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

  publish(root, { SpriteTextAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
