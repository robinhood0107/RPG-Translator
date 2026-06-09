(function attach(root) {
  const REQUEST_ACTIVE_STATUSES = Object.freeze({
    pending: true,
    translating: true,
  });
  const RECORD_ACTIVE_STATUSES = Object.freeze({
    detected: true,
    pending: true,
    translating: true,
    completed: true,
    skipped: true,
    failed: true,
  });

  function createAdapterContract(options = {}) {
    const adapterId = nonEmptyString(options.adapterId, options.sourceAdapter, 'text');
    const defaultHook = nonEmptyString(options.defaultHook, adapterId);
    const gateway = options.orchestratorGateway || options.gateway || null;
    const logger = options.logger || {};
    const subscriptions = Object.create(null);
    const states = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    const stateKey = `__rpgTranslatorAdapterRecordState_${safeIdPart(adapterId)}`;
    const statesById = new Map();

    function hasMethod(name) {
      return !!(gateway && typeof gateway[name] === 'function');
    }

    function hasRequiredMethods(required = ['observeRecord', 'requestItemTranslation', 'retireItem']) {
      return required.every(hasMethod);
    }

    function isAvailable() {
      return hasRequiredMethods();
    }

    function observeRecord(record, payload = {}, eventOptions = {}, observeOptions = {}) {
      if (!isRecordObject(record) || !hasMethod('observeRecord')) return null;
      const currentId = getRecordId(record);
      const nextPayload = normalizePayload(payload);
      if (!nextPayload.id && currentId) nextPayload.id = currentId;
      const observed = callGateway('observeRecord', () => {
        return gateway.observeRecord(nextPayload, normalizeObserveEventOptions(eventOptions, observeOptions));
      });
      const nextId = observedId(observed);
      if (!nextId) return observed || null;
      reconcileRecordId(record, currentId, nextId, observeOptions);
      record[nonEmptyString(observeOptions.idField, 'recordId')] = nextId;
      rememberRecord(record, nextId, { status: 'detected' });
      registerRecord(record, observed, nextId, observeOptions);
      return observed;
    }

    function updateItem(record, patch = {}, eventOptions = {}) {
      if (!canTouchRecord(record) || !hasMethod('updateItem')) return null;
      const id = getCapabilityRecordId(record);
      if (!id) return null;
      const updated = callGateway('updateItem', () => gateway.updateItem(id, patch || {}, normalizeEventOptions(eventOptions)));
      if (updated) rememberRecordPatch(record, id, updated);
      else rememberRecordPatch(record, id, patch);
      return updated;
    }

    function requestItemTranslation(record, requestOptions = {}) {
      if (!canTouchRecord(record) || !hasMethod('requestItemTranslation')) return false;
      const id = getCapabilityRecordId(record);
      if (!id) return false;
      const requestResult = callGateway('requestItemTranslation', () => gateway.requestItemTranslation(id, Object.assign({
        hook: defaultHook,
      }, requestOptions || {})));
      if (!requestResult) return false;
      if (!isRecordTerminal(record)) {
        markRecordStatus(record, id, 'pending', { requestActive: true });
      }
      return true;
    }

    function cancelItemTranslation(record, reason = '', options = {}) {
      if (!canTouchRecord(record) || !hasMethod('cancelItemTranslation')) return false;
      const id = getCapabilityRecordId(record);
      if (!id) return false;
      return callGateway('cancelItemTranslation', () => gateway.cancelItemTranslation(id, reason, options || {}) === true) === true;
    }

    function setItemTranslationPriority(record, priority, reason = '') {
      if (!canTouchRecord(record) || !hasMethod('setItemTranslationPriority')) return false;
      const id = getCapabilityRecordId(record);
      if (!id) return false;
      return callGateway('setItemTranslationPriority', () => gateway.setItemTranslationPriority(id, priority, reason) === true) === true;
    }

    function setItemVisibility(record, visible, details = {}) {
      if (!canTouchRecord(record) || !hasMethod('setItemVisibility')) return null;
      const id = getCapabilityRecordId(record);
      if (!id) return null;
      return callGateway('setItemVisibility', () => gateway.setItemVisibility(id, visible === true, details || {}));
    }

    function backgroundItem(record, details = {}) {
      if (!canTouchRecord(record) || !hasMethod('backgroundItem')) return null;
      const id = getCapabilityRecordId(record);
      if (!id) return null;
      return callGateway('backgroundItem', () => gateway.backgroundItem(id, details || {}));
    }

    function retireItem(record, status = 'disappeared', eventOptions = {}) {
      if (!canTouchRecord(record) || !hasMethod('retireItem')) return null;
      const id = getCapabilityRecordId(record);
      if (!id) return null;
      const normalizedOptions = normalizeEventOptions(eventOptions);
      const recordDetached = normalizedOptions.recordDetached === true;
      const gatewayOptions = Object.assign({}, normalizedOptions);
      delete gatewayOptions.recordDetached;
      const retired = callGateway('retireItem', () => gateway.retireItem(id, status || 'disappeared', gatewayOptions));
      markRetired(record, id, status || 'disappeared', recordDetached);
      return retired;
    }

    function recordDecision(record, type, message = '', details = null) {
      if (!canTouchRecord(record) || !hasMethod('recordDecision')) return null;
      const id = getCapabilityRecordId(record);
      if (!id) return null;
      return callGateway('recordDecision', () => gateway.recordDecision(id, type, message, details));
    }

    function recordRenderAccepted(record, decision = {}) {
      return recordRenderDecision(record, 'recordRenderAccepted', decision);
    }

    function recordRenderDeferred(record, decision = {}) {
      return recordRenderDecision(record, 'recordRenderDeferred', decision);
    }

    function recordRenderRejected(record, decision = {}) {
      return recordRenderDecision(record, 'recordRenderRejected', decision);
    }

    function recordRenderDecision(record, methodName, decision = {}) {
      if (!canTouchRecord(record) || !hasMethod(methodName)) return null;
      const id = getCapabilityRecordId(record);
      if (!id) return null;
      return callGateway(methodName, () => gateway[methodName](id, decision || {}));
    }

    function describeTextEligibility(payload = {}) {
      if (!hasMethod('describeTextEligibility')) return defaultEligibility(payload);
      return callGateway('describeTextEligibility', () => gateway.describeTextEligibility(normalizePayload(payload))) || defaultEligibility(payload);
    }

    function claimSurface(payload = {}) {
      if (!hasMethod('claimSurface')) return deniedOwnership('unavailable');
      const result = callGateway('claimSurface', () => gateway.claimSurface(normalizeOwnershipPayload(payload)));
      return normalizeOwnershipResult(result, 'surface');
    }

    function releaseSurface(token, reason = '') {
      if (!token || !hasMethod('releaseSurface')) return false;
      return callGateway('releaseSurface', () => gateway.releaseSurface(token, reason || 'surface released') === true) === true;
    }

    function claimText(payload = {}) {
      if (!hasMethod('claimText')) return deniedOwnership('unavailable');
      const result = callGateway('claimText', () => gateway.claimText(normalizeOwnershipPayload(payload)));
      return normalizeOwnershipResult(result, 'text');
    }

    function finalizeTextClaim(token, payload = {}) {
      if (!token) return deniedOwnership('missing-token');
      if (!hasMethod('finalizeTextClaim')) return { status: 'accepted', accepted: true, token };
      const result = callGateway('finalizeTextClaim', () => gateway.finalizeTextClaim(token, normalizeOwnershipPayload(payload)));
      return normalizeOwnershipResult(result, 'text');
    }

    function releaseTextClaim(token, reason = '') {
      if (!token || !hasMethod('releaseTextClaim')) return false;
      return callGateway('releaseTextClaim', () => gateway.releaseTextClaim(token, reason || 'text claim released') === true) === true;
    }

    function recordSurfaceDraw(payload = {}) {
      if (!hasMethod('recordSurfaceDraw')) return { status: 'ignored', reason: 'unavailable' };
      return callGateway('recordSurfaceDraw', () => gateway.recordSurfaceDraw(normalizePayload(payload))) || { status: 'ignored', reason: 'failed' };
    }

    function subscribeSurfaceDraws(options = {}) {
      if (!hasMethod('subscribeSurfaceDraws')) return false;
      const source = options && typeof options === 'object' ? options : {};
      if (typeof source.onDraw !== 'function') return false;
      const token = nonEmptyString(source.token, 'surface-draws');
      return subscribeThrough('subscribeSurfaceDraws', token, () => gateway.subscribeSurfaceDraws((event) => {
        if (!event || typeof event !== 'object') return undefined;
        if (event.adapterId && String(event.adapterId) !== adapterId) return undefined;
        return source.onDraw(event.payload || {}, event);
      }, { adapterId, token }));
    }

    function subscribe(listener, token = '') {
      if (typeof listener !== 'function' || !hasMethod('subscribe')) return false;
      return subscribeThrough('subscribe', token || 'default', () => gateway.subscribe(listener));
    }

    function subscribeRecords(options = {}) {
      if (!hasMethod('subscribeRecords')) return false;
      const source = options && typeof options === 'object' ? options : {};
      const token = nonEmptyString(source.token, source.subscriptionToken, source.renderStrategy, source.strategy, 'records');
      return subscribeThrough('subscribeRecords', token, () => gateway.subscribeRecords(wrapRecordSubscription(source)));
    }

    function subscribeThrough(methodName, token, callback) {
      const key = `${safeIdPart(adapterId)}:${safeIdPart(methodName)}:${safeIdPart(token || 'default')}`;
      if (subscriptions[key]) return true;
      const unsubscribe = callGateway(methodName, callback);
      if (unsubscribe === null || unsubscribe === false) return false;
      subscriptions[key] = unsubscribe || true;
      return true;
    }

    function wrapRecordSubscription(source) {
      const wrapped = Object.assign({
        adapterId,
      }, source || {});
      if (typeof source.onRenderQueued === 'function') {
        wrapped.onRenderQueued = (record, command, route) => {
          rememberRecordEvent(record, subscriptionRecordId(record, command, route), {
            type: 'item.render_queued',
            reason: route && route.reason,
          });
          return source.onRenderQueued(record, command, route);
        };
      }
      if (typeof source.onSkipped === 'function') {
        wrapped.onSkipped = (record, event, route) => {
          rememberRecordEvent(record, subscriptionRecordId(record, event, route), event || { type: 'item.skipped' });
          return source.onSkipped(record, event, route);
        };
      }
      if (typeof source.onFailed === 'function') {
        wrapped.onFailed = (record, event, route) => {
          rememberRecordEvent(record, subscriptionRecordId(record, event, route), event || { type: 'item.failed' });
          return source.onFailed(record, event, route);
        };
      }
      if (typeof source.onEvent === 'function') {
        wrapped.onEvent = (record, event, route) => {
          rememberRecordEvent(record, subscriptionRecordId(record, event, route), event || {});
          return source.onEvent(record, event, route);
        };
      }
      return wrapped;
    }

    function normalizePayload(payload) {
      const next = Object.assign({}, payload || {});
      if (next.sourceAdapter && String(next.sourceAdapter) !== adapterId) {
        warn(`Overriding mismatched sourceAdapter "${next.sourceAdapter}".`);
      }
      next.sourceAdapter = adapterId;
      if (!next.adapter) next.adapter = adapterId;
      if (!next.hook) next.hook = defaultHook;
      return next;
    }

    function normalizeObserveEventOptions(eventOptions, observeOptions = {}) {
      const next = normalizeEventOptions(eventOptions);
      const token = observeOptions && (observeOptions.ownershipToken || observeOptions.ownership);
      if (token) next.ownershipToken = token;
      if (observeOptions && observeOptions.ownershipRequired === true) {
        next.ownershipRequired = true;
      }
      return next;
    }

    function normalizeOwnershipPayload(payload) {
      return normalizePayload(payload);
    }

    function normalizeOwnershipResult(result, fallbackKind) {
      if (result && typeof result === 'object' && result.status) {
        return result;
      }
      if (result === true) {
        return {
          status: 'accepted',
          accepted: true,
          token: { kind: fallbackKind, owner: adapterId },
        };
      }
      return deniedOwnership('ownership-conflict');
    }

    function callGateway(operation, callback) {
      try {
        return callback();
      } catch (error) {
        throw createBoundaryError(operation, error);
      }
    }

    function createBoundaryError(operation, cause) {
      if (isContractError(cause)) return cause;
      const wrapped = new Error(`[AdapterContract:${adapterId}] ${operation} failed.`);
      wrapped.name = 'AdapterContractError';
      wrapped.code = 'RPG_TRANSLATOR_ADAPTER_CONTRACT';
      wrapped.adapterId = adapterId;
      wrapped.operation = String(operation || '');
      try { wrapped.cause = cause; } catch (_error) {}
      return wrapped;
    }

    function isContractError(error) {
      return isAdapterContractError(error);
    }

    function warn(message) {
      if (!logger || typeof logger.warn !== 'function') return;
      try {
        logger.warn(`[AdapterContract:${adapterId}] ${message}`);
      } catch (_error) {}
    }

    function rememberRecord(record, id, snapshot = {}) {
      if (!isRecordObject(record) || !id) return null;
      const state = getOrCreateRecordState(record, id);
      setRecordStateId(state, id);
      updateRecordStateStatus(state, snapshot.status || 'detected');
      state.detached = false;
      state.updatedAt = Date.now();
      return state;
    }

    function rememberRecordPatch(record, id, patch = {}) {
      if (!isRecordObject(record) || !id) return null;
      const state = getExactRecordState(record);
      if (!state) return null;
      setRecordStateId(state, id);
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'status')) {
        updateRecordStateStatus(state, patch.status);
      }
      state.updatedAt = Date.now();
      return state;
    }

    function rememberRecordEvent(record, id, event = {}) {
      if (!isRecordObject(record) || !id) return null;
      const state = getExactRecordState(record);
      if (!state) return null;
      setRecordStateId(state, id);
      if (event && event.status) updateRecordStateStatus(state, event.status);
      const eventType = String(event && event.type || '');
      if (eventType === 'item.render_queued') updateRecordStateStatus(state, 'completed');
      if (eventType === 'requestSkipped' || eventType === 'item.skipped') updateRecordStateStatus(state, 'skipped');
      if (eventType === 'item.failed'
        || eventType === 'item.translation_noop'
        || eventType === 'item.translation_noop_detached') {
        updateRecordStateStatus(state, 'failed');
      }
      if (eventType === 'item.stale' || eventType === 'item.disappeared' || eventType === 'item.removed') {
        state.active = false;
        state.requestActive = false;
      }
      state.updatedAt = Date.now();
      return state;
    }

    function markRecordStatus(record, id, status, options = {}) {
      const state = getExactRecordState(record);
      if (!state) return null;
      setRecordStateId(state, id);
      updateRecordStateStatus(state, status);
      if (Object.prototype.hasOwnProperty.call(options || {}, 'requestActive')) {
        state.requestActive = options.requestActive === true;
      }
      state.updatedAt = Date.now();
      return state;
    }

    function markRetired(record, id, status, detached) {
      const state = getExactRecordState(record);
      if (!state) return null;
      setRecordStateId(state, id || state.id);
      state.status = normalizeRecordStatus(status, state.status);
      state.active = false;
      state.detached = detached === true;
      state.requestActive = state.detached && REQUEST_ACTIVE_STATUSES[state.status] === true;
      state.updatedAt = Date.now();
      if (!state.detached) forgetRecordId(state.id, state);
      return state;
    }

    function updateRecordStateStatus(state, status) {
      if (!state) return null;
      const normalized = normalizeRecordStatus(status, state.status || 'detected');
      state.status = normalized;
      state.active = RECORD_ACTIVE_STATUSES[normalized] === true;
      state.requestActive = REQUEST_ACTIVE_STATUSES[normalized] === true;
      return state;
    }

    function canTouchRecord(record) {
      const state = getExactRecordState(record);
      return !!(state && (state.active !== false || state.detached === true));
    }

    function getRecordStatus(record, fallback = '') {
      const state = getExactRecordState(record);
      return state ? state.status : nonEmptyString(fallback);
    }

    function isRecordActive(record) {
      const state = getExactRecordState(record);
      return !!(state && state.active !== false);
    }

    function isRecordObserved(record) {
      return !!getExactRecordState(record);
    }

    function isRecordRequestActive(record) {
      const state = getExactRecordState(record);
      return !!(state && state.requestActive === true);
    }

    function isRecordTerminal(record) {
      const status = getRecordStatus(record);
      return status === 'completed' || status === 'skipped' || status === 'failed';
    }

    function getCapabilityRecordId(record) {
      const state = getExactRecordState(record);
      return state && state.id ? String(state.id) : '';
    }

    function getOrCreateRecordState(record, id = '') {
      let state = getExactRecordState(record);
      if (!state) {
        state = {
          id: String(id || getRecordId(record) || ''),
          status: 'detected',
          active: true,
          detached: false,
          requestActive: false,
          updatedAt: Date.now(),
        };
        rememberExactRecordState(record, state);
      }
      if (id) setRecordStateId(state, id);
      return state;
    }

    function getExactRecordState(record) {
      if (!isRecordObject(record)) return null;
      if (states) return states.get(record) || null;
      try {
        return record[stateKey] || null;
      } catch (_error) {
        return null;
      }
    }

    function rememberExactRecordState(record, state) {
      if (!isRecordObject(record) || !state) return false;
      if (states) {
        states.set(record, state);
        return true;
      }
      try {
        Object.defineProperty(record, stateKey, {
          value: state,
          configurable: true,
        });
        return true;
      } catch (_error) {
        try {
          record[stateKey] = state;
          return true;
        } catch (_inner) {
          return false;
        }
      }
    }

    function setRecordStateId(state, id) {
      if (!state) return null;
      const nextId = nonEmptyString(id);
      if (state.id && state.id !== nextId) forgetRecordId(state.id, state);
      state.id = nextId;
      if (!nextId) return state;
      const previous = statesById.get(nextId);
      if (previous && previous !== state) revokeRecordState(previous);
      statesById.set(nextId, state);
      return state;
    }

    function revokeRecordState(state) {
      if (!state) return null;
      state.active = false;
      state.detached = false;
      state.requestActive = false;
      state.updatedAt = Date.now();
      return state;
    }

    function forgetRecordId(id, state) {
      const key = nonEmptyString(id);
      if (!key) return false;
      const current = statesById.get(key);
      if (!current) return false;
      if (state && current !== state) return false;
      statesById.delete(key);
      return true;
    }

    function reconcileRecordId(record, previousId, nextId, observeOptions = {}) {
      if (!previousId || previousId === nextId) return;
      forgetRecordId(previousId);
      const registry = getRecordRegistry(observeOptions);
      if (registry && typeof registry.delete === 'function') {
        registry.delete(previousId);
      }
    }

    function registerRecord(record, observed, id, observeOptions = {}) {
      const registry = getRecordRegistry(observeOptions);
      if (!registry || typeof registry.set !== 'function' || !id) return;
      let value = record;
      if (typeof observeOptions.registryValue === 'function') {
        const next = observeOptions.registryValue(record, observed, id);
        value = next === undefined || next === null ? record : next;
      } else if (Object.prototype.hasOwnProperty.call(observeOptions, 'registryValue')) {
        value = observeOptions.registryValue;
      }
      registry.set(id, value);
    }

    return Object.freeze({
      adapterId,
      defaultHook,
      hasMethod,
      hasRequiredMethods,
      isAvailable,
      observeRecord,
      updateItem,
      requestItemTranslation,
      cancelItemTranslation,
      setItemTranslationPriority,
      setItemVisibility,
      backgroundItem,
      retireItem,
      recordDecision,
      recordRenderAccepted,
      recordRenderDeferred,
      recordRenderRejected,
      describeTextEligibility,
      claimSurface,
      releaseSurface,
      claimText,
      finalizeTextClaim,
      releaseTextClaim,
      recordSurfaceDraw,
      subscribeSurfaceDraws,
      subscribe,
      subscribeRecords,
      isContractError,
      getRecordStatus,
      isRecordActive,
      isRecordObserved,
      isRecordRequestActive,
      isRecordTerminal,
    });
  }

  function getRecordRegistry(options = {}) {
    return options.records || options.recordRegistry || options.recordsById || options.map || null;
  }

  function observedId(observed) {
    return nonEmptyString(observed && observed.itemId, observed && observed.recordId, observed && observed.id);
  }

  function getRecordId(record) {
    return nonEmptyString(record && record.recordId, record && record.itemId, record && record.id);
  }

  function subscriptionRecordId(record, payload, route) {
    return nonEmptyString(
      route && route.recordId,
      route && route.itemId,
      payload && payload.itemId,
      payload && payload.recordId,
      payload && payload.id,
      getRecordId(record),
    );
  }

  function normalizeEventOptions(options) {
    return options && typeof options === 'object' ? options : {};
  }

  function normalizeRecordStatus(status, fallback = 'detected') {
    const value = String(status || fallback || 'detected').toLowerCase();
    if (value === 'cancelled' || value === 'canceled') return 'stale';
    if (value === 'gone') return 'disappeared';
    if (value === 'hit' || value === 'miss') return 'detected';
    return value || 'detected';
  }

  function defaultEligibility(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const text = String((source.visibleText ?? source.text) ?? '');
    const eligible = text.trim().length > 0;
    return {
      eligible,
      skip: !eligible,
      category: eligible ? 'text' : 'empty',
      reason: eligible ? 'eligible' : 'emptyInput',
      sourceHint: 'policy',
      providerEligible: eligible,
      providerCategory: eligible ? 'text' : 'empty',
      providerReason: eligible ? 'eligible' : 'emptyInput',
      providerSourceHint: 'policy',
      text,
      normalizedText: text,
      details: {
        category: eligible ? 'text' : 'empty',
        reason: eligible ? 'eligible' : 'emptyInput',
        providerEligible: eligible,
        providerCategory: eligible ? 'text' : 'empty',
        providerReason: eligible ? 'eligible' : 'emptyInput',
        hasText: eligible,
      },
    };
  }

  function deniedOwnership(reason) {
    return {
      status: 'denied',
      accepted: false,
      reason: String(reason || 'denied'),
    };
  }

  function isRecordObject(value) {
    return !!(value && (typeof value === 'object' || typeof value === 'function'));
  }

  function nonEmptyString(...values) {
    for (const value of values) {
      if (value === undefined || value === null) continue;
      const text = String(value);
      if (text) return text;
    }
    return '';
  }

  function safeIdPart(value) {
    return nonEmptyString(value, 'id').replace(/[^a-z0-9_-]+/giu, '_').replace(/^_+|_+$/gu, '') || 'id';
  }

  function isAdapterContractError(error) {
    return !!(error
      && typeof error === 'object'
      && (error.name === 'AdapterContractError'
        || error.code === 'RPG_TRANSLATOR_ADAPTER_CONTRACT'
        || error.code === 'LIVE_TRANSLATOR_ADAPTER_CONTRACT'));
  }

  const api = { createAdapterContract, isAdapterContractError };
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
