(function attach(root) {
  const STATE_KEY = '__rpgTranslatorSpriteTextState';
  const PARENT_RUN_KEY = '__rpgTranslatorSpriteTextParentRunState';
  const INSTALL_TOKEN = 'rpg-translator-sprite-text-v2';
  let nextSpriteId = 1;
  let nextParentRunId = 1;

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
      installSurfaceDrawSubscription(scope, translator);
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

  function installSurfaceDrawSubscription(scope, translator) {
    if (!translator || typeof translator.subscribeSurfaceDraws !== 'function') return false;
    const overlayScope = overlay(scope);
    if (overlayScope.__spriteTextSurfaceDrawUnsubscribe) return true;
    const unsubscribe = translator.subscribeSurfaceDraws((event) => handleSurfaceDraw(event, scope, translator), {
      adapterId: 'sprite-text',
      token: 'sprite-text-surface-draws',
    });
    overlayScope.__spriteTextSurfaceDrawUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
    return true;
  }

  function handleSurfaceDraw(event, scope, translator) {
    const payload = event && event.payload ? event.payload : null;
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim() || !translator || typeof translator.observeRecord !== 'function') return null;
    const slotKey = surfaceDrawSlotKey(payload);
    const surface = payload.target || payload.bitmap || event.target || null;
    const command = translator.observeRecord({
      engine: overlay(scope).engine || 'unknown',
      sourceLanguage: overlay(scope).sourceLanguage,
      targetLanguage: overlay(scope).targetLanguage,
      text,
      currentText: text,
      surface,
      adapter: 'sprite-text',
      kind: 'surface-draw',
      slotKey,
      renderStrategy: 'sprite-text',
      metadata: {
        sourceAdapter: event.sourceAdapter || payload.sourceAdapter || '',
        methodName: payload.methodName || 'drawText',
        ownershipStatus: payload.ownershipStatus || event.status || '',
      },
    });
    if (!command || command.status !== 'hit') return null;
    if (typeof translator.acceptRender === 'function' && !translator.acceptRender(command, surface, text)) {
      return null;
    }
    return {
      action: 'replace-native-draw',
      text: command.translatedText,
      x: payload.x,
      y: payload.y,
      maxWidth: payload.maxWidth,
      lineHeight: payload.lineHeight,
      align: payload.align,
      reason: 'cache-hit',
    };
  }

  function surfaceDrawSlotKey(payload) {
    return [
      'sprite-surface',
      String(payload.methodName || 'drawText'),
      Math.round(finiteNumber(payload.x, 0)),
      Math.round(finiteNumber(payload.y, 0)),
      Math.round(finiteNumber(payload.maxWidth, 0)),
      Math.round(finiteNumber(payload.lineHeight, 0)),
      String(payload.align || 'left'),
    ].join(':');
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
    const parentRunResult = renderParentGlyphRun(sprite, scope, translator);
    if (parentRunResult && parentRunResult.handled) return parentRunResult.rendered;

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
    state.surfaceOwner = surfaceOwner;
    state.slotKey = slotKey;
    state.textOwner = textOwner;

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

  function renderParentGlyphRun(sprite, scope, translator) {
    const parent = sprite && sprite.parent;
    if (!parent || parent._destroyed || !Array.isArray(parent.children)) return { handled: false, rendered: false };
    const group = collectSiblingGlyphRun(parent, sprite, translator);
    if (!group || group.items.length < 2) {
      retireMissingParentRun(parent, translator, sprite);
      return { handled: false, rendered: false };
    }
    const text = group.items.map((item) => item.text).join('');
    const parentState = ensureParentRunState(parent);
    let run = parentState.runs.get(group.key);
    if (!run) {
      run = {
        id: `spr-run-${nextParentRunId++}`,
        key: group.key,
        itemId: null,
        command: null,
        text: '',
        overlaySprite: null,
        overlayBitmap: null,
        bounds: null,
        revision: 0,
      };
      parentState.runs.set(group.key, run);
    }
    parentState.lastActiveKeyByChild.set(sprite, group.key);
    retireOtherParentRuns(parentState, group.key, translator);
    if (run.text !== text) {
      retireParentRun(run, translator, 'parent-run-text-changed');
      run.text = text;
      run.revision += 1;
    }
    run.parent = parent;
    run.group = group.items;
    run.bounds = group.bounds;
    run.lineHeight = group.lineHeight;

    const slotKey = `sprite-run:${parentState.id}:${group.key}`;
    const surfaceOwner = `sprite-run:${parentState.id}`;
    const textOwner = `${surfaceOwner}:${slotKey}`;
    if (typeof translator.claimSurface === 'function' && !translator.claimSurface(parent, surfaceOwner)) {
      removeParentRunOverlay(run, 'surface-claimed');
      return { handled: true, rendered: false };
    }
    if (typeof translator.claimText === 'function' && !translator.claimText(slotKey, textOwner)) {
      removeParentRunOverlay(run, 'text-claimed');
      return { handled: true, rendered: false };
    }
    run.surfaceOwner = surfaceOwner;
    run.slotKey = slotKey;
    run.textOwner = textOwner;
    let command = run.command;
    if (!command || command.sourceText !== text || command.status !== 'hit') {
      command = translator.observeRecord({
        engine: overlay(scope).engine || 'unknown',
        sourceLanguage: overlay(scope).sourceLanguage,
        targetLanguage: overlay(scope).targetLanguage,
        text,
        currentText: text,
        surface: parent,
        adapter: 'sprite-text',
        kind: 'glyph-run',
        slotKey,
        generation: run.revision,
        metadata: {
          glyphs: group.items.length,
        },
      });
      run.command = command;
      run.itemId = command && command.itemId ? command.itemId : null;
    }
    if (!command || command.status !== 'hit') {
      syncParentRunOverlayVisibility(run);
      return { handled: true, rendered: false };
    }
    if (typeof translator.acceptRender === 'function' && !translator.acceptRender(command, parent, text)) {
      removeParentRunOverlay(run, 'stale-render');
      return { handled: true, rendered: false };
    }
    renderParentRunOverlay(scope, run, command.translatedText);
    syncParentRunOverlayVisibility(run);
    return { handled: true, rendered: true };
  }

  function collectSiblingGlyphRun(parent, anchorSprite, translator) {
    const children = Array.isArray(parent && parent.children) ? parent.children : [];
    const candidates = [];
    children.forEach((child, index) => {
      if (!child || child._destroyed || child._rpgTranslatorSpriteTextOverlay || child._rpgTranslatorSpriteTextParentRunOverlay) return;
      const source = glyphSource(child);
      if (!source || !isSingleGlyph(source.text)) return;
      const state = ensureState(child);
      syncStateSource(state, child, source);
      if (state.sourceText !== source.text) {
        removeOverlay(state, 'glyph-text-changed');
        retireActiveItem(state, translator, 'glyph-text-changed');
        state.sourceText = source.text;
        state.revision += 1;
      }
      candidates.push(createGlyphCandidate(child, state, source, index));
    });
    if (candidates.length < 2) return null;
    const groups = splitGlyphGroups(candidates);
    return groups.find((group) => group.items.some((item) => item.sprite === anchorSprite)) || null;
  }

  function createGlyphCandidate(sprite, state, source, childIndex) {
    const bitmap = sprite.bitmap || source.owner || {};
    const width = Math.max(1, Math.ceil(Number(bitmap.width) || estimateGlyphWidth(source.text)));
    const height = Math.max(1, Math.ceil(Number(bitmap.height) || 24));
    const x = finiteNumber(sprite.x, 0);
    const y = finiteNumber(sprite.y, 0);
    const font = spriteFontSignature(bitmap);
    return {
      sprite,
      state,
      text: String(source.text ?? ''),
      childIndex,
      x,
      y,
      width,
      height,
      lineHeight: height,
      font,
    };
  }

  function splitGlyphGroups(candidates) {
    const groups = [];
    const sorted = candidates.slice().sort((left, right) => {
      if (left.childIndex !== right.childIndex) return left.childIndex - right.childIndex;
      if (left.y !== right.y) return left.y - right.y;
      return left.x - right.x;
    });
    let current = [];
    let previous = null;
    const push = () => {
      if (current.length >= 2) groups.push(createGlyphGroup(current));
      current = [];
    };
    sorted.forEach((item) => {
      if (!previous || canContinueGlyphRun(previous, item)) current.push(item);
      else {
        push();
        current = [item];
      }
      previous = item;
    });
    push();
    return groups;
  }

  function canContinueGlyphRun(left, right) {
    if (!left || !right || left.font !== right.font) return false;
    const lineHeight = Math.max(1, left.lineHeight || right.lineHeight || 24);
    const gapLimit = Math.max(6, Math.ceil(lineHeight * 0.65));
    const backtrackLimit = Math.max(2, Math.ceil(lineHeight * 0.35));
    const gap = right.x - (left.x + left.width);
    if (gap > gapLimit) return false;
    if (right.x < left.x - backtrackLimit) return false;
    return Math.abs(centerY(left) - centerY(right)) <= Math.max(4, Math.ceil(lineHeight * 1.75));
  }

  function createGlyphGroup(items) {
    const bounds = items.reduce((acc, item) => ({
      x: Math.min(acc.x, item.x),
      y: Math.min(acc.y, item.y),
      x2: Math.max(acc.x2, item.x + item.width),
      y2: Math.max(acc.y2, item.y + item.height),
    }), { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity });
    bounds.width = Math.max(1, bounds.x2 - bounds.x);
    bounds.height = Math.max(1, bounds.y2 - bounds.y);
    return {
      key: items.map((item) => item.state.id).join('|'),
      items,
      bounds,
      lineHeight: Math.max(...items.map((item) => item.lineHeight || 0), 1),
    };
  }

  function renderParentRunOverlay(scope, run, translatedText) {
    if (!run || !run.parent || !run.bounds || !translatedText) return false;
    const overlayBitmap = ensureParentRunBitmap(scope, run, translatedText);
    const overlaySprite = ensureParentRunSprite(scope, run, overlayBitmap);
    if (!overlayBitmap || !overlaySprite) return false;
    if (run.renderedText !== translatedText || run.renderedRevision !== run.revision) {
      drawOverlayText(overlayBitmap, translatedText);
      run.renderedText = translatedText;
      run.renderedRevision = run.revision;
    }
    overlaySprite.x = Math.floor(run.bounds.x);
    overlaySprite.y = Math.floor(run.bounds.y);
    overlaySprite.bitmap = overlayBitmap;
    attachParentRunOverlay(run.parent, overlaySprite);
    return true;
  }

  function ensureParentRunBitmap(scope, run, translatedText) {
    const measured = estimateGlyphWidth(translatedText);
    const width = Math.max(1, Math.ceil(run.bounds.width), measured);
    const height = Math.max(1, Math.ceil(run.bounds.height), Math.ceil(run.lineHeight || 24));
    if (run.overlayBitmap && !run.overlayBitmap._destroyed && run.overlayBitmap.width >= width && run.overlayBitmap.height >= height) {
      return run.overlayBitmap;
    }
    let bitmap = null;
    try {
      bitmap = scope && typeof scope.Bitmap === 'function'
        ? new scope.Bitmap(width, height)
        : { width, height };
    } catch (_error) {
      bitmap = { width, height };
    }
    bitmap._rpgTranslatorSpriteTextOverlayBitmap = true;
    run.overlayBitmap = bitmap;
    return bitmap;
  }

  function ensureParentRunSprite(scope, run, overlayBitmap) {
    if (run.overlaySprite && !run.overlaySprite._destroyed) return run.overlaySprite;
    let sprite = null;
    try {
      sprite = scope && typeof scope.Sprite === 'function'
        ? new scope.Sprite(overlayBitmap)
        : { bitmap: overlayBitmap, children: [] };
    } catch (_error) {
      sprite = { bitmap: overlayBitmap, children: [] };
    }
    sprite._rpgTranslatorSpriteTextParentRunOverlay = true;
    sprite._rpgTranslatorSpriteTextParentRun = run;
    run.overlaySprite = sprite;
    return sprite;
  }

  function attachParentRunOverlay(parent, overlaySprite) {
    if (!parent || !overlaySprite) return false;
    if (overlaySprite.parent === parent) return true;
    detachOverlayFromParent(overlaySprite);
    if (typeof parent.addChild === 'function') {
      parent.addChild(overlaySprite);
      return overlaySprite.parent === parent || childList(parent).includes(overlaySprite);
    }
    const children = childList(parent);
    if (!children.includes(overlaySprite)) children.push(overlaySprite);
    overlaySprite.parent = parent;
    return true;
  }

  function syncParentRunOverlayVisibility(run) {
    if (!run || !run.overlaySprite) return false;
    const visible = Array.isArray(run.group)
      && run.group.length > 0
      && run.group.every((item) => isOpen(item.sprite) && item.sprite.visible !== false && item.sprite.parent === run.parent);
    run.overlaySprite.visible = visible;
    run.overlaySprite.renderable = visible;
    return true;
  }

  function retireMissingParentRun(parent, translator, sprite) {
    const parentState = parent && parent[PARENT_RUN_KEY];
    if (!parentState) return false;
    let key = parentState.lastActiveKeyByChild.get(sprite);
    let run = key ? parentState.runs.get(key) : null;
    if (!run) {
      for (const [candidateKey, candidateRun] of parentState.runs.entries()) {
        const group = Array.isArray(candidateRun && candidateRun.group) ? candidateRun.group : [];
        if (group.some((item) => item && item.sprite === sprite)) {
          key = candidateKey;
          run = candidateRun;
          break;
        }
      }
    }
    if (!run) return false;
    const group = Array.isArray(run.group) ? run.group : [];
    group.forEach((item) => {
      if (item && item.sprite) parentState.lastActiveKeyByChild.delete(item.sprite);
    });
    parentState.lastActiveKeyByChild.delete(sprite);
    if (key) parentState.runs.delete(key);
    return retireParentRun(run, translator, 'parent-run-not-seen');
  }

  function retireOtherParentRuns(parentState, activeKey, translator) {
    if (!parentState || !parentState.runs) return;
    for (const [key, run] of Array.from(parentState.runs.entries())) {
      if (key === activeKey) continue;
      retireParentRun(run, translator, 'parent-run-superseded');
      parentState.runs.delete(key);
    }
  }

  function retireParentRun(run, translator, reason) {
    if (!run) return false;
    removeParentRunOverlay(run, reason);
    if (run.itemId && translator && typeof translator.archiveItem === 'function') translator.archiveItem(run.itemId);
    if (translator && typeof translator.releaseTextClaim === 'function') {
      translator.releaseTextClaim(run.slotKey, run.textOwner);
    }
    if (run.parent && translator && typeof translator.releaseSurface === 'function') {
      translator.releaseSurface(run.parent, run.surfaceOwner);
    }
    if (run.parent && translator && typeof translator.markSurfaceChanged === 'function') translator.markSurfaceChanged(run.parent);
    run.itemId = null;
    run.command = null;
    run.surfaceOwner = '';
    run.slotKey = '';
    run.textOwner = '';
    run.retireReason = reason || 'parent-run-retired';
    return true;
  }

  function removeParentRunOverlay(run, reason) {
    if (!run || !run.overlaySprite) return false;
    const overlaySprite = run.overlaySprite;
    run.overlaySprite = null;
    run.overlayBitmap = null;
    detachOverlayFromParent(overlaySprite);
    run.removeReason = reason || 'remove';
    return true;
  }

  function ensureParentRunState(parent) {
    if (!parent[PARENT_RUN_KEY]) {
      parent[PARENT_RUN_KEY] = {
        id: String(nextParentRunId++),
        runs: new Map(),
        lastActiveKeyByChild: new WeakMap(),
      };
    }
    return parent[PARENT_RUN_KEY];
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

  function isSingleGlyph(text) {
    return Array.from(String(text ?? '').trim()).length === 1;
  }

  function estimateGlyphWidth(text) {
    return Math.max(1, Array.from(String(text ?? '')).length * 12);
  }

  function spriteFontSignature(bitmap) {
    return [
      bitmap && bitmap.fontFace || '',
      bitmap && bitmap.fontSize || '',
      bitmap && bitmap.fontBold ? 'b' : '',
      bitmap && bitmap.fontItalic ? 'i' : '',
    ].join(':');
  }

  function centerY(item) {
    return (Number(item.y) || 0) + (Number(item.height) || 0) / 2;
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
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
        surfaceOwner: '',
        slotKey: '',
        textOwner: '',
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
    if (sprite && sprite[PARENT_RUN_KEY]) {
      for (const run of Array.from(sprite[PARENT_RUN_KEY].runs.values())) retireParentRun(run, translator, reason || 'parent-retired');
      sprite[PARENT_RUN_KEY].runs.clear();
    }
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
    if (translator && typeof translator.releaseTextClaim === 'function') {
      translator.releaseTextClaim(state.slotKey, state.textOwner);
    }
    if (translator && typeof translator.releaseSurface === 'function') {
      translator.releaseSurface(state.sprite, state.surfaceOwner);
    }
    if (translator && typeof translator.markSurfaceChanged === 'function') translator.markSurfaceChanged(state.sprite);
    state.itemId = null;
    state.command = null;
    state.surfaceOwner = '';
    state.slotKey = '';
    state.textOwner = '';
    state.retireReason = reason || 'retired';
    return true;
  }

  function installLifecycleHooks(prototype, translator) {
    installDestroyHook(prototype, translator);
    installChildHook(prototype, 'removeChild', translator);
    installRemoveChildAtHook(prototype, translator);
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
      handleRemovedChild(this, child, translator, methodName);
      return result;
    };
    prototype[methodName].__rpgTranslatorOriginal = original;
    prototype[methodName].__rpgTranslatorSpriteChild = INSTALL_TOKEN;
  }

  function installRemoveChildAtHook(prototype, translator) {
    const original = prototype.removeChildAt;
    if (typeof original !== 'function' || original.__rpgTranslatorSpriteRemoveChildAt === INSTALL_TOKEN) return;
    prototype.removeChildAt = function translatedSpriteRemoveChildAt(...args) {
      const child = original.apply(this, args);
      handleRemovedChild(this, child, translator, 'removeChildAt');
      return child;
    };
    prototype.removeChildAt.__rpgTranslatorOriginal = original;
    prototype.removeChildAt.__rpgTranslatorSpriteRemoveChildAt = INSTALL_TOKEN;
  }

  function installRemoveChildrenHook(prototype, translator) {
    const original = prototype.removeChildren;
    if (typeof original !== 'function' || original.__rpgTranslatorSpriteRemoveChildren === INSTALL_TOKEN) return;
    prototype.removeChildren = function translatedSpriteRemoveChildren(...args) {
      const before = childList(this).slice();
      const result = original.apply(this, args);
      before.forEach((child) => handleRemovedChild(this, child, translator, 'removeChildren'));
      return result;
    };
    prototype.removeChildren.__rpgTranslatorOriginal = original;
    prototype.removeChildren.__rpgTranslatorSpriteRemoveChildren = INSTALL_TOKEN;
  }

  function handleRemovedChild(parent, child, translator, reason) {
    if (!child) return false;
    if (child._rpgTranslatorSpriteTextOverlay) {
      if (child.__rpgTranslatorSpriteTextDetachBypass) return false;
      retireSprite(child._rpgTranslatorSpriteTextSource, translator, `${reason}:overlay`);
      return true;
    }
    if (child._rpgTranslatorSpriteTextParentRunOverlay) {
      if (child.__rpgTranslatorSpriteTextDetachBypass) return false;
      retireParentRun(child._rpgTranslatorSpriteTextParentRun, translator, `${reason}:parent-run-overlay`);
      return true;
    }
    retireMissingParentRun(parent, translator, child);
    retireSprite(child, translator, reason);
    return true;
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
