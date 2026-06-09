(function attach(root) {
  const { RenderGuard } = loadDependency(root, './render-guard');
  const DEFAULT_EVENT_LIMIT = 128;
  const MAX_EVENT_LIMIT = 512;
  const DEFAULT_ITEM_HISTORY_LIMIT = 24;
  const MAX_ITEM_HISTORY_LIMIT = 128;
  const TEXT_LIMIT = 160;

  class TextOrchestrator {
    constructor(index, options = {}) {
      this.index = index;
      this.engine = options.engine || 'unknown';
      this.sourceLanguage = options.sourceLanguage || '';
      this.targetLanguage = options.targetLanguage || '';
      this.guard = options.renderGuard || (RenderGuard ? new RenderGuard() : null);
      this.runtimeDiagnostics = options.diagnostics || null;
      this.nextItemId = 1;
      this.nextSurfaceId = 1;
      this.activeItems = new Map();
      this.detachedItems = new Map();
      this.archivedItems = new Map();
      this.slotIndex = new Map();
      this.surfaceIds = new WeakMap();
      this.surfaceClaims = new WeakMap();
      this.textClaims = new Map();
      this.renderQueue = [];
      this.events = [];
      this.listeners = new Set();
      this.surfaceDrawListeners = new Set();
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.eventSequence = 0;
      this.eventLimit = positiveInteger(options.eventLimit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
      this.itemHistoryLimit = positiveInteger(options.itemHistoryLimit, DEFAULT_ITEM_HISTORY_LIMIT, MAX_ITEM_HISTORY_LIMIT);
      this.diagnosticState = {
        observed_items: 0,
        cache_hits: 0,
        cache_misses: 0,
        render_accepted: 0,
        render_rejected: 0,
        ownership_conflicts: 0,
        surface_claims: 0,
        text_claims: 0,
        surface_releases: 0,
        text_releases: 0,
      };
    }

    observeRecord(record = {}) {
      const text = String(record.text ?? '');
      const surface = record.surface || null;
      const slotId = record.slotId || this.defaultSlotId(record.adapter, surface, record.slotKey);
      const item = {
        id: `item-${this.nextItemId++}`,
        adapter: record.adapter || 'unknown',
        kind: record.kind || 'text',
        surfaceId: this.surfaceId(surface),
        surface,
        slotId,
        sourceText: text,
        contextHash: record.contextHash || null,
        generation: this.guard ? this.guard.generationFor(surface) : 0,
        renderStrategy: record.renderStrategy || record.strategy || record.adapter || '',
        state: 'active',
      };
      this.activeItems.set(item.id, item);
      this.slotIndex.set(slotId, item.id);
      this.diagnosticState.observed_items += 1;
      this.recordDrawTrace('observe', {
        adapter: item.adapter,
        methodName: item.kind,
        rawText: text,
        visibleText: text,
        reason: 'observed',
        force: true,
      });
      this.emit('observed', Object.assign({ reason: 'observed' }, item));

      const translatedText = this.measure('cache.lookup.ms', () => this.lookup(item), { domain: 'runtime' });
      if (!translatedText || translatedText === text) {
        this.diagnosticState.cache_misses += 1;
        item.translationState = 'miss';
        this.recordDrawTrace('cache-miss', {
          adapter: item.adapter,
          methodName: item.kind,
          rawText: text,
          visibleText: text,
          reason: 'cache-miss',
          force: true,
        });
        this.emit('cacheMiss', Object.assign({ reason: 'cache-miss', status: 'miss' }, item));
        return this.queueRenderCommand(item, text, 'miss');
      }
      this.diagnosticState.cache_hits += 1;
      item.translationState = 'hit';
      this.recordDrawTrace('cache-hit', {
        adapter: item.adapter,
        methodName: item.kind,
        rawText: text,
        visibleText: translatedText,
        reason: 'cache-hit',
        force: true,
      });
      this.emit('cacheHit', Object.assign({ reason: 'cache-hit', status: 'hit', translatedText }, item));
      return this.queueRenderCommand(item, translatedText, 'hit');
    }

    translateText(record = {}) {
      const command = this.observeRecord(record);
      if (!command || command.status !== 'hit') return String(record.text ?? '');
      const accepted = this.acceptRender(command, record.surface || null, record.currentText ?? record.text);
      if (accepted) return command.translatedText;
      return String(record.text ?? '');
    }

    acceptRender(command, surface, currentText) {
      if (!command) return false;
      const item = this.activeItems.get(command.itemId);
      const targetSurface = surface || (item && item.surface) || null;
      const stillFresh = !this.guard || this.guard.canRender(command.renderToken, targetSurface, currentText);
      const accepted = Boolean(item && command.status === 'hit' && stillFresh);
      if (accepted) {
        this.diagnosticState.render_accepted += 1;
        item.lastRenderStatus = 'accepted';
        command.reason = 'render-accepted';
        this.emit('renderAccepted', command);
        return true;
      }
      this.diagnosticState.render_rejected += 1;
      if (item) item.lastRenderStatus = 'rejected';
      command.reason = renderRejectionReason(item, command, stillFresh);
      this.emit('renderRejected', command);
      return false;
    }

    detachItem(itemId) {
      const item = this.activeItems.get(itemId);
      if (!item) return false;
      this.activeItems.delete(itemId);
      item.state = 'detached';
      this.detachedItems.set(itemId, item);
      return true;
    }

    archiveItem(itemId) {
      const item = this.activeItems.get(itemId) || this.detachedItems.get(itemId);
      if (!item) return false;
      this.activeItems.delete(itemId);
      this.detachedItems.delete(itemId);
      item.state = 'archived';
      this.archivedItems.set(itemId, item);
      return true;
    }

    retireSurface(surface, reason) {
      if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) return 0;
      let retired = 0;
      for (const [itemId, item] of Array.from(this.activeItems.entries())) {
        if (item.surface !== surface) continue;
        if (this.archiveItem(itemId)) retired += 1;
      }
      for (const [itemId, item] of Array.from(this.detachedItems.entries())) {
        if (item.surface !== surface) continue;
        if (this.archiveItem(itemId)) retired += 1;
      }
      if (retired > 0) {
        if (this.guard) this.guard.markSurfaceChanged(surface);
        this.emit('surfaceRetired', { surfaceId: this.surfaceId(surface), reason: reason || 'surface-retired', retired });
      }
      return retired;
    }

    claimSurface(surface, owner) {
      if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) return false;
      const current = this.surfaceClaims.get(surface);
      if (current && current !== owner) {
        this.diagnosticState.ownership_conflicts += 1;
        this.emit('ownershipConflict', {
          kind: 'surface',
          owner,
          current,
          surfaceId: this.surfaceId(surface),
          reason: 'ownership-conflict',
        });
        return false;
      }
      if (!current) this.diagnosticState.surface_claims += 1;
      this.surfaceClaims.set(surface, owner);
      return true;
    }

    releaseSurface(surface, owner) {
      if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) return false;
      const current = this.surfaceClaims.get(surface);
      if (!current) return false;
      if (owner && current !== owner) return false;
      this.surfaceClaims.delete(surface);
      this.diagnosticState.surface_releases += 1;
      return true;
    }

    claimText(slotId, owner) {
      const current = this.textClaims.get(slotId);
      if (current && current !== owner) {
        this.diagnosticState.ownership_conflicts += 1;
        this.emit('ownershipConflict', {
          kind: 'text',
          owner,
          current,
          slotId,
          reason: 'ownership-conflict',
        });
        return false;
      }
      if (!current) this.diagnosticState.text_claims += 1;
      this.textClaims.set(slotId, owner);
      return true;
    }

    releaseTextClaim(slotId, owner) {
      const current = this.textClaims.get(slotId);
      if (!current) return false;
      if (owner && current !== owner) return false;
      this.textClaims.delete(slotId);
      this.diagnosticState.text_releases += 1;
      return true;
    }

    markSurfaceChanged(surface) {
      if (this.guard) this.guard.markSurfaceChanged(surface);
    }

    diagnostics() {
      const diagnostics = Object.assign({}, this.diagnosticState, {
        active_items: this.activeItems.size,
        detached_items: this.detachedItems.size,
        archived_items: this.archivedItems.size,
        queued_render_commands: this.renderQueue.length,
        active: snapshotItems(this.activeItems),
        detached: snapshotItems(this.detachedItems),
        archived: snapshotItems(this.archivedItems),
        recent_events: this.events.slice(),
        events: this.events.slice(),
        renderQueue: this.renderQueue.map(cloneRenderCommand),
      });
      if (this.runtimeDiagnostics && typeof this.runtimeDiagnostics.snapshot === 'function') {
        diagnostics.runtime_diagnostics = this.runtimeDiagnostics.snapshot({ detailView: false });
      }
      return diagnostics;
    }

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    subscribeRecords(options = {}) {
      const source = options && typeof options === 'object' ? options : {};
      const renderStrategy = String(source.renderStrategy || source.strategy || '');
      return this.subscribe((event) => {
        if (!event || typeof event !== 'object') return;
        const command = event.payload || null;
        if (!command || typeof command !== 'object') return;
        if (renderStrategy && String(command.strategy || '') !== renderStrategy) return;
        if (event.type === 'renderQueued' && typeof source.onRenderQueued === 'function') {
          const route = this.renderRoute('item.render_queued', command);
          const decision = source.onRenderQueued(command, route);
          if (decision === false && typeof source.onRenderRejected === 'function') {
            source.onRenderRejected(command, this.renderRoute('item.render_rejected', command, 'adapter-declined'));
          }
          return;
        }
        if (event.type === 'renderAccepted' && typeof source.onRenderAccepted === 'function') {
          source.onRenderAccepted(command, this.renderRoute('item.render_accepted', command));
          return;
        }
        if (event.type === 'renderRejected' && typeof source.onRenderRejected === 'function') {
          source.onRenderRejected(command, this.renderRoute('item.render_rejected', command, 'render-rejected'));
        }
      });
    }

    subscribeSurfaceDraws(listener, options = {}) {
      if (typeof listener !== 'function') return () => {};
      const subscription = {
        listener,
        adapterId: String((options && options.adapterId) || ''),
        token: String((options && (options.token || options.subscriptionToken)) || 'surface-draws'),
      };
      this.surfaceDrawListeners.add(subscription);
      return () => this.surfaceDrawListeners.delete(subscription);
    }

    recordSurfaceDraw(input = {}) {
      const descriptor = this.normalizeSurfaceDrawDescriptor(input);
      if (!descriptor.target) {
        return this.surfaceDrawResult('ignored', descriptor, 'missing-target');
      }

      let deferred = false;
      let drawDecision = null;
      for (const adapterId of descriptor.candidateAdapters) {
        if (!adapterId || adapterId === descriptor.adapterId) continue;
        const decision = this.emitSurfaceDraw(adapterId, descriptor, 'deferred');
        if (decision && !drawDecision) drawDecision = decision;
        if (this.hasSurfaceDrawListener(adapterId)) deferred = true;
      }
      return this.surfaceDrawResult(
        deferred ? 'deferred' : 'fallback',
        descriptor,
        deferred ? 'deferred-to-owner-candidate' : 'fallback-owned',
        drawDecision,
      );
    }

    lookup(item) {
      if (!this.index || typeof this.index.translate !== 'function') return null;
      return this.index.translate({
        engine: this.engine,
        sourceLanguage: this.sourceLanguage,
        targetLanguage: this.targetLanguage,
        text: item.sourceText,
        contextHash: item.contextHash,
      });
    }

    queueRenderCommand(item, translatedText, status) {
      const command = {
        id: `render-${item.id}`,
        itemId: item.id,
        surfaceId: item.surfaceId,
        slotId: item.slotId,
        sourceText: item.sourceText,
        translatedText: String(translatedText ?? ''),
        status,
        reason: status,
        strategy: item.renderStrategy || '',
        generation: item.generation,
        renderToken: this.guard ? this.guard.capture(item.surface, item.sourceText) : null,
      };
      this.renderQueue.push(command);
      if (this.renderQueue.length > 256) this.renderQueue.shift();
      this.emit('renderQueued', command);
      return command;
    }

    recordDrawTrace(stage, details) {
      if (!this.runtimeDiagnostics || typeof this.runtimeDiagnostics.recordDraw !== 'function') return null;
      return this.runtimeDiagnostics.recordDraw(stage, details);
    }

    measure(name, callback, options) {
      if (this.runtimeDiagnostics && typeof this.runtimeDiagnostics.measure === 'function') {
        return this.runtimeDiagnostics.measure(name, callback, options);
      }
      return callback();
    }

    surfaceId(surface) {
      if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) return 'surface:none';
      let id = this.surfaceIds.get(surface);
      if (!id) {
        id = `surface-${this.nextSurfaceId++}`;
        this.surfaceIds.set(surface, id);
      }
      return id;
    }

    defaultSlotId(adapter, surface, slotKey) {
      return `${adapter || 'unknown'}:${this.surfaceId(surface)}:${String(slotKey || 'default')}`;
    }

    renderRoute(eventType, command, reason) {
      return {
        eventType,
        itemId: command && command.itemId ? command.itemId : '',
        slotId: command && command.slotId ? command.slotId : '',
        strategy: command && command.strategy ? command.strategy : '',
        reason: reason || '',
      };
    }

    normalizeSurfaceDrawDescriptor(input) {
      const source = input && typeof input === 'object' ? input : {};
      const candidates = Array.isArray(source.candidateAdapters)
        ? source.candidateAdapters.map((value) => String(value || '')).filter(Boolean)
        : [];
      return {
        target: source.target || source.bitmap || null,
        adapterId: String(source.adapterId || source.sourceAdapter || 'bitmap-text'),
        methodName: String(source.methodName || 'drawText'),
        text: String(source.text ?? source.rawText ?? ''),
        x: numberOrDefault(source.x, 0),
        y: numberOrDefault(source.y, 0),
        maxWidth: numberOrDefault(source.maxWidth, 0),
        lineHeight: numberOrDefault(source.lineHeight, 0),
        align: String(source.align || 'left'),
        drawState: source.drawState && typeof source.drawState === 'object' ? Object.assign({}, source.drawState) : null,
        measuredWidth: numberOrDefault(source.measuredWidth ?? source.width, 0),
        ownerType: String(source.ownerType || ''),
        standaloneGlyph: source.standaloneGlyph === true,
        candidateAdapters: candidates,
      };
    }

    hasSurfaceDrawListener(adapterId) {
      for (const subscription of this.surfaceDrawListeners) {
        if (subscription && subscription.adapterId === adapterId) return true;
      }
      return false;
    }

    emitSurfaceDraw(adapterId, descriptor, status) {
      const event = {
        type: 'surface.draw',
        adapterId,
        sourceAdapter: descriptor.adapterId,
        status,
        ownerAdapter: adapterId,
        reason: status,
        target: descriptor.target,
        payload: {
          target: descriptor.target,
          bitmap: descriptor.target,
          methodName: descriptor.methodName,
          text: descriptor.text,
          rawText: descriptor.text,
          x: descriptor.x,
          y: descriptor.y,
          maxWidth: descriptor.maxWidth,
          lineHeight: descriptor.lineHeight,
          align: descriptor.align,
          drawState: descriptor.drawState,
          measuredWidth: descriptor.measuredWidth,
          ownerType: descriptor.ownerType,
          ownershipStatus: status,
          sourceAdapter: descriptor.adapterId,
        },
      };
      let drawDecision = null;
      for (const subscription of this.surfaceDrawListeners) {
        if (!subscription || subscription.adapterId !== adapterId) continue;
        try {
          const decision = normalizeSurfaceDrawDecision(subscription.listener(event));
          if (decision && !drawDecision) drawDecision = decision;
        } catch (_error) {
          // Listener failures must not break native drawing.
        }
      }
      return drawDecision;
    }

    surfaceDrawResult(status, descriptor, reason, drawDecision) {
      const result = {
        status,
        ownerAdapter: status === 'ignored' ? '' : descriptor.adapterId,
        ownerClaimId: '',
        reason: reason || '',
        token: null,
        ownershipToken: null,
        claimId: '',
      };
      if (drawDecision) result.drawDecision = drawDecision;
      return result;
    }

    emit(type, payload) {
      const event = { type, payload };
      const diagnosticEvent = this.toDiagnosticEvent(type, payload);
      this.events.push(diagnosticEvent);
      while (this.events.length > this.eventLimit) this.events.shift();
      this.appendItemHistory(diagnosticEvent);
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (_error) {
          // Listener failures must not break game rendering.
        }
      }
    }

    toDiagnosticEvent(type, payload) {
      const source = payload && typeof payload === 'object' ? payload : {};
      return {
        seq: ++this.eventSequence,
        at: this.now(),
        type: String(type || 'event'),
        itemId: stringValue(source.itemId || source.id),
        surfaceId: stringValue(source.surfaceId),
        slotId: stringValue(source.slotId),
        adapter: stringValue(source.adapter || source.sourceAdapter),
        kind: stringValue(source.kind),
        status: stringValue(source.status),
        reason: stringValue(source.reason || defaultEventReason(type, source)),
        sourceText: limitText(source.sourceText || source.text),
        translatedText: limitText(source.translatedText),
        owner: stringValue(source.owner),
        current: stringValue(source.current),
        ownershipKind: type === 'ownershipConflict' ? stringValue(source.kind) : '',
      };
    }

    appendItemHistory(event) {
      if (!event || !event.itemId) return;
      const item = this.activeItems.get(event.itemId)
        || this.detachedItems.get(event.itemId)
        || this.archivedItems.get(event.itemId);
      if (!item) return;
      const history = Array.isArray(item.history) ? item.history : [];
      history.push(Object.assign({}, event));
      while (history.length > this.itemHistoryLimit) history.shift();
      item.history = history;
    }
  }

  function loadDependency(scope, modulePath) {
    const overlay = scope.RPGTranslatorOverlay || {};
    if (overlay.RenderGuard) return overlay;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      return require(modulePath);
    }
    return overlay;
  }

  function numberOrDefault(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function positiveInteger(value, fallback, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(Math.floor(numeric), max);
  }

  function renderRejectionReason(item, command, stillFresh) {
    if (!item) return 'missing-item';
    if (!command || command.status !== 'hit') {
      return command && command.status === 'miss' ? 'cache-miss' : 'not-cache-hit';
    }
    if (!stillFresh) return 'stale-render';
    return 'render-rejected';
  }

  function defaultEventReason(type, source) {
    if (type === 'renderQueued') return source.status || 'queued';
    if (type === 'observed') return 'observed';
    if (type === 'cacheHit') return 'cache-hit';
    if (type === 'cacheMiss') return 'cache-miss';
    if (type === 'renderAccepted') return 'render-accepted';
    if (type === 'renderRejected') return 'render-rejected';
    if (type === 'ownershipConflict') return 'ownership-conflict';
    return '';
  }

  function stringValue(value) {
    if (value === null || typeof value === 'undefined') return '';
    return String(value);
  }

  function limitText(value) {
    const text = stringValue(value);
    if (text.length <= TEXT_LIMIT) return text;
    return `${text.slice(0, TEXT_LIMIT)}...`;
  }

  function snapshotItems(map) {
    return Array.from(map.values()).map(cloneItemForDiagnostics);
  }

  function cloneItemForDiagnostics(item) {
    const source = item && typeof item === 'object' ? item : {};
    return {
      id: stringValue(source.id),
      adapter: stringValue(source.adapter),
      kind: stringValue(source.kind),
      surfaceId: stringValue(source.surfaceId),
      slotId: stringValue(source.slotId),
      sourceText: limitText(source.sourceText),
      contextHash: source.contextHash === null || typeof source.contextHash === 'undefined'
        ? null
        : stringValue(source.contextHash),
      generation: numberOrDefault(source.generation, 0),
      renderStrategy: stringValue(source.renderStrategy),
      state: stringValue(source.state),
      translationState: stringValue(source.translationState),
      lastRenderStatus: stringValue(source.lastRenderStatus),
      history: Array.isArray(source.history)
        ? source.history.map((event) => Object.assign({}, event))
        : [],
    };
  }

  function cloneRenderCommand(command) {
    const source = command && typeof command === 'object' ? command : {};
    return {
      id: stringValue(source.id),
      itemId: stringValue(source.itemId),
      surfaceId: stringValue(source.surfaceId),
      slotId: stringValue(source.slotId),
      sourceText: limitText(source.sourceText),
      translatedText: limitText(source.translatedText),
      status: stringValue(source.status),
      reason: stringValue(source.reason),
      strategy: stringValue(source.strategy),
      generation: numberOrDefault(source.generation, 0),
    };
  }

  function normalizeSurfaceDrawDecision(input) {
    if (!input || typeof input !== 'object') return null;
    const action = normalizeSurfaceDrawAction(input.action || input.nativeDrawAction);
    const text = String(input.text ?? input.replacementText ?? input.translatedText ?? '');
    if (!action || (action === 'replace-native-draw' && !text)) return null;
    return {
      action,
      text,
      x: numberOrDefault(input.x, NaN),
      y: numberOrDefault(input.y, NaN),
      maxWidth: numberOrDefault(input.maxWidth, NaN),
      lineHeight: numberOrDefault(input.lineHeight, NaN),
      align: String(input.align || ''),
      reason: String(input.reason || ''),
    };
  }

  function normalizeSurfaceDrawAction(action) {
    const value = String(action || '').replace(/_/g, '-').toLowerCase();
    if (value === 'replace-native-draw' || value === 'replace-native' || value === 'replace') {
      return 'replace-native-draw';
    }
    if (value === 'suppress-native-draw' || value === 'skip-native' || value === 'suppress') {
      return 'suppress-native-draw';
    }
    if (value === 'draw-original' || value === 'native' || value === 'original') {
      return 'draw-original';
    }
    return '';
  }

  publish(root, { TextOrchestrator });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
