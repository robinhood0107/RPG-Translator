(function attach(root) {
  const DEFAULT_MAX_BLOCKS = 24;
  const DEFAULT_MAX_COMMANDS = 512;

  class ForesightScanner {
    constructor(index, options = {}) {
      this.index = index || null;
      this.engine = options.engine || 'unknown';
      this.sourceLanguage = options.sourceLanguage || '';
      this.targetLanguage = options.targetLanguage || '';
      this.commonEvents = options.commonEvents || (root && root.$dataCommonEvents) || {};
      this.maxBlocks = positiveInteger(options.maxBlocks, DEFAULT_MAX_BLOCKS);
      this.maxCommands = positiveInteger(options.maxCommands, DEFAULT_MAX_COMMANDS);
      this.recentScans = [];
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.commandCounts = Object.create(null);
    }

    collectUpcomingMessageBlocks(input = {}) {
      const origin = resolveOrigin(input.currentMessageOrigin);
      const diagnostics = createDiagnostics(origin);
      if (!origin) {
        diagnostics.status = 'miss';
        diagnostics.stop_reason = 'current-message-unattached';
        this.recordScan(diagnostics);
        return [];
      }

      const blocks = [];
      const stack = [{
        list: origin.list,
        index: positiveInteger(origin.nextIndex, 0),
        indent: Number.isFinite(Number(origin.indent)) ? Number(origin.indent) : null,
        listId: origin.listId || origin.interpreterId || 'event',
        commonStack: cloneCommonStack(origin.commonStack || []),
      }];

      while (stack.length && blocks.length < this.maxBlocks && diagnostics.scanned_commands < this.maxCommands) {
        const frame = stack.pop();
        if (!frame || !Array.isArray(frame.list)) continue;
        scanFrame(this, frame, stack, blocks, diagnostics);
      }

      diagnostics.blocks = blocks.length;
      if (!diagnostics.stop_reason) diagnostics.stop_reason = diagnostics.scanned_commands >= this.maxCommands
        ? 'max-scan-commands'
        : blocks.length >= this.maxBlocks
          ? 'message-limit'
          : 'end-of-list';
      diagnostics.status = blocks.length ? 'scanned' : 'blocked';
      this.recordScan(diagnostics);
      return blocks;
    }

    getSnapshot() {
      return {
        cache_hits: this.cacheHits,
        cache_misses: this.cacheMisses,
        command_counts: Object.assign({}, this.commandCounts),
        recent_scans: this.recentScans.map((scan) => Object.assign({}, scan, {
          command_counts: Object.assign({}, scan.command_counts),
        })),
      };
    }

    snapshot() {
      return this.getSnapshot();
    }

    clearSnapshot() {
      this.recentScans = [];
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.commandCounts = Object.create(null);
      return this.getSnapshot();
    }

    lookup(text, metadata = {}) {
      const value = this.index && typeof this.index.translate === 'function'
        ? this.index.translate({
          engine: this.engine,
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          text,
          contextHash: metadata.contextHash || null,
        })
        : null;
      if (value && value !== text) {
        this.cacheHits += 1;
        return { cacheStatus: 'hit', translation: value };
      }
      this.cacheMisses += 1;
      return { cacheStatus: 'miss', translation: null };
    }

    incrementCommand(code, diagnostics) {
      const key = String(code);
      this.commandCounts[key] = (this.commandCounts[key] || 0) + 1;
      diagnostics.command_counts[key] = (diagnostics.command_counts[key] || 0) + 1;
    }

    recordScan(diagnostics) {
      this.recentScans.unshift(sanitizeDiagnostics(diagnostics));
      if (this.recentScans.length > 8) this.recentScans.pop();
    }
  }

  function scanFrame(scanner, frame, stack, blocks, diagnostics) {
    const list = frame.list;
    let index = Math.max(0, Math.floor(Number(frame.index) || 0));
    while (index < list.length && blocks.length < scanner.maxBlocks && diagnostics.scanned_commands < scanner.maxCommands) {
      const command = list[index];
      if (!isCommand(command)) {
        index += 1;
        continue;
      }
      const code = Number(command.code);
      scanner.incrementCommand(code, diagnostics);
      diagnostics.scanned_commands += 1;
      diagnostics.stop_index = index;
      if (code === 101) {
        const block = parseMessageBlock(list, index, command);
        if (block && block.rawText.trim()) {
          blocks.push(createBlock(scanner, block.rawText, 'message_block', frame, index, {
            lineCount: block.lines.length,
            fromCommonEvent: frame.listId && String(frame.listId).startsWith('common:'),
          }));
          index = block.nextIndex;
          continue;
        }
      }
      if (code === 102) {
        readChoices(command).forEach((choice, choiceIndex) => {
          if (blocks.length >= scanner.maxBlocks) return;
          blocks.push(createBlock(scanner, choice, 'choice', frame, index, { choiceIndex }));
        });
        index += 1;
        continue;
      }
      if (code === 117) {
        const commonEventId = readCommonEventId(command);
        const commonEvent = resolveCommonEvent(scanner.commonEvents, commonEventId);
        if (commonEvent && Array.isArray(commonEvent.list) && !frame.commonStack.includes(commonEventId)) {
          stack.push({
            list,
            index: index + 1,
            indent: frame.indent,
            listId: frame.listId,
            commonStack: cloneCommonStack(frame.commonStack),
          });
          stack.push({
            list: commonEvent.list,
            index: 0,
            indent: 0,
            listId: `common:${commonEventId}`,
            commonStack: cloneCommonStack(frame.commonStack).concat(commonEventId),
          });
          diagnostics.common_event_pushes += 1;
          return;
        }
        diagnostics.stop_reason = commonEvent ? 'common-event-recursion' : 'common-event-missing';
      }
      if (isBarrierCommand(code)) {
        diagnostics.stop_reason = `barrier-${code}`;
        return;
      }
      index += 1;
    }
  }

  function createBlock(scanner, rawText, kind, frame, index, metadata) {
    const lookup = scanner.lookup(rawText, metadata);
    return {
      kind,
      rawText,
      translation: lookup.translation,
      cacheStatus: lookup.cacheStatus,
      listId: frame.listId || '',
      commandIndex: index,
      metadata: Object.assign({}, metadata || {}),
    };
  }

  function parseMessageBlock(list, index, command) {
    const indent = Number(command && command.indent) || 0;
    const lines = [];
    let nextIndex = index + 1;
    while (nextIndex < list.length) {
      const next = list[nextIndex];
      if (!isCommand(next) || Number(next.code) !== 401 || (Number(next.indent) || 0) !== indent) break;
      const params = Array.isArray(next.parameters) ? next.parameters : [];
      lines.push(String(params[0] ?? ''));
      nextIndex += 1;
    }
    return { rawText: lines.join('\n'), lines, nextIndex };
  }

  function readChoices(command) {
    const params = Array.isArray(command && command.parameters) ? command.parameters : [];
    const first = params[0];
    if (Array.isArray(first)) return first.map((choice) => String(choice ?? '')).filter((choice) => choice.trim());
    return params.map((choice) => String(choice ?? '')).filter((choice) => choice.trim());
  }

  function readCommonEventId(command) {
    const params = Array.isArray(command && command.parameters) ? command.parameters : [];
    const id = Number(params[0]);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function resolveCommonEvent(commonEvents, id) {
    if (!id || !commonEvents) return null;
    if (Array.isArray(commonEvents)) return commonEvents[id] || null;
    return commonEvents[id] || commonEvents[String(id)] || null;
  }

  function isBarrierCommand(code) {
    return code === 201 || code === 205 || code === 301 || code === 351 || code === 352 || code === 353 || code === 354;
  }

  function resolveOrigin(origin) {
    if (!origin || !Array.isArray(origin.list)) return null;
    return origin;
  }

  function createDiagnostics(origin) {
    return {
      status: 'scanned',
      start_index: origin ? positiveInteger(origin.nextIndex, 0) : 0,
      stop_index: origin ? positiveInteger(origin.nextIndex, 0) : 0,
      stop_reason: '',
      blocks: 0,
      scanned_commands: 0,
      command_counts: Object.create(null),
      common_event_pushes: 0,
    };
  }

  function sanitizeDiagnostics(diagnostics) {
    return {
      status: diagnostics.status || '',
      start_index: diagnostics.start_index || 0,
      stop_index: diagnostics.stop_index || 0,
      stop_reason: diagnostics.stop_reason || '',
      blocks: diagnostics.blocks || 0,
      scanned_commands: diagnostics.scanned_commands || 0,
      command_counts: Object.assign({}, diagnostics.command_counts),
      common_event_pushes: diagnostics.common_event_pushes || 0,
    };
  }

  function isCommand(command) {
    return command && typeof command === 'object' && Number.isFinite(Number(command.code));
  }

  function cloneCommonStack(stack) {
    return Array.isArray(stack) ? stack.slice() : [];
  }

  function positiveInteger(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  publish(root, { ForesightScanner });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
