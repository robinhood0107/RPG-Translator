(function attach(root) {
  const STATE_KEY = '__rpgTranslatorWindowTextState';
  const INSTALL_TOKEN = 'rpg-translator-window-text-v2';
  const LIFECYCLE_TOKEN = 'rpg-translator-window-lifecycle-v2';
  let nextWindowId = 1;

  class WindowTextAdapter {
    static install(scope, translator) {
      if (!scope || !scope.Window_Base || !scope.Window_Base.prototype) return false;
      const prototype = scope.Window_Base.prototype;
      if (prototype.__rpgTranslatorWindowTextInstalled === INSTALL_TOKEN) return true;
      wrapTextMethod(prototype, 'drawText', scope, translator);
      wrapTextMethod(prototype, 'drawTextEx', scope, translator);
      wrapWindowLifecycle(prototype, translator);
      prototype.__rpgTranslatorWindowTextInstalled = INSTALL_TOKEN;
      return true;
    }
  }

  function wrapTextMethod(prototype, name, scope, translator) {
    const original = prototype[name];
    if (typeof original !== 'function') return;
    prototype[name] = function translatedWindowText(text, ...rest) {
      if (isTranslatedDrawActive(this) || isDedicatedMessageWindow(scope, this)) {
        return original.call(this, text, ...rest);
      }
      const translated = translateText(translator, scope, text, this, name, rest);
      return withTranslatedDraw(this, () => original.call(this, translated, ...rest));
    };
    prototype[name].__rpgTranslatorOriginal = original;
  }

  function translateText(translator, scope, text, surface, methodName, rest) {
    const state = ensureState(surface);
    const sourceText = String(text ?? '');
    const slotKey = createSlotKey(state, methodName, rest);
    const surfaceOwner = `window-text:${state.windowId}`;
    const textOwner = `${surfaceOwner}:${slotKey}`;
    retireReplacedSlot(translator, state, slotKey);
    state.revision += 1;
    wrapContentsMutation(surface, translator);

    if (!sourceText.trim()) {
      clearSlot(translator, state, slotKey, false);
      return text;
    }
    if (translator && typeof translator.claimSurface === 'function' && !translator.claimSurface(surface, surfaceOwner)) {
      return text;
    }
    if (translator && typeof translator.claimText === 'function' && !translator.claimText(slotKey, textOwner)) {
      return text;
    }

    const request = {
      engine: overlay(scope).engine || 'unknown',
      sourceLanguage: overlay(scope).sourceLanguage,
      targetLanguage: overlay(scope).targetLanguage,
      text: sourceText,
      currentText: sourceText,
      surface,
      adapter: 'window-text',
      kind: methodName,
      slotKey,
      generation: state.revision,
      visible: isWindowVisible(surface),
      screenState: isWindowVisible(surface) ? 'visible' : 'hidden',
      metadata: {
        windowId: state.windowId,
        methodName,
        x: rest && rest.length ? rest[0] : undefined,
        y: rest && rest.length > 1 ? rest[1] : undefined,
      },
    };

    const command = translator && typeof translator.observeRecord === 'function'
      ? translator.observeRecord(request)
      : null;
    const itemId = command && command.itemId ? command.itemId : '';
    if (itemId) state.slots.set(slotKey, { itemId, sourceText, revision: state.revision });

    const translated = command
      ? (command.status === 'hit' ? command.translatedText : null)
      : translator && typeof translator.translateText === 'function'
        ? translator.translateText(request)
        : translator && typeof translator.translate === 'function'
          ? translator.translate(request)
          : null;

    if (command && command.status === 'hit' && translator && typeof translator.acceptRender === 'function') {
      if (!translator.acceptRender(command, surface, sourceText)) return text;
    }
    return translated || text;
  }

  function wrapWindowLifecycle(prototype, translator) {
    wrapLifecycleMethod(prototype, 'refresh', translator, 'window-refresh');
    wrapLifecycleMethod(prototype, 'destroy', translator, 'window-destroyed');
    wrapLifecycleMethod(prototype, 'close', translator, 'window-closed');
  }

  function wrapLifecycleMethod(prototype, methodName, translator, reason) {
    const original = prototype[methodName];
    if (typeof original !== 'function') return false;
    if (original.__rpgTranslatorWindowLifecycle === LIFECYCLE_TOKEN) return true;
    prototype[methodName] = function translatedWindowLifecycle(...args) {
      retireWindowSurface(translator, this, reason);
      return original.apply(this, args);
    };
    prototype[methodName].__rpgTranslatorOriginal = original;
    prototype[methodName].__rpgTranslatorWindowLifecycle = LIFECYCLE_TOKEN;
    return true;
  }

  function wrapContentsMutation(windowInstance, translator) {
    const contents = windowInstance && windowInstance.contents;
    if (!contents || contents.__rpgTranslatorWindowOwner === windowInstance) return;
    contents.__rpgTranslatorWindowOwner = windowInstance;
    for (const methodName of ['clear', 'clearRect', 'resize']) {
      const original = contents[methodName];
      if (typeof original !== 'function') continue;
      if (original.__rpgTranslatorWindowLifecycle === LIFECYCLE_TOKEN) continue;
      contents[methodName] = function translatedContentsMutation(...args) {
        retireWindowSurface(translator, windowInstance, `contents-${methodName}`);
        return original.apply(this, args);
      };
      contents[methodName].__rpgTranslatorOriginal = original;
      contents[methodName].__rpgTranslatorWindowLifecycle = LIFECYCLE_TOKEN;
    }
  }

  function retireReplacedSlot(translator, state, slotKey) {
    const existing = state.slots.get(slotKey);
    if (!existing || !existing.itemId) return false;
    if (translator && typeof translator.archiveItem === 'function') translator.archiveItem(existing.itemId);
    state.slots.delete(slotKey);
    return true;
  }

  function clearSlot(translator, state, slotKey, invalidate) {
    retireReplacedSlot(translator, state, slotKey);
    if (invalidate !== false && state.surface && translator && typeof translator.markSurfaceChanged === 'function') {
      translator.markSurfaceChanged(state.surface);
    }
  }

  function retireWindowSurface(translator, windowInstance, reason) {
    const state = getState(windowInstance);
    if (state) {
      for (const entry of state.slots.values()) {
        if (entry && entry.itemId && translator && typeof translator.archiveItem === 'function') {
          translator.archiveItem(entry.itemId);
        }
      }
      state.slots.clear();
    }
    if (windowInstance && translator && typeof translator.retireSurface === 'function') {
      translator.retireSurface(windowInstance, reason);
    }
    if (windowInstance && translator && typeof translator.markSurfaceChanged === 'function') {
      translator.markSurfaceChanged(windowInstance);
    }
  }

  function ensureState(surface) {
    if (!surface[STATE_KEY]) {
      surface[STATE_KEY] = {
        windowId: String(nextWindowId++),
        revision: 0,
        slots: new Map(),
        surface,
      };
    }
    return surface[STATE_KEY];
  }

  function getState(surface) {
    return surface && surface[STATE_KEY] ? surface[STATE_KEY] : null;
  }

  function createSlotKey(state, methodName, rest) {
    const x = rest && rest.length ? rest[0] : '';
    const y = rest && rest.length > 1 ? rest[1] : '';
    const width = rest && rest.length > 2 ? rest[2] : '';
    const align = rest && rest.length > 3 ? rest[3] : '';
    return `window:${state.windowId}:${methodName}:${String(x)}:${String(y)}:${String(width)}:${String(align)}`;
  }

  function withTranslatedDraw(windowInstance, callback) {
    windowInstance.__rpgTranslatorWindowTextDrawDepth = (windowInstance.__rpgTranslatorWindowTextDrawDepth || 0) + 1;
    try {
      return callback();
    } finally {
      windowInstance.__rpgTranslatorWindowTextDrawDepth = Math.max(0, (windowInstance.__rpgTranslatorWindowTextDrawDepth || 1) - 1);
    }
  }

  function isTranslatedDrawActive(windowInstance) {
    return Number(windowInstance && windowInstance.__rpgTranslatorWindowTextDrawDepth) > 0;
  }

  function isDedicatedMessageWindow(scope, windowInstance) {
    if (!windowInstance) return false;
    if (scope && scope.Window_Message && windowInstance instanceof scope.Window_Message) return true;
    const name = windowInstance.constructor && windowInstance.constructor.name;
    return name === 'Window_Message';
  }

  function isWindowVisible(windowInstance) {
    if (!windowInstance) return false;
    if (windowInstance.visible === false) return false;
    const openness = Number(windowInstance.openness);
    if (Number.isFinite(openness) && openness <= 0) return false;
    const opacity = Number(windowInstance.contentsOpacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
    return true;
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
