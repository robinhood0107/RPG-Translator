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
      this.ownershipClaims = new Map();
      this.ownershipBuckets = new WeakMap();
      this.nextOwnershipId = 1;
      this.sourceTranslations = new Map();
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
        source_cache_hits: 0,
        render_accepted: 0,
        render_rejected: 0,
        ownership_conflicts: 0,
        surface_claims: 0,
        text_claims: 0,
        surface_releases: 0,
        text_releases: 0,
      };
    }

    observeRecord(record = {}, options = {}) {
      if (!this.validateObservationOwnership(record, options)) return null;
      const text = String(record.text ?? '');
      const surface = record.surface || null;
      const slotId = record.slotId || this.defaultSlotId(record.adapter, surface, record.slotKey);
      const existingId = slotId ? this.slotIndex.get(slotId) : '';
      const existing = existingId ? this.activeItems.get(existingId) : null;
      if (existing && sameObservedSource(existing, text)) {
        this.refreshObservedItem(existing, record, surface, slotId, 'same slot refreshed');
        return this.lookupAndQueueObservedItem(existing);
      }
      if (existing) {
        this.retireItem(existing.id, 'stale', {
          eventType: 'item.replaced',
          message: 'same slot replaced',
          details: {
            replacedBy: '',
            slotId,
            previousSourceText: existing.sourceText,
            nextSourceText: text,
          },
        });
      }
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
        priority: Object.prototype.hasOwnProperty.call(record, 'priority')
          ? normalizePriority(record.priority)
          : null,
        visible: Object.prototype.hasOwnProperty.call(record, 'visible')
          ? record.visible === true
          : true,
        screenState: String(record.screenState || (record.visible === false ? 'hidden' : 'visible')),
        backgrounded: record.backgrounded === true,
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
      return this.lookupAndQueueObservedItem(item);
    }

    refreshObservedItem(item, record, surface, slotId, reason) {
      item.adapter = record.adapter || item.adapter || 'unknown';
      item.kind = record.kind || item.kind || 'text';
      item.surface = surface || item.surface || null;
      item.surfaceId = this.surfaceId(item.surface);
      item.slotId = slotId || item.slotId;
      item.sourceText = String(record.text ?? item.sourceText ?? '');
      item.contextHash = record.contextHash || null;
      item.generation = this.guard ? this.guard.generationFor(item.surface) : item.generation;
      item.renderStrategy = record.renderStrategy || record.strategy || item.renderStrategy || '';
      item.state = 'active';
      item.status = 'detected';
      if (Object.prototype.hasOwnProperty.call(record, 'priority')) item.priority = normalizePriority(record.priority);
      item.visible = Object.prototype.hasOwnProperty.call(record, 'visible')
        ? record.visible === true
        : true;
      item.screenState = String(record.screenState || (item.visible ? 'visible' : 'hidden'));
      item.backgrounded = record.backgrounded === true;
      this.activeItems.set(item.id, item);
      this.slotIndex.set(item.slotId, item.id);
      this.diagnosticState.observed_items += 1;
      this.recordDrawTrace('observe', {
        adapter: item.adapter,
        methodName: item.kind,
        rawText: item.sourceText,
        visibleText: item.sourceText,
        reason,
        force: true,
      });
      this.emit('observed', Object.assign({ reason }, item));
      return item;
    }

    lookupAndQueueObservedItem(item) {
      const text = String((item && item.sourceText) ?? '');
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
      const cacheHitReason = item.sourceHint === 'source-cache' ? 'source-cache' : 'cache-hit';
      this.recordDrawTrace('cache-hit', {
        adapter: item.adapter,
        methodName: item.kind,
        rawText: text,
        visibleText: translatedText,
        reason: cacheHitReason,
        force: true,
      });
      this.emit('cacheHit', Object.assign({ reason: cacheHitReason, status: 'hit', translatedText }, item));
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
      if (Object.prototype.hasOwnProperty.call(source, 'translationDrawn')) item.translationDrawn = String(source.translationDrawn || '');
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
        item.translationDrawn = '';
        item.translation = '';
        item.sourceHint = '';
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
      item.sourceHint = lookupItem.sourceHint === 'source-cache' ? 'source-cache' : sourceHint;
      this.emit('requestCacheHit', Object.assign({
        reason: item.sourceHint === 'source-cache' ? 'source-cache' : 'cache-hit',
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

    recordDraw(itemId, eventName = 'draw', details = null) {
      const source = details && typeof details === 'object' ? details : {};
      const patch = {};
      const drawnText = firstNonEmpty(
        source.translationDrawn,
        source.drawnTranslation,
        source.drawnText,
        source.text,
      );
      const receivedText = firstNonEmpty(source.translationReceived, source.receivedTranslation);
      if (drawnText) {
        patch.translation = drawnText;
        patch.translationDrawn = drawnText;
      }
      if (receivedText) patch.translationReceived = receivedText;
      return this.updateItem(itemId, patch, {
        eventType: 'item.rendered',
        message: String(eventName || 'draw'),
        details: source,
      });
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

    detachItem(itemId, reason = 'item detached') {
      const item = this.activeItems.get(itemId);
      if (!item) return false;
      const message = String(reason || 'item detached');
      this.rejectOpenRenderCommands(item, message);
      this.activeItems.delete(itemId);
      item.state = 'detached';
      item.status = 'detached';
      item.active = false;
      item.deactivatedAt = this.now();
      this.detachedItems.set(itemId, item);
      this.releaseSlotIndexesForItem(itemId);
      this.emit('item.detached', Object.assign({ reason: message }, item));
      return true;
    }

    archiveItem(itemId, reason = 'item archived') {
      const item = this.activeItems.get(itemId) || this.detachedItems.get(itemId);
      if (!item) return false;
      const message = String(reason || 'item archived');
      this.rejectOpenRenderCommands(item, message);
      this.activeItems.delete(itemId);
      this.detachedItems.delete(itemId);
      item.state = 'archived';
      item.status = 'archived';
      item.active = false;
      item.deactivatedAt = this.now();
      this.archivedItems.set(itemId, item);
      this.releaseSlotIndexesForItem(itemId);
      this.emit('item.archived', Object.assign({ reason: message }, item));
      return true;
    }

    retireSurface(surface, reason) {
      if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) return 0;
      const message = String(reason || 'surface-retired');
      let retired = 0;
      for (const [itemId, item] of Array.from(this.activeItems.entries())) {
        if (item.surface !== surface) continue;
        if (this.archiveItem(itemId, message)) retired += 1;
      }
      for (const [itemId, item] of Array.from(this.detachedItems.entries())) {
        if (item.surface !== surface) continue;
        if (this.archiveItem(itemId, message)) retired += 1;
      }
      if (retired > 0) {
        if (this.guard) this.guard.markSurfaceChanged(surface);
        this.emit('surfaceRetired', { surfaceId: this.surfaceId(surface), reason: message, retired });
      }
      return retired;
    }

    claimSurface(surface, owner) {
      const payloadMode = isPlainObject(surface) && owner === undefined;
      const descriptor = payloadMode
        ? this.normalizeOwnershipDescriptor(surface, 'surface')
        : this.normalizeOwnershipDescriptor({ target: surface, owner }, 'surface');
      if (!descriptor.target || (typeof descriptor.target !== 'object' && typeof descriptor.target !== 'function')) {
        return payloadMode ? ownershipDenied('missing-target') : false;
      }
      const bucket = payloadMode ? this.getOwnershipBucket(descriptor.target, true) : null;
      const winner = bucket ? this.getSurfaceWinner(bucket) : null;
      if (winner && winner.owner !== descriptor.owner && winner.priority >= descriptor.priority) {
        this.diagnosticState.ownership_conflicts += 1;
        this.emit('ownershipConflict', {
          kind: 'surface',
          owner: descriptor.owner,
          current: winner.owner,
          surfaceId: this.surfaceId(descriptor.target),
          reason: 'surface-owned',
        });
        return ownershipDenied('surface-owned', winner);
      }
      const current = this.surfaceClaims.get(descriptor.target);
      const currentOwner = ownershipClaimOwner(current);
      if (currentOwner && currentOwner !== descriptor.owner) {
        this.diagnosticState.ownership_conflicts += 1;
        this.emit('ownershipConflict', {
          kind: 'surface',
          owner: descriptor.owner,
          current: currentOwner,
          surfaceId: this.surfaceId(descriptor.target),
          reason: 'ownership-conflict',
        });
        return payloadMode ? ownershipDenied('ownership-conflict', current) : false;
      }
      if (!current) this.diagnosticState.surface_claims += 1;
      if (!payloadMode) {
        this.surfaceClaims.set(descriptor.target, descriptor.owner);
        return true;
      }
      const claim = this.createOwnershipClaim('surface', descriptor, 'claimed', bucket);
      this.registerOwnershipClaim(claim);
      this.preemptLowerPriorityClaims(bucket, claim);
      this.surfaceClaims.set(descriptor.target, claim);
      return ownershipAccepted('claimed', claim);
    }

    releaseSurface(surface, owner) {
      const tokenMode = isOwnershipToken(surface, 'surface');
      const target = tokenMode ? surface.surface : surface;
      const expectedOwner = tokenMode ? surface.owner : owner;
      if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
      const current = this.surfaceClaims.get(target);
      if (!current) return false;
      if (expectedOwner && ownershipClaimOwner(current) !== expectedOwner) return false;
      this.surfaceClaims.delete(target);
      if (tokenMode) this.retireOwnershipToken(surface, 'released');
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
      const payloadMode = isPlainObject(slotId) && owner === undefined;
      const descriptor = payloadMode
        ? this.normalizeOwnershipDescriptor(slotId, 'text')
        : this.normalizeOwnershipDescriptor({ slotKey: slotId, owner }, 'text');
      if (!descriptor.slotKey) return payloadMode ? ownershipDenied('missing-slot') : false;
      const blocker = payloadMode ? this.findTextOwnershipBlocker(descriptor) : null;
      if (blocker) return ownershipDenied(blocker.reason, blocker.claim);
      const bucket = payloadMode && descriptor.target ? this.getOwnershipBucket(descriptor.target, true) : null;
      const winner = bucket ? this.getSurfaceWinner(bucket) : null;
      if (winner && winner.owner !== descriptor.owner && winner.priority >= descriptor.priority) {
        this.diagnosticState.ownership_conflicts += 1;
        this.emit('ownershipConflict', {
          kind: 'text',
          owner: descriptor.owner,
          current: winner.owner,
          slotId: descriptor.slotKey,
          reason: 'surface-owned',
        });
        return ownershipDenied('surface-owned', winner);
      }
      const current = this.textClaims.get(descriptor.slotKey);
      const currentOwner = ownershipClaimOwner(current);
      if (currentOwner && currentOwner !== descriptor.owner) {
        this.diagnosticState.ownership_conflicts += 1;
        this.emit('ownershipConflict', {
          kind: 'text',
          owner: descriptor.owner,
          current: currentOwner,
          slotId: descriptor.slotKey,
          reason: 'ownership-conflict',
        });
        return payloadMode ? ownershipDenied('ownership-conflict', current) : false;
      }
      if (!current) this.diagnosticState.text_claims += 1;
      if (!payloadMode) {
        this.textClaims.set(descriptor.slotKey, descriptor.owner);
        return true;
      }
      const claim = this.createOwnershipClaim(
        'text',
        descriptor,
        descriptor.provisional ? 'provisional' : 'claimed',
        bucket,
      );
      this.registerOwnershipClaim(claim);
      this.textClaims.set(descriptor.slotKey, claim);
      return ownershipAccepted(descriptor.provisional ? 'provisional' : 'claimed', claim);
    }

    finalizeTextClaim(token, input = {}) {
      if (!isOwnershipToken(token, 'text')) return ownershipDenied('missing-token');
      const claim = this.ownershipClaims.get(token);
      if (!claim || claim.active !== true) return ownershipDenied('stale-claim', claim);
      const descriptor = this.normalizeOwnershipDescriptor(Object.assign({}, claim.descriptor, input || {}, {
        owner: claim.owner,
        target: claim.target,
        slotKey: claim.slotKey,
      }), 'text');
      const bucket = claim.bucket || (claim.target ? this.getOwnershipBucket(claim.target, false) : null);
      const winner = bucket ? this.getSurfaceWinner(bucket) : null;
      if (winner && winner.owner !== claim.owner && winner.priority >= claim.priority) {
        this.revokeOwnershipClaim(claim, 'surface-owned');
        return ownershipDenied('surface-owned', winner);
      }
      const current = this.textClaims.get(descriptor.slotKey);
      const currentOwner = ownershipClaimOwner(current);
      if (currentOwner && currentOwner !== claim.owner) {
        this.revokeOwnershipClaim(claim, 'ownership-conflict');
        return ownershipDenied('ownership-conflict', current);
      }
      claim.provisional = false;
      claim.status = 'claimed';
      claim.updatedAt = this.now();
      this.textClaims.set(descriptor.slotKey, claim);
      return ownershipAccepted('claimed', claim);
    }

    releaseTextClaim(slotId, owner) {
      const tokenMode = isOwnershipToken(slotId, 'text');
      const key = tokenMode ? slotId.slotKey : slotId;
      const expectedOwner = tokenMode ? slotId.owner : owner;
      const current = this.textClaims.get(key);
      if (!current) return false;
      if (expectedOwner && ownershipClaimOwner(current) !== expectedOwner) return false;
      this.textClaims.delete(key);
      if (tokenMode) this.retireOwnershipToken(slotId, 'released');
      this.diagnosticState.text_releases += 1;
      return true;
    }

    normalizeOwnershipDescriptor(input = {}, defaultKind = 'text') {
      const source = input && typeof input === 'object' ? input : {};
      const owner = stringValue(
        source.owner
        || source.ownerAdapter
        || source.sourceAdapter
        || source.adapterId
        || source.hook
        || defaultKind
      );
      return {
        owner,
        sourceAdapter: stringValue(source.sourceAdapter || source.adapterId || owner),
        target: source.target || source.surface || source.bitmap || source.window || source.windowInstance || source.sprite || null,
        slotKey: stringValue(source.slotKey || source.slotId || source.id),
        kind: defaultKind,
        mode: stringValue(source.mode || source.role || defaultKind),
        text: stringValue(source.text || source.visibleText || source.rawText || source.translationSource),
        searchText: normalizeOwnershipText(source.searchText || source.text || source.visibleText || source.rawText || source.translationSource),
        standaloneGlyph: source.standaloneGlyph === true,
        priority: normalizePriority(source.priority),
        provisional: source.provisional === true,
        metadata: sanitizeDetails(source.metadata),
      };
    }

    createOwnershipClaim(kind, descriptor, status, bucket = null) {
      const token = {
        id: `own-${this.nextOwnershipId++}`,
        kind,
        surface: kind === 'surface' ? descriptor.target : null,
        target: descriptor.target,
        slotKey: descriptor.slotKey,
        owner: descriptor.owner,
      };
      const claim = {
        token,
        kind,
        owner: descriptor.owner,
        target: descriptor.target,
        slotKey: descriptor.slotKey,
        bucket,
        mode: descriptor.mode,
        searchText: descriptor.searchText,
        standaloneGlyph: descriptor.standaloneGlyph,
        priority: descriptor.priority,
        provisional: status === 'provisional',
        status,
        active: true,
        descriptor,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.ownershipClaims.set(token, claim);
      return claim;
    }

    findTextOwnershipBlocker(descriptor) {
      if (!descriptor || descriptor.owner === 'message') return null;
      const glyph = descriptor.standaloneGlyph || descriptor.mode === 'bitmapFallback'
        ? normalizeOwnershipText(descriptor.text)
        : '';
      if (!glyph) return null;
      for (const claim of this.ownershipClaims.values()) {
        if (!claim || claim.kind !== 'text') continue;
        if (!isLiveOwnershipClaim(claim)) continue;
        if (claim.mode !== 'messageGlyphSource') continue;
        if (claim.owner === descriptor.owner) continue;
        if (claim.searchText && claim.searchText.indexOf(glyph) >= 0) {
          return { reason: 'message-glyph-source', claim };
        }
      }
      return null;
    }

    validateObservationOwnership(source = {}, options = {}) {
      const eventOptions = options && typeof options === 'object' ? options : {};
      const required = eventOptions.ownershipRequired === true;
      const token = eventOptions.ownershipToken || eventOptions.ownership || null;
      if (!required && !token) return true;
      const claim = this.ownershipClaims.get(token);
      if (!claim || claim.kind !== 'text' || claim.active !== true) return false;
      const owner = stringValue(source.sourceAdapter || source.adapter || source.hook || 'text');
      if (claim.owner !== owner) return false;
      if (claim.provisional === true) return false;
      const bucket = claim.bucket || (claim.target ? this.getOwnershipBucket(claim.target, false) : null);
      if (!bucket) return true;
      const winner = this.getSurfaceWinner(bucket);
      return !(winner && winner.owner !== claim.owner && winner.priority >= claim.priority);
    }

    registerOwnershipClaim(claim) {
      if (!claim || !claim.bucket) return false;
      if (claim.kind === 'surface') claim.bucket.surfaceClaims.add(claim);
      if (claim.kind === 'text') claim.bucket.textClaims.add(claim);
      return true;
    }

    retireOwnershipToken(token, status) {
      const claim = this.ownershipClaims.get(token);
      if (!claim) return false;
      claim.active = false;
      claim.status = String(status || 'released');
      claim.updatedAt = this.now();
      this.ownershipClaims.delete(token);
      this.removeOwnershipClaim(claim);
      return true;
    }

    revokeOwnershipClaim(claim, reason) {
      if (!claim || claim.active !== true) return false;
      claim.active = false;
      claim.status = 'revoked';
      claim.reason = String(reason || 'revoked');
      claim.updatedAt = this.now();
      this.removeOwnershipClaim(claim);
      return true;
    }

    removeOwnershipClaim(claim) {
      if (!claim) return false;
      const bucket = claim.bucket || null;
      if (bucket) {
        if (claim.kind === 'surface') bucket.surfaceClaims.delete(claim);
        if (claim.kind === 'text') bucket.textClaims.delete(claim);
      }
      if (claim.kind === 'surface' && claim.target && this.surfaceClaims.get(claim.target) === claim) {
        this.surfaceClaims.delete(claim.target);
      }
      if (claim.kind === 'text' && claim.slotKey && this.textClaims.get(claim.slotKey) === claim) {
        this.textClaims.delete(claim.slotKey);
      }
      return true;
    }

    getOwnershipBucket(target, create) {
      if (!target || (typeof target !== 'object' && typeof target !== 'function')) return null;
      let bucket = this.ownershipBuckets.get(target);
      if (!bucket && create) {
        bucket = {
          surfaceClaims: new Set(),
          textClaims: new Set(),
        };
        this.ownershipBuckets.set(target, bucket);
      }
      return bucket || null;
    }

    getSurfaceWinner(bucket) {
      if (!bucket) return null;
      let winner = null;
      for (const claim of bucket.surfaceClaims) {
        if (!isLiveOwnershipClaim(claim)) continue;
        if (!winner
          || claim.priority > winner.priority
          || (claim.priority === winner.priority && claim.createdAt < winner.createdAt)) {
          winner = claim;
        }
      }
      return winner;
    }

    preemptLowerPriorityClaims(bucket, winner) {
      if (!bucket || !winner) return 0;
      let revoked = 0;
      for (const claim of Array.from(bucket.surfaceClaims)) {
        if (claim === winner) continue;
        if (!isLiveOwnershipClaim(claim)) continue;
        if (claim.owner !== winner.owner && claim.priority < winner.priority) {
          if (this.revokeOwnershipClaim(claim, 'preempted')) revoked += 1;
        }
      }
      for (const claim of Array.from(bucket.textClaims)) {
        if (!isLiveOwnershipClaim(claim)) continue;
        if (claim.owner !== winner.owner && claim.priority < winner.priority) {
          if (this.revokeOwnershipClaim(claim, 'preempted')) revoked += 1;
        }
      }
      return revoked;
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
        source_cache_entries: this.sourceTranslations.size,
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
        if (renderStrategy && subscriptionPayloadStrategy(command) !== renderStrategy) return;
        if (event.type === 'renderQueued' && typeof source.onRenderQueued === 'function') {
          if (recordBacked) {
            this.dispatchRecordBackedRender(source, command);
            return;
          }
          const route = this.renderRoute('item.render_queued', command);
          let decision = null;
          try {
            decision = source.onRenderQueued(command, route);
          } catch (error) {
            this.recordAdapterCallbackError('render_queued', command.itemId || route.itemId, error);
            return;
          }
          if (decision === false && typeof source.onRenderRejected === 'function') {
            try {
              source.onRenderRejected(command, this.renderRoute('item.render_rejected', command, 'adapter-declined'));
            } catch (error) {
              this.recordAdapterCallbackError('render_rejected', command.itemId || route.itemId, error);
            }
          }
          return;
        }
        if (recordBacked) {
          this.dispatchRecordBackedEvent(source, event, command);
          return;
        }
        if (event.type === 'renderAccepted' && typeof source.onRenderAccepted === 'function') {
          const route = this.renderRoute('item.render_accepted', command);
          try {
            source.onRenderAccepted(command, route);
          } catch (error) {
            this.recordAdapterCallbackError('render_accepted', command.itemId || route.itemId, error);
          }
          return;
        }
        if (event.type === 'renderRejected' && typeof source.onRenderRejected === 'function') {
          const route = this.renderRoute('item.render_rejected', command, 'render-rejected');
          try {
            source.onRenderRejected(command, route);
          } catch (error) {
            this.recordAdapterCallbackError('render_rejected', command.itemId || route.itemId, error);
          }
        }
      });
    }

    dispatchRecordBackedRender(source, command) {
      const route = this.renderRoute('item.render_queued', command);
      route.recordId = command.itemId || '';
      route.commandId = command.id || '';
      route.commandGeneration = numberOrDefault(command.generation, 0);
      let target = null;
      try {
        target = resolveSubscriptionRecord(source, route.recordId, command, route);
      } catch (error) {
        const decision = createAdapterRenderErrorDecision(command, route, error);
        this.dispatchSubscriptionRenderRejected(source, null, decision, route);
        return false;
      }
      if (!target) {
        const decision = createSubscriptionRenderDecision('rejected', 'missing-adapter-record', command, route);
        this.dispatchSubscriptionRenderRejected(source, null, decision, route);
        if (typeof source.onMissingRecord === 'function') {
          try {
            source.onMissingRecord(Object.assign({}, route, { reason: decision.reason }), { type: 'item.render_queued' }, command);
          } catch (error) {
            this.recordAdapterCallbackError('render_queued.missing', command.itemId || route.recordId, error);
          }
        }
        return false;
      }

      let lifecycleRecord = target;
      let validationFailure = null;
      try {
        lifecycleRecord = resolveLifecycleRecord(source, target, command, route);
        validationFailure = this.validateSubscriptionRenderCommand(source, target, lifecycleRecord, command, route);
      } catch (error) {
        validationFailure = createAdapterRenderErrorDecision(command, route, error);
      }
      if (validationFailure) {
        this.dispatchSubscriptionRenderRejected(source, target, validationFailure, route);
        return false;
      }

      rememberSubscriptionRecordEvent(lifecycleRecord, route.recordId, { type: 'item.render_queued' }, route);
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

    dispatchRecordBackedEvent(source, event, payload) {
      const type = String(event && event.type || '');
      if (type === 'requestSkipped' || type === 'item.skipped') {
        return this.dispatchSubscriptionRecordEvent(source, event, payload, source.onSkipped, 'skipped');
      }
      if (type === 'item.failed' || type === 'item.translation_noop' || type === 'item.translation_noop_detached') {
        return this.dispatchSubscriptionRecordEvent(source, event, payload, source.onFailed, 'failed');
      }
      if (typeof source.onEvent === 'function') {
        return this.dispatchSubscriptionRecordEvent(source, event, payload, source.onEvent, type || 'event');
      }
      return false;
    }

    dispatchSubscriptionRecordEvent(source, event, payload, handler, operation) {
      if (typeof handler !== 'function') return false;
      const recordId = subscriptionEventRecordId(event, payload);
      const route = this.subscriptionEventRoute(event, payload, recordId);
      let target = null;
      try {
        target = resolveSubscriptionEventRecord(source, recordId, event, payload, route);
      } catch (error) {
        this.recordAdapterCallbackError(`${String(operation || 'event')}.resolveRecord`, recordId, error);
        return false;
      }
      if (!target) {
        if (typeof source.onMissingRecord === 'function') {
          try {
            source.onMissingRecord(Object.assign({}, route, { reason: 'missing-adapter-record' }), event, payload);
          } catch (error) {
            this.recordAdapterCallbackError(`${String(operation || 'event')}.missing`, recordId, error);
          }
        }
        return false;
      }
      if (!canTouchSubscriptionLifecycleRecord(target)) return false;
      rememberSubscriptionRecordEvent(target, recordId, event, route);
      try {
        handler(target, event, route);
      } catch (error) {
        this.recordAdapterCallbackError(operation || 'event', recordId, error);
      }
      return true;
    }

    recordAdapterCallbackError(operation, itemId, error) {
      const details = {};
      if (error && typeof error === 'object') {
        if (error.name) details.errorName = String(error.name);
        if (error.message) details.errorMessage = String(error.message);
        if (error.code) details.errorCode = String(error.code);
      } else if (error !== undefined && error !== null) {
        details.errorMessage = String(error);
      }
      this.emit('adapterCallbackError', {
        reason: `subscribeRecords.${String(operation || 'event')}`,
        itemId,
        details: sanitizeDetails(details),
      });
    }

    validateSubscriptionRenderCommand(source, target, lifecycleRecord, command, route) {
      if (!command.itemId || !command.strategy) {
        return createSubscriptionRenderDecision('rejected', 'invalid-command', command, route);
      }
      if (!lifecycleRecord || (typeof lifecycleRecord !== 'object' && typeof lifecycleRecord !== 'function')) {
        return createSubscriptionRenderDecision('rejected', 'missing-lifecycle-record', command, route);
      }
      if (!canTouchSubscriptionLifecycleRecord(lifecycleRecord)) {
        return createSubscriptionRenderDecision('rejected', 'inactive-record', command, route);
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
        try {
          source.onRenderAccepted(record, decision, route);
        } catch (error) {
          this.recordAdapterCallbackError('render_accepted', decision.itemId || route.itemId, error);
        }
      }
    }

    dispatchSubscriptionRenderDeferred(decision, route) {
      this.recordRenderDeferred(decision.itemId || route.itemId, decision);
    }

    dispatchSubscriptionRenderRejected(source, record, decision, route) {
      this.recordRenderRejected(decision.itemId || route.itemId, decision);
      if (typeof source.onRenderRejected === 'function') {
        try {
          source.onRenderRejected(record, decision, route);
        } catch (error) {
          this.recordAdapterCallbackError('render_rejected', decision.itemId || route.itemId, error);
        }
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
      const key = buildSourceTranslationKey(item);
      if (key && this.sourceTranslations.has(key)) {
        const cached = this.sourceTranslations.get(key);
        if (cached && cached.translation) {
          if (item) item.sourceHint = 'source-cache';
          this.diagnosticState.source_cache_hits += 1;
          return cached.translation;
        }
      }
      if (!this.index || typeof this.index.translate !== 'function') return null;
      const translation = this.index.translate({
        engine: this.engine,
        sourceLanguage: this.sourceLanguage,
        targetLanguage: this.targetLanguage,
        text: item.sourceText,
        contextHash: item.contextHash,
      });
      if (translation) this.rememberSourceTranslation(item, translation, 'cache');
      return translation;
    }

    rememberSourceTranslation(item, translation, sourceHint = 'cache') {
      const key = buildSourceTranslationKey(item);
      const value = String(translation ?? '');
      if (!key || !value.trim()) return false;
      if (normalizeComparableText(key) === normalizeComparableText(value)) return false;
      this.sourceTranslations.set(key, {
        translation: value,
        sourceHint: String(sourceHint || 'cache'),
      });
      return true;
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

    subscriptionEventRoute(event, payload, recordId) {
      const source = payload && typeof payload === 'object' ? payload : {};
      return {
        recordId: String(recordId || ''),
        itemId: String(recordId || ''),
        eventType: String(event && event.type || ''),
        adapterId: String(source.adapter || source.adapterId || ''),
        surfaceId: String(source.surfaceId || ''),
        status: String(source.status || source.translationState || source.state || ''),
        message: String(source.message || ''),
        reason: String(source.reason || ''),
        strategy: subscriptionPayloadStrategy(source),
        event,
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
        translatedText: limitText(source.translatedText || source.translationDrawn || source.drawnTranslation || source.translation),
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

  function isPlainObject(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function isOwnershipToken(value, kind) {
    return !!(value
      && typeof value === 'object'
      && value.kind === kind
      && value.id);
  }

  function ownershipClaimOwner(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return stringValue(value.owner || value.adapterId || value.sourceAdapter);
  }

  function isLiveOwnershipClaim(claim) {
    return !!(claim
      && claim.active === true
      && (claim.status === 'claimed' || claim.status === 'provisional'));
  }

  function normalizeOwnershipText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function ownershipAccepted(status, claim) {
    const token = claim && claim.token ? claim.token : null;
    return {
      status: String(status || 'accepted'),
      accepted: true,
      token,
      ownershipToken: token,
      claimId: token && token.id ? token.id : '',
      ownerAdapter: claim && claim.owner ? claim.owner : '',
    };
  }

  function ownershipDenied(reason, current) {
    return {
      status: 'denied',
      accepted: false,
      reason: String(reason || 'denied'),
      token: null,
      ownershipToken: null,
      claimId: '',
      ownerAdapter: ownershipClaimOwner(current),
    };
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
      translationDrawn: limitText(source.translationDrawn),
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

  function sameObservedSource(item, nextText) {
    return normalizeComparableText(item && item.sourceText) === normalizeComparableText(nextText);
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

  function resolveSubscriptionEventRecord(source, recordId, event, payload, route) {
    if (source && typeof source.resolveRecord === 'function') {
      return source.resolveRecord(recordId, event, payload, route) || null;
    }
    const records = source && (source.records || source.recordRegistry || source.recordsById);
    if (!records || !recordId) return null;
    if (typeof records.get === 'function') return records.get(recordId) || null;
    if (Object.prototype.hasOwnProperty.call(records, recordId)) return records[recordId] || null;
    return null;
  }

  function subscriptionEventRecordId(event, payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return String(
      source.itemId
      || source.recordId
      || source.id
      || (event && (event.itemId || event.recordId || event.id))
      || '',
    );
  }

  function subscriptionPayloadStrategy(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return String(source.strategy || source.renderStrategy || source.adapter || '');
  }

  function resolveLifecycleRecord(source, target, command, route) {
    if (source && typeof source.getLifecycleRecord === 'function') {
      return source.getLifecycleRecord(target, command, route) || null;
    }
    return target || null;
  }

  function rememberSubscriptionRecordEvent(record, recordId, event, route) {
    if (!record || (typeof record !== 'object' && typeof record !== 'function')) return null;
    const eventType = String(event && event.type || (route && route.eventType) || '');
    const reason = String(
      (route && route.reason)
      || (event && event.reason)
      || (event && event.message)
      || '',
    );
    const nextStatus = subscriptionRecordStatusForEvent(eventType, route && route.status);
    try {
      if (recordId) record.recordId = String(recordId);
      if (eventType) record.lastEventType = eventType;
      if (reason) record.lastEventReason = reason;
      if (nextStatus) {
        record.status = nextStatus;
        record.lastEventStatus = nextStatus;
        if (nextStatus === 'stale' || nextStatus === 'disappeared' || nextStatus === 'removed') {
          record.active = false;
          record.requestActive = false;
        } else if (nextStatus === 'pending' || nextStatus === 'translating') {
          record.requestActive = true;
        } else {
          record.requestActive = false;
        }
      }
      record.updatedAt = Date.now();
    } catch (_error) {
      return null;
    }
    return record;
  }

  function subscriptionRecordStatusForEvent(eventType, fallbackStatus) {
    const type = String(eventType || '');
    if (type === 'item.render_queued') return 'completed';
    if (type === 'requestSkipped' || type === 'item.skipped') return 'skipped';
    if (type === 'item.failed' || type === 'item.translation_noop' || type === 'item.translation_noop_detached') {
      return 'failed';
    }
    if (type === 'item.stale') return 'stale';
    if (type === 'item.disappeared') return 'disappeared';
    if (type === 'item.removed') return 'removed';
    return normalizeSubscriptionRecordStatus(fallbackStatus);
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

  function canTouchSubscriptionLifecycleRecord(record) {
    if (!record || (typeof record !== 'object' && typeof record !== 'function')) return false;
    if (record.active === false) return record.detached === true;
    const status = normalizeSubscriptionRecordStatus(record.status);
    if (!status) return true;
    return status !== 'stale' && status !== 'disappeared' && status !== 'removed';
  }

  function normalizeSubscriptionRecordStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'cancelled' || value === 'canceled') return 'stale';
    if (value === 'gone') return 'disappeared';
    return value;
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

  function createAdapterRenderErrorDecision(command, route, error) {
    return createSubscriptionRenderDecision('rejected', 'adapter-render-error', command, route, {
      message: error && error.message ? String(error.message) : String(error || ''),
      name: error && error.name ? String(error.name) : '',
    });
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

  function buildSourceTranslationKey(source) {
    const value = firstNonEmpty(
      source && source.normalizedSource,
      source && source.translationSource,
      source && source.original,
      source && source.visibleText,
      source && source.rawText,
      source && source.sourceText,
      source && source.text,
    );
    return String(value || '').trim();
  }

  function normalizeComparableText(value) {
    return String(value ?? '').trim();
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
