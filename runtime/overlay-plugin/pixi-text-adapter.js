(function attach(root) {
  class PixiTextAdapter {
    static install(scope, index) {
      const pixi = scope && scope.PIXI;
      if (!pixi) return false;
      const textInstalled = wrapTextClass(pixi.Text, '__rpgTranslatorPixiTextInstalled', scope, index);
      const bitmapTextInstalled = wrapTextClass(
        pixi.BitmapText,
        '__rpgTranslatorPixiBitmapTextInstalled',
        scope,
        index,
      );
      return textInstalled || bitmapTextInstalled;
    }
  }

  function wrapTextClass(ctor, flagName, scope, index) {
    if (!ctor || !ctor.prototype || ctor.prototype[flagName]) return false;
    const descriptor = findPropertyDescriptor(ctor.prototype, 'text');
    if (descriptor && (descriptor.get || descriptor.set)) {
      Object.defineProperty(ctor.prototype, 'text', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          if (descriptor.get) return descriptor.get.call(this);
          return this.__rpgTranslatorPixiText;
        },
        set(value) {
          const translated = translateText(index, scope, value);
          if (descriptor.set) {
            descriptor.set.call(this, translated);
          } else {
            this.__rpgTranslatorPixiText = translated;
          }
        },
      });
    } else {
      Object.defineProperty(ctor.prototype, 'text', {
        configurable: true,
        get() {
          return this.__rpgTranslatorPixiText;
        },
        set(value) {
          this.__rpgTranslatorPixiText = translateText(index, scope, value);
        },
      });
    }
    ctor.prototype[flagName] = true;
    return true;
  }

  function findPropertyDescriptor(prototype, name) {
    let cursor = prototype;
    while (cursor) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) return descriptor;
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
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

  publish(root, { PixiTextAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
