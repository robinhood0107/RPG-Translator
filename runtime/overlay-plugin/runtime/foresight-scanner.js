(function attach(root) {
  const DEFAULT_MAX_BLOCKS = 24;
  const DEFAULT_MAX_COMMANDS = 512;
  const DEFAULT_MAX_BRANCH_DEPTH = 8;
  const DEFAULT_MAX_NESTED_DEPTH = 8;
  const DEFAULT_MAX_NESTED_LISTS_PER_COMMAND = 8;
  const DEFAULT_MESSAGE_BUDGET_COST = 1;

  class ForesightScanner {
    constructor(index, options = {}) {
      this.index = index || null;
      this.engine = options.engine || 'unknown';
      this.sourceLanguage = options.sourceLanguage || '';
      this.targetLanguage = options.targetLanguage || '';
      this.commonEvents = options.commonEvents || (root && root.$dataCommonEvents) || {};
      this.commandCatalog = normalizeCommandCatalog(options.commandCatalog);
      this.maxBlocks = positiveInteger(options.maxBlocks, DEFAULT_MAX_BLOCKS);
      this.maxCommands = positiveInteger(options.maxCommands, DEFAULT_MAX_COMMANDS);
      this.maxBranchDepth = positiveInteger(options.maxBranchDepth, DEFAULT_MAX_BRANCH_DEPTH);
      this.maxNestedDepth = positiveInteger(options.maxNestedDepth, DEFAULT_MAX_NESTED_DEPTH);
      this.maxNestedListsPerCommand = positiveInteger(options.maxNestedListsPerCommand, DEFAULT_MAX_NESTED_LISTS_PER_COMMAND);
      this.budgetLimit = positiveInteger(options.budget, this.maxBlocks);
      this.recentScans = [];
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.commandCounts = Object.create(null);
    }

    collectUpcomingMessageBlocks(input = {}) {
      const origin = resolveOrigin(input.currentMessageOrigin);
      const diagnostics = createDiagnostics(origin, this.budgetLimit, this.maxBlocks);
      if (!origin) {
        diagnostics.status = 'miss';
        diagnostics.stop_reason = 'current-message-unattached';
        this.recordScan(diagnostics);
        return [];
      }

      const blocks = [];
      const stack = createInitialFrames(origin);

      while (
        stack.length
        && blocks.length < this.maxBlocks
        && diagnostics.scanned_commands < this.maxCommands
        && hasBudgetRemaining(diagnostics.budget)
      ) {
        const frame = stack.pop();
        if (!frame || !Array.isArray(frame.list)) continue;
        scanFrame(this, frame, stack, blocks, diagnostics);
      }

      diagnostics.blocks = blocks.length;
      if (!diagnostics.stop_reason) {
        const limitReason = selectLimitStopReason(this, diagnostics, blocks);
        if (limitReason) {
          diagnostics.stop_reason = limitReason;
          appendLimitPathStop(diagnostics, diagnostics.stop_index, limitReason);
        } else {
          diagnostics.stop_reason = 'end-of-list';
        }
      }
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

    getEventCommandMetadata(code) {
      return this.commandCatalog.eventCommands[String(Number(code))] || getEventCommandMetadata(code);
    }

    getMovementRouteCommandMetadata(code) {
      return this.commandCatalog.movementRouteCommands[String(Number(code))] || getMovementRouteCommandMetadata(code);
    }

    recordScan(diagnostics) {
      this.recentScans.unshift(sanitizeDiagnostics(diagnostics));
      if (this.recentScans.length > 8) this.recentScans.pop();
    }
  }

  function createInitialFrames(origin) {
    const frames = Array.isArray(origin && origin.frames)
      ? normalizeOriginFrames(origin.frames, origin)
      : [];
    if (frames.length) return frames;
    return [{
      list: origin.list,
      index: positiveInteger(origin.nextIndex, 0),
      indent: Number.isFinite(Number(origin.indent)) ? Number(origin.indent) : null,
      listId: origin.listId || origin.interpreterId || 'event',
      commonStack: cloneCommonStack(origin.commonStack || []),
      nestedDepth: 0,
      branchDepth: 0,
      branchPath: [],
    }];
  }

  function normalizeOriginFrames(frames, origin) {
    const normalized = [];
    const commonStack = cloneCommonStack(origin && origin.commonStack);
    for (const frame of frames) {
      const normalizedFrame = normalizeOriginFrame(frame, origin, commonStack);
      if (!normalizedFrame) continue;
      normalized.push(normalizedFrame);
      const commonEventId = positiveCommonEventId(frame && frame.commonEventId);
      if (commonEventId && !commonStack.includes(commonEventId)) {
        commonStack.push(commonEventId);
      }
    }
    return normalized;
  }

  function normalizeOriginFrame(frame, origin, commonStack) {
    if (!frame || !Array.isArray(frame.list)) return null;
    const index = integerOrFallback(frame.index, positiveInteger(origin && origin.nextIndex, 0));
    if (index < 0 || index > frame.list.length) return null;
    const indent = Number.isFinite(Number(frame.expectedIndent))
      ? Number(frame.expectedIndent)
      : Number.isFinite(Number(frame.indent))
        ? Number(frame.indent)
        : (Number.isFinite(Number(origin && origin.indent)) ? Number(origin.indent) : null);
    const normalized = {
      list: frame.list,
      index,
      indent,
      listId: frame.listId || frame.interpreterId || origin.listId || origin.interpreterId || 'event',
      commonStack: cloneCommonStack(commonStack),
      nestedDepth: Math.max(cloneCommonStack(commonStack).length, Math.max(0, Math.floor(Number(frame.nestedDepth) || 0))),
      branchDepth: Math.max(0, Math.floor(Number(frame.branchDepth ?? frame.resumeBranchDepth) || 0)),
      branchPath: cloneBranchPath(frame.branchPath || frame.resumeBranchPath),
    };
    if (Number.isFinite(Number(frame.endIndex))) normalized.endIndex = Math.max(0, Math.floor(Number(frame.endIndex)));
    if (frame.branchKind) {
      normalized.branchKind = frame.branchKind;
      normalized.branchIndex = Math.max(0, Math.floor(Number(frame.branchIndex) || 0));
      normalized.branchCount = Math.max(0, Math.floor(Number(frame.branchCount) || 0));
      normalized.branchLabel = frame.branchLabel || '';
      normalized.parentCommandIndex = Math.max(0, Math.floor(Number(frame.parentCommandIndex) || 0));
    }
    return normalized;
  }

  function integerOrFallback(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) ? number : fallback;
  }

  function positiveCommonEventId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
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
          spendBudget(diagnostics.budget, DEFAULT_MESSAGE_BUDGET_COST);
          diagnostics.stop_index = block.nextIndex;
          frame.index = block.nextIndex;
          const limitReason = selectLimitStopReason(scanner, diagnostics, blocks);
          if (limitReason) {
            diagnostics.stop_reason = limitReason;
            appendLimitPathStop(diagnostics, block.nextIndex, limitReason, frame);
            return;
          }
          index = block.nextIndex;
          continue;
        }
      }
      if (code === 102) {
        readChoices(command).forEach((choice, choiceIndex) => {
          if (blocks.length >= scanner.maxBlocks || !hasBudgetRemaining(diagnostics.budget)) return;
          blocks.push(createBlock(scanner, choice, 'choice', frame, index, { choiceIndex }));
          spendBudget(diagnostics.budget, DEFAULT_MESSAGE_BUDGET_COST);
        });
        const limitReason = selectLimitStopReason(scanner, diagnostics, blocks);
        if (limitReason) {
          diagnostics.stop_reason = limitReason;
          appendLimitPathStop(diagnostics, index + 1, limitReason, frame);
          return;
        }
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
      if (isControlFlowCommand(code)) {
        const target = resolveControlFlowTarget(list, index, command);
        diagnostics.stop_reason = target ? 'control-flow-target' : 'unsafe-control-flow';
        if (target) diagnostics.control_flow_targets += 1;
        appendPathStop(diagnostics, {
          index,
          stop_reason: diagnostics.stop_reason,
          branch_depth: frame.branchDepth || 0,
          branch_path: cloneBranchPath(frame.branchPath),
          code,
          label: getEventCommandLabel(code),
          control_flow_target: target,
        });
        return;
      }
      if (code === 205) {
        const routeRead = readMovementRouteCommand(scanner, list, index, readIndent(command));
        diagnostics.route_commands += 1;
        diagnostics.route_command_actions.push(...routeRead.route_command_actions);
        if (routeRead.transparent) {
          index = routeRead.nextIndex;
          continue;
        }
        diagnostics.stop_reason = routeRead.stop_reason || 'movement-route-barrier';
        diagnostics.route_barriers += 1;
        diagnostics.route_barrier_code = routeRead.route_barrier_code;
        diagnostics.route_barrier_reason = routeRead.route_barrier_reason || '';
        diagnostics.route_barrier_label = routeRead.route_barrier_label || '';
        appendPathStop(diagnostics, {
          index,
          stop_reason: diagnostics.stop_reason,
          branch_depth: frame.branchDepth || 0,
          branch_path: cloneBranchPath(frame.branchPath),
          code,
          label: getEventCommandLabel(code),
          route_barrier_code: diagnostics.route_barrier_code,
          route_barrier_reason: diagnostics.route_barrier_reason,
          route_barrier_label: diagnostics.route_barrier_label,
        });
        return;
      }
      if (code === 117) {
        const commonEventId = readCommonEventId(command);
        const commonEvent = resolveCommonEvent(scanner.commonEvents, commonEventId);
        const nestedList = createCommonEventNestedList(commonEventId, commonEvent, frame);
        const commonStack = cloneCommonStack(frame.commonStack);
        const nestedDepth = getFrameNestedDepth(frame);
        if (
          commonEventId
          && commonEvent
          && Array.isArray(commonEvent.list)
          && !commonStack.includes(commonEventId)
          && nestedDepth < scanner.maxNestedDepth
        ) {
          stack.push({
            list,
            index: index + 1,
            indent: frame.indent,
            listId: frame.listId,
            commonStack,
            nestedDepth,
            ...inheritBranchContext(frame),
          });
          stack.push({
            list: commonEvent.list,
            index: 0,
            indent: 0,
            listId: `common:${commonEventId}`,
            commonStack: commonStack.concat(commonEventId),
            nestedDepth: nestedDepth + 1,
            ...inheritBranchContext(frame),
          });
          diagnostics.common_event_pushes += 1;
          return;
        }
        if (!commonEventId) {
          diagnostics.stop_reason = 'common-event-missing-id';
        } else if (!commonEvent || !Array.isArray(commonEvent.list)) {
          diagnostics.stop_reason = 'common-event-missing-list';
        } else if (commonStack.includes(commonEventId)) {
          diagnostics.stop_reason = 'common-event-cycle';
        } else {
          diagnostics.stop_reason = 'common-event-depth-limit';
        }
        stack.length = 0;
        appendPathStop(diagnostics, {
          index,
          stop_reason: diagnostics.stop_reason,
          branch_depth: frame.branchDepth || 0,
          branch_path: cloneBranchPath(frame.branchPath),
          code,
          label: getEventCommandLabel(code),
          nested_list: nestedList,
        });
        return;
      }
      const metadata = scanner.getEventCommandMetadata(code);
      const canReadEmbeddedNestedList = metadata.scanBehavior === 'advance' || metadata.scanBehavior === 'nested-list';
      const nestedRead = canReadEmbeddedNestedList
        ? readEmbeddedNestedListCommand(scanner, list, index, command, metadata, frame)
        : null;
      if (nestedRead) {
        if (nestedRead.transparent) {
          recordCommandAction(diagnostics, metadata, { action: 'nested-list' });
          stack.push({
            list,
            index: index + 1,
            indent: frame.indent,
            listId: frame.listId,
            commonStack: cloneCommonStack(frame.commonStack),
            nestedDepth: getFrameNestedDepth(frame),
            ...inheritBranchContext(frame),
          });
          for (let nestedIndex = nestedRead.frames.length - 1; nestedIndex >= 0; nestedIndex -= 1) {
            stack.push(nestedRead.frames[nestedIndex]);
          }
          return;
        }
        recordCommandAction(diagnostics, metadata, {
          action: 'barrier',
          stop_reason: nestedRead.stop_reason,
          nested_list: nestedRead.nested_list,
        });
        diagnostics.stop_reason = nestedRead.stop_reason;
        stack.length = 0;
        appendPathStop(diagnostics, {
          index,
          stop_reason: diagnostics.stop_reason,
          branch_depth: frame.branchDepth || 0,
          branch_path: cloneBranchPath(frame.branchPath),
          code,
          label: metadata.label,
          nested_list: nestedRead.nested_list,
        });
        return;
      }
      if (metadata.scanBehavior === 'advance') {
        recordCommandAction(diagnostics, metadata);
        index += 1;
        continue;
      }
      if (metadata.scanBehavior === 'frame-end') {
        diagnostics.stop_reason = 'frame-end';
        appendPathStop(diagnostics, {
          index,
          stop_reason: diagnostics.stop_reason,
          branch_depth: frame.branchDepth || 0,
          branch_path: cloneBranchPath(frame.branchPath),
          code,
          label: metadata.label,
        });
        return;
      }
      diagnostics.stop_reason = metadata.scanBehavior === 'message-line' || metadata.scanBehavior === 'movement-route-line'
        ? 'orphan-continuation'
        : 'barrier-command';
      appendPathStop(diagnostics, {
        index,
        stop_reason: diagnostics.stop_reason,
        branch_depth: frame.branchDepth || 0,
        branch_path: cloneBranchPath(frame.branchPath),
        code,
        label: metadata.label,
      });
      if (metadata.scanBehavior === 'barrier') {
        recordCommandAction(diagnostics, metadata);
      }
      return;
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
      if (
        blocks.length >= scanner.maxBlocks
        || diagnostics.scanned_commands >= scanner.maxCommands
        || !hasBudgetRemaining(diagnostics.budget)
      ) return;
      const branchPath = cloneBranchPath(frame.branchPath).concat(branchIndex);
      const branchFrame = {
        list: frame.list,
        index: target.startIndex,
        endIndex: target.endIndex,
        indent: target.bodyIndent,
        listId: `${frame.listId || 'event'}:branch:${target.ownerIndex}:${branchIndex}`,
        commonStack: cloneCommonStack(frame.commonStack),
        nestedDepth: getFrameNestedDepth(frame),
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

  function readEmbeddedNestedListCommand(scanner, list, index, command, metadata, frame) {
    const specs = Array.isArray(metadata && metadata.nestedLists) ? metadata.nestedLists : [];
    if (!specs.length) {
      if (metadata && metadata.scanBehavior === 'nested-list') {
        return {
          transparent: false,
          stop_reason: 'nested-list-unavailable',
          nested_list: null,
        };
      }
      return null;
    }
    if (specs.length > scanner.maxNestedListsPerCommand) {
      return {
        transparent: false,
        stop_reason: 'nested-list-limit',
        nested_list: createEmbeddedNestedListInfo({ name: 'limit', path: '' }, frame, index, metadata, 0),
      };
    }

    const resolved = specs.map((spec) => resolveConfiguredNestedList(command, spec));
    const unavailable = resolved.find((entry) => !entry.list && !entry.optional);
    if (unavailable) {
      return {
        transparent: false,
        stop_reason: 'nested-list-unavailable',
        nested_list: createEmbeddedNestedListInfo(unavailable, frame, index, metadata, 0),
      };
    }

    const available = resolved.filter((entry) => Array.isArray(entry.list));
    if (!available.length) return null;
    if (getFrameNestedDepth(frame) >= scanner.maxNestedDepth) {
      return {
        transparent: false,
        stop_reason: 'nested-list-depth-limit',
        nested_list: createEmbeddedNestedListInfo(available[0], frame, index, metadata, 0),
      };
    }

    return {
      transparent: true,
      frames: available.map((entry, nestedIndex) => createEmbeddedNestedListFrame(entry, frame, index, metadata, nestedIndex)),
    };
  }

  function resolveConfiguredNestedList(command, spec) {
    const path = createDisplayNestedListPath(spec && spec.path);
    const resolved = resolveNestedListPath(command, path);
    return {
      list: resolved.found && isEventCommandList(resolved.value) ? resolved.value : null,
      path,
      name: nonEmptyString(spec && spec.name) || nestedListNameFromPath(path),
      optional: Boolean(spec && spec.optional),
    };
  }

  function resolveNestedListPath(command, path) {
    const segments = parseNestedListPath(path);
    if (!segments.length) return { found: false, value: null };
    let value = command;
    for (const segment of segments) {
      if (value === null || value === undefined) return { found: false, value: null };
      if (!Object.prototype.hasOwnProperty.call(Object(value), segment)) return { found: false, value: null };
      value = value[segment];
    }
    return { found: true, value };
  }

  function parseNestedListPath(path) {
    const source = nonEmptyString(path);
    if (!source) return [];
    const relative = source.indexOf('command.') === 0 ? source.slice('command.'.length) : source;
    const segments = [];
    let cursor = 0;
    while (cursor < relative.length) {
      if (relative[cursor] === '.') {
        cursor += 1;
        continue;
      }
      if (relative[cursor] === '[') {
        const end = relative.indexOf(']', cursor + 1);
        if (end < 0) return [];
        const indexText = relative.slice(cursor + 1, end);
        if (!/^\d+$/u.test(indexText)) return [];
        segments.push(Number(indexText));
        cursor = end + 1;
        continue;
      }
      if (!/[A-Za-z_$]/u.test(relative[cursor])) return [];
      let end = cursor + 1;
      while (end < relative.length && /[A-Za-z0-9_$]/u.test(relative[end])) end += 1;
      segments.push(relative.slice(cursor, end));
      cursor = end;
    }
    return segments;
  }

  function createEmbeddedNestedListFrame(entry, frame, parentCommandIndex, metadata, nestedIndex) {
    return {
      list: entry.list,
      index: 0,
      indent: 0,
      listId: `${frame.listId || 'event'}:nested:${parentCommandIndex}:${nestedIndex}`,
      commonStack: cloneCommonStack(frame.commonStack),
      nestedDepth: getFrameNestedDepth(frame) + 1,
      ...inheritBranchContext(frame),
    };
  }

  function createEmbeddedNestedListInfo(entry, frame, parentCommandIndex, metadata, nestedIndex) {
    return {
      type: 'embedded-event-list',
      id: null,
      name: nonEmptyString(entry && entry.name),
      path: nonEmptyString(entry && entry.path),
      index: nestedIndex,
      parentCode: Number(metadata && metadata.code),
      depth: getFrameNestedDepth(frame) + 1,
      length: Array.isArray(entry && entry.list) ? entry.list.length : 0,
      parentCommandIndex,
    };
  }

  function isEventCommandList(value) {
    return Array.isArray(value) && value.every(isCommand);
  }

  function createDisplayNestedListPath(path) {
    const source = nonEmptyString(path);
    if (!source) return '';
    return source.indexOf('command.') === 0 ? source : `command.${source}`;
  }

  function nestedListNameFromPath(path) {
    const source = nonEmptyString(path);
    if (!source) return '';
    const dotIndex = source.lastIndexOf('.');
    const bracketIndex = source.lastIndexOf('[');
    const splitIndex = Math.max(dotIndex, bracketIndex);
    return splitIndex >= 0 ? source.slice(splitIndex + 1).replace(/\]$/u, '') : source;
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

  function readMovementRouteCommand(scanner, list, index, expectedIndent) {
    const routeCommands = getMovementRouteCommands(list, index, expectedIndent);
    const nextIndex = getMovementRouteNextIndex(list, index, expectedIndent);
    const routeCommandActions = routeCommands.map((routeCommand) => createRouteCommandAction(scanner, routeCommand));
    if (!routeCommands.length) {
      return {
        transparent: false,
        stop_reason: 'movement-route-missing-list',
        route_barrier_code: null,
        route_barrier_reason: 'missing-list',
        route_barrier_label: 'Missing movement route',
        route_command_actions: routeCommandActions,
      };
    }
    const barrier = findRouteBarrierCommand(scanner, routeCommands);
    if (barrier) {
      return {
        transparent: false,
        stop_reason: 'movement-route-barrier',
        route_barrier_code: barrier.code,
        route_barrier_reason: barrier.reason,
        route_barrier_label: barrier.label,
        route_command_actions: routeCommandActions,
      };
    }
    return {
      transparent: true,
      nextIndex,
      route_command_actions: routeCommandActions,
    };
  }

  function getMovementRouteCommands(list, index, expectedIndent) {
    const command = list[index];
    const params = Array.isArray(command && command.parameters) ? command.parameters : [];
    const route = params[1] && typeof params[1] === 'object' ? params[1] : null;
    const commands = [];
    if (route && Array.isArray(route.list)) commands.push(...route.list);
    let cursor = index + 1;
    while (cursor < list.length && isMovementRouteLine(list[cursor], expectedIndent)) {
      const routeParams = Array.isArray(list[cursor].parameters) ? list[cursor].parameters : [];
      if (routeParams[0] && typeof routeParams[0] === 'object') commands.push(routeParams[0]);
      cursor += 1;
    }
    return commands;
  }

  function getMovementRouteNextIndex(list, index, expectedIndent) {
    let cursor = index + 1;
    while (cursor < list.length && isMovementRouteLine(list[cursor], expectedIndent)) cursor += 1;
    return cursor;
  }

  function isMovementRouteLine(command, expectedIndent) {
    return isCommand(command) && Number(command.code) === 505 && readIndent(command) === expectedIndent;
  }

  function findRouteBarrierCommand(scanner, routeCommands) {
    for (const routeCommand of routeCommands) {
      const code = Number(routeCommand && routeCommand.code);
      if (!Number.isFinite(code)) {
        return { code: null, reason: 'unknown', label: 'Unknown movement-route command' };
      }
      const metadata = scanner.getMovementRouteCommandMetadata(code);
      if (metadata.scanBehavior !== 'advance') {
        return {
          code,
          reason: metadata.reason || reasonFromLabel(metadata.label) || metadata.classification,
          label: metadata.label,
        };
      }
    }
    return null;
  }

  function createRouteCommandAction(scanner, routeCommand) {
    const code = Number(routeCommand && routeCommand.code);
    const metadata = scanner.getMovementRouteCommandMetadata(code);
    return {
      code: Number.isFinite(code) ? code : null,
      label: metadata.label,
      scan_behavior: metadata.scanBehavior,
      staleness_risk: metadata.stalenessRisk,
      reason: metadata.reason,
    };
  }

  function getMovementRouteCommandMetadata(code) {
    const numeric = Number(code);
    if (!Number.isFinite(numeric)) {
      return {
        code: null,
        label: 'Unknown movement-route command',
        classification: 'external',
        scanBehavior: 'barrier',
        stalenessRisk: 'external',
        reason: 'unknown',
      };
    }
    const labels = {
      0: 'Route End',
      1: 'Move Down',
      2: 'Move Left',
      3: 'Move Right',
      4: 'Move Up',
      41: 'Change Image',
      45: 'Script (runs JavaScript)',
    };
    if (numeric >= 0 && numeric <= 45) {
      return {
        code: numeric,
        label: labels[numeric] || `Movement Route Command ${numeric}`,
        classification: numeric === 45 ? 'external' : 'linear',
        scanBehavior: 'advance',
        stalenessRisk: numeric === 27 || numeric === 28 ? 'state' : (numeric === 45 ? 'external' : ''),
        reason: numeric === 45 ? 'script' : '',
      };
    }
    return {
      code: numeric,
      label: `Unknown movement-route command ${numeric}`,
      classification: 'external',
      scanBehavior: 'barrier',
      stalenessRisk: 'external',
      reason: 'unknown',
    };
  }

  function isControlFlowCommand(code) {
    return code === 112 || code === 113 || code === 119 || code === 413;
  }

  function resolveControlFlowTarget(list, index, command) {
    const code = Number(command && command.code);
    if (code === 112) return resolveLoopStartTarget(list, index);
    if (code === 113) return resolveBreakLoopTarget(list, index);
    if (code === 119) return resolveJumpToLabelTarget(list, index, command);
    if (code === 413) return resolveRepeatAboveTarget(list, index);
    return null;
  }

  function resolveJumpToLabelTarget(list, index, command) {
    if (!Array.isArray(list)) return null;
    const params = Array.isArray(command && command.parameters) ? command.parameters : [];
    const labelName = nonEmptyString(params[0]);
    if (!labelName) return null;
    for (let cursor = 0; cursor < list.length; cursor += 1) {
      const candidate = list[cursor];
      if (!isCommand(candidate) || Number(candidate.code) !== 118) continue;
      const candidateParams = Array.isArray(candidate.parameters) ? candidate.parameters : [];
      if (nonEmptyString(candidateParams[0]) !== labelName) continue;
      return createControlFlowTarget(list, index, cursor, 'jump-label', {
        label_name: labelName,
        target_name: labelName,
      });
    }
    return null;
  }

  function resolveLoopStartTarget(list, index) {
    const repeatIndex = findMatchingLoopRepeatIndex(list, index);
    if (repeatIndex === null) return null;
    return createControlFlowTarget(list, index, repeatIndex, 'loop-repeat', {
      via_index: repeatIndex,
      via_code: 413,
      via_label: 'Repeat Above',
    });
  }

  function resolveBreakLoopTarget(list, index) {
    const repeatIndex = findBreakLoopRepeatIndex(list, index);
    if (repeatIndex === null) return null;
    return createControlFlowTarget(list, index, repeatIndex + 1, 'break-loop', {
      via_index: repeatIndex,
      via_code: 413,
      via_label: 'Repeat Above',
    });
  }

  function resolveRepeatAboveTarget(list, index) {
    const loopIndex = findMatchingLoopStartIndex(list, index);
    if (loopIndex === null) return null;
    return createControlFlowTarget(list, index, loopIndex, 'repeat-loop', {
      via_index: loopIndex,
      via_code: 112,
      via_label: 'Loop',
    });
  }

  function findMatchingLoopRepeatIndex(list, index) {
    if (!Array.isArray(list)) return null;
    let depth = 0;
    for (let cursor = index + 1; cursor < list.length; cursor += 1) {
      const code = Number(list[cursor] && list[cursor].code);
      if (code === 112) {
        depth += 1;
      } else if (code === 413) {
        if (depth > 0) {
          depth -= 1;
        } else {
          return cursor;
        }
      }
    }
    return null;
  }

  function findBreakLoopRepeatIndex(list, index) {
    if (!Array.isArray(list)) return null;
    let depth = 0;
    for (let cursor = index + 1; cursor < list.length; cursor += 1) {
      const code = Number(list[cursor] && list[cursor].code);
      if (code === 112) {
        depth += 1;
      } else if (code === 413) {
        if (depth > 0) {
          depth -= 1;
        } else {
          return cursor;
        }
      }
    }
    return null;
  }

  function findMatchingLoopStartIndex(list, index) {
    if (!Array.isArray(list)) return null;
    const repeat = list[index];
    const repeatIndent = readIndent(repeat);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const command = list[cursor];
      if (!isCommand(command) || readIndent(command) !== repeatIndent) continue;
      return Number(command.code) === 112 ? cursor : null;
    }
    return null;
  }

  function createControlFlowTarget(list, sourceIndex, targetIndex, kind, details = {}) {
    const target = Array.isArray(list) && targetIndex >= 0 && targetIndex < list.length ? list[targetIndex] : null;
    const targetCode = target ? Number(target.code) : null;
    const direction = targetIndex === sourceIndex ? 'self' : (targetIndex < sourceIndex ? 'backward' : 'forward');
    return {
      kind: nonEmptyString(kind) || 'control-flow',
      source_index: Math.max(0, Math.floor(Number(sourceIndex) || 0)),
      target_index: nullableNumber(targetIndex),
      target_code: targetCode,
      target_label: targetCode === null ? 'End' : getEventCommandLabel(targetCode),
      target_name: nonEmptyString(details.target_name),
      label_name: nonEmptyString(details.label_name),
      direction,
      via_index: nullableNumber(details.via_index),
      via_code: nullableNumber(details.via_code),
      via_label: nonEmptyString(details.via_label),
    };
  }

  const EVENT_COMMAND_LABELS = Object.freeze({
    0: 'End',
    101: 'Show Text',
    102: 'Show Choices',
    103: 'Input Number',
    104: 'Select Item',
    105: 'Show Scrolling Text',
    108: 'Comment',
    111: 'Conditional Branch',
    112: 'Loop',
    113: 'Break Loop',
    115: 'Exit Event Processing',
    117: 'Common Event',
    118: 'Label',
    119: 'Jump to Label',
    121: 'Control Switches',
    122: 'Control Variables',
    123: 'Control Self Switch',
    124: 'Control Timer',
    125: 'Change Gold',
    126: 'Change Items',
    127: 'Change Weapons',
    128: 'Change Armor',
    129: 'Change Party Members',
    132: 'Change Battle BGM',
    133: 'Change Victory ME',
    134: 'Change Save Access',
    135: 'Change Menu Access',
    136: 'Enable/Disable Encounters',
    137: 'Change Formation Access',
    138: 'Change Window Color',
    139: 'Change Defeat ME',
    140: 'Change Vehicle BGM',
    201: 'Transfer Player',
    202: 'Set Vehicle Location',
    203: 'Set Event Location',
    204: 'Scroll Map',
    205: 'Set Movement Route',
    206: 'Get On/Off Vehicle',
    211: 'Change Transparency',
    212: 'Show Animation',
    213: 'Show Balloon Icon',
    214: 'Erase Event',
    216: 'Change Player Followers',
    217: 'Gather Followers',
    221: 'Fadeout Screen',
    222: 'Fadein Screen',
    223: 'Tint Screen',
    224: 'Flash Screen',
    225: 'Shake Screen',
    230: 'Wait',
    231: 'Show Picture',
    232: 'Move Picture',
    233: 'Rotate Picture',
    234: 'Tint Picture',
    235: 'Erase Picture',
    236: 'Set Weather Effect',
    241: 'Play BGM (background music)',
    242: 'Fadeout BGM (background music)',
    243: 'Save BGM (background music)',
    244: 'Replay BGM (background music)',
    245: 'Play BGS (background sound)',
    246: 'Fadeout BGS (background sound)',
    247: 'Save BGS (background sound)',
    248: 'Replay BGS (background sound)',
    249: 'Play ME (music effect)',
    250: 'Play SE (sound effect)',
    251: 'Stop SE (sound effect)',
    261: 'Play Movie',
    281: 'Change Map Name Display',
    282: 'Change Tileset',
    283: 'Change Battle Background',
    284: 'Change Parallax',
    285: 'Get Location Info',
    301: 'Battle Processing',
    302: 'Shop Processing',
    303: 'Name Input Processing',
    311: 'Change HP (health points)',
    312: 'Change MP (magic points)',
    313: 'Change State',
    314: 'Recover All',
    315: 'Change EXP (experience)',
    316: 'Change Level',
    317: 'Change Parameter',
    318: 'Change Skill',
    319: 'Change Equipment',
    320: 'Change Name',
    321: 'Change Class',
    322: 'Change Actor Images',
    323: 'Change Vehicle Image',
    324: 'Change Nickname',
    325: 'Change Profile',
    326: 'Change TP (tactical points)',
    331: 'Change Enemy HP (health points)',
    332: 'Change Enemy MP (magic points)',
    333: 'Change Enemy State',
    334: 'Enemy Recover All',
    335: 'Enemy Appearance',
    336: 'Enemy Transform',
    337: 'Show Battle Animation',
    339: 'Force Action',
    340: 'Abort Battle',
    342: 'Change Enemy TP (tactical points)',
    351: 'Open Menu Screen',
    352: 'Open Save Screen',
    353: 'Game Over',
    354: 'Return to Title Screen',
    355: 'Script (runs JavaScript)',
    356: 'Plugin Command (runs MV plugin code)',
    357: 'Plugin Command (runs MZ plugin code)',
    401: 'Show Text Line',
    402: 'Choice Branch',
    403: 'Choice Cancel Branch',
    404: 'End Choices',
    405: 'Show Scrolling Text Line',
    408: 'Comment Line',
    411: 'Else',
    412: 'End Conditional Branch',
    413: 'Repeat Above',
    505: 'Movement Route Command (one route step)',
    601: 'Battle Win Branch',
    602: 'Battle Escape Branch',
    603: 'Battle Lose Branch',
    604: 'End Battle Processing',
    605: 'Shop Item',
    655: 'Script Line (continues JavaScript)',
    657: 'Plugin Command Argument Line (continues plugin command)',
  });

  const EVENT_ADVANCE_CODES = new Set([
    103, 104, 105, 108, 118,
    121, 122, 123, 124, 125, 126, 127, 128, 129,
    132, 133, 134, 135, 136, 137, 138, 139, 140,
    202, 203, 204, 206, 211, 212, 213, 214, 216, 217,
    221, 222, 223, 224, 225, 230, 231, 232, 233, 234, 235, 236,
    241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 261,
    281, 282, 283, 284, 285,
    302, 303,
    311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326,
    331, 332, 333, 334, 335, 336, 337, 339, 342,
    351, 352, 355, 356, 357, 405, 408, 605, 655, 657,
  ]);

  const EVENT_BARRIER_CODES = new Set([
    102, 111, 112, 113, 115, 119, 201, 301, 340, 353, 354,
    402, 403, 404, 411, 412, 413, 601, 602, 603, 604,
  ]);

  const EVENT_STATE_RISK_CODES = new Set([
    103, 104,
    121, 122, 123, 124, 125, 126, 127, 128, 129,
    132, 133, 134, 135, 136, 137, 138, 139, 140,
    201, 202, 203, 205, 206, 214,
    281, 282, 283, 284, 285,
    302, 303,
    311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326,
    331, 332, 333, 334, 335, 336, 337, 339, 342, 505, 605,
  ]);

  const EVENT_EXTERNAL_RISK_CODES = new Set([355, 356, 357, 655, 657]);

  function normalizeCommandCatalog(catalog) {
    const normalized = {
      eventCommands: Object.create(null),
      movementRouteCommands: Object.create(null),
    };
    if (!catalog || typeof catalog !== 'object') return normalized;
    Object.assign(normalized.eventCommands, normalizeCommandTable(catalog.eventCommands, getEventCommandMetadata));
    Object.assign(normalized.movementRouteCommands, normalizeCommandTable(catalog.movementRouteCommands, getMovementRouteCommandMetadata));
    Object.assign(normalized.eventCommands, normalizeCommandTable(catalog, getEventCommandMetadata));
    return normalized;
  }

  function normalizeCommandTable(table, fallbackGetter) {
    const normalized = Object.create(null);
    if (!table || typeof table !== 'object') return normalized;
    Object.keys(table).forEach((key) => {
      const numeric = Number(key);
      if (!Number.isFinite(numeric)) return;
      const entry = table[key];
      if (!entry || typeof entry !== 'object') return;
      normalized[String(numeric)] = normalizeCatalogCommandMetadata(entry, numeric, fallbackGetter(numeric));
    });
    return normalized;
  }

  function normalizeCatalogCommandMetadata(entry, numeric, fallback) {
    const classification = normalizeClassification(entry.classification);
    return {
      code: numeric,
      label: nonEmptyString(entry.label) || fallback.label,
      classification,
      scanBehavior: normalizeScanBehavior(entry.scanBehavior, classification) || fallback.scanBehavior,
      stalenessRisk: normalizeStalenessRisk(entry.stalenessRisk, classification),
      reason: nonEmptyString(entry.reason),
      nestedLists: normalizeNestedListSpecs(entry.nestedLists),
    };
  }

  function normalizeClassification(value) {
    const classification = nonEmptyString(value);
    return [
      'linear',
      'continuation',
      'nesting',
      'branching',
      'terminal',
      'external',
    ].includes(classification) ? classification : 'external';
  }

  function normalizeScanBehavior(value, classification = '') {
    const behavior = nonEmptyString(value);
    if ([
      'advance',
      'barrier',
      'frame-end',
      'message',
      'message-line',
      'movement-route',
      'movement-route-line',
      'nested-list',
    ].includes(behavior)) return behavior;
    return isTransparentClassification(classification) ? 'advance' : 'barrier';
  }

  function normalizeStalenessRisk(value, classification = '') {
    const risk = nonEmptyString(value);
    if (['state', 'context', 'external'].includes(risk)) return risk;
    return classification === 'external' ? 'external' : '';
  }

  function isTransparentClassification(classification) {
    return classification === 'linear' || classification === 'continuation' || classification === 'external';
  }

  function normalizeNestedListSpecs(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const specs = [];
    value.forEach((entry, index) => {
      const source = typeof entry === 'string'
        ? { path: entry }
        : (entry && typeof entry === 'object' ? entry : null);
      const path = nonEmptyString(source && source.path);
      if (!path || seen.has(path)) return;
      seen.add(path);
      specs.push({
        path,
        name: nonEmptyString(source && source.name),
        runtimeOrder: Number.isFinite(Number(source && source.runtimeOrder))
          ? Number(source.runtimeOrder)
          : index,
        optional: Boolean(source && source.optional),
        index,
      });
    });
    specs.sort((left, right) => {
      const byOrder = Number(left.runtimeOrder) - Number(right.runtimeOrder);
      return byOrder || (Number(left.index) - Number(right.index));
    });
    return specs.map((spec) => ({
      path: spec.path,
      name: spec.name,
      runtimeOrder: spec.runtimeOrder,
      optional: spec.optional,
    }));
  }

  function getEventCommandMetadata(code) {
    const numeric = Number(code);
    const label = getEventCommandLabel(numeric);
    if (!Number.isFinite(numeric)) {
      return {
        code: null,
        label: 'Unknown event command',
        scanBehavior: 'barrier',
        stalenessRisk: 'external',
        reason: 'unknown',
      };
    }
    if (numeric === 0) {
      return { code: numeric, label, scanBehavior: 'frame-end', stalenessRisk: '', reason: '' };
    }
    if (numeric === 101) {
      return { code: numeric, label, scanBehavior: 'message', stalenessRisk: '', reason: '' };
    }
    if (numeric === 117) {
      return { code: numeric, label, scanBehavior: 'nested-list', stalenessRisk: '', reason: '' };
    }
    if (numeric === 205) {
      return { code: numeric, label, scanBehavior: 'movement-route', stalenessRisk: 'state', reason: '' };
    }
    if (numeric === 401) {
      return { code: numeric, label, scanBehavior: 'message-line', stalenessRisk: '', reason: '' };
    }
    if (numeric === 505) {
      return { code: numeric, label, scanBehavior: 'movement-route-line', stalenessRisk: 'state', reason: '' };
    }
    if (EVENT_ADVANCE_CODES.has(numeric)) {
      return {
        code: numeric,
        label,
        scanBehavior: 'advance',
        stalenessRisk: EVENT_STATE_RISK_CODES.has(numeric) ? 'state' : (EVENT_EXTERNAL_RISK_CODES.has(numeric) ? 'external' : ''),
        reason: '',
      };
    }
    if (EVENT_BARRIER_CODES.has(numeric)) {
      return {
        code: numeric,
        label,
        scanBehavior: 'barrier',
        stalenessRisk: EVENT_STATE_RISK_CODES.has(numeric) ? 'state' : '',
        reason: '',
      };
    }
    return {
      code: numeric,
      label,
      scanBehavior: 'barrier',
      stalenessRisk: 'external',
      reason: 'unknown',
    };
  }

  function getEventCommandLabel(code) {
    const numeric = Number(code);
    return EVENT_COMMAND_LABELS[numeric] || `Event Command ${numeric}`;
  }

  function resolveOrigin(origin) {
    if (!origin || !Array.isArray(origin.list)) return null;
    if (origin.interpreter && origin.interpreter._list !== origin.list) return null;
    const startIndex = integerOrNull(origin.startIndex);
    if (startIndex !== null && !isGeneratedMessageOrigin(origin)) {
      const nextIndex = integerOrNull(origin.nextIndex);
      if (nextIndex === null || startIndex < 0 || startIndex >= origin.list.length) return null;
      if (nextIndex <= startIndex || nextIndex > origin.list.length) return null;
      const command = origin.list[startIndex];
      if (!command || Number(command.code) !== 101) return null;
      const indent = Number.isFinite(Number(origin.indent)) ? Number(origin.indent) : (Number(command.indent) || 0);
      if (indent !== (Number(command.indent) || 0)) return null;
      const block = parseMessageBlock(origin.list, startIndex, command);
      if (!block || block.nextIndex !== nextIndex) return null;
    }
    return origin;
  }

  function isGeneratedMessageOrigin(origin) {
    return !!(origin && origin.originKind === 'game-message-add' && origin.verified === true);
  }

  function integerOrNull(value) {
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
  }

  function createDiagnostics(origin, budgetLimit, messageLimit) {
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
      control_flow_targets: 0,
      route_commands: 0,
      route_barriers: 0,
      route_barrier_code: null,
      route_barrier_reason: '',
      route_barrier_label: '',
      route_command_actions: [],
      command_actions: [],
      staleness_risks: 0,
      budget: createBudgetState(budgetLimit, messageLimit),
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
      control_flow_targets: diagnostics.control_flow_targets || 0,
      route_commands: diagnostics.route_commands || 0,
      route_barriers: diagnostics.route_barriers || 0,
      route_barrier_code: diagnostics.route_barrier_code === null ? null : nullableNumber(diagnostics.route_barrier_code),
      route_barrier_reason: diagnostics.route_barrier_reason || '',
      route_barrier_label: diagnostics.route_barrier_label || '',
      route_command_actions: Array.isArray(diagnostics.route_command_actions)
        ? diagnostics.route_command_actions.map((action) => Object.assign({}, action))
        : [],
      command_actions: Array.isArray(diagnostics.command_actions)
        ? diagnostics.command_actions.map((action) => Object.assign({}, action))
        : [],
      staleness_risks: diagnostics.staleness_risks || 0,
      budget: cloneBudgetSnapshot(diagnostics.budget),
      path_stops: Array.isArray(diagnostics.path_stops)
        ? diagnostics.path_stops.map(sanitizePathStop)
        : [],
    };
  }

  function isCommand(command) {
    return command && typeof command === 'object' && Number.isFinite(Number(command.code));
  }

  function cloneCommonStack(stack) {
    return Array.isArray(stack) ? stack.slice() : [];
  }

  function getFrameNestedDepth(frame) {
    return Math.max(
      cloneCommonStack(frame && frame.commonStack).length,
      Math.max(0, Math.floor(Number(frame && frame.nestedDepth) || 0)),
    );
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
    const entry = {
      index: Math.max(0, Math.floor(Number(stop && stop.index) || 0)),
      stop_reason: stop && stop.stop_reason ? String(stop.stop_reason) : '',
      branch_depth: Math.max(0, Math.floor(Number(stop && stop.branch_depth) || 0)),
      branch_path: cloneBranchPath(stop && stop.branch_path),
      code: stop && stop.code === null ? null : (Number.isFinite(Number(stop && stop.code)) ? Number(stop.code) : null),
      label: stop && stop.label ? String(stop.label) : '',
      control_flow_target: cloneControlFlowTarget(stop && stop.control_flow_target),
    };
    if (stop && Object.prototype.hasOwnProperty.call(stop, 'nested_list')) {
      entry.nested_list = cloneNestedListInfo(stop.nested_list);
    }
    if (stop && Object.prototype.hasOwnProperty.call(stop, 'route_barrier_code')) {
      entry.route_barrier_code = stop.route_barrier_code === null ? null : nullableNumber(stop.route_barrier_code);
      entry.route_barrier_reason = stop.route_barrier_reason ? String(stop.route_barrier_reason) : '';
      entry.route_barrier_label = stop.route_barrier_label ? String(stop.route_barrier_label) : '';
    }
    diagnostics.path_stops.push(entry);
  }

  function recordCommandAction(diagnostics, metadata, details = {}) {
    if (!diagnostics || !metadata) return;
    if (!Array.isArray(diagnostics.command_actions)) diagnostics.command_actions = [];
    const action = {
      code: metadata.code,
      label: metadata.label,
      scan_behavior: metadata.scanBehavior,
      staleness_risk: metadata.stalenessRisk,
      reason: metadata.reason,
    };
    if (details && details.action) action.action = String(details.action);
    if (details && Object.prototype.hasOwnProperty.call(details, 'stop_reason')) {
      action.stop_reason = details.stop_reason ? String(details.stop_reason) : '';
    }
    if (details && Object.prototype.hasOwnProperty.call(details, 'nested_list')) {
      action.nested_list = cloneNestedListInfo(details.nested_list);
    }
    diagnostics.command_actions.push(action);
    if (metadata.stalenessRisk) diagnostics.staleness_risks += 1;
  }

  function selectLimitStopReason(scanner, diagnostics, blocks) {
    if (diagnostics.scanned_commands >= scanner.maxCommands) return 'scan-limit';
    if (!hasBudgetRemaining(diagnostics.budget)) return 'budget-limit';
    if (blocks.length >= scanner.maxBlocks) return 'message-limit';
    return '';
  }

  function appendLimitPathStop(diagnostics, index, reason, frame) {
    if (!diagnostics || !reason) return;
    const stops = Array.isArray(diagnostics.path_stops) ? diagnostics.path_stops : [];
    const last = stops[stops.length - 1];
    if (last && last.stop_reason === reason && Number(last.index) === Number(index)) return;
    appendPathStop(diagnostics, {
      index,
      stop_reason: reason,
      branch_depth: frame && frame.branchDepth ? frame.branchDepth : 0,
      branch_path: cloneBranchPath(frame && frame.branchPath),
      code: null,
      label: '',
    });
  }

  function createBudgetState(limit, messageLimit) {
    const initial = positiveInteger(limit, DEFAULT_MAX_BLOCKS);
    return {
      initial,
      limit: initial,
      messageLimit: positiveInteger(messageLimit, initial),
      spent: 0,
      remaining: initial,
      messageCost: DEFAULT_MESSAGE_BUDGET_COST,
    };
  }

  function hasBudgetRemaining(budget) {
    return Boolean(budget && Number(budget.remaining) > 0);
  }

  function spendBudget(budget, amount) {
    if (!budget) return 0;
    const cost = positiveInteger(amount, DEFAULT_MESSAGE_BUDGET_COST);
    const spent = Math.min(Math.max(0, Math.floor(Number(budget.remaining) || 0)), cost);
    budget.spent = Math.max(0, Math.floor(Number(budget.spent) || 0)) + spent;
    budget.remaining = Math.max(0, Math.floor(Number(budget.remaining) || 0) - spent);
    return spent;
  }

  function cloneBudgetSnapshot(budget) {
    if (!budget || typeof budget !== 'object') return null;
    return {
      initial: Math.max(0, Math.floor(Number(budget.initial) || 0)),
      limit: Math.max(0, Math.floor(Number(budget.limit) || 0)),
      message_limit: Math.max(0, Math.floor(Number(budget.messageLimit) || 0)),
      spent: Math.max(0, Math.floor(Number(budget.spent) || 0)),
      remaining: Math.max(0, Math.floor(Number(budget.remaining) || 0)),
      message_cost: Math.max(1, Math.floor(Number(budget.messageCost) || DEFAULT_MESSAGE_BUDGET_COST)),
    };
  }

  function sanitizePathStop(stop) {
    const entry = Object.assign({}, stop, {
      branch_path: cloneBranchPath(stop && stop.branch_path),
      control_flow_target: cloneControlFlowTarget(stop && stop.control_flow_target),
    });
    if (stop && Object.prototype.hasOwnProperty.call(stop, 'route_barrier_code')) {
      entry.route_barrier_code = stop.route_barrier_code === null ? null : nullableNumber(stop.route_barrier_code);
      entry.route_barrier_reason = stop.route_barrier_reason || '';
      entry.route_barrier_label = stop.route_barrier_label || '';
    } else {
      delete entry.route_barrier_code;
      delete entry.route_barrier_reason;
      delete entry.route_barrier_label;
    }
    return entry;
  }

  function createCommonEventNestedList(commonEventId, commonEvent, frame) {
    const id = commonEventId ? Number(commonEventId) : null;
    return {
      type: 'common-event',
      id,
      name: nonEmptyString(commonEvent && commonEvent.name),
      depth: Math.max(1, getFrameNestedDepth(frame) + 1),
      length: commonEvent && Array.isArray(commonEvent.list) ? commonEvent.list.length : 0,
    };
  }

  function cloneNestedListInfo(info) {
    if (!info || typeof info !== 'object') return null;
    const cloned = {
      type: nonEmptyString(info.type),
      id: info.id === null || info.id === undefined ? null : nullableNumber(info.id),
      name: nonEmptyString(info.name),
      depth: Math.max(0, Math.floor(Number(info.depth) || 0)),
      length: Math.max(0, Math.floor(Number(info.length) || 0)),
    };
    if (Object.prototype.hasOwnProperty.call(info, 'path')) cloned.path = nonEmptyString(info.path);
    if (Object.prototype.hasOwnProperty.call(info, 'index')) cloned.index = nullableNumber(info.index);
    if (Object.prototype.hasOwnProperty.call(info, 'parentCode')) cloned.parentCode = nullableNumber(info.parentCode);
    if (Object.prototype.hasOwnProperty.call(info, 'parentCommandIndex')) cloned.parentCommandIndex = nullableNumber(info.parentCommandIndex);
    return cloned;
  }

  function cloneControlFlowTarget(target) {
    if (!target || typeof target !== 'object') return null;
    return {
      kind: nonEmptyString(target.kind),
      source_index: nullableNumber(target.source_index),
      target_index: nullableNumber(target.target_index),
      target_code: nullableNumber(target.target_code),
      target_label: nonEmptyString(target.target_label),
      target_name: nonEmptyString(target.target_name),
      label_name: nonEmptyString(target.label_name),
      direction: nonEmptyString(target.direction),
      via_index: nullableNumber(target.via_index),
      via_code: nullableNumber(target.via_code),
      via_label: nonEmptyString(target.via_label),
    };
  }

  function cloneBranchPath(path) {
    return Array.isArray(path)
      ? path.map((value) => Math.max(0, Math.floor(Number(value) || 0)))
      : [];
  }

  function readIndent(command) {
    return Math.max(0, Math.floor(Number(command && command.indent) || 0));
  }

  function nullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function nonEmptyString(value) {
    const text = String(value ?? '').trim();
    return text || '';
  }

  function reasonFromLabel(label) {
    return String(label || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
