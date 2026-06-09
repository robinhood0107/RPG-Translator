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
        status: 'detected',
        priority: null,
        visible: true,
        screenState: 'visible',
        backgrounded: false,
        metadata: {},
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

    updateItem(itemId, patch = {}, options = {}) {
      const item = this.getItemById(itemId);
      if (!item) return null;
      const source = patch && typeof patch === 'object' ? patch : {};
      const previousSourceText = item.sourceText;
      if (Object.prototype.hasOwnProperty.call(source, 'text')) item.sourceText = String(source.text ?? '');
      if (Object.prototype.hasOwnProperty.call(source, 'sourceText')) item.sourceText = String(source.sourceText ?? '');
      if (Object.prototype.hasOwnProperty.call(source, 'contextHash')) item.contextHash = source.contextHash || null;
      if (Object.prototype.hasOwnProperty.call(source, 'renderStrategy')) item.renderStrategy = String(source.renderStrategy || '');
      if (Object.prototype.hasOwnProperty.call(source, 'strategy')) item.renderStrategy = String(source.strategy || '');
      if (Object.prototype.hasOwnProperty.call(source, 'translationState')) item.translationState = String(source.translationState || '');
      if (Object.prototype.hasOwnProperty.call(source, 'translationReceived')) item.translationReceived = String(source.translationReceived || '');
      if (Object.prototype.hasOwnProperty.call(source, 'translation')) item.translation = String(source.translation || '');
      if (Object.prototype.hasOwnProperty.call(source, 'status')) item.status = String(source.status || item.state || '');
      if (Object.prototype.hasOwnProperty.call(source, 'priority')) item.priority = normalizePriority(source.priority);
      if (Object.prototype.hasOwnProperty.call(source, 'visible')) item.visible = source.visible === true;
      if (Object.prototype.hasOwnProperty.call(source, 'screenState')) item.screenState = String(source.screenState || '');
      if (Object.prototype.hasOwnProperty.call(source, 'backgrounded')) item.backgrounded = source.backgrounded === true;
      if (source.metadata && typeof source.metadata === 'object') item.metadata = sanitizeDetails(source.metadata) || {};
      if (previousSourceText !== item.sourceText) {
        item.translationState = '';
        item.translationReceived = '';
        item.translation = '';
        item.lastRenderStatus = '';
        item.generation = this.guard ? this.guard.generationFor(item.surface) : item.generation;
      }
      this.emit(options.eventType || 'item.updated', Object.assign({
        reason: options.message || options.reason || 'item-updated',
      }, item));
      return cloneItemForDiagnostics(item);
    }

    requestItemTranslation(itemId, requestOptions = {}) {
      const item = this.activeItems.get(String(itemId || ''));
      if (!item) {
        throw new Error(`[TextOrchestrator] Cannot request cache translation for unknown text item: ${itemId || '(missing id)'}`);
      }
      const sourceHint = String(requestOptions.sourceHint || 'cache-only');
      const text = String(requestOptions.text ?? item.sourceText ?? '');
      const strategy = String(requestOptions.renderStrategy || item.renderStrategy || '');
      const lookupItem = Object.assign({}, item, { sourceText: text });
      const translatedText = this.measure('cache.lookup.ms', () => this.lookup(lookupItem), { domain: 'runtime' });
      if (!translatedText || translatedText === text) {
        this.diagnosticState.cache_misses += 1;
        item.translationState = 'miss';
        item.sourceHint = sourceHint;
        this.emit('requestCacheMiss', Object.assign({
          reason: 'cache-miss',
          status: 'miss',
        }, item));
        this.emit('requestSkipped', Object.assign({
          reason: 'cache-only-miss',
          status: 'miss',
        }, item));
        return createCacheOnlyHandle(text, 'miss', sourceHint);
      }
      this.diagnosticState.cache_hits += 1;
      item.translationState = 'hit';
      item.translationReceived = String(translatedText);
      item.translation = String(translatedText);
      item.sourceHint = sourceHint;
      this.emit('requestCacheHit', Object.assign({
        reason: 'cache-hit',
        status: 'hit',
        translatedText,
      }, item));
      if (requestOptions.queueRender !== false && strategy) {
        this.queueRenderCommand(item, translatedText, 'hit');
      }
      this.emit('requestCompleted', Object.assign({
        reason: sourceHint,
        status: 'completed',
        translatedText,
      }, item));
      return createCacheOnlyHandle(String(translatedText), 'completed', sourceHint);
    }

    cancelItemTranslation(itemId, reason = 'translation canceled', options = {}) {
      const item = this.getItemById(itemId);
      const handle = item && item.translationHandle ? item.translationHandle : null;
      if (!handle || typeof handle.cancel !== 'function') return false;
      try {
        return handle.cancel(String(reason || 'translation canceled'), options && typeof options === 'object' ? options : {}) === true;
      } catch (_error) {
        return false;
      }
    }

    setItemTranslationPriority(itemId, priority, reason = '', details = {}) {
      const item = this.getItemById(itemId);
      if (!item) return false;
      const nextPriority = normalizePriority(priority);
      const changed = item.priority !== nextPriority;
      item.priority = nextPriority;
      const handle = item.translationHandle || null;
      let handleChanged = false;
      if (handle && typeof handle.setPriority === 'function') {
        try {
          handleChanged = handle.setPriority(nextPriority, String(reason || '')) === true;
        } catch (_error) {
          handleChanged = false;
        }
      }
      this.emit('item.priority_changed', Object.assign({
        reason: String(reason || ''),
        details: sanitizeDetails(Object.assign({ priority: nextPriority }, details || {})),
      }, item));
      return changed || handleChanged;
    }

    setItemVisibility(itemId, visible, details = {}) {
      const item = this.getItemById(itemId);
      if (!item) return null;
      const source = details && typeof details === 'object' ? details : {};
      const isVisible = visible === true;
      item.visible = isVisible;
      item.screenState = String(source.screenState || (isVisible ? 'visible' : 'hidden'));
      this.emit(isVisible ? 'item.visible' : 'item.hidden', Object.assign({
        reason: String(source.reason || ''),
        details: sanitizeDetails(source),
      }, item));
      return cloneItemForDiagnostics(item);
    }

    backgroundItem(itemId, details = {}) {
      const item = this.getItemById(itemId);
      if (!item) return null;
      const source = details && typeof details === 'object' ? details : {};
      const priority = normalizePriority(source.priority === undefined ? 100 : source.priority);
      item.visible = false;
      item.backgrounded = true;
      item.priority = priority;
      item.screenState = String(source.screenState || 'background');
      this.emit('item.backgrounded', Object.assign({
        reason: String(source.reason || ''),
        details: sanitizeDetails(Object.assign({ priority }, source)),
      }, item));
      return cloneItemForDiagnostics(item);
    }

    retireItem(itemId, status = 'disappeared', options = {}) {
      const item = this.getItemById(itemId);
      if (!item) return null;
      const source = options && typeof options === 'object' ? options : {};
      const nextStatus = String(status || 'disappeared');
      const reason = String(source.message || source.reason || nextStatus);
      this.rejectOpenRenderCommands(item, reason, source.details);
      this.activeItems.delete(item.id);
      this.detachedItems.delete(item.id);
      item.status = nextStatus;
      item.state = 'archived';
      item.active = false;
      item.deactivatedAt = this.now();
      this.archivedItems.set(item.id, item);
      this.releaseSlotIndexesForItem(item.id);
      this.emit(source.eventType || `item.${nextStatus}`, Object.assign({
        reason,
        details: sanitizeDetails(source.details),
      }, item));
      return cloneItemForDiagnostics(item);
    }

    recordDecision(itemId, type, message = '', details = null) {
      const item = this.getItemById(itemId);
      if (!item) return null;
      this.emit(`decision.${String(type || 'event')}`, Object.assign({
        reason: String(message || ''),
        details: sanitizeDetails(details),
      }, item));
      return cloneItemForDiagnostics(item);
    }

    describeTextEligibility(payload = {}) {
      return describeTextEligibilityDecision(payload);
    }

    rejectOpenRenderCommands(item, reason, details = null) {
      if (!item || !item.id) return 0;
      let rejected = 0;
      for (const command of this.renderQueue) {
        if (!command || command.itemId !== item.id) continue;
        if (command.renderStatus !== 'queued' && command.renderStatus !== 'deferred') continue;
        if (this.recordRenderRejected(item.id, {
          commandId: command.id,
          reason: String(reason || 'item-retired'),
          details,
        })) {
          rejected += 1;
        }
      }
      return rejected;
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

    recordRenderAccepted(itemId, decision = {}) {
      return this.recordRenderDecision('accepted', itemId, decision);
    }

    recordRenderDeferred(itemId, decision = {}) {
      return this.recordRenderDecision('deferred', itemId, decision);
    }

    recordRenderRejected(itemId, decision = {}) {
      return this.recordRenderDecision('rejected', itemId, decision);
    }

    recordRenderDecision(status, itemId, decision = {}) {
      const normalizedStatus = normalizeRenderDecisionStatus(status);
      const source = decision && typeof decision === 'object' ? decision : {};
      const item = this.getItemById(itemId || source.itemId || source.recordId);
      if (!item) return false;
      const command = this.findRenderCommand(item.id, source.commandId);
      const reason = String(source.reason || normalizedStatus);
      const details = sanitizeDetails(source.details);
      const previousStatus = command ? command.renderStatus : item.lastRenderStatus;
      if (command) {
        command.renderStatus = normalizedStatus;
        command.renderReason = reason;
        command.renderDetails = details;
        command.reason = reason;
      }
      item.lastRenderStatus = normalizedStatus;
      if (normalizedStatus === 'accepted' && previousStatus !== 'accepted') {
        this.diagnosticState.render_accepted += 1;
      }
      if (normalizedStatus === 'rejected' && previousStatus !== 'rejected') {
        this.diagnosticState.render_rejected += 1;
      }
      this.emit(renderDecisionEventType(normalizedStatus), Object.assign({
        reason,
        status: normalizedStatus,
        translatedText: command ? command.translatedText : item.translation,
        sourceText: command ? command.sourceText : item.sourceText,
        renderStatus: normalizedStatus,
        renderReason: reason,
        renderDetails: details,
      }, command || item));
      return true;
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

    releaseSlotIndexesForItem(itemId) {
      const key = String(itemId || '');
      for (const [slotId, id] of Array.from(this.slotIndex.entries())) {
        if (id === key) this.slotIndex.delete(slotId);
      }
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

    getItemById(itemId) {
      const key = String(itemId || '');
      return this.activeItems.get(key) || this.detachedItems.get(key) || this.archivedItems.get(key) || null;
    }

    findRenderCommand(itemId, commandId = '') {
      const itemKey = String(itemId || '');
      const commandKey = String(commandId || '');
      for (let index = this.renderQueue.length - 1; index >= 0; index -= 1) {
        const command = this.renderQueue[index];
        if (!command) continue;
        if (commandKey && command.id === commandKey) return command;
        if (!commandKey && itemKey && command.itemId === itemKey) return command;
      }
      return null;
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
      const recordBacked = isRecordBackedSubscription(source);
      return this.subscribe((event) => {
        if (!event || typeof event !== 'object') return;
        const command = event.payload || null;
        if (!command || typeof command !== 'object') return;
        if (renderStrategy && String(command.strategy || '') !== renderStrategy) return;
        if (event.type === 'renderQueued' && typeof source.onRenderQueued === 'function') {
          if (recordBacked) {
            this.dispatchRecordBackedRender(source, command);
            return;
          }
          const route = this.renderRoute('item.render_queued', command);
          const decision = source.onRenderQueued(command, route);
          if (decision === false && typeof source.onRenderRejected === 'function') {
            source.onRenderRejected(command, this.renderRoute('item.render_rejected', command, 'adapter-declined'));
          }
          return;
        }
        if (recordBacked) return;
        if (event.type === 'renderAccepted' && typeof source.onRenderAccepted === 'function') {
          source.onRenderAccepted(command, this.renderRoute('item.render_accepted', command));
          return;
        }
        if (event.type === 'renderRejected' && typeof source.onRenderRejected === 'function') {
          source.onRenderRejected(command, this.renderRoute('item.render_rejected', command, 'render-rejected'));
        }
      });
    }

    dispatchRecordBackedRender(source, command) {
      const route = this.renderRoute('item.render_queued', command);
      route.recordId = command.itemId || '';
      route.commandId = command.id || '';
      route.commandGeneration = numberOrDefault(command.generation, 0);
      const target = resolveSubscriptionRecord(source, route.recordId, command, route);
      if (!target) {
        const decision = createSubscriptionRenderDecision('rejected', 'missing-adapter-record', command, route);
        this.dispatchSubscriptionRenderRejected(source, null, decision, route);
        if (typeof source.onMissingRecord === 'function') {
          source.onMissingRecord(Object.assign({}, route, { reason: decision.reason }), { type: 'item.render_queued' }, command);
        }
        return false;
      }

      const lifecycleRecord = resolveLifecycleRecord(source, target, command, route);
      const validationFailure = this.validateSubscriptionRenderCommand(source, target, lifecycleRecord, command, route);
      if (validationFailure) {
        this.dispatchSubscriptionRenderRejected(source, target, validationFailure, route);
        return false;
      }

      let callbackDecision = null;
      try {
        callbackDecision = normalizeSubscriptionRenderCallbackDecision(
          source.onRenderQueued(target, command, route),
          command,
          route,
        );
      } catch (error) {
        callbackDecision = createSubscriptionRenderDecision('rejected', 'adapter-render-error', command, route, {
          message: error && error.message ? String(error.message) : String(error || ''),
        });
      }

      if (callbackDecision.status === 'deferred') {
        this.dispatchSubscriptionRenderDeferred(callbackDecision, route);
        return true;
      }
      if (callbackDecision.status !== 'accepted') {
        this.dispatchSubscriptionRenderRejected(source, target, callbackDecision, route);
        return false;
      }
      this.dispatchSubscriptionRenderAccepted(source, target, callbackDecision, route);
      return true;
    }

    validateSubscriptionRenderCommand(source, target, lifecycleRecord, command, route) {
      if (!command.itemId || !command.strategy) {
        return createSubscriptionRenderDecision('rejected', 'invalid-command', command, route);
      }
      if (!lifecycleRecord || (typeof lifecycleRecord !== 'object' && typeof lifecycleRecord !== 'function')) {
        return createSubscriptionRenderDecision('rejected', 'missing-lifecycle-record', command, route);
      }
      const generationFailure = validateSubscriptionGeneration(source, target, command, route);
      if (generationFailure) return generationFailure;
      if (typeof source.isRenderTargetCurrent !== 'function') {
        return createSubscriptionRenderDecision('rejected', 'missing-current-validator', command, route);
      }
      const current = source.isRenderTargetCurrent(target, command, route);
      if (current === true) return null;
      const details = current && typeof current === 'object' ? current : {};
      const reason = String(details.reason || details.status || current || 'target-not-current');
      return createSubscriptionRenderDecision('rejected', reason, command, route, details);
    }

    dispatchSubscriptionRenderAccepted(source, record, decision, route) {
      this.recordRenderAccepted(decision.itemId || route.itemId, decision);
      if (typeof source.onRenderAccepted === 'function') {
        source.onRenderAccepted(record, decision, route);
      }
    }

    dispatchSubscriptionRenderDeferred(decision, route) {
      this.recordRenderDeferred(decision.itemId || route.itemId, decision);
    }

    dispatchSubscriptionRenderRejected(source, record, decision, route) {
      this.recordRenderRejected(decision.itemId || route.itemId, decision);
      if (typeof source.onRenderRejected === 'function') {
        source.onRenderRejected(record, decision, route);
      }
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
        renderStatus: 'queued',
        renderReason: '',
        renderDetails: null,
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
      status: stringValue(source.status),
      priority: source.priority === null || typeof source.priority === 'undefined'
        ? null
        : numberOrDefault(source.priority, 0),
      visible: source.visible === true,
      screenState: stringValue(source.screenState),
      backgrounded: source.backgrounded === true,
      translationState: stringValue(source.translationState),
      translationReceived: limitText(source.translationReceived),
      translation: limitText(source.translation),
      lastRenderStatus: stringValue(source.lastRenderStatus),
      sourceHint: stringValue(source.sourceHint),
      metadata: source.metadata && typeof source.metadata === 'object'
        ? Object.assign({}, source.metadata)
        : {},
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
      renderStatus: stringValue(source.renderStatus),
      renderReason: stringValue(source.renderReason),
      renderDetails: source.renderDetails && typeof source.renderDetails === 'object'
        ? Object.assign({}, source.renderDetails)
        : null,
      strategy: stringValue(source.strategy),
      generation: numberOrDefault(source.generation, 0),
    };
  }

  function createCacheOnlyHandle(text, status, sourceHint) {
    return {
      promise: Promise.resolve(String(text ?? '')),
      cancel: () => false,
      setPriority: () => false,
      getPriority: () => 0,
      getStatus: () => String(status || ''),
      getSourceHint: () => String(sourceHint || ''),
    };
  }

  function normalizeRenderDecisionStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'accepted') return 'accepted';
    if (value === 'deferred') return 'deferred';
    if (value === 'rejected') return 'rejected';
    return 'rejected';
  }

  function renderDecisionEventType(status) {
    if (status === 'accepted') return 'renderAccepted';
    if (status === 'deferred') return 'renderDeferred';
    return 'renderRejected';
  }

  function isRecordBackedSubscription(source) {
    return Boolean(source && (
      source.records
      || source.recordRegistry
      || source.recordsById
      || source.resolveRecord
      || source.getLifecycleRecord
      || source.getRenderGeneration
      || source.isRenderTargetCurrent
      || source.onMissingRecord
    ));
  }

  function resolveSubscriptionRecord(source, recordId, command, route) {
    if (source && typeof source.resolveRecord === 'function') {
      return source.resolveRecord(recordId, { type: 'item.render_queued' }, command, route) || null;
    }
    const records = source && (source.records || source.recordRegistry || source.recordsById);
    if (!records || !recordId) return null;
    if (typeof records.get === 'function') return records.get(recordId) || null;
    if (Object.prototype.hasOwnProperty.call(records, recordId)) return records[recordId] || null;
    return null;
  }

  function resolveLifecycleRecord(source, target, command, route) {
    if (source && typeof source.getLifecycleRecord === 'function') {
      return source.getLifecycleRecord(target, command, route) || null;
    }
    return target || null;
  }

  function validateSubscriptionGeneration(source, target, command, route) {
    const commandGeneration = numberOrDefault(command && command.generation, 0);
    if (!commandGeneration) return null;
    if (!source || typeof source.getRenderGeneration !== 'function') return null;
    const targetGeneration = Number(source.getRenderGeneration(target, command, route));
    if (!Number.isFinite(targetGeneration)) {
      return createSubscriptionRenderDecision('rejected', 'missing-generation', command, route, {
        commandGeneration,
      });
    }
    if (targetGeneration !== commandGeneration) {
      return createSubscriptionRenderDecision('rejected', 'generation-mismatch', command, route, {
        commandGeneration,
        targetGeneration,
      });
    }
    return null;
  }

  function createSubscriptionRenderDecision(status, reason, command, route, details = {}) {
    const normalizedStatus = normalizeRenderDecisionStatus(status);
    return {
      status: normalizedStatus,
      reason: String(reason || normalizedStatus),
      recordId: String((route && route.recordId) || (command && command.itemId) || ''),
      itemId: String((route && route.itemId) || (command && command.itemId) || ''),
      commandId: String((command && command.id) || (route && route.commandId) || ''),
      strategy: String((command && command.strategy) || (route && route.strategy) || ''),
      commandGeneration: numberOrDefault((command && command.generation) || (route && route.commandGeneration), 0),
      details: sanitizeDetails(details) || {},
    };
  }

  function normalizeSubscriptionRenderCallbackDecision(value, command, route) {
    if (value === true) return createSubscriptionRenderDecision('accepted', 'accepted', command, route);
    if (typeof value === 'string') {
      const status = normalizeRenderDecisionStatus(value);
      return createSubscriptionRenderDecision(status, value || status, command, route);
    }
    if (value && typeof value === 'object') {
      const status = normalizeRenderDecisionStatus(value.status || value.result || value.decision);
      const fallbackReason = status === 'accepted' ? 'accepted' : (status === 'deferred' ? 'deferred' : 'adapter-declined');
      return createSubscriptionRenderDecision(status, value.reason || fallbackReason, command, route, value.details || {});
    }
    return createSubscriptionRenderDecision('rejected', 'adapter-declined', command, route);
  }

  function sanitizeDetails(details) {
    if (!details || typeof details !== 'object') return null;
    const output = {};
    for (const [key, value] of Object.entries(details)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        output[key] = value;
      }
    }
    return output;
  }

  function normalizePriority(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(10000, Math.floor(numeric)));
  }

  function describeTextEligibilityDecision(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const text = selectEligibilityText(source);
    const hasText = hasAnyTextValue(source);
    if (!hasText) {
      return textEligibilityDecision(false, 'empty', 'emptyInput', '', 'policy', { hasText: false });
    }
    if (!String(text || '').trim()) {
      return textEligibilityDecision(false, 'empty', 'emptyTrimmed', text, 'policy', { hasText: true });
    }
    if (isNativeTextInput(source)) {
      return textEligibilityDecision(false, 'native', String(source.reason || source.skipReason || 'native'), text, 'native', {
        explicitNative: true,
      });
    }
    if (String(source.status || source.translationStatus || '') === 'skipped') {
      return textEligibilityDecision(false, 'skipped', String(source.reason || source.skipReason || 'skipped'), text, 'policy', {
        status: 'skipped',
      });
    }
    const counterText = stripKnownCounterLikeEscapes(String(source.visibleText || text || ''));
    if (isCounterLikeText(counterText)) {
      return textEligibilityDecision(false, 'counterLike', 'counterLike', text, 'policy', {
        visibleText: String(source.visibleText || ''),
        counterLikeText: counterText,
      });
    }
    return textEligibilityDecision(true, 'eligible', '', text, '', {
      status: String(source.status || source.translationStatus || 'detected'),
    });
  }

  function textEligibilityDecision(eligible, category, reason, text, sourceHint, details = {}) {
    const normalizedText = String(text || '').trim();
    return {
      eligible: eligible === true,
      skip: eligible !== true,
      category: String(category || (eligible ? 'eligible' : 'policy')),
      reason: String(reason || ''),
      sourceHint: String(sourceHint || ''),
      providerEligible: eligible === true,
      providerCategory: String(category || ''),
      providerReason: String(reason || ''),
      providerSourceHint: String(sourceHint || ''),
      text: String(text || ''),
      normalizedText,
      details: Object.assign({}, sanitizeDetails(details) || {}, {
        category: String(category || ''),
        reason: String(reason || ''),
        providerEligible: eligible === true,
        providerCategory: String(category || ''),
        providerReason: String(reason || ''),
      }),
    };
  }

  function selectEligibilityText(source) {
    if (hasExplicitTranslationSource(source)) {
      return stringValue(source.normalizedSource || source.translationSource);
    }
    return stringValue(
      firstNonEmpty(
        source.visibleText,
        source.original,
        source.rawText,
        source.text,
      ),
    );
  }

  function hasAnyTextValue(source) {
    return [
      source.normalizedSource,
      source.translationSource,
      source.visibleText,
      source.original,
      source.rawText,
      source.text,
    ].some((value) => value !== undefined && value !== null && String(value).length > 0);
  }

  function hasExplicitTranslationSource(source) {
    return Object.prototype.hasOwnProperty.call(source, 'normalizedSource')
      || Object.prototype.hasOwnProperty.call(source, 'translationSource');
  }

  function isNativeTextInput(source) {
    if (source.isTranslatable === false || source.translatable === false) return true;
    if (source.native === true || source.keepNative === true || source.skipTranslation === true) return true;
    return String(source.sourceHint || source.translationSourceKind || '') === 'native';
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = stringValue(value);
      if (text) return text;
    }
    return '';
  }

  function stripKnownCounterLikeEscapes(text) {
    return String(text || '').replace(/(?:\x1b|\\)(?:C\[[^\]]*\]|I\[[^\]]*\]|\{|\}|\$|\.|\||!|>|<|\^)/giu, '').trim();
  }

  function isCounterLikeText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (/[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(value)) return false;
    return /^[\d\s.,:;/%+\-()[\]#]+$/u.test(value);
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
