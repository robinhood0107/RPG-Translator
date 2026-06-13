(function attach(root) {
  const STATE_KEY = '__rpgTranslatorPixiState';
  const SETTER_TOKEN = 'rpg-translator-pixi-setter-v2';
  const LIFECYCLE_TOKEN = 'rpg-translator-pixi-lifecycle-v2';
  const PRIORITY_VISIBLE = 750;
  const PRIORITY_DETACHED = 250;
  const PRIORITY_HIDDEN = 100;
  let nextObjectId = 1;

  class PixiTextAdapter {
    static install(scope, translator) {
      const pixi = scope && scope.PIXI;
      if (!pixi) return false;
      const watched = ensureWatchedSet(scope);
      const textInstalled = wrapTextClass(pixi.Text, '__rpgTranslatorPixiTextInstalled', scope, translator, 'pixi-text', watched);
      const bitmapTextInstalled = wrapTextClass(
        pixi.BitmapText,
        '__rpgTranslatorPixiBitmapTextInstalled',
        scope,
        translator,
        'pixi-bitmap-text',
        watched,
      );
      const containerLifecycleInstalled = installContainerLifecycle(pixi.Container, translator, watched);
      const displayObjectContainerLifecycleInstalled = installContainerLifecycle(
        pixi.DisplayObjectContainer,
        translator,
        watched,
      );
      const lifecycleInstalled = containerLifecycleInstalled || displayObjectContainerLifecycleInstalled;
      installFrameSweep(scope, translator, watched);
      return textInstalled || bitmapTextInstalled || lifecycleInstalled;
    }
  }

  function wrapTextClass(ctor, flagName, scope, translator, adapterName, watched) {
    if (!ctor || !ctor.prototype) return false;
    if (ctor.prototype[flagName] === SETTER_TOKEN) return true;
    const descriptor = findPropertyDescriptor(ctor.prototype, 'text');
    const descriptorBody = descriptor && descriptor.desc ? descriptor.desc : null;
    const originalGetter = descriptorBody && typeof descriptorBody.get === 'function'
      ? descriptorBody.get
      : function getPixiTextFallback() { return this.__rpgTranslatorPixiText; };
    const originalSetter = descriptorBody && typeof descriptorBody.set === 'function'
      ? descriptorBody.set
      : function setPixiTextFallback(value) { this.__rpgTranslatorPixiText = value; };

    Object.defineProperty((descriptor && descriptor.owner) || ctor.prototype, 'text', {
      configurable: true,
      enumerable: descriptorBody ? descriptorBody.enumerable : true,
      get() {
        return originalGetter.call(this);
      },
      set(value) {
        const state = ensureState(this, adapterName);
        if (state.applyingNativeText) {
          originalSetter.call(this, value);
          return;
        }
        const translated = translateText(translator, scope, value, this, adapterName, state, watched);
        state.applyingNativeText = true;
        try {
          if (translated !== String(value ?? '')) applyTranslatedTextScale(this, scope);
          else restoreTextScale(this);
          originalSetter.call(this, translated);
        } finally {
          state.applyingNativeText = false;
        }
      },
    });

    ctor.prototype[flagName] = SETTER_TOKEN;
    installTextDestroyHook(ctor, translator, watched);
    return true;
  }

  function translateText(translator, scope, value, surface, adapterName, state, watched) {
    const text = String(value ?? '');
    retireCurrentItem(translator, surface, state, 'pixi-text-replaced', false);
    state.revision += 1;
    state.originalText = text;
    state.renderedText = text;
    state.visible = isRenderable(surface);
    state.screenState = screenStateFor(surface, state.visible);
    state.priority = priorityFor(surface, state.visible);
    state.itemId = '';
    watched.add(surface);

    if (!text.trim()) {
      restoreTextScale(surface);
      return text;
    }

    const owner = `${adapterName}:${state.objectId}`;
    const slotKey = `pixi:${state.objectId}:text`;
    if (translator && typeof translator.claimSurface === 'function' && !translator.claimSurface(surface, owner)) {
      return text;
    }
    if (translator && typeof translator.claimText === 'function' && !translator.claimText(slotKey, owner)) {
      return text;
    }
    state.owner = owner;
    state.slotKey = slotKey;

    const request = {
      engine: overlay(scope).engine || 'unknown',
      sourceLanguage: overlay(scope).sourceLanguage,
      targetLanguage: overlay(scope).targetLanguage,
      text,
      currentText: text,
      surface,
      adapter: adapterName,
      kind: 'text-setter',
      slotKey,
      generation: state.revision,
      visible: state.visible,
      screenState: state.screenState,
      priority: state.priority,
      metadata: {
        objectId: state.objectId,
        windowType: adapterName,
      },
    };

    const command = translator && typeof translator.observeRecord === 'function'
      ? translator.observeRecord(request)
      : null;
    if (command && command.itemId) state.itemId = command.itemId;

    const translated = command
      ? (command.status === 'hit' ? command.translatedText : null)
      : translator && typeof translator.translateText === 'function'
        ? translator.translateText(request)
        : translator && typeof translator.translate === 'function'
          ? translator.translate(request)
          : null;

    if (command && command.status === 'hit' && translator && typeof translator.acceptRender === 'function') {
      if (!translator.acceptRender(command, surface, text)) {
        retireCurrentItem(translator, surface, state, 'pixi-render-stale', true);
        return text;
      }
    }
    const output = translated || text;
    state.renderedText = String(output);
    exposeState(surface, state);
    return output;
  }

  function installTextDestroyHook(ctor, translator, watched) {
    if (!ctor || !ctor.prototype || typeof ctor.prototype.destroy !== 'function') return false;
    if (ctor.prototype.destroy.__rpgTranslatorPixiLifecycle === LIFECYCLE_TOKEN) return true;
    const original = ctor.prototype.destroy;
    ctor.prototype.destroy = function translatedPixiDestroy(...args) {
      retireTree(translator, this, watched, 'pixi-text-destroyed');
      return original.apply(this, args);
    };
    ctor.prototype.destroy.__rpgTranslatorOriginal = original;
    ctor.prototype.destroy.__rpgTranslatorPixiLifecycle = LIFECYCLE_TOKEN;
    return true;
  }

  function installContainerLifecycle(ctor, translator, watched) {
    if (!ctor || !ctor.prototype) return false;
    let installed = false;
    if (typeof ctor.prototype.removeChild === 'function'
        && ctor.prototype.removeChild.__rpgTranslatorPixiLifecycle !== LIFECYCLE_TOKEN) {
      const original = ctor.prototype.removeChild;
      ctor.prototype.removeChild = function translatedRemoveChild(...children) {
        const result = original.apply(this, children);
        children.forEach((child) => retireTree(translator, child, watched, 'pixi-text-removed'));
        return result;
      };
      ctor.prototype.removeChild.__rpgTranslatorOriginal = original;
      ctor.prototype.removeChild.__rpgTranslatorPixiLifecycle = LIFECYCLE_TOKEN;
      installed = true;
    }
    if (typeof ctor.prototype.removeChildAt === 'function'
        && ctor.prototype.removeChildAt.__rpgTranslatorPixiLifecycle !== LIFECYCLE_TOKEN) {
      const original = ctor.prototype.removeChildAt;
      ctor.prototype.removeChildAt = function translatedRemoveChildAt(index, ...rest) {
        const child = this && Array.isArray(this.children) ? this.children[index] : null;
        const result = original.call(this, index, ...rest);
        retireTree(translator, child || result, watched, 'pixi-text-removed');
        return result;
      };
      ctor.prototype.removeChildAt.__rpgTranslatorOriginal = original;
      ctor.prototype.removeChildAt.__rpgTranslatorPixiLifecycle = LIFECYCLE_TOKEN;
      installed = true;
    }
    if (typeof ctor.prototype.removeChildren === 'function'
        && ctor.prototype.removeChildren.__rpgTranslatorPixiLifecycle !== LIFECYCLE_TOKEN) {
      const original = ctor.prototype.removeChildren;
      ctor.prototype.removeChildren = function translatedRemoveChildren(beginIndex, endIndex, ...rest) {
        const removed = snapshotRemovedChildren(this, beginIndex, endIndex);
        const result = original.call(this, beginIndex, endIndex, ...rest);
        const children = Array.isArray(result) && result.length ? result : removed;
        children.forEach((child) => retireTree(translator, child, watched, 'pixi-text-removed'));
        return result;
      };
      ctor.prototype.removeChildren.__rpgTranslatorOriginal = original;
      ctor.prototype.removeChildren.__rpgTranslatorPixiLifecycle = LIFECYCLE_TOKEN;
      installed = true;
    }
    if (typeof ctor.prototype.destroy === 'function'
        && ctor.prototype.destroy.__rpgTranslatorPixiLifecycle !== LIFECYCLE_TOKEN) {
      const original = ctor.prototype.destroy;
      ctor.prototype.destroy = function translatedContainerDestroy(...args) {
        retireTree(translator, this, watched, 'pixi-container-destroyed');
        return original.apply(this, args);
      };
      ctor.prototype.destroy.__rpgTranslatorOriginal = original;
      ctor.prototype.destroy.__rpgTranslatorPixiLifecycle = LIFECYCLE_TOKEN;
      installed = true;
    }
    return installed;
  }

  function installFrameSweep(scope, translator, watched) {
    installSweepHook(scope && scope.SceneManager, 'updateScene', translator, watched);
    installSweepHook(scope && scope.Graphics, 'render', translator, watched);
  }

  function installSweepHook(target, methodName, translator, watched) {
    if (!target || typeof target[methodName] !== 'function') return false;
    if (target[methodName].__rpgTranslatorPixiLifecycle === LIFECYCLE_TOKEN) return true;
    const original = target[methodName];
    target[methodName] = function translatedPixiSweep(...args) {
      const result = original.apply(this, args);
      sweepVisibility(translator, watched);
      return result;
    };
    target[methodName].__rpgTranslatorOriginal = original;
    target[methodName].__rpgTranslatorPixiLifecycle = LIFECYCLE_TOKEN;
    return true;
  }

  function sweepVisibility(translator, watched) {
    Array.from(watched).forEach((surface) => {
      const state = getState(surface);
      if (!state || !state.itemId) {
        watched.delete(surface);
        return;
      }
      if (surface._destroyed || surface.destroyed) {
        retireCurrentItem(translator, surface, state, 'pixi-text-destroyed', true);
        watched.delete(surface);
        return;
      }
      const visible = isRenderable(surface);
      const priority = priorityFor(surface, visible);
      const screenState = screenStateFor(surface, visible);
      if (state.priority !== priority) {
        state.priority = priority;
        if (translator && typeof translator.setItemTranslationPriority === 'function') {
          translator.setItemTranslationPriority(state.itemId, priority, priorityReason(screenState), {
            screenState,
            windowType: state.label,
          });
        }
      }
      if (state.visible !== visible) {
        state.visible = visible;
        state.screenState = screenState;
        if (translator && typeof translator.setItemVisibility === 'function') {
          translator.setItemVisibility(state.itemId, visible, {
            reason: priorityReason(screenState),
            screenState,
            windowType: state.label,
          });
        }
      } else if (state.screenState !== screenState) {
        state.screenState = screenState;
      }
      exposeState(surface, state);
    });
  }

  function retireTree(translator, surface, watched, reason) {
    if (!surface) return;
    const state = getState(surface);
    retireCurrentItem(translator, surface, state, reason, true);
    watched.delete(surface);
    const children = Array.isArray(surface.children) ? surface.children.slice() : [];
    children.forEach((child) => retireTree(translator, child, watched, reason));
  }

  function retireCurrentItem(translator, surface, state, reason, invalidate) {
    if (!state) return false;
    const itemId = state.itemId;
    if (itemId && translator && typeof translator.archiveItem === 'function') {
      translator.archiveItem(itemId);
    } else if (surface && translator && typeof translator.retireSurface === 'function') {
      translator.retireSurface(surface, reason);
    }
    if (state.slotKey && translator && typeof translator.releaseTextClaim === 'function') {
      translator.releaseTextClaim(state.slotKey, state.owner);
    }
    if (surface && state.owner && translator && typeof translator.releaseSurface === 'function') {
      translator.releaseSurface(surface, state.owner);
    }
    if (invalidate !== false && surface && translator && typeof translator.markSurfaceChanged === 'function') {
      translator.markSurfaceChanged(surface);
    }
    restoreTextScale(surface);
    state.itemId = '';
    state.originalText = '';
    state.renderedText = '';
    state.visible = false;
    state.screenState = 'inactive';
    state.owner = '';
    state.slotKey = '';
    exposeState(surface, state);
    return Boolean(itemId);
  }

  function ensureState(surface, label) {
    if (!surface) return {
      objectId: 'none',
      revision: 0,
      itemId: '',
      applyingNativeText: false,
      originalText: '',
      renderedText: '',
      visible: false,
      screenState: 'inactive',
      priority: null,
      label,
    };
    if (!surface[STATE_KEY]) {
      surface[STATE_KEY] = {
        objectId: String(nextObjectId++),
        revision: 0,
        itemId: '',
        owner: '',
        slotKey: '',
        applyingNativeText: false,
        originalText: '',
        renderedText: '',
        visible: false,
        screenState: 'inactive',
        priority: null,
        label,
      };
    }
    if (label) surface[STATE_KEY].label = label;
    exposeState(surface, surface[STATE_KEY]);
    return surface[STATE_KEY];
  }

  function getState(surface) {
    return surface && surface[STATE_KEY] ? surface[STATE_KEY] : null;
  }

  function exposeState(surface, state) {
    if (!surface || !state) return;
    try {
      surface._rpgTranslatorPixiObjectId = state.objectId;
      surface._rpgTranslatorPixiItemId = state.itemId || null;
      surface._rpgTranslatorPixiVisible = state.visible === true;
      surface._rpgTranslatorPixiRevision = state.revision;
    } catch (_error) {}
  }

  function applyTranslatedTextScale(surface, scope) {
    const percent = resolveTextScale(scope);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100 || !surface) return;
    const target = resolveFontSizeTarget(surface);
    if (!target || !target.owner || !target.key) return;
    if (!surface.__rpgTranslatorPixiTextScaleState) {
      surface.__rpgTranslatorPixiTextScaleState = {
        owner: target.owner,
        key: target.key,
        value: target.owner[target.key],
      };
    }
    const numeric = Number(surface.__rpgTranslatorPixiTextScaleState.value);
    if (Number.isFinite(numeric) && numeric > 0) {
      target.owner[target.key] = Math.max(1, Math.round(numeric * (percent / 100)));
    }
  }

  function restoreTextScale(surface) {
    const state = surface && surface.__rpgTranslatorPixiTextScaleState;
    if (!state) return;
    try {
      if (state.owner && state.key) state.owner[state.key] = state.value;
    } catch (_error) {}
    try {
      delete surface.__rpgTranslatorPixiTextScaleState;
    } catch (_error) {
      surface.__rpgTranslatorPixiTextScaleState = null;
    }
  }

  function resolveTextScale(scope) {
    const settings = overlay(scope).config || overlay(scope).settings || {};
    const candidates = [
      settings.text_scale_others,
      settings.textScaleOthers,
      settings.textScale,
      settings && settings.gameMessage && settings.gameMessage.textScaleOthers,
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) return numeric;
    }
    return 100;
  }

  function resolveFontSizeTarget(surface) {
    if (surface.style && Object.prototype.hasOwnProperty.call(surface.style, 'fontSize')) {
      return { owner: surface.style, key: 'fontSize' };
    }
    if (Object.prototype.hasOwnProperty.call(surface, 'fontSize')) {
      return { owner: surface, key: 'fontSize' };
    }
    return null;
  }

  function isRenderable(surface) {
    if (!surface) return false;
    if (surface._destroyed || surface.destroyed) return false;
    if (surface.visible === false || surface.renderable === false) return false;
    if (!hasPositiveOpacity(surface)) return false;
    if (!surface.parent) return false;
    let child = surface;
    let cursor = surface.parent;
    while (cursor) {
      if (cursor._destroyed || cursor.destroyed || cursor.visible === false || cursor.renderable === false) return false;
      if (!hasPositiveOpacity(cursor)) return false;
      if (Array.isArray(cursor.children) && cursor.children.indexOf(child) < 0) return false;
      child = cursor;
      cursor = cursor.parent;
    }
    return true;
  }

  function hasPositiveOpacity(surface) {
    const alpha = Number(surface && surface.alpha);
    if (Number.isFinite(alpha) && alpha <= 0) return false;
    const opacity = Number(surface && surface.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
    return true;
  }

  function priorityFor(surface, visible) {
    if (!surface || surface._destroyed || surface.destroyed) return PRIORITY_HIDDEN;
    if (!surface.parent) return PRIORITY_DETACHED;
    return visible ? PRIORITY_VISIBLE : PRIORITY_HIDDEN;
  }

  function screenStateFor(surface, visible) {
    if (!surface || surface._destroyed || surface.destroyed) return 'destroyed';
    if (visible) return 'visible';
    if (!surface.parent) return 'detached';
    return 'hidden';
  }

  function priorityReason(screenState) {
    if (screenState === 'visible') return 'pixi-text-visible';
    if (screenState === 'detached') return 'pixi-text-detached';
    return 'pixi-text-hidden';
  }

  function snapshotRemovedChildren(container, beginIndex, endIndex) {
    if (!container || !Array.isArray(container.children)) return [];
    const begin = Number.isInteger(beginIndex) ? beginIndex : 0;
    const end = Number.isInteger(endIndex) ? endIndex : container.children.length;
    return container.children.slice(begin, end);
  }

  function ensureWatchedSet(scope) {
    const overlayScope = overlay(scope);
    if (!overlayScope.__pixiTextWatchedObjects) overlayScope.__pixiTextWatchedObjects = new Set();
    return overlayScope.__pixiTextWatchedObjects;
  }

  function findPropertyDescriptor(prototype, name) {
    let cursor = prototype;
    while (cursor) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) return { owner: cursor, desc: descriptor };
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
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
