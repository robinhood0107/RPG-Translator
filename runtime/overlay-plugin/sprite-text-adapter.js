(function attach(root) {
  const STATE_KEY = '__rpgTranslatorSpriteTextState';
  const INSTALL_TOKEN = 'rpg-translator-sprite-text-v2';
  let nextSpriteId = 1;

  class SpriteTextAdapter {
    static install(scope, translator) {
      if (!scope || !scope.Sprite || !scope.Sprite.prototype) return false;
      const prototype = scope.Sprite.prototype;
      if (prototype.__rpgTranslatorSpriteTextInstalled === INSTALL_TOKEN) return true;
      const originalUpdate = prototype.update;
      if (typeof originalUpdate !== 'function') return false;
      prototype.update = function translatedSpriteText(...args) {
        translateGlyphText(this, scope, translator);
        return originalUpdate.apply(this, args);
      };
      prototype.update.__rpgTranslatorOriginal = originalUpdate;
      prototype.__rpgTranslatorSpriteTextInstalled = INSTALL_TOKEN;
      installLifecycleHooks(prototype, translator);
      return true;
    }
  }

  function translateGlyphText(sprite, scope, translator) {
    if (translator && typeof translator.observeRecord === 'function') {
      renderGlyphOverlay(sprite, scope, translator);
      return;
    }
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

  function renderGlyphOverlay(sprite, scope, translator) {
    if (!sprite || sprite._rpgTranslatorSpriteTextOverlay) return false;
    const source = glyphSource(sprite);
    if (!source || !source.text.trim()) {
      retireSprite(sprite, translator, 'no-glyph-text');
      return false;
    }
    const state = ensureState(sprite);
    syncStateSource(state, sprite, source);
    if (state.sourceText !== source.text) {
      removeOverlay(state, 'glyph-text-changed');
      retireActiveItem(state, translator, 'glyph-text-changed');
      state.sourceText = source.text;
      state.revision += 1;
    }

    const slotKey = `sprite:${state.id}:glyph`;
    const surfaceOwner = `sprite-text:${state.id}`;
    const textOwner = `${surfaceOwner}:${slotKey}`;
    if (typeof translator.claimSurface === 'function' && !translator.claimSurface(sprite, surfaceOwner)) {
      removeOverlay(state, 'surface-claimed');
      return false;
    }
    if (typeof translator.claimText === 'function' && !translator.claimText(slotKey, textOwner)) {
      removeOverlay(state, 'text-claimed');
      return false;
    }

    let command = state.command;
    if (!command || command.sourceText !== source.text || command.status !== 'hit') {
      command = translator.observeRecord({
        engine: overlay(scope).engine || 'unknown',
        sourceLanguage: overlay(scope).sourceLanguage,
        targetLanguage: overlay(scope).targetLanguage,
        text: source.text,
        currentText: source.text,
        surface: sprite,
        adapter: 'sprite-text',
        kind: 'glyph',
        slotKey,
        generation: state.revision,
        metadata: {
          source: source.kind,
        },
      });
      state.command = command;
      state.itemId = command && command.itemId ? command.itemId : null;
    }
    if (!command || command.status !== 'hit') {
      syncOverlayVisibility(state);
      return false;
    }
    if (typeof translator.acceptRender === 'function' && !translator.acceptRender(command, sprite, source.text)) {
      removeOverlay(state, 'stale-render');
      return false;
    }
    renderOverlay(scope, state, command.translatedText);
    syncOverlayVisibility(state);
    return true;
  }

  function glyphSource(sprite) {
    if (sprite && typeof sprite._rpgTranslatorGlyphText === 'string') {
      return { kind: 'sprite', owner: sprite, text: sprite._rpgTranslatorGlyphText };
    }
    if (sprite && sprite.bitmap && typeof sprite.bitmap._rpgTranslatorGlyphText === 'string') {
      return { kind: 'sprite-bitmap', owner: sprite.bitmap, text: sprite.bitmap._rpgTranslatorGlyphText };
    }
    return null;
  }

  function ensureState(sprite) {
    if (!sprite[STATE_KEY]) {
      sprite[STATE_KEY] = {
        id: String(nextSpriteId++),
        sprite,
        sourceText: '',
        sourceKind: '',
        sourceOwner: null,
        itemId: null,
        command: null,
        overlaySprite: null,
        overlayBitmap: null,
        revision: 0,
      };
    }
    return sprite[STATE_KEY];
  }

  function getState(sprite) {
    return sprite && sprite[STATE_KEY] ? sprite[STATE_KEY] : null;
  }

  function syncStateSource(state, sprite, source) {
    state.sprite = sprite;
    state.sourceKind = source.kind;
    state.sourceOwner = source.owner;
  }

  function renderOverlay(scope, state, translatedText) {
    if (!state || !state.sprite || !translatedText) return false;
    const sprite = state.sprite;
    const sourceBitmap = sprite.bitmap || state.sourceOwner || {};
    const overlayBitmap = ensureOverlayBitmap(scope, state, sourceBitmap);
    const overlaySprite = ensureOverlaySprite(scope, state, overlayBitmap);
    if (!overlayBitmap || !overlaySprite) return false;
    if (state.renderedText !== translatedText || state.renderedRevision !== state.revision) {
      drawOverlayText(overlayBitmap, translatedText);
      state.renderedText = translatedText;
      state.renderedRevision = state.revision;
    }
    if (overlaySprite.bitmap !== overlayBitmap) overlaySprite.bitmap = overlayBitmap;
    copySpriteVisualState(sprite, overlaySprite);
    attachOverlay(sprite, overlaySprite);
    return true;
  }

  function ensureOverlayBitmap(scope, state, sourceBitmap) {
    if (state.overlayBitmap && !state.overlayBitmap._destroyed) return state.overlayBitmap;
    const width = Math.max(1, Math.ceil(Number(sourceBitmap && sourceBitmap.width) || 1));
    const height = Math.max(1, Math.ceil(Number(sourceBitmap && sourceBitmap.height) || 1));
    let bitmap = null;
    try {
      bitmap = scope && typeof scope.Bitmap === 'function'
        ? new scope.Bitmap(width, height)
        : { width, height };
    } catch (_error) {
      bitmap = { width, height };
    }
    bitmap._rpgTranslatorSpriteTextOverlayBitmap = true;
    state.overlayBitmap = bitmap;
    return bitmap;
  }

  function ensureOverlaySprite(scope, state, overlayBitmap) {
    if (state.overlaySprite && !state.overlaySprite._destroyed) return state.overlaySprite;
    let sprite = null;
    try {
      sprite = scope && typeof scope.Sprite === 'function'
        ? new scope.Sprite(overlayBitmap)
        : { bitmap: overlayBitmap, children: [] };
    } catch (_error) {
      sprite = { bitmap: overlayBitmap, children: [] };
    }
    sprite._rpgTranslatorSpriteTextOverlay = true;
    sprite._rpgTranslatorSpriteTextSource = state.sprite;
    state.overlaySprite = sprite;
    return sprite;
  }

  function drawOverlayText(bitmap, text) {
    if (!bitmap) return false;
    bitmap._rpgTranslatorGlyphText = String(text ?? '');
    const drawText = originalBitmapDrawText(bitmap) || bitmap.drawText;
    if (typeof drawText !== 'function') return false;
    bitmap.__rpgTranslatorSpriteTextReplayDepth = (bitmap.__rpgTranslatorSpriteTextReplayDepth || 0) + 1;
    try {
      drawText.call(bitmap, text, 0, 0, Math.max(1, Number(bitmap.width) || 1), Math.max(1, Number(bitmap.height) || 24), 'left');
      return true;
    } finally {
      bitmap.__rpgTranslatorSpriteTextReplayDepth = Math.max(0, (bitmap.__rpgTranslatorSpriteTextReplayDepth || 1) - 1);
    }
  }

  function originalBitmapDrawText(bitmap) {
    const drawText = bitmap && bitmap.constructor && bitmap.constructor.prototype
      ? bitmap.constructor.prototype.drawText
      : null;
    return drawText && drawText.__rpgTranslatorOriginal ? drawText.__rpgTranslatorOriginal : null;
  }

  function copySpriteVisualState(source, target) {
    if (!source || !target) return;
    for (const key of ['x', 'y', 'opacity', 'alpha', 'rotation', 'z', 'zIndex', 'blendMode', 'tint']) {
      if (source[key] !== undefined) target[key] = source[key];
    }
    if (source.scale && target.scale) {
      if (Number.isFinite(Number(source.scale.x))) target.scale.x = source.scale.x;
      if (Number.isFinite(Number(source.scale.y))) target.scale.y = source.scale.y;
    }
    if (source.anchor && target.anchor) {
      if (Number.isFinite(Number(source.anchor.x))) target.anchor.x = source.anchor.x;
      if (Number.isFinite(Number(source.anchor.y))) target.anchor.y = source.anchor.y;
    }
    target.visible = source.visible !== false;
    target.renderable = source.renderable !== false && isOpen(source);
  }

  function attachOverlay(sprite, overlaySprite) {
    if (!sprite || !overlaySprite) return false;
    const parent = sprite.parent && sprite.parent !== overlaySprite ? sprite.parent : null;
    const parentChildren = childList(parent);
    const sourceIndex = parentChildren.indexOf(sprite);
    if (parent && sourceIndex >= 0) {
      const overlayIndex = parentChildren.indexOf(overlaySprite);
      if (overlaySprite.parent !== parent || overlayIndex !== sourceIndex + 1) {
        detachOverlayFromParent(overlaySprite);
        const targetIndex = Math.min(parentChildren.length, sourceIndex + 1);
        if (typeof parent.addChildAt === 'function') {
          parent.addChildAt(overlaySprite, targetIndex);
        } else if (typeof parent.addChild === 'function') {
          parent.addChild(overlaySprite);
          const currentIndex = parentChildren.indexOf(overlaySprite);
          if (currentIndex >= 0 && currentIndex !== targetIndex) {
            parentChildren.splice(currentIndex, 1);
            parentChildren.splice(targetIndex, 0, overlaySprite);
          }
        } else {
          parentChildren.splice(targetIndex, 0, overlaySprite);
          overlaySprite.parent = parent;
        }
      }
      return overlaySprite.parent === parent || parentChildren.includes(overlaySprite);
    }

    if (overlaySprite.parent === sprite) return true;
    detachOverlayFromParent(overlaySprite);
    if (typeof sprite.addChild === 'function') {
      sprite.addChild(overlaySprite);
      return overlaySprite.parent === sprite || childList(sprite).includes(overlaySprite);
    }
    const children = childList(sprite);
    if (!children.includes(overlaySprite)) children.push(overlaySprite);
    overlaySprite.parent = sprite;
    return true;
  }

  function syncOverlayVisibility(state) {
    if (!state || !state.overlaySprite || !state.sprite) return false;
    copySpriteVisualState(state.sprite, state.overlaySprite);
    state.overlaySprite.visible = state.sprite.visible !== false && isOpen(state.sprite);
    state.overlaySprite.renderable = state.overlaySprite.visible && state.sprite.renderable !== false;
    return true;
  }

  function isOpen(sprite) {
    if (!sprite || sprite._destroyed) return false;
    if (sprite.visible === false || sprite._hidden === true) return false;
    const alpha = Number(sprite.alpha);
    if (Number.isFinite(alpha) && alpha <= 0) return false;
    const opacity = Number(sprite.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
    return true;
  }

  function removeOverlay(state, reason) {
    if (!state || !state.overlaySprite) return false;
    const overlaySprite = state.overlaySprite;
    state.overlaySprite = null;
    state.overlayBitmap = null;
    detachOverlayFromParent(overlaySprite);
    state.removeReason = reason || 'remove';
    return true;
  }

  function detachOverlayFromParent(overlaySprite) {
    if (!overlaySprite || !overlaySprite.parent) return false;
    const parent = overlaySprite.parent;
    if (typeof parent.removeChild === 'function') {
      try {
        overlaySprite.__rpgTranslatorSpriteTextDetachBypass = true;
        parent.removeChild(overlaySprite);
        return true;
      } catch (_error) {
      } finally {
        overlaySprite.__rpgTranslatorSpriteTextDetachBypass = false;
      }
    }
    const children = childList(parent);
    const index = children.indexOf(overlaySprite);
    if (index >= 0) children.splice(index, 1);
    overlaySprite.parent = null;
    return true;
  }

  function retireSprite(sprite, translator, reason) {
    const state = getState(sprite);
    if (!state) return false;
    removeOverlay(state, reason);
    retireActiveItem(state, translator, reason || 'sprite-retired');
    state.command = null;
    state.itemId = null;
    state.sourceText = '';
    return true;
  }

  function retireActiveItem(state, translator, reason) {
    if (!state || !state.itemId) return false;
    if (translator && typeof translator.archiveItem === 'function') translator.archiveItem(state.itemId);
    if (translator && typeof translator.markSurfaceChanged === 'function') translator.markSurfaceChanged(state.sprite);
    state.itemId = null;
    state.command = null;
    state.retireReason = reason || 'retired';
    return true;
  }

  function installLifecycleHooks(prototype, translator) {
    installDestroyHook(prototype, translator);
    installChildHook(prototype, 'removeChild', translator);
    installRemoveChildrenHook(prototype, translator);
  }

  function installDestroyHook(prototype, translator) {
    const originalDestroy = prototype.destroy;
    if (typeof originalDestroy !== 'function' || originalDestroy.__rpgTranslatorSpriteDestroy === INSTALL_TOKEN) return;
    prototype.destroy = function translatedSpriteDestroy(...args) {
      retireSprite(this, translator, 'destroy');
      return originalDestroy.apply(this, args);
    };
    prototype.destroy.__rpgTranslatorOriginal = originalDestroy;
    prototype.destroy.__rpgTranslatorSpriteDestroy = INSTALL_TOKEN;
  }

  function installChildHook(prototype, methodName, translator) {
    const original = prototype[methodName];
    if (typeof original !== 'function' || original.__rpgTranslatorSpriteChild === INSTALL_TOKEN) return;
    prototype[methodName] = function translatedSpriteChild(child, ...args) {
      const result = original.call(this, child, ...args);
      if (child && child._rpgTranslatorSpriteTextOverlay) {
        if (child.__rpgTranslatorSpriteTextDetachBypass) return result;
        const source = child._rpgTranslatorSpriteTextSource;
        retireSprite(source, translator, `${methodName}:overlay`);
      } else {
        retireSprite(child, translator, methodName);
      }
      return result;
    };
    prototype[methodName].__rpgTranslatorOriginal = original;
    prototype[methodName].__rpgTranslatorSpriteChild = INSTALL_TOKEN;
  }

  function installRemoveChildrenHook(prototype, translator) {
    const original = prototype.removeChildren;
    if (typeof original !== 'function' || original.__rpgTranslatorSpriteRemoveChildren === INSTALL_TOKEN) return;
    prototype.removeChildren = function translatedSpriteRemoveChildren(...args) {
      const before = childList(this).slice();
      const result = original.apply(this, args);
      before.forEach((child) => {
        if (child && child._rpgTranslatorSpriteTextOverlay) {
          retireSprite(child._rpgTranslatorSpriteTextSource, translator, 'removeChildren:overlay');
        } else {
          retireSprite(child, translator, 'removeChildren');
        }
      });
      return result;
    };
    prototype.removeChildren.__rpgTranslatorOriginal = original;
    prototype.removeChildren.__rpgTranslatorSpriteRemoveChildren = INSTALL_TOKEN;
  }

  function childList(sprite) {
    if (!sprite) return [];
    if (!Array.isArray(sprite.children)) sprite.children = [];
    return sprite.children;
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
