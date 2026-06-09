(function attach(root) {
  const DEFAULT_MAX_BLOCKS = 24;
  const DEFAULT_MAX_COMMANDS = 512;
  const DEFAULT_MAX_BRANCH_DEPTH = 8;

  class ForesightScanner {
    constructor(index, options = {}) {
      this.index = index || null;
      this.engine = options.engine || 'unknown';
      this.sourceLanguage = options.sourceLanguage || '';
      this.targetLanguage = options.targetLanguage || '';
      this.commonEvents = options.commonEvents || (root && root.$dataCommonEvents) || {};
      this.maxBlocks = positiveInteger(options.maxBlocks, DEFAULT_MAX_BLOCKS);
      this.maxCommands = positiveInteger(options.maxCommands, DEFAULT_MAX_COMMANDS);
      this.maxBranchDepth = positiveInteger(options.maxBranchDepth, DEFAULT_MAX_BRANCH_DEPTH);
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
        branchDepth: 0,
        branchPath: [],
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
    const endIndex = Number.isFinite(Number(frame.endIndex))
      ? Math.max(0, Math.floor(Number(frame.endIndex)))
      : list.length;
    while (index < list.length && index < endIndex && blocks.length < scanner.maxBlocks && diagnostics.scanned_commands < scanner.maxCommands) {
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
        const branchRead = readChoiceBranches(list, index, command);
        if (branchRead && branchRead.targets.length) {
          index = scanBranchTargets(scanner, frame, stack, blocks, diagnostics, branchRead, 'choice');
          continue;
        }
        index += 1;
        continue;
      }
      if (code === 111) {
        const branchRead = readConditionalBranches(list, index, command);
        if (branchRead && branchRead.targets.length) {
          index = scanBranchTargets(scanner, frame, stack, blocks, diagnostics, branchRead, 'conditional');
          continue;
        }
        diagnostics.stop_reason = 'branch-structure-desync';
        appendPathStop(diagnostics, {
          index,
          stop_reason: 'branch-structure-desync',
          branch_depth: frame.branchDepth || 0,
          branch_path: cloneBranchPath(frame.branchPath),
          code,
          label: 'Conditional Branch',
        });
        return;
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
            ...inheritBranchContext(frame),
          });
          stack.push({
            list: commonEvent.list,
            index: 0,
            indent: 0,
            listId: `common:${commonEventId}`,
            commonStack: cloneCommonStack(frame.commonStack).concat(commonEventId),
            ...inheritBranchContext(frame),
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
    const branchMetadata = createBranchMetadata(frame);
    return {
      kind,
      rawText,
      translation: lookup.translation,
      cacheStatus: lookup.cacheStatus,
      listId: frame.listId || '',
      commandIndex: index,
      metadata: Object.assign({}, metadata || {}, branchMetadata),
    };
  }

  function scanBranchTargets(scanner, frame, stack, blocks, diagnostics, branchRead, branchKind) {
    const parentDepth = Math.max(0, Math.floor(Number(frame.branchDepth) || 0));
    if (parentDepth >= scanner.maxBranchDepth) {
      diagnostics.stop_reason = 'branch-depth-limit';
      appendPathStop(diagnostics, {
        index: branchRead.ownerIndex,
        stop_reason: 'branch-depth-limit',
        branch_depth: parentDepth,
        branch_path: cloneBranchPath(frame.branchPath),
        code: branchKind === 'conditional' ? 111 : 102,
        label: branchKind,
      });
      return branchRead.joinIndex;
    }
    const branchCount = branchRead.targets.length;
    diagnostics.branch_paths += branchCount;
    branchRead.targets.forEach((target, branchIndex) => {
      if (blocks.length >= scanner.maxBlocks || diagnostics.scanned_commands >= scanner.maxCommands) return;
      const branchPath = cloneBranchPath(frame.branchPath).concat(branchIndex);
      const branchFrame = {
        list: frame.list,
        index: target.startIndex,
        endIndex: target.endIndex,
        indent: target.bodyIndent,
        listId: `${frame.listId || 'event'}:branch:${target.ownerIndex}:${branchIndex}`,
        commonStack: cloneCommonStack(frame.commonStack),
        branchKind,
        branchDepth: parentDepth + 1,
        branchPath,
        branchIndex,
        branchCount,
        branchLabel: target.label,
        parentCommandIndex: target.ownerIndex,
      };
      scanFrame(scanner, branchFrame, stack, blocks, diagnostics);
      appendPathStop(diagnostics, {
        index: target.endIndex,
        stop_reason: 'branch-end',
        branch_depth: branchFrame.branchDepth,
        branch_path: branchPath,
        code: branchKind === 'conditional' ? 111 : 102,
        label: target.label,
      });
    });
    return branchRead.joinIndex;
  }

  function readChoiceBranches(list, index, command) {
    const expectedIndent = readIndent(command);
    const endIndex = findBranchEndIndex(list, index, expectedIndent, 404);
    if (endIndex === null) return null;
    const branchCodes = new Set([402, 403]);
    const targets = [];
    for (let cursor = index + 1; cursor < endIndex; cursor += 1) {
      const candidate = list[cursor];
      if (!isCommand(candidate)) return null;
      const indent = readIndent(candidate);
      if (indent < expectedIndent) return null;
      if (indent !== expectedIndent) continue;
      const code = Number(candidate.code);
      if (!branchCodes.has(code)) return null;
      targets.push(createBranchTarget(list, cursor, index, expectedIndent, endIndex, branchCodes, 404, targets.length));
    }
    if (!targets.length) return null;
    return { ownerIndex: index, targets, joinIndex: endIndex + 1 };
  }

  function readConditionalBranches(list, index, command) {
    const expectedIndent = readIndent(command);
    const endIndex = findBranchEndIndex(list, index, expectedIndent, 412);
    if (endIndex === null) return null;
    let elseIndex = null;
    for (let cursor = index + 1; cursor < endIndex; cursor += 1) {
      const candidate = list[cursor];
      if (!isCommand(candidate)) return null;
      const indent = readIndent(candidate);
      if (indent < expectedIndent) return null;
      if (indent !== expectedIndent) continue;
      if (Number(candidate.code) !== 411 || elseIndex !== null) return null;
      elseIndex = cursor;
    }
    const joinIndex = endIndex + 1;
    return {
      ownerIndex: index,
      targets: [
        {
          ownerIndex: index,
          startIndex: index + 1,
          endIndex: elseIndex === null ? endIndex : elseIndex,
          joinIndex,
          bodyIndent: expectedIndent + 1,
          label: 'Condition true',
        },
        {
          ownerIndex: index,
          startIndex: elseIndex === null ? endIndex : elseIndex + 1,
          endIndex,
          joinIndex,
          bodyIndent: expectedIndent + 1,
          label: elseIndex === null ? 'Condition false' : getBranchHeaderLabel(list[elseIndex], 'Condition false'),
        },
      ],
      joinIndex,
    };
  }

  function findBranchEndIndex(list, index, expectedIndent, endCode) {
    if (!Array.isArray(list)) return null;
    for (let cursor = index + 1; cursor < list.length; cursor += 1) {
      const command = list[cursor];
      if (!isCommand(command)) return null;
      const indent = readIndent(command);
      if (indent < expectedIndent) return null;
      if (indent === expectedIndent && Number(command.code) === Number(endCode)) return cursor;
    }
    return null;
  }

  function createBranchTarget(list, headerIndex, ownerIndex, expectedIndent, endIndex, branchCodes, endCode, branchIndex) {
    const nextBoundary = findNextBranchBoundary(list, headerIndex + 1, expectedIndent, endIndex, branchCodes, endCode);
    return {
      ownerIndex,
      startIndex: headerIndex + 1,
      endIndex: nextBoundary === null ? endIndex : nextBoundary,
      joinIndex: endIndex + 1,
      bodyIndent: expectedIndent + 1,
      label: getBranchHeaderLabel(list[headerIndex], `Branch ${branchIndex + 1}`),
    };
  }

  function findNextBranchBoundary(list, startIndex, expectedIndent, endIndex, branchCodes, endCode) {
    for (let cursor = startIndex; cursor <= endIndex && cursor < list.length; cursor += 1) {
      const command = list[cursor];
      if (!isCommand(command)) return null;
      const indent = readIndent(command);
      if (indent < expectedIndent) return null;
      if (indent !== expectedIndent) continue;
      const code = Number(command.code);
      if (code === Number(endCode) || branchCodes.has(code)) return cursor;
    }
    return null;
  }

  function getBranchHeaderLabel(command, fallback) {
    const code = Number(command && command.code);
    const params = Array.isArray(command && command.parameters) ? command.parameters : [];
    if (code === 402) return nonEmptyString(params[1]) || fallback;
    if (code === 403) return 'Cancel';
    if (code === 411) return 'Condition false';
    return fallback;
  }

  function createBranchMetadata(frame) {
    if (!frame || !frame.branchKind) return {};
    return {
      branchKind: frame.branchKind,
      branchDepth: Math.max(0, Math.floor(Number(frame.branchDepth) || 0)),
      branchPath: cloneBranchPath(frame.branchPath),
      branchIndex: Math.max(0, Math.floor(Number(frame.branchIndex) || 0)),
      branchCount: Math.max(0, Math.floor(Number(frame.branchCount) || 0)),
      branchLabel: frame.branchLabel || '',
      parentCommandIndex: Math.max(0, Math.floor(Number(frame.parentCommandIndex) || 0)),
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
      branch_paths: 0,
      path_stops: [],
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
      branch_paths: diagnostics.branch_paths || 0,
      path_stops: Array.isArray(diagnostics.path_stops)
        ? diagnostics.path_stops.map((stop) => Object.assign({}, stop, {
          branch_path: cloneBranchPath(stop.branch_path),
        }))
        : [],
    };
  }

  function isCommand(command) {
    return command && typeof command === 'object' && Number.isFinite(Number(command.code));
  }

  function cloneCommonStack(stack) {
    return Array.isArray(stack) ? stack.slice() : [];
  }

  function inheritBranchContext(frame) {
    const context = {
      branchDepth: Math.max(0, Math.floor(Number(frame && frame.branchDepth) || 0)),
      branchPath: cloneBranchPath(frame && frame.branchPath),
    };
    if (frame && frame.branchKind) {
      context.branchKind = frame.branchKind;
      context.branchIndex = Math.max(0, Math.floor(Number(frame.branchIndex) || 0));
      context.branchCount = Math.max(0, Math.floor(Number(frame.branchCount) || 0));
      context.branchLabel = frame.branchLabel || '';
      context.parentCommandIndex = Math.max(0, Math.floor(Number(frame.parentCommandIndex) || 0));
    }
    return context;
  }

  function appendPathStop(diagnostics, stop) {
    if (!diagnostics) return;
    if (!Array.isArray(diagnostics.path_stops)) diagnostics.path_stops = [];
    diagnostics.path_stops.push({
      index: Math.max(0, Math.floor(Number(stop && stop.index) || 0)),
      stop_reason: stop && stop.stop_reason ? String(stop.stop_reason) : '',
      branch_depth: Math.max(0, Math.floor(Number(stop && stop.branch_depth) || 0)),
      branch_path: cloneBranchPath(stop && stop.branch_path),
      code: Number.isFinite(Number(stop && stop.code)) ? Number(stop.code) : null,
      label: stop && stop.label ? String(stop.label) : '',
    });
  }

  function cloneBranchPath(path) {
    return Array.isArray(path)
      ? path.map((value) => Math.max(0, Math.floor(Number(value) || 0)))
      : [];
  }

  function readIndent(command) {
    return Math.max(0, Math.floor(Number(command && command.indent) || 0));
  }

  function nonEmptyString(value) {
    const text = String(value ?? '').trim();
    return text || '';
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
