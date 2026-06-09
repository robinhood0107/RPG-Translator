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
  const DEFAULT_REQUIRED_METHODS = Object.freeze([
    'observeRecord',
    'requestItemTranslation',
    'subscribe',
  ]);
  const BACKING_METHOD_BY_PUBLIC_METHOD = Object.freeze({
    observeRecord: 'observeRecord',
    updateItem: 'updateItem',
    requestItemTranslation: 'requestItemTranslation',
    cancelItemTranslation: 'cancelItemTranslation',
    setItemTranslationPriority: 'setItemTranslationPriority',
    setItemVisibility: 'setItemVisibility',
    backgroundItem: 'backgroundItem',
    retireItem: 'retireItem',
    recordDecision: 'recordDecision',
    recordDraw: 'recordDraw',
    describeTextEligibility: 'describeTextEligibility',
    claimSurface: 'claimSurface',
    releaseSurface: 'releaseSurface',
    claimText: 'claimText',
    finalizeTextClaim: 'finalizeTextClaim',
    releaseTextClaim: 'releaseTextClaim',
    recordSurfaceDraw: 'recordSurfaceDraw',
    recordRenderAccepted: 'recordRenderAccepted',
    recordRenderDeferred: 'recordRenderDeferred',
    recordRenderRejected: 'recordRenderRejected',
    subscribeSurfaceDraws: 'subscribeSurfaceDraws',
    subscribe: 'subscribe',
    subscribeRecords: 'subscribe',
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

    function hasBackingMethod(name) {
      return !!(gateway && typeof gateway[name] === 'function');
    }

    function hasMethod(name) {
      const backingName = BACKING_METHOD_BY_PUBLIC_METHOD[String(name || '')] || '';
      return !!(backingName && hasBackingMethod(backingName));
    }

    function hasRequiredMethods(required = DEFAULT_REQUIRED_METHODS) {
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

    function recordDraw(record, eventName = 'draw', details = null) {
      if (!canTouchRecord(record) || !hasMethod('recordDraw')) return null;
      const id = getCapabilityRecordId(record);
      if (!id) return null;
      const rendered = callGateway('recordDraw', () => gateway.recordDraw(id, eventName || 'draw', details));
      if (rendered) {
        rememberRecordEvent(record, id, {
          type: 'item.rendered',
          status: 'completed',
          reason: String(eventName || 'draw'),
        });
      }
      return rendered;
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
      if (hasBackingMethod('subscribeRecords')) {
        return subscribeThrough('subscribeRecords', token, () => gateway.subscribeRecords(wrapRecordSubscription(source)));
      }
      return subscribeThrough('subscribeRecords', token, () => gateway.subscribe((event) => {
        return routeSubscribedRecordEvent(source, event);
      }));
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

    function routeSubscribedRecordEvent(source, event) {
      if (!event || typeof event !== 'object') return undefined;
      const eventType = String(event.type || '');
      if (source.adapterEventsOnly !== false
        && event.adapterId
        && String(event.adapterId) !== adapterId) {
        return undefined;
      }
      if (eventType === 'item.render_queued') {
        const command = normalizeRenderCommand(event.details);
        const renderStrategy = nonEmptyString(source.renderStrategy, source.strategy);
        if (renderStrategy && String(command.strategy || '') !== renderStrategy) return undefined;
        return dispatchSubscribedRenderCommand(source, event, command);
      }
      if (eventType === 'item.skipped') {
        return dispatchSubscribedRecordEvent(source, source.onSkipped, event, null, 'skipped');
      }
      if (eventType === 'item.failed'
        || eventType === 'item.translation_noop'
        || eventType === 'item.translation_noop_detached') {
        return dispatchSubscribedRecordEvent(source, source.onFailed, event, null, 'failed');
      }
      if (typeof source.onEvent === 'function') {
        return dispatchSubscribedRecordEvent(source, source.onEvent, event, null, eventType || 'event');
      }
      return undefined;
    }

    function dispatchSubscribedRenderCommand(source, event, command) {
      const recordId = subscribedRecordId(event, command);
      const route = createSubscribedRoute(event, command, recordId);
      const record = resolveSubscribedRecord(source, recordId, event, command);
      if (!record) {
        dispatchSubscribedMissingRecord(source, route, event, command, 'render_queued');
        notifySubscribedRenderRejected(source, null, createRenderDecision('rejected', 'missing-adapter-record', command, route), route);
        return false;
      }
      const lifecycleRecord = resolveSubscribedLifecycleRecord(source, record, command, route);
      const rejectedDecision = validateSubscribedRenderCommand(source, record, lifecycleRecord, command, route);
      if (rejectedDecision) {
        notifySubscribedRenderRejected(source, record, rejectedDecision, route);
        return false;
      }
      rememberRecordEvent(lifecycleRecord, recordId, event);
      if (typeof source.onRenderQueued !== 'function') return false;
      let callbackDecision = null;
      try {
        callbackDecision = normalizeRenderCallbackDecision(source.onRenderQueued(record, command, route), command, route);
      } catch (error) {
        callbackDecision = createRenderDecision('rejected', 'adapter-render-error', command, route, describeCallbackError(error));
      }
      if (callbackDecision.status === 'deferred') {
        notifySubscribedRenderDecision('recordRenderDeferred', callbackDecision, route);
        return true;
      }
      if (callbackDecision.status !== 'accepted') {
        notifySubscribedRenderRejected(source, record, callbackDecision, route);
        return false;
      }
      notifySubscribedRenderDecision('recordRenderAccepted', callbackDecision, route);
      if (typeof source.onRenderAccepted === 'function') {
        try {
          source.onRenderAccepted(record, callbackDecision, route);
        } catch (_error) {}
      }
      return true;
    }

    function resolveSubscribedLifecycleRecord(source, record, command, route) {
      if (typeof source.getLifecycleRecord !== 'function') return record;
      try {
        return source.getLifecycleRecord(record, command, route) || null;
      } catch (_error) {
        return null;
      }
    }

    function validateSubscribedRenderCommand(source, record, lifecycleRecord, command, route) {
      if (!command || !command.itemId || !command.strategy) {
        return createRenderDecision('rejected', 'invalid-command', command, route);
      }
      if (!isRecordObject(lifecycleRecord)) {
        return createRenderDecision('rejected', 'missing-lifecycle-record', command, route);
      }
      if (!canTouchRecord(lifecycleRecord)) {
        return createRenderDecision('rejected', 'inactive-record', command, route);
      }
      const generationDecision = validateSubscribedRenderGeneration(source, record, command, route);
      if (generationDecision) return generationDecision;
      if (typeof source.isRenderTargetCurrent !== 'function') {
        return createRenderDecision('rejected', 'missing-current-validator', command, route);
      }
      let current = false;
      try {
        current = source.isRenderTargetCurrent(record, command, route);
      } catch (error) {
        return createRenderDecision('rejected', 'target-validator-error', command, route, describeCallbackError(error));
      }
      if (current === true) return null;
      const details = current && typeof current === 'object' ? current : {};
      const reason = nonEmptyString(details.reason, details.status, 'target-not-current');
      return createRenderDecision('rejected', reason, command, route, details);
    }

    function validateSubscribedRenderGeneration(source, record, command, route) {
      const commandGeneration = Number(command && command.generation);
      if (!Number.isFinite(commandGeneration) || commandGeneration <= 0) return null;
      const targetGeneration = resolveSubscribedRenderGeneration(source, record, command, route);
      if (!Number.isFinite(targetGeneration)) {
        return createRenderDecision('rejected', 'missing-generation', command, route, {
          commandGeneration,
        });
      }
      if (targetGeneration !== commandGeneration) {
        return createRenderDecision('rejected', 'generation-mismatch', command, route, {
          commandGeneration,
          targetGeneration,
        });
      }
      return null;
    }

    function resolveSubscribedRenderGeneration(source, record, command, route) {
      if (typeof source.getRenderGeneration !== 'function') return NaN;
      try {
        const value = source.getRenderGeneration(record, command, route);
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : NaN;
      } catch (_error) {
        return NaN;
      }
    }

    function dispatchSubscribedRecordEvent(source, handler, event, command, operation) {
      if (typeof handler !== 'function') return false;
      const recordId = subscribedRecordId(event, command);
      const route = createSubscribedRoute(event, command, recordId);
      const record = resolveSubscribedRecord(source, recordId, event, command);
      if (!record) return dispatchSubscribedMissingRecord(source, route, event, command, operation);
      if (!canTouchRecord(record)) return false;
      rememberRecordEvent(record, recordId, event);
      try {
        if (command) handler(record, command, event, route);
        else handler(record, event, route);
      } catch (_error) {
        return false;
      }
      return true;
    }

    function notifySubscribedRenderRejected(source, record, decision, route) {
      notifySubscribedRenderDecision('recordRenderRejected', decision, route);
      if (typeof source.onRenderRejected !== 'function') return false;
      try {
        source.onRenderRejected(record, decision, route);
      } catch (_error) {}
      return true;
    }

    function notifySubscribedRenderDecision(methodName, decision, route) {
      if (!hasBackingMethod(methodName)) return null;
      const itemId = nonEmptyString(decision && decision.itemId, route && route.itemId, route && route.recordId);
      if (!itemId) return null;
      return callGateway(methodName, () => gateway[methodName](itemId, decision || {}));
    }

    function dispatchSubscribedMissingRecord(source, route, event, command, operation) {
      if (typeof source.onMissingRecord !== 'function') return false;
      try {
        source.onMissingRecord(route, event, command, operation);
      } catch (_error) {
        return false;
      }
      return true;
    }

    function resolveSubscribedRecord(source, recordId, event, command) {
      if (typeof source.resolveRecord === 'function') {
        try {
          return source.resolveRecord(recordId, event, command) || null;
        } catch (_error) {
          return null;
        }
      }
      const records = getRecordRegistry(source);
      if (!records || typeof records.get !== 'function' || !recordId) return null;
      return records.get(recordId) || null;
    }

    function subscribedRecordId(event, command) {
      return nonEmptyString(
        command && command.itemId,
        event && event.itemId,
        event && event.recordId,
        event && event.id,
      );
    }

    function normalizeRenderCommand(details) {
      const source = details && typeof details === 'object' ? details : {};
      return Object.freeze({
        id: nonEmptyString(source.id),
        itemId: nonEmptyString(source.itemId),
        surfaceId: nonEmptyString(source.surfaceId),
        strategy: nonEmptyString(source.strategy),
        text: typeof source.text === 'string' ? source.text : nonEmptyString(source.text),
        generation: finiteNumber(source.generation),
        bounds: plainObjectOrNull(source.bounds),
        metadata: Object.freeze(Object.assign({}, plainObjectOrEmpty(source.metadata))),
        queuedAt: finiteNumber(source.queuedAt),
      });
    }

    function createSubscribedRoute(event, command, recordId) {
      return Object.freeze({
        recordId,
        itemId: recordId,
        eventType: event && event.type ? String(event.type) : '',
        adapterId: event && event.adapterId ? String(event.adapterId) : '',
        surfaceId: nonEmptyString(command && command.surfaceId, event && event.surfaceId),
        status: event && event.status ? String(event.status) : '',
        message: event && event.message ? String(event.message) : '',
        commandId: nonEmptyString(command && command.id),
        strategy: nonEmptyString(command && command.strategy),
        commandGeneration: finiteNumber(command && command.generation),
      });
    }

    function createRenderDecision(status, reason, command, route, details = {}) {
      return Object.freeze({
        status: normalizeRenderDecisionStatus(status),
        reason: nonEmptyString(reason, status, 'rejected'),
        recordId: route && route.recordId ? route.recordId : '',
        itemId: route && route.itemId ? route.itemId : '',
        commandId: command && command.id ? command.id : '',
        strategy: command && command.strategy ? command.strategy : '',
        commandGeneration: finiteNumber(command && command.generation),
        details: Object.freeze(Object.assign({}, plainObjectOrEmpty(details))),
      });
    }

    function normalizeRenderCallbackDecision(value, command, route) {
      if (value === true) return createRenderDecision('accepted', 'accepted', command, route);
      if (typeof value === 'string') {
        const status = normalizeRenderDecisionStatus(value);
        if (status === 'accepted') return createRenderDecision('accepted', value || 'accepted', command, route);
        if (status === 'deferred') return createRenderDecision('deferred', value || 'deferred', command, route);
        return createRenderDecision('rejected', value || 'adapter-declined', command, route);
      }
      if (value && typeof value === 'object') {
        const status = normalizeRenderDecisionStatus(value.status || value.result || value.decision);
        const reason = nonEmptyString(value.reason, status === 'accepted' ? 'accepted' : (status === 'deferred' ? 'deferred' : 'adapter-declined'));
        return createRenderDecision(status, reason, command, route, value.details || {});
      }
      return createRenderDecision('rejected', 'adapter-declined', command, route);
    }

    function normalizeRenderDecisionStatus(value) {
      const status = String(value || '').toLowerCase();
      if (status === 'accepted' || status === 'rendered' || status === 'drawn') return 'accepted';
      if (status === 'deferred' || status === 'queued' || status === 'pending') return 'deferred';
      return 'rejected';
    }

    function describeCallbackError(error) {
      const details = {};
      if (error && typeof error === 'object') {
        if (error.name) details.errorName = String(error.name);
        if (error.message) details.errorMessage = String(error.message);
        if (error.code) details.errorCode = String(error.code);
      } else if (error !== undefined && error !== null) {
        details.errorMessage = String(error);
      }
      return details;
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
      if (eventType === 'item.render_queued' || eventType === 'item.rendered') updateRecordStateStatus(state, 'completed');
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
      recordDraw,
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

  function finiteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function plainObjectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function plainObjectOrNull(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.assign({}, value) : null;
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
