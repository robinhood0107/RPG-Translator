(function attach(root) {
  const { MessageWrapper } = loadDependency(root, './wrapping');
  const STATE_KEY = '__rpgTranslatorMessageAdapterState';
  const INSTALL_TOKEN = 'rpg-translator-message-v2';
  const CLEAR_TOKEN = 'rpg-translator-message-clear-v1';
  const PROCESS_TOKEN = 'rpg-translator-message-process-v1';
  const LIFECYCLE_TOKEN = 'rpg-translator-message-lifecycle-v1';

  class MessageAdapter {
    static install(scope, translator) {
      if (!scope || !scope.Window_Message || !scope.Window_Message.prototype) return false;
      const prototype = scope.Window_Message.prototype;
      if (prototype.__rpgTranslatorMessageInstalled === INSTALL_TOKEN) return true;
      const trackedWindows = new Set();
      const originalStartMessage = prototype.startMessage;
      prototype.startMessage = function startMessageWithTranslation(...args) {
        trackedWindows.add(this);
        retireMessageWindow(translator, this, 'message-session-replaced');
        const message = scope.$gameMessage;
        if (message && Array.isArray(message._texts)) {
          const originalText = readMessageBlock(message);
          const state = ensureState(this);
          state.startMessageHandled = true;
          state.processCharacterText = '';
          state.processCharacterTextState = null;
          state.processCharacterCompletedState = null;
          const translated = applyMessageTranslation(translator, scope, originalText, this);
          if (translated && translated !== originalText) {
            message._texts = translatedLines(translated, originalText, this);
          }
        }
        if (typeof originalStartMessage === 'function') {
          return originalStartMessage.apply(this, args);
        }
        return undefined;
      };
      prototype.processCompleteMessage = function processCompleteMessageWithTranslation(message, _sessionId) {
        trackedWindows.add(this);
        retireMessageWindow(translator, this, 'message-translation-replaced');
        const originalText = readCompletedMessage(message);
        if (!String(originalText || '').trim()) return undefined;
        const translated = applyMessageTranslation(translator, scope, originalText, this);
        if (translated && translated !== originalText && scope.$gameMessage && Array.isArray(scope.$gameMessage._texts)) {
          scope.$gameMessage._texts = translatedLines(translated, originalText, this);
        }
        if (translated && translated !== originalText) {
          redrawMessageFallback(this, translated, originalText);
        }
        return translated;
      };
      installProcessCharacterFallback(prototype, scope, translator, trackedWindows);
      installWindowLifecycleHooks(prototype, translator, trackedWindows);
      installPendingRedrawHook(prototype);
      prototype.__rpgTranslatorMessageInstalled = INSTALL_TOKEN;
      wrapGameMessageClear(scope, translator, trackedWindows);
      return true;
    }
  }

  function readMessageBlock(message) {
    if (typeof message.allText === 'function') {
      return String(message.allText() || '');
    }
    return message._texts.map((text) => String(text || '')).join('\n');
  }

  function readCompletedMessage(message) {
    if (message && typeof message === 'object') {
      return firstString(
        message.normalizedTranslationSource,
        message.translationSource,
        message.resolved,
        message.visible,
        message.text,
      );
    }
    return String(message || '');
  }

  function countNewlines(text) {
    return String(text || '').split('\n').length - 1;
  }

  function translatedLines(translated, originalText, windowInstance) {
    if (MessageWrapper && typeof MessageWrapper.wrap === 'function') {
      return MessageWrapper.wrap(translated, { window: windowInstance });
    }
    if (countNewlines(translated) === countNewlines(originalText)) {
      return String(translated).split('\n');
    }
    return String(originalText).split('\n');
  }

  function applyMessageTranslation(translator, scope, originalText, windowInstance) {
    const result = translateText(translator, scope, originalText, windowInstance);
    const translated = result && result.text ? result.text : originalText;
    if (result && result.itemId) {
      const state = ensureState(windowInstance);
      state.itemId = result.itemId;
      state.slotKey = result.slotKey;
      state.textOwner = result.textOwner;
      state.surfaceOwner = result.surfaceOwner;
    }
    return translated;
  }

  function installProcessCharacterFallback(prototype, scope, translator, trackedWindows) {
    if (!prototype || typeof prototype.processCharacter !== 'function') return false;
    if (prototype.processCharacter.__rpgTranslatorMessageProcess === PROCESS_TOKEN) return true;
    const originalProcessCharacter = prototype.processCharacter;
    prototype.processCharacter = function processCharacterWithMessageCapture(textState) {
      trackedWindows.add(this);
      if (Number(this && this.__rpgTranslatorMessageRedrawDepth) > 0) {
        return originalProcessCharacter.call(this, textState);
      }
      const state = ensureState(this);
      const sourceText = textState && typeof textState.text === 'string'
        ? String(textState.text)
        : '';
      if (!sourceText || state.startMessageHandled) {
        return originalProcessCharacter.call(this, textState);
      }
      if (state.processCharacterTextState !== textState) {
        state.processCharacterText = sourceText;
        state.processCharacterTextState = textState;
      }

      const result = originalProcessCharacter.call(this, textState);
      if (textState && typeof textState.text === 'string' && Number(textState.index) >= textState.text.length) {
        completeProcessCharacterFallback(scope, translator, this, state, textState);
      }
      return result;
    };
    prototype.processCharacter.__rpgTranslatorOriginal = originalProcessCharacter;
    prototype.processCharacter.__rpgTranslatorMessageProcess = PROCESS_TOKEN;
    return true;
  }

  function completeProcessCharacterFallback(scope, translator, windowInstance, state, textState) {
    if (!state || state.processCharacterCompletedState === textState) return;
    const sourceText = state.processCharacterText || (textState && textState.text) || '';
    state.processCharacterText = '';
    state.processCharacterTextState = null;
    if (!String(sourceText || '').trim()) return;
    if (windowInstance && typeof windowInstance.processCompleteMessage === 'function') {
      windowInstance.processCompleteMessage({
        visible: sourceText,
        resolved: sourceText,
        translationSource: sourceText,
      }, state.windowId);
      state.processCharacterCompletedState = textState;
      return;
    }
    const translated = applyMessageTranslation(translator, scope, sourceText, windowInstance);
    if (translated && translated !== sourceText && scope.$gameMessage && Array.isArray(scope.$gameMessage._texts)) {
      scope.$gameMessage._texts = translatedLines(translated, sourceText, windowInstance);
    }
    state.processCharacterCompletedState = textState;
  }

  function installWindowLifecycleHooks(prototype, translator, trackedWindows) {
    ['close', 'hide', 'destroy'].forEach((methodName) => {
      const current = prototype && prototype[methodName];
      if (typeof current !== 'function') return;
      if (current.__rpgTranslatorMessageLifecycle === LIFECYCLE_TOKEN) return;
      const original = current;
      prototype[methodName] = function messageLifecycleWithRetire(...args) {
        trackedWindows.add(this);
        if (methodName === 'destroy') {
          retireMessageWindow(translator, this, `message-window-${methodName}`);
          return original.apply(this, args);
        }
        const result = original.apply(this, args);
        retireMessageWindow(translator, this, `message-window-${methodName}`);
        return result;
      };
      prototype[methodName].__rpgTranslatorOriginal = original;
      prototype[methodName].__rpgTranslatorMessageLifecycle = LIFECYCLE_TOKEN;
    });
  }

  function installPendingRedrawHook(prototype) {
    if (!prototype || typeof prototype.update !== 'function') return false;
    if (prototype.update.__rpgTranslatorMessagePendingRedraw === LIFECYCLE_TOKEN) return true;
    const original = prototype.update;
    prototype.update = function messageUpdateWithPendingRedraw(...args) {
      const result = original.apply(this, args);
      applyPendingMessageRedraw(this);
      return result;
    };
    prototype.update.__rpgTranslatorOriginal = original;
    prototype.update.__rpgTranslatorMessagePendingRedraw = LIFECYCLE_TOKEN;
    return true;
  }

  function translateText(translator, scope, text, surface) {
    const slotKey = 'message:game-message';
    const state = ensureState(surface);
    const surfaceOwner = `message:${state.windowId}`;
    const textOwner = `${surfaceOwner}:${slotKey}`;
    if (translator && typeof translator.claimSurface === 'function' && !translator.claimSurface(surface, surfaceOwner)) {
      return { text, itemId: '', slotKey, surfaceOwner, textOwner };
    }
    if (translator && typeof translator.claimText === 'function' && !translator.claimText(slotKey, textOwner)) {
      if (translator && typeof translator.releaseSurface === 'function') {
        translator.releaseSurface(surface, surfaceOwner);
      }
      return { text, itemId: '', slotKey, surfaceOwner, textOwner };
    }
    const request = {
      engine: overlay(scope).engine || 'unknown',
      sourceLanguage: overlay(scope).sourceLanguage,
      targetLanguage: overlay(scope).targetLanguage,
      text,
      currentText: text,
      surface,
      adapter: 'message',
      kind: 'message_block',
      slotKey,
    };
    if (translator && typeof translator.observeRecord === 'function') {
      const command = translator.observeRecord(request);
      const itemId = command && command.itemId ? command.itemId : '';
      if (command && command.status === 'hit' && translator && typeof translator.acceptRender === 'function') {
        if (!translator.acceptRender(command, surface, text)) {
          return { text, itemId, slotKey, surfaceOwner, textOwner };
        }
      }
      return {
        text: command && command.status === 'hit' ? command.translatedText : text,
        itemId,
        slotKey,
        surfaceOwner,
        textOwner,
      };
    }
    const translated = translator && typeof translator.translateText === 'function'
      ? translator.translateText(request)
      : translator && typeof translator.translate === 'function'
        ? translator.translate(request)
        : null;
    return { text: translated || text, itemId: '', slotKey, surfaceOwner, textOwner };
  }

  function wrapGameMessageClear(scope, translator, trackedWindows) {
    const prototype = scope && scope.Game_Message && scope.Game_Message.prototype;
    if (prototype && typeof prototype.clear === 'function' && prototype.clear.__rpgTranslatorMessageClear !== CLEAR_TOKEN) {
      const original = prototype.clear;
      prototype.clear = function clearWithMessageRetire(...args) {
        retireWindowsForMessage(scope, translator, trackedWindows, this, 'game-message-clear');
        return original.apply(this, args);
      };
      prototype.clear.__rpgTranslatorOriginal = original;
      prototype.clear.__rpgTranslatorMessageClear = CLEAR_TOKEN;
    }
    const message = scope && scope.$gameMessage;
    if (message && typeof message.clear === 'function' && message.clear.__rpgTranslatorMessageClear !== CLEAR_TOKEN) {
      const original = message.clear;
      message.clear = function clearSingletonWithMessageRetire(...args) {
        retireWindowsForMessage(scope, translator, trackedWindows, this, 'game-message-clear');
        return original.apply(this, args);
      };
      message.clear.__rpgTranslatorOriginal = original;
      message.clear.__rpgTranslatorMessageClear = CLEAR_TOKEN;
    }
  }

  function retireWindowsForMessage(scope, translator, trackedWindows, message, reason) {
    for (const windowInstance of Array.from(trackedWindows)) {
      if (!windowInstance) {
        trackedWindows.delete(windowInstance);
        continue;
      }
      if (message && scope && scope.$gameMessage && message !== scope.$gameMessage) continue;
      retireMessageWindow(translator, windowInstance, reason);
    }
  }

  function retireMessageWindow(translator, windowInstance, reason) {
    const state = getState(windowInstance);
    if (!state) return false;
    if (state.itemId && translator && typeof translator.archiveItem === 'function') {
      translator.archiveItem(state.itemId);
    }
    if (state.slotKey && translator && typeof translator.releaseTextClaim === 'function') {
      translator.releaseTextClaim(state.slotKey, state.textOwner);
    }
    if (translator && typeof translator.releaseSurface === 'function') {
      translator.releaseSurface(windowInstance, state.surfaceOwner);
    }
    if (windowInstance && translator && typeof translator.retireSurface === 'function') {
      translator.retireSurface(windowInstance, reason || 'message-retired');
    }
    if (windowInstance && translator && typeof translator.markSurfaceChanged === 'function') {
      translator.markSurfaceChanged(windowInstance);
    }
    state.itemId = '';
    state.slotKey = '';
    state.textOwner = '';
    state.surfaceOwner = '';
    state.startMessageHandled = false;
    state.processCharacterText = '';
    state.processCharacterTextState = null;
    state.processCharacterCompletedState = null;
    state.pendingRedraw = null;
    return true;
  }

  let nextWindowId = 1;

  function ensureState(windowInstance) {
    if (!windowInstance) return { windowId: 'none' };
    if (!windowInstance[STATE_KEY]) {
      windowInstance[STATE_KEY] = {
        windowId: String(nextWindowId++),
        itemId: '',
        slotKey: '',
        textOwner: '',
        surfaceOwner: '',
        startMessageHandled: false,
        processCharacterText: '',
        processCharacterTextState: null,
        processCharacterCompletedState: null,
        pendingRedraw: null,
      };
    }
    return windowInstance[STATE_KEY];
  }

  function redrawMessageFallback(windowInstance, translated, originalText) {
    if (!windowInstance) return false;
    const state = ensureState(windowInstance);
    if (!isMessageWindowReady(windowInstance)) {
      state.pendingRedraw = {
        text: String(translated ?? ''),
        originalText: String(originalText ?? ''),
      };
      return false;
    }
    state.pendingRedraw = null;
    return drawMessageTextExFallback(windowInstance, translated, originalText);
  }

  function applyPendingMessageRedraw(windowInstance) {
    const state = getState(windowInstance);
    const pending = state && state.pendingRedraw ? state.pendingRedraw : null;
    if (!pending || !isMessageWindowReady(windowInstance)) return false;
    state.pendingRedraw = null;
    return drawMessageTextExFallback(windowInstance, pending.text, pending.originalText);
  }

  function drawMessageTextExFallback(windowInstance, translated, originalText) {
    if (!windowInstance || typeof windowInstance.drawTextEx !== 'function') return false;
    const contents = windowInstance.contents;
    if (contents && typeof contents.clear === 'function') {
      try { contents.clear(); } catch (_) {}
    }
    if (typeof windowInstance.resetFontSettings === 'function') windowInstance.resetFontSettings();
    drawMessageFaceIfNeeded(windowInstance);
    const text = redrawText(translated, originalText, windowInstance);
    const x = finiteNumber(windowInstance._trMsgStartX, 0);
    const y = finiteNumber(windowInstance._trMsgStartY, 0);
    windowInstance.__rpgTranslatorMessageRedrawDepth = (windowInstance.__rpgTranslatorMessageRedrawDepth || 0) + 1;
    try {
      windowInstance.drawTextEx(text, x, y);
    } finally {
      windowInstance.__rpgTranslatorMessageRedrawDepth = Math.max(0, (windowInstance.__rpgTranslatorMessageRedrawDepth || 1) - 1);
    }
    return true;
  }

  function drawMessageFaceIfNeeded(windowInstance) {
    if (!windowInstance || typeof windowInstance.drawMessageFace !== 'function') return false;
    try {
      windowInstance.drawMessageFace();
      return true;
    } catch (_) {
      return false;
    }
  }

  function redrawText(translated, originalText, windowInstance) {
    const lines = translatedLines(translated, originalText, windowInstance);
    if (Array.isArray(lines)) return lines.join('\n');
    return String(translated ?? '');
  }

  function isMessageWindowReady(windowInstance) {
    if (!windowInstance || !windowInstance.contents || windowInstance.visible === false) return false;
    return typeof windowInstance.isOpen === 'function' ? windowInstance.isOpen() : true;
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getState(windowInstance) {
    return windowInstance && windowInstance[STATE_KEY] ? windowInstance[STATE_KEY] : null;
  }

  function overlay(scope) {
    return scope.RPGTranslatorOverlay || {};
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value) return value;
      if (value !== undefined && value !== null && typeof value !== 'object') {
        const text = String(value);
        if (text) return text;
      }
    }
    return '';
  }

  function loadDependency(scope, modulePath) {
    const overlayApi = scope.RPGTranslatorOverlay || {};
    if (overlayApi.MessageWrapper) return overlayApi;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      return require(modulePath);
    }
    return overlayApi;
  }

  publish(root, { MessageAdapter });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
