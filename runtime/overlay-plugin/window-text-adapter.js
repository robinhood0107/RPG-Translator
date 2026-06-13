(function attach(root) {
  const { ReplayState } = loadDependency(root, './replay-state');
  const STATE_KEY = '__rpgTranslatorWindowTextState';
  const INSTALL_TOKEN = 'rpg-translator-window-text-v2';
  const LIFECYCLE_TOKEN = 'rpg-translator-window-lifecycle-v2';
  const CTOR_TOKEN = 'rpg-translator-window-constructor-v2';
  const CONTENTS_REPLAY_TOKEN = 'rpg-translator-window-contents-replay-v2';
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
      wrapWindowConstructor(scope, translator);
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
      return observeWindowTextDraw(scope, translator, this, original, name, text, rest);
    };
    prototype[name].__rpgTranslatorOriginal = original;
  }

  function observeWindowTextDraw(scope, translator, surface, original, methodName, text, rest) {
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
      return original.call(surface, text, ...rest);
    }
    if (translator && typeof translator.claimSurface === 'function' && !translator.claimSurface(surface, surfaceOwner)) {
      return original.call(surface, text, ...rest);
    }
    if (translator && typeof translator.claimText === 'function' && !translator.claimText(slotKey, textOwner)) {
      return original.call(surface, text, ...rest);
    }
    const drawOrder = ReplayState.nextDrawOrder(state);
    const bounds = textBounds(surface, methodName, rest, sourceText);

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
        drawOrder,
      },
    };

    const command = translator && typeof translator.observeRecord === 'function'
      ? translator.observeRecord(request)
      : null;
    const itemId = command && command.itemId ? command.itemId : '';
    const entry = {
      command,
      itemId,
      slotKey,
      sourceText,
      methodName,
      args: Array.isArray(rest) ? rest.slice() : [],
      revision: state.revision,
      textOwner,
      drawOrder,
      bounds,
      status: 'observed',
    };
    if (itemId) state.slots.set(slotKey, entry);

    const nativeResult = original.call(surface, text, ...rest);

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
          drawOrder,
          bounds,
        });
        return nativeResult;
      }
      dropPendingDraw(state, slotKey);
      if (!translator.acceptRender(command, surface, sourceText)) return nativeResult;
    }
    if (translated) {
      renderWindowEntry(translator, surface, state, Object.assign(entry, { translatedText: translated }));
    }
    return nativeResult;
  }

  function wrapWindowConstructor(scope, translator) {
    const OriginalCtor = scope && scope.Window_Base;
    if (typeof OriginalCtor !== 'function' || OriginalCtor.__rpgTranslatorWindowConstructor === CTOR_TOKEN) return false;
    function WrappedWindowBase(...args) {
      let instance = null;
      try {
        instance = Reflect.construct(OriginalCtor, args, new.target || WrappedWindowBase);
      } catch (_error) {
        const result = OriginalCtor.apply(this, args);
        instance = result && (typeof result === 'object' || typeof result === 'function') ? result : this;
      }
      registerWindowInstance(instance, translator);
      return instance;
    }
    WrappedWindowBase.prototype = OriginalCtor.prototype;
    Object.setPrototypeOf(WrappedWindowBase, OriginalCtor);
    for (const key of Object.keys(OriginalCtor)) {
      try {
        WrappedWindowBase[key] = OriginalCtor[key];
      } catch (_error) {
        // Static copy is best-effort for host engine constructors.
      }
    }
    WrappedWindowBase.__rpgTranslatorWindowConstructor = CTOR_TOKEN;
    WrappedWindowBase.__rpgTranslatorOriginal = OriginalCtor;
    scope.Window_Base = WrappedWindowBase;
    return true;
  }

  function registerWindowInstance(windowInstance, translator) {
    if (!windowInstance) return false;
    ensureState(windowInstance);
    wrapContentsMutation(windowInstance, translator);
    return true;
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
    for (const methodName of ['fillRect', 'gradientFillRect', 'strokeRect', 'drawCircle', 'blt', 'bltImage']) {
      const original = contents[methodName];
      if (typeof original !== 'function') continue;
      if (original.__rpgTranslatorWindowReplay === CONTENTS_REPLAY_TOKEN) continue;
      contents[methodName] = function translatedContentsRenderOp(...args) {
        const result = original.apply(this, args);
        if (!isTranslatedDrawActive(windowInstance)) {
          recordWindowRenderOp(windowInstance, methodName, args, original);
        }
        return result;
      };
      contents[methodName].__rpgTranslatorOriginal = original;
      contents[methodName].__rpgTranslatorWindowReplay = CONTENTS_REPLAY_TOKEN;
    }
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
        drawOrderCounter: 0,
        slots: new Map(),
        pendingDraws: new Map(),
        renderOps: [],
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
      renderWindowEntry(translator, windowInstance, state, entry);
      flushed = true;
    });
    return flushed;
  }

  function renderWindowEntry(translator, windowInstance, state, entry) {
    if (!entry || !entry.translatedText) return false;
    const translatedBounds = textBounds(windowInstance, entry.methodName, entry.args || [], entry.translatedText);
    const originalBounds = entry.bounds || textBounds(windowInstance, entry.methodName, entry.args || [], entry.sourceText);
    const dirtyRect = ReplayState.unionRect(originalBounds, translatedBounds);
    const replayBefore = ReplayState.sortedOverlappingOps(state && state.renderOps, dirtyRect, entry.drawOrder);
    recordWindowOverflow(translator, windowInstance, entry.methodName, entry.translatedText, entry.args || []);
    withTranslatedDraw(windowInstance, () => {
      const cleared = clearWindowTextRegion(windowInstance, entry.methodName, entry.args || [], dirtyRect);
      const contents = windowInstance && windowInstance.contents;
      const replayed = contents ? ReplayState.replayOps(contents, replayBefore, '__rpgTranslatorWindowReplayDepth') : 0;
      recordReplayTrace(translator, 'background.restore', entry, dirtyRect, originalBounds, translatedBounds, replayed, cleared);
      const draw = windowInstance && windowInstance[entry.methodName];
      const original = draw && draw.__rpgTranslatorOriginal;
      if (typeof original !== 'function') return false;
      const result = withFittedWindowText(
        windowInstance,
        entry.methodName,
        entry.translatedText,
        entry.args || [],
        () => original.call(windowInstance, entry.translatedText, ...(entry.args || [])),
      );
      recordReplayTrace(translator, 'render.accepted', entry, dirtyRect, originalBounds, translatedBounds, replayed, cleared);
      return result;
    });
    entry.status = 'rendered';
    return true;
  }

  function recordReplayTrace(translator, stage, entry, dirtyRect, originalBounds, translatedBounds, replayed, cleared) {
    if (!translator || typeof translator.recordDrawTrace !== 'function') return null;
    return translator.recordDrawTrace(stage, {
      adapter: 'window-text',
      methodName: entry.methodName,
      rawText: entry.sourceText,
      visibleText: entry.translatedText,
      slotKey: entry.slotKey,
      itemId: entry.itemId,
      textOwner: entry.textOwner,
      drawOrder: entry.drawOrder,
      dirtyRect,
      originalBounds,
      translatedBounds,
      replayBeforeCount: replayed,
      replayAfterCount: 0,
      clearMode: replayed > 0 ? 'replay' : cleared ? 'clear' : 'draw',
      snapshotStatus: replayed > 0 ? 'render-op-replay' : 'clear-only',
      force: true,
    });
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

  function clearWindowTextRegion(windowInstance, methodName, args, boundsOverride) {
    if (methodName !== 'drawText') return false;
    const contents = windowInstance && windowInstance.contents;
    const clear = contents && typeof contents.clearRect === 'function' ? contents.clearRect : null;
    const bounds = ReplayState.normalizeRect(boundsOverride);
    const width = bounds ? bounds.width : numberAt(args, 2, 0);
    if (typeof clear !== 'function' || width <= 0) return false;
    clear.call(
      contents,
      bounds ? bounds.x : numberAt(args, 0, 0),
      bounds ? bounds.y : numberAt(args, 1, 0),
      width,
      bounds ? bounds.height : resolveLineHeight(windowInstance, args),
    );
    return true;
  }

  function recordWindowRenderOp(windowInstance, methodName, args, original) {
    const state = getState(windowInstance) || ensureState(windowInstance);
    if (!state.renderOps) state.renderOps = [];
    const bounds = renderOpBounds(windowInstance && windowInstance.contents, methodName, args);
    if (!ReplayState.normalizeRect(bounds)) return false;
    state.renderOps.push({
      methodName,
      args: Array.isArray(args) ? args.slice() : [],
      original,
      bounds,
      drawOrder: ReplayState.nextDrawOrder(state),
    });
    if (state.renderOps.length > 256) state.renderOps.splice(0, state.renderOps.length - 256);
    return true;
  }

  function renderOpBounds(contents, methodName, args) {
    if (methodName === 'fillRect' || methodName === 'gradientFillRect' || methodName === 'strokeRect') {
      return { x: numberAt(args, 0, 0), y: numberAt(args, 1, 0), width: numberAt(args, 2, 0), height: numberAt(args, 3, 0) };
    }
    if (methodName === 'drawCircle') {
      const x = numberAt(args, 0, 0);
      const y = numberAt(args, 1, 0);
      const radius = numberAt(args, 2, 0);
      return { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
    }
    if (methodName === 'blt' || methodName === 'bltImage') {
      return { x: numberAt(args, 5, 0), y: numberAt(args, 6, 0), width: numberAt(args, 7, numberAt(args, 3, 0)), height: numberAt(args, 8, numberAt(args, 4, 0)) };
    }
    return contents ? { x: 0, y: 0, width: Number(contents.width) || 0, height: Number(contents.height) || 0 } : null;
  }

  function textBounds(windowInstance, methodName, args, text) {
    const x = numberAt(args, 0, 0);
    const y = numberAt(args, 1, 0);
    const width = Math.max(1, resolveWindowTextWidth(windowInstance, methodName, args) || measureWindowTextWidth(windowInstance, windowInstance && windowInstance.contents, text));
    const height = Math.max(1, resolveLineHeight(windowInstance, args));
    return { x, y, width, height };
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

function loadDependency(root, path) {
  const overlay = root.RPGTranslatorOverlay || {};
  if (path === './replay-state' && overlay.ReplayState) return { ReplayState: overlay.ReplayState };
  if (typeof require === 'function') return require(path);
  return {};
}
