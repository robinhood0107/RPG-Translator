(function attach(root) {
  class SpriteTextAdapter {
    static install(scope, index) {
      if (!scope || !scope.Sprite || !scope.Sprite.prototype) return false;
      const prototype = scope.Sprite.prototype;
      if (prototype.__rpgTranslatorSpriteTextInstalled) return true;
      const originalUpdate = prototype.update;
      if (typeof originalUpdate !== 'function') return false;
      prototype.update = function translatedSpriteText(...args) {
        translateGlyphText(this, scope, index);
        return originalUpdate.apply(this, args);
      };
      prototype.__rpgTranslatorSpriteTextInstalled = true;
      return true;
    }
  }

  function translateGlyphText(sprite, scope, index) {
    translateField(sprite, '_rpgTranslatorGlyphText', scope, index);
    if (sprite && sprite.bitmap) {
      translateField(sprite.bitmap, '_rpgTranslatorGlyphText', scope, index);
    }
  }

  function translateField(target, key, scope, index) {
    if (!target || typeof target[key] !== 'string') return;
    target[key] = translateText(index, scope, target[key]);
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

  publish(root, { SpriteTextAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
