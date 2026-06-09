(function attach(root) {
  const { RenderGuard } = loadDependency(root, './render-guard');

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
      this.emit('observed', item);

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
        this.emit('renderAccepted', command);
        return true;
      }
      this.diagnosticState.render_rejected += 1;
      if (item) item.lastRenderStatus = 'rejected';
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
        this.emit('ownershipConflict', { kind: 'surface', owner, current, surfaceId: this.surfaceId(surface) });
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
        this.emit('ownershipConflict', { kind: 'text', owner, current, slotId });
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

    emit(type, payload) {
      const event = { type, payload };
      this.events.push(event);
      if (this.events.length > 128) this.events.shift();
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (_error) {
          // Listener failures must not break game rendering.
        }
      }
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

  publish(root, { TextOrchestrator });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
