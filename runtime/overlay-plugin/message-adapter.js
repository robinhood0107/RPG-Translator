(function attach(root) {
  const { MessageWrapper } = loadDependency(root, './wrapping');
  const STATE_KEY = '__rpgTranslatorMessageAdapterState';
  const INSTALL_TOKEN = 'rpg-translator-message-v2';
  const CLEAR_TOKEN = 'rpg-translator-message-clear-v1';
  const PROCESS_TOKEN = 'rpg-translator-message-process-v1';
  const LIFECYCLE_TOKEN = 'rpg-translator-message-lifecycle-v1';
  const FORESIGHT_ORIGIN_TOKEN = 'rpg-translator-message-origin-v1';
  const BREAK_SENTINEL_PREFIX = '\uE000RPGT_BR_';
  const BREAK_SENTINEL_SUFFIX = '_RPGT\uE001';

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
          const originalText = readResolvedMessageBlock(scope, message, this);
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
          redrawMessageFallback(scope, this, translated, originalText);
        }
        return translated;
      };
      installProcessCharacterFallback(prototype, scope, translator, trackedWindows);
      installWindowLifecycleHooks(prototype, translator, trackedWindows);
      installPendingRedrawHook(prototype, scope);
      prototype.__rpgTranslatorMessageInstalled = INSTALL_TOKEN;
      wrapGameMessageClear(scope, translator, trackedWindows);
      installForesightOriginHooks(scope);
      return true;
    }
  }

  function readMessageBlock(message) {
    if (typeof message.allText === 'function') {
      return String(message.allText() || '');
    }
    return message._texts.map((text) => String(text || '')).join('\n');
  }

  function readResolvedMessageBlock(scope, message, windowInstance) {
    const rawText = readMessageBlock(message);
    if (!windowInstance || typeof windowInstance.convertEscapeCharacters !== 'function') return rawText;
    if (!resolveOriginAwareLineBreaks(scope)) {
      try { return String(windowInstance.convertEscapeCharacters(rawText) || ''); } catch (_) { return rawText; }
    }
    const breakMap = createBreakMap(rawText);
    try {
      const converted = String(windowInstance.convertEscapeCharacters(breakMap.markedText) || '');
      return normalizeConvertedMessageText(converted, breakMap).text;
    } catch (_) {
      return rawText;
    }
  }

  function resolveOriginAwareLineBreaks(scope) {
    const settings = overlay(scope).config || overlay(scope).settings || {};
    const gameMessage = settings && settings.gameMessage && typeof settings.gameMessage === 'object'
      ? settings.gameMessage
      : {};
    const raw = gameMessage.originAwareLineBreaks;
    return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
  }

  function createBreakMap(rawText) {
    const breaks = [];
    const markedText = String(rawText || '').replace(/\r\n?|\n/g, (value) => {
      const token = `${BREAK_SENTINEL_PREFIX}${breaks.length}${BREAK_SENTINEL_SUFFIX}`;
      breaks.push({ token, value });
      return token;
    });
    return {
      markedText,
      breaks,
      hadHardMessageBreaks: breaks.length > 0,
    };
  }

  function normalizeConvertedMessageText(convertedText, breakMap) {
    if (!breakMap || !Array.isArray(breakMap.breaks)) {
      return { reliable: false, text: String(convertedText || '') };
    }
    for (const item of breakMap.breaks) {
      if (!item || countTokenOccurrences(convertedText, item.token) !== 1) {
        return { reliable: false, text: String(convertedText || '') };
      }
    }
    let text = collapseGameMessageSoftBreaks(convertedText);
    for (const item of breakMap.breaks) {
      text = text.replace(item.token, item.value);
    }
    return { reliable: true, text };
  }

  function countTokenOccurrences(text, token) {
    if (!token) return 0;
    let count = 0;
    let index = String(text || '').indexOf(token);
    while (index !== -1) {
      count += 1;
      index = String(text || '').indexOf(token, index + token.length);
    }
    return count;
  }

  function collapseGameMessageSoftBreaks(text) {
    const source = String(text || '');
    return source
      .replace(/[ \t\v]*\r?\n[ \t\v]*/g, (match, offset) => {
        const before = previousNonHorizontalWhitespace(source, offset);
        const after = nextNonHorizontalWhitespace(source, offset + match.length);
        return shouldJoinSoftBreakWithoutSpace(before, after) ? '' : ' ';
      })
      .replace(/[ \t\v]{2,}/g, ' ');
  }

  function previousNonHorizontalWhitespace(text, index) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const character = text.charAt(cursor);
      if (character !== ' ' && character !== '\t' && character !== '\v') return character;
    }
    return '';
  }

  function nextNonHorizontalWhitespace(text, index) {
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const character = text.charAt(cursor);
      if (character !== ' ' && character !== '\t' && character !== '\v') return character;
    }
    return '';
  }

  function shouldJoinSoftBreakWithoutSpace(before, after) {
    if (!before || !after) return true;
    if (before.indexOf(BREAK_SENTINEL_SUFFIX) !== -1 || after.indexOf(BREAK_SENTINEL_PREFIX) !== -1) return true;
    return isCjkCharacter(before) && isCjkCharacter(after);
  }

  function isCjkCharacter(character) {
    const code = String(character || '').codePointAt(0);
    return Number.isFinite(code) && (
      (code >= 0x1100 && code <= 0x11ff)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff01 && code <= 0xff60)
    );
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

  function installPendingRedrawHook(prototype, scope) {
    if (!prototype || typeof prototype.update !== 'function') return false;
    if (prototype.update.__rpgTranslatorMessagePendingRedraw === LIFECYCLE_TOKEN) return true;
    const original = prototype.update;
    prototype.update = function messageUpdateWithPendingRedraw(...args) {
      const result = original.apply(this, args);
      applyPendingMessageRedraw(scope, this);
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
        clearMessageOrigin(this);
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
        clearMessageOrigin(this);
        return original.apply(this, args);
      };
      message.clear.__rpgTranslatorOriginal = original;
      message.clear.__rpgTranslatorMessageClear = CLEAR_TOKEN;
    }
  }

  function installForesightOriginHooks(scope) {
    const interpreterPrototype = scope && scope.Game_Interpreter && scope.Game_Interpreter.prototype;
    if (interpreterPrototype
      && typeof interpreterPrototype.command101 === 'function'
      && interpreterPrototype.command101.__rpgTranslatorMessageOrigin !== FORESIGHT_ORIGIN_TOKEN) {
      const original = interpreterPrototype.command101;
      interpreterPrototype.command101 = function command101WithMessageOrigin(...args) {
        const pendingOrigin = createPendingMessageOrigin(scope, this);
        if (pendingOrigin) clearMessageOrigin(pendingOrigin.gameMessage);
        const result = original.apply(this, args);
        if (pendingOrigin) attachCompletedMessageOrigin(scope, pendingOrigin);
        return result;
      };
      interpreterPrototype.command101.__rpgTranslatorOriginal = original;
      interpreterPrototype.command101.__rpgTranslatorMessageOrigin = FORESIGHT_ORIGIN_TOKEN;
    }

    const messagePrototype = scope && scope.Game_Message && scope.Game_Message.prototype;
    if (messagePrototype
      && typeof messagePrototype.add === 'function'
      && messagePrototype.add.__rpgTranslatorMessageOrigin !== FORESIGHT_ORIGIN_TOKEN) {
      const original = messagePrototype.add;
      messagePrototype.add = function addWithMessageOrigin(...args) {
        const result = original.apply(this, args);
        attachGameMessageAddOrigin(scope, this);
        return result;
      };
      messagePrototype.add.__rpgTranslatorOriginal = original;
      messagePrototype.add.__rpgTranslatorMessageOrigin = FORESIGHT_ORIGIN_TOKEN;
    }
  }

  function createPendingMessageOrigin(scope, interpreter) {
    const gameMessage = scope && scope.$gameMessage;
    if (!gameMessage || !interpreter || !Array.isArray(interpreter._list)) return null;
    if (typeof gameMessage.isBusy === 'function' && gameMessage.isBusy()) return null;
    const startIndex = integerIndex(interpreter._index);
    if (startIndex === null || startIndex < 0 || startIndex >= interpreter._list.length) return null;
    const command = interpreter._list[startIndex];
    if (!command || Number(command.code) !== 101) return null;
    return {
      gameMessage,
      interpreter,
      list: interpreter._list,
      startIndex,
      indent: Number(command.indent) || 0,
    };
  }

  function attachCompletedMessageOrigin(scope, pendingOrigin) {
    if (!pendingOrigin || !pendingOrigin.gameMessage || pendingOrigin.interpreter._list !== pendingOrigin.list) return false;
    const command = pendingOrigin.list[pendingOrigin.startIndex];
    if (!command || Number(command.code) !== 101 || (Number(command.indent) || 0) !== pendingOrigin.indent) return false;
    const block = parseMessageOriginBlock(pendingOrigin.list, pendingOrigin.startIndex, pendingOrigin.indent);
    if (!block || !String(block.rawText || '').trim()) return false;
    pendingOrigin.gameMessage._trMessageOrigin = {
      gameMessage: pendingOrigin.gameMessage,
      interpreter: pendingOrigin.interpreter,
      interpreterId: getInterpreterOriginId(scope, pendingOrigin.interpreter),
      listId: getInterpreterOriginId(scope, pendingOrigin.interpreter),
      commonEventId: null,
      commonEventName: '',
      list: pendingOrigin.list,
      startIndex: pendingOrigin.startIndex,
      nextIndex: block.nextIndex,
      indent: pendingOrigin.indent,
      rawText: block.rawText,
      frames: [],
      createdAt: Date.now(),
    };
    return true;
  }

  function attachGameMessageAddOrigin(scope, gameMessage) {
    if (!gameMessage) return false;
    const rawText = readMessageBlock(gameMessage);
    if (!String(rawText || '').trim()) return false;
    gameMessage._trMessageOrigin = {
      gameMessage,
      interpreter: null,
      interpreterId: getInterpreterOriginId(scope, null),
      listId: getInterpreterOriginId(scope, null),
      commonEventId: null,
      commonEventName: '',
      list: [],
      startIndex: 0,
      nextIndex: 0,
      indent: 0,
      rawText,
      originKind: 'game-message-add',
      verified: true,
      frames: [],
      createdAt: Date.now(),
    };
    return true;
  }

  function parseMessageOriginBlock(list, startIndex, indent) {
    if (!Array.isArray(list)) return null;
    const numericStart = integerIndex(startIndex);
    if (numericStart === null || numericStart < 0 || numericStart >= list.length) return null;
    const command = list[numericStart];
    if (!command || Number(command.code) !== 101 || (Number(command.indent) || 0) !== indent) return null;
    const lines = [];
    let nextIndex = numericStart + 1;
    while (nextIndex < list.length) {
      const next = list[nextIndex];
      if (!next || Number(next.code) !== 401 || (Number(next.indent) || 0) !== indent) break;
      const params = Array.isArray(next.parameters) ? next.parameters : [];
      lines.push(String(params[0] ?? ''));
      nextIndex += 1;
    }
    return { nextIndex, rawText: lines.join('\n') };
  }

  function clearMessageOrigin(gameMessage) {
    if (gameMessage) gameMessage._trMessageOrigin = null;
  }

  function getInterpreterOriginId(scope, interpreter) {
    if (scope && scope.$gameMap && scope.$gameMap._interpreter === interpreter) return 'map';
    if (scope && scope.$gameTroop && scope.$gameTroop._interpreter === interpreter) return 'troop';
    const commonEvents = scope && scope.$gameMap && scope.$gameMap._commonEvents;
    if (Array.isArray(commonEvents)) {
      for (let index = 0; index < commonEvents.length; index += 1) {
        if (commonEvents[index] && commonEvents[index]._interpreter === interpreter) return `common:${index}`;
      }
    }
    return 'attached';
  }

  function integerIndex(value) {
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
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

  function redrawMessageFallback(scope, windowInstance, translated, originalText) {
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
    if (drawNativeMessageReplay(scope, windowInstance, translated, originalText)) return true;
    return drawMessageTextExFallback(scope, windowInstance, translated, originalText);
  }

  function applyPendingMessageRedraw(scope, windowInstance) {
    const state = getState(windowInstance);
    const pending = state && state.pendingRedraw ? state.pendingRedraw : null;
    if (!pending || !isMessageWindowReady(windowInstance)) return false;
    state.pendingRedraw = null;
    if (drawNativeMessageReplay(scope, windowInstance, pending.text, pending.originalText)) return true;
    return drawMessageTextExFallback(scope, windowInstance, pending.text, pending.originalText);
  }

  function drawNativeMessageReplay(scope, windowInstance, translated, originalText) {
    if (!canUseNativeMessageReplay(windowInstance)) return false;
    const text = redrawText(translated, originalText, windowInstance);
    const scaleScope = createMessageTextScaleScope(scope, windowInstance);
    const textState = createNativeTextState(windowInstance, text);
    const previousPause = !!windowInstance.pause;
    const previousWaitCount = finiteNumber(windowInstance._waitCount, 0);
    windowInstance.__rpgTranslatorMessageRedrawDepth = (windowInstance.__rpgTranslatorMessageRedrawDepth || 0) + 1;
    try {
      windowInstance._textState = textState;
      windowInstance.newPage(textState);
      if (typeof windowInstance.updatePlacement === 'function') windowInstance.updatePlacement();
      if (typeof windowInstance.updateBackground === 'function') windowInstance.updateBackground();
      if (typeof windowInstance.open === 'function') windowInstance.open();
      drawMessageFaceIfReady(windowInstance);
      windowInstance._trMsgStartX = finiteNumber(textState.startX, finiteNumber(textState.left, finiteNumber(textState.x, 0)));
      windowInstance._trMsgStartY = finiteNumber(textState.startY, finiteNumber(textState.y, 0));
      windowInstance._trWrappedMessageText = String(textState.text || text || '');
      return flushNativeMessageText(windowInstance, textState);
    } catch (_error) {
      windowInstance.pause = previousPause;
      windowInstance._waitCount = previousWaitCount;
      return false;
    } finally {
      if (scaleScope && typeof scaleScope.restore === 'function') scaleScope.restore();
      windowInstance.__rpgTranslatorMessageRedrawDepth = Math.max(0, (windowInstance.__rpgTranslatorMessageRedrawDepth || 1) - 1);
    }
  }

  function canUseNativeMessageReplay(windowInstance) {
    if (!windowInstance || !windowInstance.contents) return false;
    if (typeof windowInstance.newPage !== 'function'
      || typeof windowInstance.processCharacter !== 'function'
      || typeof windowInstance.isEndOfText !== 'function'
      || typeof windowInstance.onEndOfText !== 'function') {
      return false;
    }
    return !(typeof windowInstance.isAnySubWindowActive === 'function' && windowInstance.isAnySubWindowActive());
  }

  function createNativeTextState(windowInstance, text) {
    const x = finiteNumber(windowInstance._trMsgStartX, 0);
    const y = finiteNumber(windowInstance._trMsgStartY, 0);
    if (typeof windowInstance.createTextState === 'function') {
      const textState = windowInstance.createTextState(String(text || ''), 0, y, 0);
      const startX = Number.isFinite(x)
        ? x
        : (typeof windowInstance.newLineX === 'function' ? finiteNumber(windowInstance.newLineX(textState), 0) : 0);
      textState.x = startX;
      textState.startX = startX;
      textState.y = y;
      if (typeof textState.startY === 'number') textState.startY = y;
      if (typeof textState.index !== 'number') textState.index = 0;
      if (typeof textState.text !== 'string') textState.text = String(text || '');
      return textState;
    }
    return { index: 0, text: String(text || ''), x, y, startX: x, startY: y };
  }

  function flushNativeMessageText(windowInstance, textState) {
    if (!windowInstance || !textState) return false;
    windowInstance.pause = false;
    windowInstance._waitCount = 0;
    windowInstance._showFast = true;
    while (windowInstance._textState && !windowInstance.isEndOfText(textState)) {
      if (typeof windowInstance.needsNewPage === 'function' && windowInstance.needsNewPage(textState)) {
        windowInstance.newPage(textState);
        windowInstance._showFast = true;
        drawMessageFaceIfReady(windowInstance);
      }
      windowInstance.processCharacter(textState);
      if (windowInstance.pause || windowInstance._waitCount > 0) break;
    }
    if (typeof windowInstance.flushTextState === 'function') windowInstance.flushTextState(textState);
    const isWaiting = typeof windowInstance.isWaiting === 'function'
      ? windowInstance.isWaiting()
      : (windowInstance.pause || windowInstance._waitCount > 0);
    if (windowInstance._textState && windowInstance.isEndOfText(textState) && !isWaiting) {
      windowInstance.onEndOfText();
    }
    windowInstance._showFast = true;
    windowInstance._lineShowFast = true;
    return true;
  }

  function drawMessageTextExFallback(scope, windowInstance, translated, originalText) {
    if (!windowInstance || typeof windowInstance.drawTextEx !== 'function') return false;
    const contents = windowInstance.contents;
    if (contents && typeof contents.clear === 'function') {
      try { contents.clear(); } catch (_) {}
    }
    if (typeof windowInstance.resetFontSettings === 'function') windowInstance.resetFontSettings();
    drawMessageFaceIfNeeded(windowInstance);
    const scaleScope = createMessageTextScaleScope(scope, windowInstance);
    const text = redrawText(translated, originalText, windowInstance);
    const x = finiteNumber(windowInstance._trMsgStartX, 0);
    const y = finiteNumber(windowInstance._trMsgStartY, 0);
    windowInstance.__rpgTranslatorMessageRedrawDepth = (windowInstance.__rpgTranslatorMessageRedrawDepth || 0) + 1;
    try {
      windowInstance.drawTextEx(text, x, y);
    } finally {
      if (scaleScope && typeof scaleScope.restore === 'function') scaleScope.restore();
      windowInstance.__rpgTranslatorMessageRedrawDepth = Math.max(0, (windowInstance.__rpgTranslatorMessageRedrawDepth || 1) - 1);
    }
    return true;
  }

  function drawMessageFaceIfReady(windowInstance) {
    if (!windowInstance || !windowInstance._faceBitmap) return false;
    try {
      if (typeof windowInstance._faceBitmap.isReady === 'function' && windowInstance._faceBitmap.isReady()) {
        const drawn = drawMessageFaceIfNeeded(windowInstance);
        if (drawn) windowInstance._faceBitmap = null;
        return drawn;
      }
    } catch (_) {}
    return false;
  }

  function createMessageTextScaleScope(scope, windowInstance) {
    const scalePercent = resolveMessageTextScale(scope);
    if (!windowInstance || !windowInstance.contents || !shouldScaleText(scalePercent)) return null;

    const contents = windowInstance.contents;
    const originalState = captureBitmapDrawState(contents);
    const originalResetFontSettings = windowInstance.resetFontSettings;
    const hadOwnReset = Object.prototype.hasOwnProperty.call(windowInstance, 'resetFontSettings');
    const originalMakeFontBigger = windowInstance.makeFontBigger;
    const hadOwnBigger = Object.prototype.hasOwnProperty.call(windowInstance, 'makeFontBigger');
    const originalMakeFontSmaller = windowInstance.makeFontSmaller;
    const hadOwnSmaller = Object.prototype.hasOwnProperty.call(windowInstance, 'makeFontSmaller');
    let logicalFontSize = positiveNumber(contents.fontSize, null);

    const refreshLogicalFontSize = () => {
      const current = positiveNumber(contents.fontSize, null);
      if (current !== null) logicalFontSize = current;
    };
    const applyScaledFontSize = () => {
      if (logicalFontSize === null) return;
      contents.fontSize = scaleFontSizeValue(logicalFontSize, scalePercent);
    };
    const invokeWithLogicalFontSize = (original, context, args) => {
      if (logicalFontSize !== null) contents.fontSize = logicalFontSize;
      const result = original.apply(context, args);
      refreshLogicalFontSize();
      applyScaledFontSize();
      return result;
    };

    if (typeof originalResetFontSettings === 'function') {
      windowInstance.resetFontSettings = function resetFontSettingsWithMessageTextScale(...args) {
        const result = originalResetFontSettings.apply(this, args);
        refreshLogicalFontSize();
        applyScaledFontSize();
        return result;
      };
    }
    if (typeof originalMakeFontBigger === 'function') {
      windowInstance.makeFontBigger = function makeFontBiggerWithMessageTextScale(...args) {
        return invokeWithLogicalFontSize(originalMakeFontBigger, this, args);
      };
    }
    if (typeof originalMakeFontSmaller === 'function') {
      windowInstance.makeFontSmaller = function makeFontSmallerWithMessageTextScale(...args) {
        return invokeWithLogicalFontSize(originalMakeFontSmaller, this, args);
      };
    }

    applyScaledFontSize();
    return {
      restore() {
        restoreWrappedMethod(windowInstance, 'resetFontSettings', originalResetFontSettings, hadOwnReset);
        restoreWrappedMethod(windowInstance, 'makeFontBigger', originalMakeFontBigger, hadOwnBigger);
        restoreWrappedMethod(windowInstance, 'makeFontSmaller', originalMakeFontSmaller, hadOwnSmaller);
        applyBitmapDrawState(contents, originalState);
      },
    };
  }

  function resolveMessageTextScale(scope) {
    const overlayApi = overlay(scope);
    const settings = overlayApi.config || overlayApi.settings || {};
    const gameMessage = settings && settings.gameMessage && typeof settings.gameMessage === 'object'
      ? settings.gameMessage
      : {};
    const candidates = [
      gameMessage.textScale,
      gameMessage.text_scale,
      settings.messageTextScale,
      settings.message_text_scale,
      settings.textScaleMessage,
      settings.text_scale_message,
      overlayApi.messageTextScalePercent,
      overlayApi.textScalePercent,
      settings.textScale,
      settings.text_scale,
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) return numeric;
    }
    return 100;
  }

  function shouldScaleText(scalePercent) {
    return Number.isInteger(scalePercent) && scalePercent > 0 && scalePercent < 100;
  }

  function scaleFontSizeValue(value, scalePercent) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return value;
    return Math.max(1, Math.round(numeric * (scalePercent / 100)));
  }

  function captureBitmapDrawState(bitmap) {
    if (!bitmap) return null;
    const state = {};
    let hasAny = false;
    for (const key of ['fontFace', 'fontSize', 'fontBold', 'fontItalic', 'textColor', 'outlineColor', 'outlineWidth', 'paintOpacity']) {
      if (bitmap[key] !== undefined) {
        state[key] = bitmap[key];
        hasAny = true;
      }
    }
    return hasAny ? state : null;
  }

  function applyBitmapDrawState(bitmap, state) {
    if (!bitmap || !state) return;
    for (const [key, value] of Object.entries(state)) {
      try { bitmap[key] = value; } catch (_) {}
    }
  }

  function restoreWrappedMethod(target, name, original, hadOwnProperty) {
    try {
      if (hadOwnProperty) {
        target[name] = original;
      } else {
        delete target[name];
      }
    } catch (_) {}
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
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
