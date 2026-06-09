(function attach(root) {
  const DEFAULT_TRACE_LIMIT = 320;
  const MAX_TRACE_LIMIT = 2000;
  const DEFAULT_TEXT_LIMIT = 160;
  const DEFAULT_TARGET_FPS = 40;
  const MAX_TARGET_FPS = 240;
  const DEFAULT_ROLLING_FRAMES = 1200;
  const CJK_TEXT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/u;

  class RuntimeDiagnostics {
    constructor(options = {}) {
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.settings = normalizeSettings(options.settings || {});
      this.drawEvents = [];
      this.drawSequence = 0;
      this.timings = new Map();
      this.counters = new Map();
      this.domainTimings = new Map();
      this.adapterStatuses = [];
      this.frames = [];
      this.foresightSnapshotProvider = null;
      this.frameTotals = {
        total: 0,
        slow: 0,
        dropped: 0,
      };
    }

    recordDraw(stage, details = {}) {
      if (!this.isDrawTraceEnabled()) return null;
      const source = details && typeof details === 'object' ? details : {};
      const rawText = firstString(source.rawText, source.text, source.visibleText, source.normalizedText);
      const visibleText = firstString(source.visibleText, source.normalizedText, rawText);
      if (!this.shouldRecordDraw(rawText, visibleText, source)) return null;
      const event = sanitize({
        seq: ++this.drawSequence,
        at: this.now(),
        stage: String(stage || source.stage || 'draw'),
        adapter: firstString(source.adapter, source.sourceAdapter, ''),
        methodName: firstString(source.methodName, source.method, ''),
        reason: firstString(source.reason, ''),
        rawText: limitText(rawText),
        visibleText: limitText(visibleText),
        normalizedText: limitText(firstString(source.normalizedText, visibleText, rawText)),
        windowType: firstString(source.windowType, ''),
        ownerType: firstString(source.ownerType, ''),
      }, 2);
      this.drawEvents.push(event);
      while (this.drawEvents.length > this.settings.drawTrace.limit) this.drawEvents.shift();
      return event;
    }

    time(name, ms, options = {}) {
      const label = sanitizeTimingLabel(name);
      const elapsed = roundMs(ms);
      if (!label || !Number.isFinite(elapsed) || elapsed < 0) return null;
      addTiming(this.timings, label, elapsed);
      const domain = sanitizeTimingLabel(options && (options.domain || options.category || options.workload || 'runtime'));
      if (!this.domainTimings.has(domain)) this.domainTimings.set(domain, new Map());
      addTiming(this.domainTimings.get(domain), label, elapsed);
      return this.timingSummary()[label] || null;
    }

    increment(name, count = 1) {
      const label = sanitizeTimingLabel(name);
      const amount = Number.isFinite(Number(count)) ? Number(count) : 1;
      this.counters.set(label, (this.counters.get(label) || 0) + amount);
      return this.counters.get(label);
    }

    measure(name, callback, options = {}) {
      const startedAt = this.now();
      try {
        return callback();
      } finally {
        this.time(name, Math.max(0, this.now() - startedAt), options);
      }
    }

    measureAdapterInstall(adapter, callback) {
      const startedAt = this.now();
      let status = 'installed';
      try {
        const result = callback();
        if (result === false) status = 'skipped';
        return result;
      } catch (error) {
        status = 'failed';
        throw error;
      } finally {
        this.recordAdapterInstall(adapter, status, Math.max(0, this.now() - startedAt));
      }
    }

    recordAdapterInstall(adapter, status, elapsedMs) {
      const name = String(adapter || 'unknown');
      const entry = {
        adapter: name,
        status: String(status || 'unknown'),
        elapsedMs: roundMs(elapsedMs),
      };
      const existingIndex = this.adapterStatuses.findIndex((item) => item.adapter === name);
      if (existingIndex >= 0) {
        this.adapterStatuses[existingIndex] = entry;
      } else {
        this.adapterStatuses.push(entry);
      }
      this.time(`hook.install.${name}.ms`, entry.elapsedMs, { domain: 'runtime' });
      return entry;
    }

    recordFrame(durationMs, details = {}) {
      if (!this.isProfilerEnabled()) return null;
      const duration = roundMs(durationMs);
      if (!Number.isFinite(duration) || duration < 0) return null;
      const profiler = this.settings.profiler;
      const slow = duration >= profiler.slowFrameMs;
      const dropped = duration >= profiler.targetFrameMs * profiler.droppedFrameMultiplier;
      const frame = {
        id: this.frameTotals.total + 1,
        at: this.now(),
        durationMs: duration,
        slow: slow || dropped,
        dropped,
        stage: firstString(details && (details.stage || details.name || details.label), ''),
      };
      this.frameTotals.total += 1;
      if (frame.slow) this.frameTotals.slow += 1;
      if (frame.dropped) this.frameTotals.dropped += 1;
      this.frames.push(frame);
      while (this.frames.length > profiler.rollingFrames) this.frames.shift();
      return frame;
    }

    setForesightSnapshotProvider(provider) {
      this.foresightSnapshotProvider = typeof provider === 'function' ? provider : null;
    }

    snapshot(options = {}) {
      const detailView = options.detailView !== false && options.includeDetails !== false;
      const drawEvents = detailView ? this.drawEvents.slice() : [];
      return {
        updatedAt: this.now(),
        enabled: this.isEnabled(),
        performance: {
          counters: toPlainCounterObject(this.counters),
          timings: timingRows(this.timings),
          domains: this.domainSnapshot(),
          frames: this.frameSnapshot(),
        },
        hookTimingSummary: this.timingSummary(/^hook\./u),
        adapterInstallStatus: this.adapterStatuses.map((entry) => Object.assign({}, entry)),
        drawTrace: {
          enabled: this.isDrawTraceEnabled(),
          limit: this.settings.drawTrace.limit,
          size: this.drawEvents.length,
          sequence: this.drawSequence,
          summary: summarizeEvents(this.drawEvents),
          events: drawEvents,
        },
        foresight: this.foresightSnapshot(),
      };
    }

    diagnostics() {
      return this.snapshot({ detailView: true });
    }

    clear() {
      this.drawEvents.length = 0;
      this.drawSequence = 0;
      this.timings.clear();
      this.counters.clear();
      this.domainTimings.clear();
      this.adapterStatuses.length = 0;
      this.frames.length = 0;
      this.frameTotals = { total: 0, slow: 0, dropped: 0 };
    }

    foresightSnapshot() {
      if (!this.foresightSnapshotProvider) return null;
      try {
        const snapshot = this.foresightSnapshotProvider();
        return snapshot && typeof snapshot === 'object' ? sanitize(snapshot, 4) : null;
      } catch (_) {
        return {
          status: 'unavailable',
        };
      }
    }

    isEnabled() {
      return this.settings.enabled;
    }

    isDrawTraceEnabled() {
      return this.isEnabled() && this.settings.drawTrace.enabled;
    }

    isProfilerEnabled() {
      return this.isEnabled() && this.settings.profiler.enabled;
    }

    shouldRecordDraw(rawText, visibleText, source) {
      if (source && source.force === true) return true;
      if (this.settings.drawTrace.recordAll) return true;
      const texts = [rawText, visibleText, firstString(source && source.normalizedText, '')]
        .map((value) => String(value || ''))
        .filter(Boolean);
      if (!texts.length) return false;
      if (this.settings.drawTrace.targetTexts.length) {
        return this.settings.drawTrace.targetTexts.some((target) => texts.some((value) => value.includes(target)));
      }
      return this.settings.drawTrace.recordCjk && texts.some((value) => CJK_TEXT_PATTERN.test(value));
    }

    timingSummary(pattern = null) {
      const rows = timingRows(this.timings);
      return rows.reduce((output, row) => {
        if (pattern && !pattern.test(row.name)) return output;
        output[row.name] = {
          count: row.count,
          totalMs: row.totalMs,
          avgMs: row.avgMs,
          maxMs: row.maxMs,
        };
        return output;
      }, {});
    }

    domainSnapshot() {
      const output = {};
      for (const [domain, timings] of this.domainTimings.entries()) {
        output[domain] = {
          timings: timingRows(timings),
        };
      }
      return output;
    }

    frameSnapshot() {
      const profiler = this.settings.profiler;
      return {
        enabled: this.isProfilerEnabled(),
        summary: {
          total: this.frameTotals.total,
          slow: this.frameTotals.slow,
          dropped: this.frameTotals.dropped,
          targetFps: profiler.targetFps,
          targetFrameMs: roundMs(profiler.targetFrameMs),
          slowFrameMs: roundMs(profiler.slowFrameMs),
          droppedFrameMs: roundMs(profiler.targetFrameMs * profiler.droppedFrameMultiplier),
        },
        recent: this.frames.map((frame) => Object.assign({}, frame)),
      };
    }
  }

  function normalizeSettings(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const diagnostics = source.diagnostics && typeof source.diagnostics === 'object' ? source.diagnostics : {};
    const drawTrace = source.draw_capture_trace || source.drawCaptureTrace || diagnostics.draw_capture_trace || diagnostics.drawCaptureTrace || {};
    const profiler = source.performance_profiler || source.performanceProfiler || diagnostics.performance_profiler || diagnostics.performanceProfiler || {};
    return {
      enabled: source.diagnostics_enabled !== false && diagnostics.enabled !== false,
      drawTrace: {
        enabled: drawTrace.enabled !== false,
        recordAll: drawTrace.record_all === true || drawTrace.recordAll === true,
        recordCjk: drawTrace.record_cjk !== false && drawTrace.recordCjk !== false,
        limit: positiveInteger(drawTrace.limit, DEFAULT_TRACE_LIMIT, 1, MAX_TRACE_LIMIT),
        targetTexts: normalizeTargetTexts(drawTrace.target_texts || drawTrace.targetTexts),
      },
      profiler: normalizeProfilerSettings(profiler),
    };
  }

  function normalizeProfilerSettings(source) {
    const raw = source && typeof source === 'object' ? source : {};
    const targetFps = resolveTargetFps(raw.target_fps ?? raw.targetFps ?? raw.targetFPS);
    const targetFrameMs = 1000 / targetFps;
    const droppedFrameMultiplier = Math.max(1.1, Number(raw.dropped_frame_multiplier ?? raw.droppedFrameMultiplier) || 2);
    return {
      enabled: raw.enabled === true,
      targetFps,
      targetFrameMs,
      slowFrameMs: targetFrameMs,
      droppedFrameMultiplier,
      rollingFrames: positiveInteger(raw.rolling_frames ?? raw.rollingFrames, DEFAULT_ROLLING_FRAMES, 1, 5000),
    };
  }

  function resolveTargetFps(value) {
    const fps = Number(value);
    if (!Number.isFinite(fps) || fps <= 0) return DEFAULT_TARGET_FPS;
    return Math.max(1, Math.min(MAX_TARGET_FPS, fps));
  }

  function normalizeTargetTexts(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const list = [];
    for (const entry of value) {
      const text = String(entry || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      list.push(text);
    }
    return list.slice(0, 32);
  }

  function addTiming(target, name, ms) {
    const existing = target.get(name) || { count: 0, totalMs: 0, maxMs: 0 };
    existing.count += 1;
    existing.totalMs = roundMs(existing.totalMs + ms);
    existing.maxMs = roundMs(Math.max(existing.maxMs || 0, ms));
    target.set(name, existing);
  }

  function timingRows(map) {
    return Array.from(map.entries())
      .sort((a, b) => b[1].totalMs - a[1].totalMs || a[0].localeCompare(b[0]))
      .map(([name, value]) => ({
        name,
        count: value.count || 0,
        totalMs: roundMs(value.totalMs || 0),
        avgMs: value.count ? roundMs((value.totalMs || 0) / value.count) : 0,
        maxMs: roundMs(value.maxMs || 0),
      }));
  }

  function summarizeEvents(events) {
    const summary = {
      total: events.length,
      byStage: {},
      byAdapter: {},
      byMethod: {},
      byReason: {},
      byWindowType: {},
      byOwnerType: {},
      byText: {},
    };
    for (const event of events) {
      count(summary.byStage, event.stage);
      count(summary.byAdapter, event.adapter);
      count(summary.byMethod, event.methodName || event.method);
      count(summary.byReason, event.reason);
      count(summary.byWindowType, event.windowType);
      count(summary.byOwnerType, event.ownerType);
      count(summary.byText, event.normalizedText || event.visibleText || event.rawText);
    }
    for (const key of Object.keys(summary)) {
      if (key !== 'total') summary[key] = topCounts(summary[key]);
    }
    return summary;
  }

  function count(bucket, key) {
    const label = String(key || '').trim();
    if (!label) return;
    bucket[label] = (bucket[label] || 0) + 1;
  }

  function topCounts(bucket) {
    return Object.entries(bucket || {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 40)
      .reduce((output, entry) => {
        output[entry[0]] = entry[1];
        return output;
      }, {});
  }

  function toPlainCounterObject(map) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .reduce((output, entry) => {
        output[entry[0]] = entry[1];
        return output;
      }, {});
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

  function limitText(value) {
    const text = String(value || '');
    return text.length <= DEFAULT_TEXT_LIMIT ? text : `${text.slice(0, DEFAULT_TEXT_LIMIT - 3)}...`;
  }

  function positiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
  }

  function sanitize(value, depth = 2) {
    if (value === undefined) return undefined;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (depth <= 0) return String(value);
    if (Array.isArray(value)) return value.slice(0, 24).map((item) => sanitize(item, depth - 1));
    if (typeof value === 'object') {
      const output = {};
      for (const key of Object.keys(value).slice(0, 40)) {
        const sanitized = sanitize(value[key], depth - 1);
        if (sanitized !== undefined) output[key] = sanitized;
      }
      return output;
    }
    return String(value);
  }

  function sanitizeTimingLabel(value) {
    return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
  }

  function roundMs(value) {
    return Math.round((Number(value) || 0) * 1000) / 1000;
  }

  publish(root, { RuntimeDiagnostics });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
