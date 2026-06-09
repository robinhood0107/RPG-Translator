(function attach(root) {
  const { MessageWrapper } = loadDependency(root, './wrapping');
  const STATE_KEY = '__rpgTranslatorMessageAdapterState';
  const INSTALL_TOKEN = 'rpg-translator-message-v2';
  const CLEAR_TOKEN = 'rpg-translator-message-clear-v1';

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
        return translated;
      };
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
      };
    }
    return windowInstance[STATE_KEY];
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
