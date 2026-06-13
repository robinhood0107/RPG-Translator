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
      wrapPendingFlushMethod(prototype, 'open', translator);
      wrapPendingFlushMethod(prototype, 'update', translator);
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
      recordWindowOverflow(translator, this, name, translated, rest);
      return withTranslatedDraw(this, () => withFittedWindowText(this, name, translated, rest, () => original.call(this, translated, ...rest)));
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
        owner: surfaceOwner,
        sceneName: currentSceneName(scope),
        mapId: currentMapId(scope),
        x: rest && rest.length ? rest[0] : undefined,
        y: rest && rest.length > 1 ? rest[1] : undefined,
        width: rest && rest.length > 2 ? rest[2] : undefined,
        height: rest && rest.length > 3 ? rest[3] : undefined,
        maxWidth: rest && rest.length > 2 ? rest[2] : undefined,
        lineHeight: rest && rest.length > 3 ? rest[3] : undefined,
      },
    };

    const command = translator && typeof translator.observeRecord === 'function'
      ? translator.observeRecord(request)
      : null;
    const itemId = command && command.itemId ? command.itemId : '';
    if (itemId) state.slots.set(slotKey, { itemId, sourceText, revision: state.revision, textOwner });

    const translated = command
      ? (command.status === 'hit' ? command.translatedText : null)
      : translator && typeof translator.translateText === 'function'
        ? translator.translateText(request)
        : translator && typeof translator.translate === 'function'
          ? translator.translate(request)
          : null;

    if (command && command.status === 'hit' && translator && typeof translator.acceptRender === 'function') {
      if (!isWindowVisible(surface)) {
        queuePendingDraw(state, slotKey, {
          command,
          sourceText,
          translatedText: command.translatedText,
          methodName,
          args: Array.isArray(rest) ? rest.slice() : [],
          itemId,
        });
        return text;
      }
      dropPendingDraw(state, slotKey);
      if (!translator.acceptRender(command, surface, sourceText)) return text;
    }
    return translated || text;
  }

  function wrapWindowLifecycle(prototype, translator) {
    wrapLifecycleMethod(prototype, 'refresh', translator, 'window-refresh');
    wrapLifecycleMethod(prototype, 'createContents', translator, 'window-contents-recreated');
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

  function wrapPendingFlushMethod(prototype, methodName, translator) {
    const original = prototype[methodName];
    if (typeof original !== 'function') return false;
    if (original.__rpgTranslatorWindowPendingFlush === LIFECYCLE_TOKEN) return true;
    prototype[methodName] = function translatedWindowPendingFlush(...args) {
      const result = original.apply(this, args);
      flushPendingDraws(this, translator);
      return result;
    };
    prototype[methodName].__rpgTranslatorOriginal = original;
    prototype[methodName].__rpgTranslatorWindowPendingFlush = LIFECYCLE_TOKEN;
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
        if (!isTranslatedDrawActive(windowInstance)) retireWindowSurface(translator, windowInstance, `contents-${methodName}`);
        return original.apply(this, args);
      };
      contents[methodName].__rpgTranslatorOriginal = original;
      contents[methodName].__rpgTranslatorWindowLifecycle = LIFECYCLE_TOKEN;
    }
  }

  function retireReplacedSlot(translator, state, slotKey) {
    const existing = state.slots.get(slotKey);
    dropPendingDraw(state, slotKey);
    if (!existing || !existing.itemId) return false;
    if (translator && typeof translator.archiveItem === 'function') translator.archiveItem(existing.itemId);
    if (translator && typeof translator.releaseTextClaim === 'function') {
      translator.releaseTextClaim(slotKey, existing.textOwner);
    }
    state.slots.delete(slotKey);
    return true;
  }

  function clearSlot(translator, state, slotKey, invalidate) {
    retireReplacedSlot(translator, state, slotKey);
    dropPendingDraw(state, slotKey);
    if (invalidate !== false && state.surface && translator && typeof translator.markSurfaceChanged === 'function') {
      translator.markSurfaceChanged(state.surface);
    }
  }

  function retireWindowSurface(translator, windowInstance, reason) {
    const state = getState(windowInstance);
    if (state) {
      for (const [slotKey, entry] of state.slots.entries()) {
        if (entry && entry.itemId && translator && typeof translator.archiveItem === 'function') {
          translator.archiveItem(entry.itemId);
        }
        if (entry && translator && typeof translator.releaseTextClaim === 'function') {
          translator.releaseTextClaim(slotKey, entry.textOwner);
        }
      }
      state.slots.clear();
      if (state.pendingDraws) state.pendingDraws.clear();
    }
    if (state && translator && typeof translator.releaseSurface === 'function') {
      translator.releaseSurface(windowInstance, `window-text:${state.windowId}`);
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
        pendingDraws: new Map(),
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

  function queuePendingDraw(state, slotKey, entry) {
    if (!state || !slotKey || !entry) return false;
    if (!state.pendingDraws) state.pendingDraws = new Map();
    state.pendingDraws.set(slotKey, entry);
    return true;
  }

  function dropPendingDraw(state, slotKey) {
    if (!state || !state.pendingDraws || !slotKey) return false;
    return state.pendingDraws.delete(slotKey);
  }

  function flushPendingDraws(windowInstance, translator) {
    const state = getState(windowInstance);
    if (!state || !state.pendingDraws || !state.pendingDraws.size || !isWindowVisible(windowInstance)) return false;
    const pending = Array.from(state.pendingDraws.entries());
    let flushed = false;
    pending.forEach(([slotKey, entry]) => {
      if (!entry || !entry.command || !entry.methodName) {
        state.pendingDraws.delete(slotKey);
        return;
      }
      const current = state.slots.get(slotKey);
      if (!current || current.itemId !== entry.itemId) {
        state.pendingDraws.delete(slotKey);
        return;
      }
      if (translator && typeof translator.acceptRender === 'function') {
        if (!translator.acceptRender(entry.command, windowInstance, entry.sourceText)) {
          state.pendingDraws.delete(slotKey);
          return;
        }
      }
      const draw = windowInstance && windowInstance[entry.methodName];
      if (typeof draw !== 'function') {
        state.pendingDraws.delete(slotKey);
        return;
      }
      state.pendingDraws.delete(slotKey);
      recordWindowOverflow(translator, windowInstance, entry.methodName, entry.translatedText, entry.args || []);
      withTranslatedDraw(windowInstance, () => {
        clearWindowTextRegion(windowInstance, entry.methodName, entry.args || []);
        return withFittedWindowText(
          windowInstance,
          entry.methodName,
          entry.translatedText,
          entry.args || [],
          () => draw.call(windowInstance, entry.translatedText, ...(entry.args || [])),
        );
      });
      flushed = true;
    });
    return flushed;
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

  function recordWindowOverflow(translator, windowInstance, methodName, text, args) {
    if (!translator || typeof translator.recordSurfaceDraw !== 'function') return false;
    const fit = calculateWindowTextFit(windowInstance, methodName, text, args);
    if (!fit || !fit.overflow) return false;
    translator.recordSurfaceDraw({
      target: windowInstance,
      adapterId: 'window-text',
      methodName,
      text: String(text ?? ''),
      x: numberAt(args, 0, 0),
      y: numberAt(args, 1, 0),
      maxWidth: fit.maxWidth,
      lineHeight: resolveLineHeight(windowInstance, args),
      measuredWidth: fit.measuredWidth,
      ownerType: 'window',
      candidateAdapters: [],
    });
    return true;
  }

  function withFittedWindowText(windowInstance, methodName, text, args, callback) {
    const fit = calculateWindowTextFit(windowInstance, methodName, text, args);
    const contents = windowInstance && windowInstance.contents;
    if (!fit || !fit.overflow || !contents || !Number.isFinite(fit.originalFontSize)) {
      return callback();
    }
    const nextFontSize = Math.max(8, Math.floor(fit.originalFontSize * fit.scale));
    if (!Number.isFinite(nextFontSize) || nextFontSize >= fit.originalFontSize) return callback();
    const previousFontSize = contents.fontSize;
    contents.fontSize = nextFontSize;
    try {
      return callback();
    } finally {
      contents.fontSize = previousFontSize;
    }
  }

  function clearWindowTextRegion(windowInstance, methodName, args) {
    if (methodName !== 'drawText') return false;
    const contents = windowInstance && windowInstance.contents;
    const clear = contents && typeof contents.clearRect === 'function' ? contents.clearRect : null;
    const width = numberAt(args, 2, 0);
    if (typeof clear !== 'function' || width <= 0) return false;
    clear.call(contents, numberAt(args, 0, 0), numberAt(args, 1, 0), width, resolveLineHeight(windowInstance, args));
    return true;
  }

  function calculateWindowTextFit(windowInstance, methodName, text, args) {
    const contents = windowInstance && windowInstance.contents;
    const maxWidth = resolveWindowTextWidth(windowInstance, methodName, args);
    const originalFontSize = Number(contents && contents.fontSize);
    if (!contents || !Number.isFinite(maxWidth) || maxWidth <= 0 || !Number.isFinite(originalFontSize) || originalFontSize <= 0) {
      return null;
    }
    const measuredWidth = measureWindowTextWidth(windowInstance, contents, text);
    if (!Number.isFinite(measuredWidth) || measuredWidth <= maxWidth) {
      return { overflow: false, maxWidth, measuredWidth, originalFontSize, scale: 1 };
    }
    const scale = Math.max(0.35, Math.min(1, maxWidth / measuredWidth));
    return { overflow: true, maxWidth, measuredWidth, originalFontSize, scale };
  }

  function resolveWindowTextWidth(windowInstance, methodName, args) {
    if (methodName === 'drawText') return numberAt(args, 2, 0);
    if (methodName === 'drawTextEx') {
      const contents = windowInstance && windowInstance.contents;
      const x = numberAt(args, 0, 0);
      const width = Number(contents && contents.width);
      if (Number.isFinite(width) && width > x) return width - x;
      const innerWidth = Number(windowInstance && windowInstance.innerWidth);
      if (Number.isFinite(innerWidth) && innerWidth > x) return innerWidth - x;
    }
    return 0;
  }

  function resolveLineHeight(windowInstance, args) {
    const explicit = numberAt(args, 3, 0);
    if (explicit > 0) return explicit;
    if (windowInstance && typeof windowInstance.lineHeight === 'function') {
      const value = Number(windowInstance.lineHeight());
      if (Number.isFinite(value) && value > 0) return value;
    }
    const contents = windowInstance && windowInstance.contents;
    const fontSize = Number(contents && contents.fontSize);
    return Number.isFinite(fontSize) && fontSize > 0 ? Math.ceil(fontSize * 1.2) : 24;
  }

  function measureWindowTextWidth(windowInstance, contents, text) {
    const value = String(text ?? '');
    const candidates = [
      () => (windowInstance && typeof windowInstance.textWidth === 'function' ? windowInstance.textWidth(value) : 0),
      () => (contents && typeof contents.measureTextWidth === 'function' ? contents.measureTextWidth(value) : 0),
      () => (contents && typeof contents.textWidth === 'function' ? contents.textWidth(value) : 0),
    ];
    for (const measure of candidates) {
      try {
        const width = Number(measure());
        if (Number.isFinite(width) && width > 0) return Math.ceil(width);
      } catch (_error) {
        // Fall through to the next measurement strategy.
      }
    }
    const fontSize = Number(contents && contents.fontSize);
    return Math.ceil(value.length * Math.max(6, (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 20) * 0.6));
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

  function currentSceneName(scope) {
    const scene = scope && scope.SceneManager && scope.SceneManager._scene;
    return scene && scene.constructor && scene.constructor.name ? scene.constructor.name : '';
  }

  function currentMapId(scope) {
    const gameMap = scope && scope.$gameMap;
    if (gameMap && typeof gameMap.mapId === 'function') {
      const value = Number(gameMap.mapId());
      return Number.isFinite(value) ? value : undefined;
    }
    return undefined;
  }

  function numberAt(values, index, fallback) {
    const value = Number(values && values.length > index ? values[index] : fallback);
    return Number.isFinite(value) ? value : fallback;
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
