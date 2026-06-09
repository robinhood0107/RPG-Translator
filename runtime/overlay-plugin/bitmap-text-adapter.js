(function attach(root) {
  const STATE_KEY = '__rpgTranslatorBitmapTextState';
  const INSTALL_TOKEN = 'rpg-translator-bitmap-text-v2';
  const MUTATION_TOKEN = 'rpg-translator-bitmap-mutation-v2';
  const FRAME_TOKEN = 'rpg-translator-bitmap-frame-v2';
  let nextBitmapId = 1;

  class BitmapTextAdapter {
    static install(scope, translator) {
      if (!scope || !scope.Bitmap || !scope.Bitmap.prototype) return false;
      const prototype = scope.Bitmap.prototype;
      if (prototype.__rpgTranslatorBitmapTextInstalled === INSTALL_TOKEN) return true;
      const originalDrawText = prototype.drawText;
      if (typeof originalDrawText !== 'function') return false;
      overlay(scope).__bitmapTextTranslator = translator;
      prototype.drawText = function translatedBitmapText(text, ...rest) {
        if (this.__rpgTranslatorBitmapReplayDepth > 0 || !translator || typeof translator.observeRecord !== 'function') {
          return originalDrawText.call(this, translateText(translator, scope, text, this), ...rest);
        }
        const fragment = createFragment(scope, this, text, rest);
        const surfaceDraw = routeSurfaceDraw(translator, this, fragment, originalDrawText);
        if (surfaceDraw.handled) return surfaceDraw.result;
        const state = ensureState(this);
        state.fragments.push(fragment);
        if (state.fragments.length > 240) state.fragments.splice(0, state.fragments.length - 240);
        scheduleFlush(scope, this);
        return originalDrawText.call(this, text, ...rest);
      };
      prototype.drawText.__rpgTranslatorOriginal = originalDrawText;
      prototype.__rpgTranslatorBitmapTextInstalled = INSTALL_TOKEN;
      installMutationHooks(prototype, translator);
      installFrameHooks(scope);
      return true;
    }
  }

  function createFragment(scope, bitmap, text, rest) {
    const x = numberAt(rest, 0, 0);
    const y = numberAt(rest, 1, 0);
    const maxWidth = numberAt(rest, 2, estimateTextWidth(bitmap, text));
    const lineHeight = numberAt(rest, 3, Number(bitmap && bitmap.fontSize) || 24);
    const align = rest && rest.length > 4 ? String(rest[4] || 'left') : 'left';
    return {
      text: String(text ?? ''),
      x,
      y,
      maxWidth,
      lineHeight,
      align,
      width: Math.max(1, estimateTextWidth(bitmap, text)),
      font: fontSignature(bitmap),
    };
  }

  function routeSurfaceDraw(translator, bitmap, fragment, originalDrawText) {
    if (!translator || typeof translator.recordSurfaceDraw !== 'function') return { handled: false, result: undefined };
    const outcome = translator.recordSurfaceDraw({
      target: bitmap,
      adapterId: 'bitmap-text',
      methodName: 'drawText',
      text: fragment.text,
      x: fragment.x,
      y: fragment.y,
      maxWidth: fragment.maxWidth,
      lineHeight: fragment.lineHeight,
      align: fragment.align,
      measuredWidth: fragment.width,
      drawState: {
        font: fragment.font,
      },
      candidateAdapters: ['sprite-text'],
    });
    const decision = outcome && outcome.drawDecision ? outcome.drawDecision : null;
    if (!decision || !decision.action) return { handled: false, result: undefined };
    if (decision.action === 'suppress-native-draw') return { handled: true, result: undefined };
    if (decision.action === 'draw-original') {
      return {
        handled: true,
        result: originalDrawText.call(bitmap, fragment.text, fragment.x, fragment.y, fragment.maxWidth, fragment.lineHeight, fragment.align),
      };
    }
    if (decision.action === 'replace-native-draw') {
      return {
        handled: true,
        result: originalDrawText.call(
          bitmap,
          decision.text,
          finiteOr(decision.x, fragment.x),
          finiteOr(decision.y, fragment.y),
          finiteOr(decision.maxWidth, fragment.maxWidth),
          finiteOr(decision.lineHeight, fragment.lineHeight),
          decision.align || fragment.align,
        ),
      };
    }
    return { handled: false, result: undefined };
  }

  function scheduleFlush(scope, bitmap) {
    const state = ensureState(bitmap);
    state.flushQueued = true;
    const overlayScope = overlay(scope);
    if (!overlayScope.__bitmapTextFlushQueue) overlayScope.__bitmapTextFlushQueue = new Set();
    overlayScope.__bitmapTextFlushQueue.add(bitmap);
    if (!overlayScope.__bitmapTextFrameHooksInstalled) installFrameHooks(scope);
  }

  function flushQueuedBitmaps(scope, reason) {
    const overlayScope = overlay(scope);
    const queue = overlayScope.__bitmapTextFlushQueue;
    if (!queue || !queue.size) return;
    const bitmaps = Array.from(queue);
    queue.clear();
    bitmaps.forEach((bitmap) => flushBitmap(scope, bitmap, reason || 'frame'));
  }

  function flushBitmap(scope, bitmap, reason) {
    const state = getState(bitmap);
    if (!state || !state.fragments.length) return;
    const fragments = state.fragments.splice(0, state.fragments.length);
    state.flushQueued = false;
    const groups = groupFragments(fragments);
    groups.forEach((group) => renderGroup(scope, bitmap, state, group, reason));
  }

  function groupFragments(fragments) {
    const lines = new Map();
    fragments.forEach((fragment) => {
      if (!fragment || !String(fragment.text || '').trim()) return;
      const key = `${Math.round(fragment.y)}:${Math.round(fragment.lineHeight)}:${fragment.font}:${fragment.align}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(fragment);
    });
    const groups = [];
    lines.forEach((line) => {
      line.sort((a, b) => a.x - b.x);
      let current = [];
      let previous = null;
      line.forEach((fragment) => {
        if (!previous || canMerge(previous, fragment)) current.push(fragment);
        else {
          groups.push(current);
          current = [fragment];
        }
        previous = fragment;
      });
      if (current.length) groups.push(current);
    });
    return groups;
  }

  function renderGroup(scope, bitmap, state, group, reason) {
    if (!group.length) return false;
    const text = group.map((fragment) => fragment.text).join('');
    const bounds = groupBounds(group);
    const slotKey = `bitmap:${state.id}:${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${group[0].font}`;
    const surfaceOwner = `bitmap-text:${state.id}`;
    const textOwner = `${surfaceOwner}:${slotKey}`;
    const translator = overlay(scope).__bitmapTextTranslator;
    if (!translator || typeof translator.observeRecord !== 'function') return false;
    if (typeof translator.claimSurface === 'function' && !translator.claimSurface(bitmap, surfaceOwner)) return false;
    if (typeof translator.claimText === 'function' && !translator.claimText(slotKey, textOwner)) return false;

    const command = translator.observeRecord({
      engine: overlay(scope).engine || 'unknown',
      sourceLanguage: overlay(scope).sourceLanguage,
      targetLanguage: overlay(scope).targetLanguage,
      text,
      currentText: text,
      surface: bitmap,
      adapter: 'bitmap-text',
      kind: 'drawText',
      slotKey,
      generation: state.revision,
      metadata: {
        reason,
        fragments: group.length,
      },
    });
    if (command && command.itemId) state.entries.set(slotKey, {
      itemId: command.itemId,
      bounds,
      text,
      revision: state.revision,
      textOwner,
    });
    if (!command || command.status !== 'hit') return false;
    if (typeof translator.acceptRender === 'function' && !translator.acceptRender(command, bitmap, text)) return false;
    replayDrawText(bitmap, command.translatedText, bounds.x, bounds.y, Math.max(bounds.width, group[0].maxWidth || 1), group[0].lineHeight, group[0].align);
    return true;
  }

  function replayDrawText(bitmap, text, x, y, width, lineHeight, align) {
    const original = bitmap && bitmap.constructor && bitmap.constructor.prototype
      ? bitmap.constructor.prototype.drawText.__rpgTranslatorOriginal
      : null;
    if (typeof original !== 'function') return false;
    bitmap.__rpgTranslatorBitmapReplayDepth = (bitmap.__rpgTranslatorBitmapReplayDepth || 0) + 1;
    try {
      original.call(bitmap, text, x, y, width, lineHeight, align);
      return true;
    } finally {
      bitmap.__rpgTranslatorBitmapReplayDepth = Math.max(0, (bitmap.__rpgTranslatorBitmapReplayDepth || 1) - 1);
    }
  }

  function installMutationHooks(prototype, translator) {
    for (const methodName of ['clear', 'clearRect', 'resize', 'fillRect', 'fillAll', 'blt', 'destroy']) {
      const original = prototype[methodName];
      if (typeof original !== 'function') continue;
      if (original.__rpgTranslatorBitmapMutation === MUTATION_TOKEN) continue;
      prototype[methodName] = function translatedBitmapMutation(...args) {
        const result = original.apply(this, args);
        retireBitmapSurface(translator, this, methodName, args);
        return result;
      };
      prototype[methodName].__rpgTranslatorOriginal = original;
      prototype[methodName].__rpgTranslatorBitmapMutation = MUTATION_TOKEN;
    }
  }

  function retireBitmapSurface(translator, bitmap, methodName, args) {
    const state = getState(bitmap);
    if (state) {
      const rect = mutationRect(methodName, args, bitmap);
      for (const [slotKey, entry] of Array.from(state.entries.entries())) {
        if (!rect || rectsOverlap(rect, entry.bounds)) {
          if (entry.itemId && translator && typeof translator.archiveItem === 'function') translator.archiveItem(entry.itemId);
          if (translator && typeof translator.releaseTextClaim === 'function') {
            translator.releaseTextClaim(slotKey, entry.textOwner);
          }
          state.entries.delete(slotKey);
        }
      }
      state.fragments = rect
        ? state.fragments.filter((fragment) => !rectsOverlap(rect, fragmentRect(fragment)))
        : [];
      state.revision += 1;
      if (state.entries.size === 0 && translator && typeof translator.releaseSurface === 'function') {
        translator.releaseSurface(bitmap, `bitmap-text:${state.id}`);
      }
    }
    if (bitmap && translator && typeof translator.markSurfaceChanged === 'function') translator.markSurfaceChanged(bitmap);
  }

  function installFrameHooks(scope) {
    const overlayScope = overlay(scope);
    if (overlayScope.__bitmapTextFrameHooksInstalled) return true;
    const installed = installFrameHook(scope && scope.SceneManager, 'updateScene', scope)
      || installFrameHook(scope && scope.Graphics, 'render', scope);
    overlayScope.__bitmapTextFrameHooksInstalled = installed;
    return installed;
  }

  function installFrameHook(target, methodName, scope) {
    if (!target || typeof target[methodName] !== 'function') return false;
    if (target[methodName].__rpgTranslatorBitmapFrame === FRAME_TOKEN) return true;
    const original = target[methodName];
    target[methodName] = function translatedBitmapFrame(...args) {
      const result = original.apply(this, args);
      flushQueuedBitmaps(scope, methodName);
      return result;
    };
    target[methodName].__rpgTranslatorOriginal = original;
    target[methodName].__rpgTranslatorBitmapFrame = FRAME_TOKEN;
    return true;
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

  function ensureState(bitmap) {
    if (!bitmap[STATE_KEY]) {
      bitmap[STATE_KEY] = {
        id: String(nextBitmapId++),
        bitmap,
        revision: 0,
        fragments: [],
        entries: new Map(),
        flushQueued: false,
      };
    }
    return bitmap[STATE_KEY];
  }

  function getState(bitmap) {
    return bitmap && bitmap[STATE_KEY] ? bitmap[STATE_KEY] : null;
  }

  function canMerge(left, right) {
    if (!left || !right) return false;
    if (left.font !== right.font || left.align !== right.align) return false;
    const lineHeight = Math.max(1, left.lineHeight || right.lineHeight || 24);
    const gapLimit = Math.max(6, Math.ceil(lineHeight * 0.65));
    return right.x - (left.x + left.width) <= gapLimit;
  }

  function groupBounds(group) {
    const x1 = Math.min(...group.map((fragment) => fragment.x));
    const y1 = Math.min(...group.map((fragment) => fragment.y));
    const x2 = Math.max(...group.map((fragment) => fragment.x + Math.max(1, fragment.width)));
    const y2 = Math.max(...group.map((fragment) => fragment.y + Math.max(1, fragment.lineHeight)));
    return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
  }

  function fragmentRect(fragment) {
    return {
      x: fragment.x,
      y: fragment.y,
      width: Math.max(1, fragment.width),
      height: Math.max(1, fragment.lineHeight),
    };
  }

  function mutationRect(methodName, args, bitmap) {
    if (methodName === 'clearRect' || methodName === 'fillRect') {
      return { x: numberAt(args, 0, 0), y: numberAt(args, 1, 0), width: numberAt(args, 2, 0), height: numberAt(args, 3, 0) };
    }
    if (methodName === 'blt') {
      return { x: numberAt(args, 5, 0), y: numberAt(args, 6, 0), width: numberAt(args, 7, numberAt(args, 3, 0)), height: numberAt(args, 8, numberAt(args, 4, 0)) };
    }
    if (methodName === 'resize') {
      return null;
    }
    if (methodName === 'destroy' || methodName === 'clear' || methodName === 'fillAll') return null;
    return bitmap ? { x: 0, y: 0, width: Number(bitmap.width) || 0, height: Number(bitmap.height) || 0 } : null;
  }

  function rectsOverlap(left, right) {
    if (!left || !right) return true;
    if (left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) return false;
    return left.x < right.x + right.width
      && left.x + left.width > right.x
      && left.y < right.y + right.height
      && left.y + left.height > right.y;
  }

  function estimateTextWidth(bitmap, text) {
    if (bitmap && typeof bitmap.textWidth === 'function') {
      const width = Number(bitmap.textWidth(String(text ?? '')));
      if (Number.isFinite(width) && width > 0) return width;
    }
    const fontSize = Number(bitmap && bitmap.fontSize) || 20;
    return String(text ?? '').length * Math.max(1, Math.round(fontSize * 0.5));
  }

  function fontSignature(bitmap) {
    return [
      bitmap && bitmap.fontFace ? bitmap.fontFace : '',
      bitmap && bitmap.fontSize ? bitmap.fontSize : '',
      bitmap && bitmap.fontBold ? 'bold' : '',
      bitmap && bitmap.fontItalic ? 'italic' : '',
    ].join(':');
  }

  function numberAt(values, index, fallback) {
    const value = Number(values && values.length > index ? values[index] : fallback);
    return Number.isFinite(value) ? value : fallback;
  }

  function finiteOr(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
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
