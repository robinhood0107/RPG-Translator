const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Boot } = require('../boot');
const { BitmapTextAdapter } = require('../bitmap-text-adapter');
const { CacheKeyBuilder, LookupIndex } = require('../lookup-index');
const { CacheLoader } = require('../cache-loader');
const { MessageAdapter } = require('../message-adapter');
const { TextOrchestrator } = require('../orchestrator');
const { createAdapterContract, isAdapterContractError } = require('../adapter-contract');
const { PixiTextAdapter } = require('../pixi-text-adapter');
const { RenderGuard } = require('../render-guard');
const { RuntimeEntry } = require('../RPGTranslator');
const { RuntimeDiagnostics } = require('../runtime-diagnostics');
const { RuntimeMissLogger } = require('../runtime-miss-logger');
const { SpriteTextAdapter } = require('../sprite-text-adapter');
const { StartupToast } = require('../startup-toast');
const { TextCodec } = require('../text-codec');
const { MessageWrapper } = require('../wrapping');
const { WindowTextAdapter } = require('../window-text-adapter');
const { ForesightScanner } = require('../foresight-scanner');

test('text codec follows shared Rust/runtime vectors', () => {
  const vectorsPath = path.join(__dirname, '..', 'test', 'fixtures', 'text-codec-vectors.json');
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

  for (const vector of vectors) {
    const analysis = TextCodec.analyze(vector.input);
    assert.equal(analysis.normalizedText, vector.normalized_text);
    assert.equal(analysis.visibleText, vector.visible_text);
    assert.deepEqual(analysis.controlCodes, vector.control_codes);

    const providerState = TextCodec.encodeForProvider(vector.input);
    assert.equal(providerState.providerText, vector.provider_text);
    assert.deepEqual(providerState.controlCodes, vector.control_codes);
    assert.equal(
      TextCodec.restoreProviderTranslation(vector.restored_provider_translation, providerState),
      vector.restored_text,
    );
  }
});

test('lookup index returns cache hits and leaves misses untranslated', () => {
  const cacheKey = CacheKeyBuilder.build({
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    normalizedText: '\\C[1]こんにちは',
    controlCodeSignature: '\\C[1]',
    contextHash: null,
  });
  const index = new LookupIndex({
    manifest: {
      schema_version: 1,
      key_schema_version: 'v1',
      source_language: 'ja',
      target_language: 'ko',
    },
    records: [
      {
        cache_key: cacheKey,
        source_text_id: 1,
        source_hash: '0'.repeat(64),
        source_language: 'ja',
        target_language: 'ko',
        normalized_text: '\\C[1]こんにちは',
        visible_text: 'こんにちは',
        translation: '\\C[1]안녕',
        control_code_signature: '\\C[1]',
        context_hash: null,
      },
    ],
  });

  assert.equal(
    index.translate({
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      text: '\\C[1]こんにちは',
    }),
    '\\C[1]안녕',
  );
  assert.equal(
    index.translate({
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      text: '未翻訳',
    }),
    null,
  );
  assert.deepEqual(index.diagnostics(), {
    cache_hits: 1,
    cache_misses: 1,
    recent_misses: [
      {
        text: '未翻訳',
        normalized_text: '未翻訳',
        control_code_signature: '',
        cache_key: CacheKeyBuilder.build({
          engine: 'mz',
          sourceLanguage: 'ja',
          targetLanguage: 'ko',
          normalizedText: '未翻訳',
          controlCodeSignature: '',
          contextHash: null,
        }),
      },
    ],
  });
});

test('lookup index writes cache-only miss diagnostics when logger is enabled', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-translator-misses-'));
  const logger = new RuntimeMissLogger({
    directory,
    enabled: true,
    now: () => '2026-06-09T00:00:00.000Z',
  });
  const index = new LookupIndex({
    manifest: {
      schema_version: 1,
      key_schema_version: 'v1',
      source_language: 'ja',
      target_language: 'ko',
    },
    records: [],
    missLogger: logger,
  });

  const translated = index.translate({
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    text: '未翻訳',
    contextHash: 'map001-event001',
  });
  const logPath = path.join(directory, 'runtime-misses.jsonl');
  const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);

  assert.equal(translated, null);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    timestamp: '2026-06-09T00:00:00.000Z',
    text: '未翻訳',
    normalized_text: '未翻訳',
    control_code_signature: '',
    cache_key: CacheKeyBuilder.build({
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      normalizedText: '未翻訳',
      controlCodeSignature: '',
      contextHash: 'map001-event001',
    }),
    engine: 'mz',
    source_language: 'ja',
    target_language: 'ko',
    context_hash: 'map001-event001',
  });
});

test('lookup index suppresses duplicate miss log writes with bounded negative cache', () => {
  const misses = [];
  const index = new LookupIndex({
    manifest: {
      schema_version: 1,
      key_schema_version: 'v1',
      source_language: 'ja',
      target_language: 'ko',
    },
    records: [],
    missLogger: {
      recordMiss(miss) {
        misses.push(miss);
      },
    },
  });
  const request = {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    text: '未翻訳',
    contextHash: 'same-slot',
  };

  assert.equal(index.translate(request), null);
  assert.equal(index.translate(request), null);
  assert.equal(index.translate(Object.assign({}, request, { contextHash: 'other-slot' })), null);

  assert.equal(index.diagnostics().cache_misses, 3);
  assert.equal(misses.length, 2);
  assert.equal(index.diagnostics().recent_misses.length, 2);
});

test('cache loader parses static manifest config and jsonl records', async () => {
  const files = new Map([
    [
      'manifest.json',
      JSON.stringify({
        schema_version: 1,
        project_id: 1,
        source_language: 'ja',
        target_language: 'ko',
        created_timestamp: '1',
        key_schema_version: 'v1',
        cache_files: ['cache.jsonl'],
        record_count: 1,
      }),
    ],
    [
      'overlay-config.json',
      JSON.stringify({
        schema_version: 1,
        diagnostics_enabled: false,
        startup_toast_enabled: true,
        startup_toast_text: 'RPG-Translator 작동중',
      }),
    ],
    [
      'cache.jsonl',
      `${JSON.stringify({
        cache_key: 'ck:v1:' + '0'.repeat(64),
        source_text_id: 1,
        source_hash: '0'.repeat(64),
        source_language: 'ja',
        target_language: 'ko',
        normalized_text: '世界',
        visible_text: '世界',
        translation: '세계',
        control_code_signature: '',
        context_hash: null,
      })}\n`,
    ],
  ]);
  const bundle = await CacheLoader.load('', async (url) => ({
    ok: true,
    text: async () => files.get(url),
  }));

  assert.equal(bundle.manifest.record_count, 1);
  assert.equal(bundle.config.startup_toast_text, 'RPG-Translator 작동중');
  assert.equal(bundle.records[0].translation, '세계');
});

test('render guard rejects stale render operations after surface changes', () => {
  const guard = new RenderGuard();
  const surface = {};
  const token = guard.capture(surface, 'こんにちは');

  assert.equal(guard.canRender(token, surface, 'こんにちは'), true);
  assert.equal(guard.canRender(token, surface, 'こんばんは'), false);
  guard.markSurfaceChanged(surface);
  assert.equal(guard.canRender(token, surface, 'こんにちは'), false);
});

test('runtime diagnostics records hook timing and bounded draw trace summaries', () => {
  let now = 1000;
  const diagnostics = new RuntimeDiagnostics({
    now: () => {
      now += 10;
      return now;
    },
    settings: {
      diagnostics_enabled: true,
      draw_capture_trace: {
        enabled: true,
        record_all: true,
        limit: 2,
      },
    },
  });

  diagnostics.recordDraw('native-draw', {
    adapter: 'window-text',
    methodName: 'drawText',
    rawText: 'こんにちは',
    reason: 'cache-miss',
  });
  diagnostics.recordDraw('native-draw', {
    adapter: 'bitmap-text',
    methodName: 'drawText',
    rawText: '世界',
    reason: 'cache-hit',
  });
  diagnostics.recordDraw('skip', {
    adapter: 'pixi-text',
    methodName: 'text',
    rawText: 'Plain',
    reason: 'ownership-conflict',
  });
  diagnostics.time('adapter.window.draw.ms', 7.5, { domain: 'runtime' });
  diagnostics.recordAdapterInstall('window-text', 'installed', 5.2);

  const snapshot = diagnostics.snapshot({ detailView: true });
  assert.equal(snapshot.drawTrace.size, 2);
  assert.deepEqual(snapshot.drawTrace.summary.byAdapter, {
    'bitmap-text': 1,
    'pixi-text': 1,
  });
  assert.deepEqual(snapshot.drawTrace.summary.byReason, {
    'cache-hit': 1,
    'ownership-conflict': 1,
  });
  assert.deepEqual(snapshot.hookTimingSummary, {
    'hook.install.window-text.ms': {
      count: 1,
      totalMs: 5.2,
      avgMs: 5.2,
      maxMs: 5.2,
    },
  });
  assert.deepEqual(snapshot.adapterInstallStatus, [
    {
      adapter: 'window-text',
      status: 'installed',
      elapsedMs: 5.2,
    },
  ]);
  assert.equal(snapshot.performance.timings.some((entry) => entry.name === 'adapter.window.draw.ms'), true);
});

test('runtime diagnostics records slow and dropped frame policy summaries', () => {
  const diagnostics = new RuntimeDiagnostics({
    settings: {
      diagnostics_enabled: true,
      performance_profiler: {
        enabled: true,
        target_fps: 50,
        dropped_frame_multiplier: 2,
        rolling_frames: 3,
      },
    },
  });

  diagnostics.recordFrame(10, { stage: 'scene-update' });
  diagnostics.recordFrame(21, { stage: 'scene-update' });
  diagnostics.recordFrame(45, { stage: 'message-redraw' });
  diagnostics.recordFrame(60, { stage: 'bitmap-replay' });

  const snapshot = diagnostics.snapshot({ detailView: true });
  assert.deepEqual(snapshot.performance.frames.summary, {
    total: 4,
    slow: 3,
    dropped: 2,
    targetFps: 50,
    targetFrameMs: 20,
    slowFrameMs: 20,
    droppedFrameMs: 40,
  });
  assert.deepEqual(snapshot.performance.frames.recent.map((frame) => [frame.durationMs, frame.slow, frame.dropped, frame.stage]), [
    [21, true, false, 'scene-update'],
    [45, true, true, 'message-redraw'],
    [60, true, true, 'bitmap-replay'],
  ]);
});

test('orchestrator records canonical items and rejects stale render commands', () => {
  const surface = {};
  const index = {
    translate(request) {
      if (request.text === 'Origin') return '번역';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const command = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'slot-a',
    text: 'Origin',
  });

  assert.equal(command.status, 'hit');
  assert.equal(command.translatedText, '번역');
  assert.equal(orchestrator.acceptRender(command, surface, 'Origin'), true);
  orchestrator.markSurfaceChanged(surface);
  assert.equal(orchestrator.acceptRender(command, surface, 'Origin'), false);
  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.observed_items, 1);
  assert.equal(diagnostics.cache_hits, 1);
  assert.equal(diagnostics.cache_misses, 0);
  assert.equal(diagnostics.render_accepted, 1);
  assert.equal(diagnostics.render_rejected, 1);
  assert.equal(diagnostics.ownership_conflicts, 0);
  assert.equal(diagnostics.surface_claims, 0);
  assert.equal(diagnostics.text_claims, 0);
  assert.equal(diagnostics.surface_releases, 0);
  assert.equal(diagnostics.text_releases, 0);
  assert.equal(diagnostics.active_items, 1);
  assert.equal(diagnostics.detached_items, 0);
  assert.equal(diagnostics.archived_items, 0);
  assert.equal(diagnostics.queued_render_commands, 1);
  assert.deepEqual(diagnostics.active.map((item) => [
    item.id,
    item.adapter,
    item.kind,
    item.state,
    item.sourceText,
    item.translationState,
    item.lastRenderStatus,
    item.history.map((event) => event.type),
  ]), [[
    command.itemId,
    'window-text',
    'drawText',
    'active',
    'Origin',
    'hit',
    'rejected',
    ['observed', 'cacheHit', 'renderQueued', 'renderAccepted', 'renderRejected'],
  ]]);
  assert.deepEqual(diagnostics.detached, []);
  assert.deepEqual(diagnostics.archived, []);
  assert.deepEqual(diagnostics.renderQueue.map((entry) => [
    entry.id,
    entry.itemId,
    entry.status,
    entry.reason,
    entry.sourceText,
    entry.translatedText,
  ]), [[
    command.id,
    command.itemId,
    'hit',
    'stale-render',
    'Origin',
    '번역',
  ]]);
  assert.deepEqual(diagnostics.recent_events.map((event) => [event.type, event.reason]), [
    ['observed', 'observed'],
    ['cacheHit', 'cache-hit'],
    ['renderQueued', 'hit'],
    ['renderAccepted', 'render-accepted'],
    ['renderRejected', 'stale-render'],
  ]);
});

test('orchestrator preserves adapter visibility and priority on observation refresh', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });

  orchestrator.observeRecord({
    adapter: 'pixi-text',
    kind: 'text-setter',
    surface,
    slotKey: 'pixi-visible-state',
    text: 'Hidden JP',
    visible: false,
    screenState: 'hidden',
    priority: 100,
    backgrounded: true,
  });

  let active = orchestrator.diagnostics().active[0];
  assert.equal(active.visible, false);
  assert.equal(active.screenState, 'hidden');
  assert.equal(active.priority, 100);
  assert.equal(active.backgrounded, true);

  orchestrator.observeRecord({
    adapter: 'pixi-text',
    kind: 'text-setter',
    surface,
    slotKey: 'pixi-visible-state',
    text: 'Hidden JP',
    visible: true,
    screenState: 'visible',
    priority: 750,
    backgrounded: false,
  });

  active = orchestrator.diagnostics().active[0];
  assert.equal(active.visible, true);
  assert.equal(active.screenState, 'visible');
  assert.equal(active.priority, 750);
  assert.equal(active.backgrounded, false);
  assert.equal(orchestrator.diagnostics().active_items, 1);
});

test('orchestrator refreshes same-slot source without duplicating active items', () => {
  const surface = {};
  const lookups = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      lookups.push(request.text);
      if (request.text === 'Stable source') return '안정 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const first = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'stable-slot',
    text: 'Stable source',
    renderStrategy: 'window-text',
  });
  const second = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'stable-slot',
    text: 'Stable source',
    renderStrategy: 'window-text',
  });

  const diagnostics = orchestrator.diagnostics();
  assert.equal(second.itemId, first.itemId);
  assert.equal(diagnostics.active_items, 1);
  assert.equal(diagnostics.archived_items, 0);
  assert.deepEqual(lookups, ['Stable source']);
  assert.equal(diagnostics.cache_hits, 2);
  assert.equal(diagnostics.source_cache_hits, 1);
  assert.deepEqual(diagnostics.active[0].history.map((event) => [event.type, event.reason]), [
    ['observed', 'observed'],
    ['cacheHit', 'cache-hit'],
    ['renderQueued', 'hit'],
    ['observed', 'same slot refreshed'],
    ['cacheHit', 'source-cache'],
    ['renderQueued', 'hit'],
  ]);
});

test('orchestrator replaces same-slot source and rejects stale queued renders', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Old source') return '옛 번역';
      if (request.text === 'New source') return '새 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const first = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'replace-slot',
    text: 'Old source',
    renderStrategy: 'window-text',
  });
  const second = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'replace-slot',
    text: 'New source',
    renderStrategy: 'window-text',
  });

  const diagnostics = orchestrator.diagnostics();
  assert.notEqual(second.itemId, first.itemId);
  assert.equal(diagnostics.active_items, 1);
  assert.equal(diagnostics.archived_items, 1);
  assert.equal(diagnostics.active[0].id, second.itemId);
  assert.equal(diagnostics.active[0].sourceText, 'New source');
  assert.equal(diagnostics.archived[0].id, first.itemId);
  assert.equal(diagnostics.archived[0].sourceText, 'Old source');
  assert.equal(diagnostics.archived[0].state, 'archived');
  assert.equal(diagnostics.archived[0].status, 'stale');
  assert.equal(diagnostics.render_rejected, 1);
  assert.deepEqual(diagnostics.renderQueue.map((entry) => [
    entry.itemId,
    entry.sourceText,
    entry.translatedText,
    entry.renderStatus,
    entry.renderReason,
  ]), [
    [first.itemId, 'Old source', '옛 번역', 'rejected', 'same slot replaced'],
    [second.itemId, 'New source', '새 번역', 'queued', ''],
  ]);
  assert.deepEqual(diagnostics.recent_events.slice(-5).map((event) => [event.type, event.reason]), [
    ['renderRejected', 'same slot replaced'],
    ['item.replaced', 'same slot replaced'],
    ['observed', 'observed'],
    ['cacheHit', 'cache-hit'],
    ['renderQueued', 'hit'],
  ]);
});

test('orchestrator diagnostics snapshots detached and archived item lifecycle', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      return request.text === 'Lifecycle source' ? '라이프사이클 번역' : null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const command = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawTextEx',
    surface,
    slotKey: 'lifecycle',
    text: 'Lifecycle source',
    contextHash: 'menu-status',
  });

  assert.equal(orchestrator.detachItem(command.itemId), true);
  let diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.active_items, 0);
  assert.equal(diagnostics.detached_items, 1);
  assert.equal(diagnostics.archived_items, 0);
  assert.deepEqual(diagnostics.detached.map((item) => [
    item.id,
    item.state,
    item.contextHash,
    item.translationState,
    item.history.map((event) => event.type),
  ]), [[
    command.itemId,
    'detached',
    'menu-status',
    'hit',
    ['observed', 'cacheHit', 'renderQueued', 'renderRejected', 'item.detached'],
  ]]);

  assert.equal(orchestrator.archiveItem(command.itemId), true);
  diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.active_items, 0);
  assert.equal(diagnostics.detached_items, 0);
  assert.equal(diagnostics.archived_items, 1);
  assert.deepEqual(diagnostics.archived.map((item) => [
    item.id,
    item.state,
    item.sourceText,
    item.translationState,
  ]), [[
    command.itemId,
    'archived',
    'Lifecycle source',
    'hit',
  ]]);
});

test('orchestrator detachItem rejects queued renders before parking inactive items', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Detach source') return '분리 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const command = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'detach-slot',
    text: 'Detach source',
    renderStrategy: 'window-text',
  });

  assert.equal(orchestrator.detachItem(command.itemId, 'window hidden'), true);

  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.active_items, 0);
  assert.equal(diagnostics.detached_items, 1);
  assert.equal(diagnostics.archived_items, 0);
  assert.equal(diagnostics.detached[0].id, command.itemId);
  assert.equal(diagnostics.detached[0].state, 'detached');
  assert.equal(diagnostics.detached[0].status, 'detached');
  assert.equal(diagnostics.render_rejected, 1);
  assert.deepEqual(diagnostics.renderQueue.map((entry) => [
    entry.itemId,
    entry.sourceText,
    entry.renderStatus,
    entry.renderReason,
  ]), [
    [command.itemId, 'Detach source', 'rejected', 'window hidden'],
  ]);
  assert.deepEqual(diagnostics.recent_events.slice(-2).map((event) => [event.type, event.reason]), [
    ['renderRejected', 'window hidden'],
    ['item.detached', 'window hidden'],
  ]);
});

test('orchestrator archiveItem rejects queued renders and releases slot identity', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Archive source') return '보관 번역';
      if (request.text === 'Archive replacement') return '보관 교체';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const first = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'archive-slot',
    text: 'Archive source',
    renderStrategy: 'window-text',
  });

  assert.equal(orchestrator.archiveItem(first.itemId, 'bitmap mutated'), true);
  const second = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'archive-slot',
    text: 'Archive replacement',
    renderStrategy: 'window-text',
  });

  const diagnostics = orchestrator.diagnostics();
  assert.notEqual(second.itemId, first.itemId);
  assert.equal(diagnostics.active_items, 1);
  assert.equal(diagnostics.archived_items, 1);
  assert.equal(diagnostics.archived[0].id, first.itemId);
  assert.equal(diagnostics.archived[0].state, 'archived');
  assert.equal(diagnostics.archived[0].status, 'archived');
  assert.equal(diagnostics.render_rejected, 1);
  assert.deepEqual(diagnostics.renderQueue.map((entry) => [
    entry.itemId,
    entry.sourceText,
    entry.renderStatus,
    entry.renderReason,
  ]), [
    [first.itemId, 'Archive source', 'rejected', 'bitmap mutated'],
    [second.itemId, 'Archive replacement', 'queued', ''],
  ]);
  assert.deepEqual(diagnostics.recent_events.slice(-5).map((event) => [event.type, event.reason]), [
    ['renderRejected', 'bitmap mutated'],
    ['item.archived', 'bitmap mutated'],
    ['observed', 'observed'],
    ['cacheHit', 'cache-hit'],
    ['renderQueued', 'hit'],
  ]);
});

test('orchestrator retireSurface propagates lifecycle reason to archived renders', () => {
  const surface = {};
  const otherSurface = {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Surface source') return '서피스 번역';
      if (request.text === 'Other source') return '다른 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const first = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'surface-slot',
    text: 'Surface source',
    renderStrategy: 'window-text',
  });
  const second = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: otherSurface,
    slotKey: 'other-slot',
    text: 'Other source',
    renderStrategy: 'window-text',
  });

  assert.equal(orchestrator.retireSurface(surface, 'window destroyed'), 1);

  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.active_items, 1);
  assert.equal(diagnostics.archived_items, 1);
  assert.equal(diagnostics.active[0].id, second.itemId);
  assert.equal(diagnostics.archived[0].id, first.itemId);
  assert.equal(diagnostics.render_rejected, 1);
  assert.deepEqual(diagnostics.renderQueue.map((entry) => [
    entry.itemId,
    entry.sourceText,
    entry.renderStatus,
    entry.renderReason,
  ]), [
    [first.itemId, 'Surface source', 'rejected', 'window destroyed'],
    [second.itemId, 'Other source', 'queued', ''],
  ]);
  assert.deepEqual(diagnostics.recent_events.slice(-3).map((event) => [event.type, event.reason]), [
    ['renderRejected', 'window destroyed'],
    ['item.archived', 'window destroyed'],
    ['surfaceRetired', 'window destroyed'],
  ]);
});

test('orchestrator updates items through cache-only request contract', async () => {
  const surface = {};
  const lookups = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      lookups.push(request.text);
      if (request.text === 'Fresh source') return '새 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const command = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'update',
    text: 'Old source',
    renderStrategy: 'window-text',
  });
  assert.equal(command.status, 'miss');

  const updated = orchestrator.updateItem(command.itemId, {
    sourceText: 'Fresh source',
    contextHash: 'status-menu',
    renderStrategy: 'window-text',
  }, {
    eventType: 'item.updated',
    message: 'same slot source changed',
  });
  assert.equal(updated.id, command.itemId);
  assert.equal(updated.sourceText, 'Fresh source');
  assert.equal(updated.translationState, '');

  const handle = orchestrator.requestItemTranslation(command.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  assert.equal(handle.getStatus(), 'completed');
  assert.equal(handle.getSourceHint(), 'cache-only');
  assert.equal(await handle.promise, '새 번역');

  const diagnostics = orchestrator.diagnostics();
  assert.deepEqual(lookups, ['Old source', 'Fresh source']);
  assert.equal(diagnostics.cache_hits, 1);
  assert.equal(diagnostics.cache_misses, 1);
  assert.equal(diagnostics.active[0].sourceText, 'Fresh source');
  assert.equal(diagnostics.active[0].translationState, 'hit');
  assert.equal(diagnostics.active[0].translationReceived, '새 번역');
  assert.equal(diagnostics.renderQueue.at(-1).translatedText, '새 번역');
  assert.deepEqual(diagnostics.recent_events.slice(-4).map((event) => [event.type, event.reason]), [
    ['item.updated', 'same slot source changed'],
    ['requestCacheHit', 'cache-hit'],
    ['renderQueued', 'hit'],
    ['requestCompleted', 'cache-only'],
  ]);
});

test('orchestrator reuses completed source translations before cache index lookup', () => {
  const lookups = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      lookups.push(request.text);
      if (request.text === 'Repeated source') return '반복 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const first = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'first',
    text: 'Repeated source',
    renderStrategy: 'window-text',
  });
  const second = orchestrator.observeRecord({
    adapter: 'pixi-text',
    kind: 'PIXI.Text',
    surface: {},
    slotKey: 'second',
    text: 'Repeated source',
    renderStrategy: 'pixi-text',
  });

  const diagnostics = orchestrator.diagnostics();
  assert.equal(first.status, 'hit');
  assert.equal(second.status, 'hit');
  assert.equal(second.translatedText, '반복 번역');
  assert.deepEqual(lookups, ['Repeated source']);
  assert.equal(diagnostics.cache_hits, 2);
  assert.equal(diagnostics.source_cache_hits, 1);
  assert.equal(diagnostics.source_cache_entries, 1);
  assert.deepEqual(diagnostics.renderQueue.map((entry) => [entry.id, entry.translatedText]), [
    [first.id, '반복 번역'],
    [second.id, '반복 번역'],
  ]);
  assert.deepEqual(diagnostics.recent_events.slice(-3).map((event) => [event.type, event.reason]), [
    ['observed', 'observed'],
    ['cacheHit', 'source-cache'],
    ['renderQueued', 'hit'],
  ]);
});

test('orchestrator request path reports completed source translation reuse', async () => {
  const lookups = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      lookups.push(request.text);
      if (request.text === 'Reusable request source') return '재사용 요청 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const first = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'request-source',
    text: 'Reusable request source',
    renderStrategy: 'window-text',
  });
  const second = orchestrator.observeRecord({
    adapter: 'pixi-text',
    kind: 'PIXI.Text',
    surface: {},
    slotKey: 'request-miss',
    text: 'Initial miss source',
    renderStrategy: 'pixi-text',
  });
  const handle = orchestrator.requestItemTranslation(second.itemId, {
    text: 'Reusable request source',
    renderStrategy: 'pixi-text',
    sourceHint: 'cache-only',
  });

  assert.equal(first.status, 'hit');
  assert.equal(second.status, 'miss');
  assert.equal(handle.getStatus(), 'completed');
  assert.equal(await handle.promise, '재사용 요청 번역');
  assert.deepEqual(lookups, ['Reusable request source', 'Initial miss source']);

  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.source_cache_hits, 1);
  assert.equal(diagnostics.active.find((item) => item.id === second.itemId).sourceHint, 'source-cache');
  assert.deepEqual(diagnostics.recent_events.slice(-3).map((event) => [event.type, event.reason]), [
    ['requestCacheHit', 'source-cache'],
    ['renderQueued', 'hit'],
    ['requestCompleted', 'cache-only'],
  ]);
});

test('orchestrator cache-only request records miss without provider handle', async () => {
  const orchestrator = new TextOrchestrator({ translate: () => null }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const command = orchestrator.observeRecord({
    adapter: 'pixi-text',
    kind: 'PIXI.Text',
    surface: {},
    slotKey: 'missing',
    text: 'Missing source',
  });

  const handle = orchestrator.requestItemTranslation(command.itemId, {
    sourceHint: 'cache-only',
  });
  assert.equal(handle.getStatus(), 'miss');
  assert.equal(handle.cancel(), false);
  assert.equal(await handle.promise, 'Missing source');

  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.cache_hits, 0);
  assert.equal(diagnostics.cache_misses, 2);
  assert.equal(diagnostics.active[0].translationState, 'miss');
  assert.deepEqual(diagnostics.recent_events.slice(-2).map((event) => [event.type, event.reason]), [
    ['requestCacheMiss', 'cache-miss'],
    ['requestSkipped', 'cache-only-miss'],
  ]);
});

test('orchestrator records adapter render decisions against queued commands', () => {
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Decision source') return '결정 번역';
      if (request.text === 'Reject source') return '거절 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const acceptedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'decision-a',
    text: 'Decision source',
    renderStrategy: 'window-text',
  });
  const rejectedCommand = orchestrator.observeRecord({
    adapter: 'bitmap-text',
    kind: 'Bitmap.drawText',
    surface: {},
    slotKey: 'decision-b',
    text: 'Reject source',
    renderStrategy: 'bitmap-text',
  });

  assert.equal(orchestrator.recordRenderDeferred(acceptedCommand.itemId, {
    commandId: acceptedCommand.id,
    reason: 'window-hidden',
  }), true);
  assert.equal(orchestrator.recordRenderAccepted(acceptedCommand.itemId, {
    commandId: acceptedCommand.id,
    reason: 'bitmap-replay',
    details: { textScale: 1.1 },
  }), true);
  assert.equal(orchestrator.recordRenderRejected(rejectedCommand.itemId, {
    commandId: rejectedCommand.id,
    reason: 'surface-generation-mismatch',
    details: { currentGeneration: 2 },
  }), true);

  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.render_accepted, 1);
  assert.equal(diagnostics.render_rejected, 1);
  assert.deepEqual(diagnostics.renderQueue.map((entry) => [
    entry.id,
    entry.renderStatus,
    entry.renderReason,
    entry.renderDetails && entry.renderDetails.textScale || null,
    entry.renderDetails && entry.renderDetails.currentGeneration || null,
  ]), [
    [acceptedCommand.id, 'accepted', 'bitmap-replay', 1.1, null],
    [rejectedCommand.id, 'rejected', 'surface-generation-mismatch', null, 2],
  ]);
  assert.deepEqual(diagnostics.recent_events.slice(-3).map((event) => [event.type, event.reason]), [
    ['renderDeferred', 'window-hidden'],
    ['renderAccepted', 'bitmap-replay'],
    ['renderRejected', 'surface-generation-mismatch'],
  ]);
});

test('orchestrator recordDraw keeps received and drawn translations distinct', () => {
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Draw source') return '수신 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const command = orchestrator.observeRecord({
    adapter: 'bitmap-text',
    kind: 'Bitmap.drawText',
    surface: {},
    slotKey: 'draw-record',
    text: 'Draw source',
    renderStrategy: 'bitmap-text',
  });

  const rendered = orchestrator.recordDraw(command.itemId, 'bitmap replay', {
    translationReceived: '수신 번역',
    translationDrawn: '화면 번역',
    text: 'fallback text should not win',
  });

  const diagnostics = orchestrator.diagnostics();
  assert.equal(rendered.id, command.itemId);
  assert.equal(rendered.translationReceived, '수신 번역');
  assert.equal(rendered.translationDrawn, '화면 번역');
  assert.equal(rendered.translation, '화면 번역');
  assert.equal(diagnostics.active[0].translationReceived, '수신 번역');
  assert.equal(diagnostics.active[0].translationDrawn, '화면 번역');
  assert.equal(diagnostics.active[0].translation, '화면 번역');
  assert.deepEqual(diagnostics.recent_events.slice(-1).map((event) => [
    event.type,
    event.reason,
    event.translatedText,
  ]), [
    ['item.rendered', 'bitmap replay', '화면 번역'],
  ]);
});

test('orchestrator routes render commands through record subscriptions', () => {
  const surface = {};
  const routed = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Subscribed') return '구독됨';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    onRenderQueued(command, route) {
      routed.push(['queued', command.strategy, command.translatedText, route.eventType]);
      return true;
    },
    onRenderAccepted(command, route) {
      routed.push(['accepted', command.strategy, command.translatedText, route.eventType]);
    },
    onRenderRejected(command, route) {
      routed.push(['rejected', command.strategy, command.translatedText, route.eventType]);
    },
  });

  const command = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface,
    slotKey: 'slot-a',
    text: 'Subscribed',
    renderStrategy: 'window-text',
  });
  assert.equal(orchestrator.acceptRender(command, surface, 'Subscribed'), true);
  orchestrator.markSurfaceChanged(surface);
  assert.equal(orchestrator.acceptRender(command, surface, 'Subscribed'), false);
  unsubscribe();
  orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'slot-b',
    text: 'Subscribed',
    renderStrategy: 'window-text',
  });

  assert.deepEqual(routed, [
    ['queued', 'window-text', '구독됨', 'item.render_queued'],
    ['accepted', 'window-text', '구독됨', 'item.render_accepted'],
    ['rejected', 'window-text', '구독됨', 'item.render_rejected'],
  ]);
});

test('orchestrator contains lightweight render subscription callback errors', () => {
  const acceptedSurface = {};
  const rejectedSurface = {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Lightweight queued error') return '가벼운 큐 오류';
      if (request.text === 'Lightweight accepted') return '가벼운 승인';
      if (request.text === 'Lightweight rejected') return '가벼운 거부';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    onRenderQueued(command) {
      if (command.sourceText === 'Lightweight queued error') {
        throw new Error('queued callback exploded');
      }
      return true;
    },
    onRenderAccepted() {
      throw new Error('accepted callback exploded');
    },
    onRenderRejected() {
      throw new Error('rejected callback exploded');
    },
  });

  const queuedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'lightweight-queued-error',
    text: 'Lightweight queued error',
    renderStrategy: 'window-text',
  });
  const acceptedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: acceptedSurface,
    slotKey: 'lightweight-accepted',
    text: 'Lightweight accepted',
    renderStrategy: 'window-text',
  });
  const rejectedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: rejectedSurface,
    slotKey: 'lightweight-rejected',
    text: 'Lightweight rejected',
    renderStrategy: 'window-text',
  });
  assert.equal(orchestrator.acceptRender(acceptedCommand, acceptedSurface, 'Lightweight accepted'), true);
  orchestrator.markSurfaceChanged(rejectedSurface);
  assert.equal(orchestrator.acceptRender(rejectedCommand, rejectedSurface, 'Lightweight rejected'), false);
  unsubscribe();

  const diagnostics = orchestrator.diagnostics();
  assert.ok(diagnostics.recent_events.some((event) => (
    event.type === 'adapterCallbackError'
    && event.reason === 'subscribeRecords.render_queued'
    && event.itemId === queuedCommand.itemId
  )));
  assert.ok(diagnostics.recent_events.some((event) => (
    event.type === 'adapterCallbackError'
    && event.reason === 'subscribeRecords.render_accepted'
    && event.itemId === acceptedCommand.itemId
  )));
  assert.ok(diagnostics.recent_events.some((event) => (
    event.type === 'adapterCallbackError'
    && event.reason === 'subscribeRecords.render_rejected'
    && event.itemId === rejectedCommand.itemId
  )));
});

test('orchestrator validates record-backed render subscriptions and reports decisions', () => {
  const records = new Map();
  const routed = [];
  const misses = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Accepted target') return '승인 대상';
      if (request.text === 'Stale target') return '오래된 대상';
      if (request.text === 'Missing target') return '없는 대상';
      if (request.text === 'Inactive target') return '비활성 대상';
      if (request.text === 'Validator throws') return '검증기 오류';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const acceptedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'accepted-target',
    text: 'Accepted target',
    renderStrategy: 'window-text',
  });
  records.set(acceptedCommand.itemId, {
    name: 'accepted',
    generation: acceptedCommand.generation,
    current: true,
    decision: true,
  });

  const staleSurface = {};
  orchestrator.markSurfaceChanged(staleSurface);
  const staleCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: staleSurface,
    slotKey: 'stale-target',
    text: 'Stale target',
    renderStrategy: 'window-text',
  });
  records.set(staleCommand.itemId, {
    name: 'stale',
    generation: staleCommand.generation + 1,
    current: true,
    decision: true,
  });

  const missingCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'missing-target',
    text: 'Missing target',
    renderStrategy: 'window-text',
  });

  const inactiveCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'inactive-target',
    text: 'Inactive target',
    renderStrategy: 'window-text',
  });
  records.set(inactiveCommand.itemId, {
    name: 'inactive',
    generation: inactiveCommand.generation,
    current: true,
    active: false,
    decision: true,
  });

  const validatorThrowCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'validator-throws',
    text: 'Validator throws',
    renderStrategy: 'window-text',
  });
  records.set(validatorThrowCommand.itemId, {
    name: 'validator-throws',
    generation: validatorThrowCommand.generation,
    current: 'throws',
    decision: true,
  });

  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    records,
    getRenderGeneration(record) {
      return record.generation;
    },
    isRenderTargetCurrent(record) {
      if (record.current === 'throws') {
        throw new Error('current validator exploded');
      }
      return record.current === true ? true : { reason: 'target-not-current' };
    },
    onRenderQueued(record, command, route) {
      routed.push(['queued', record.name, command.translatedText, route.commandId]);
      return record.decision;
    },
    onRenderAccepted(record, decision, route) {
      routed.push(['accepted', record.name, decision.reason, route.commandId]);
    },
    onRenderRejected(record, decision, route) {
      routed.push(['rejected', record && record.name || 'missing', decision.reason, route.commandId]);
    },
    onMissingRecord(route) {
      misses.push([route.itemId, route.commandId, route.reason]);
    },
  });

  orchestrator.requestItemTranslation(acceptedCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  orchestrator.requestItemTranslation(staleCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  orchestrator.requestItemTranslation(missingCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  orchestrator.requestItemTranslation(inactiveCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  orchestrator.requestItemTranslation(validatorThrowCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  unsubscribe();

  const diagnostics = orchestrator.diagnostics();
  assert.deepEqual(routed, [
    ['queued', 'accepted', '승인 대상', acceptedCommand.id],
    ['accepted', 'accepted', 'accepted', acceptedCommand.id],
    ['rejected', 'stale', 'generation-mismatch', staleCommand.id],
    ['rejected', 'missing', 'missing-adapter-record', missingCommand.id],
    ['rejected', 'inactive', 'inactive-record', inactiveCommand.id],
    ['rejected', 'validator-throws', 'adapter-render-error', validatorThrowCommand.id],
  ]);
  assert.deepEqual(misses, [[missingCommand.itemId, missingCommand.id, 'missing-adapter-record']]);
  assert.equal(diagnostics.render_accepted, 1);
  assert.equal(diagnostics.render_rejected, 4);
  assert.deepEqual(diagnostics.renderQueue.slice(-5).map((entry) => [
    entry.id,
    entry.renderStatus,
    entry.renderReason,
  ]), [
    [acceptedCommand.id, 'accepted', 'accepted'],
    [staleCommand.id, 'rejected', 'generation-mismatch'],
    [missingCommand.id, 'rejected', 'missing-adapter-record'],
    [inactiveCommand.id, 'rejected', 'inactive-record'],
    [validatorThrowCommand.id, 'rejected', 'adapter-render-error'],
  ]);
});

test('orchestrator contains record-backed render missing-record callback errors', () => {
  const records = new Map();
  const routed = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Missing render target') return '없는 렌더 대상';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const command = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'missing-render-target',
    text: 'Missing render target',
    renderStrategy: 'window-text',
  });

  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    records,
    onRenderQueued() {
      routed.push(['queued']);
      return true;
    },
    onRenderRejected(record, decision, route) {
      routed.push(['rejected', record && record.name || 'missing', decision.reason, route.commandId]);
    },
    onMissingRecord() {
      throw new Error('missing callback exploded');
    },
  });

  orchestrator.requestItemTranslation(command.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  unsubscribe();

  const diagnostics = orchestrator.diagnostics();
  assert.deepEqual(routed, [
    ['rejected', 'missing', 'missing-adapter-record', command.id],
  ]);
  assert.ok(diagnostics.recent_events.some((event) => (
    event.type === 'adapterCallbackError'
    && event.reason === 'subscribeRecords.render_queued.missing'
    && event.itemId === command.itemId
  )));
});

test('orchestrator contains record-backed render decision callback errors', () => {
  const records = new Map();
  const routed = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Accepted callback target') return '승인 콜백 대상';
      if (request.text === 'Rejected callback target') return '거부 콜백 대상';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const acceptedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'accepted-callback-target',
    text: 'Accepted callback target',
    renderStrategy: 'window-text',
  });
  const rejectedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'rejected-callback-target',
    text: 'Rejected callback target',
    renderStrategy: 'window-text',
  });
  records.set(acceptedCommand.itemId, {
    name: 'accepted-callback',
    generation: acceptedCommand.generation,
    current: true,
    decision: true,
  });
  records.set(rejectedCommand.itemId, {
    name: 'rejected-callback',
    generation: rejectedCommand.generation,
    current: true,
    decision: false,
  });

  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    records,
    getRenderGeneration(record) {
      return record.generation;
    },
    isRenderTargetCurrent(record) {
      return record.current === true;
    },
    onRenderQueued(record) {
      routed.push(['queued', record.name]);
      return record.decision;
    },
    onRenderAccepted() {
      throw new Error('accepted callback exploded');
    },
    onRenderRejected() {
      throw new Error('rejected callback exploded');
    },
  });

  orchestrator.requestItemTranslation(acceptedCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  orchestrator.requestItemTranslation(rejectedCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  unsubscribe();

  const diagnostics = orchestrator.diagnostics();
  assert.deepEqual(routed, [
    ['queued', 'accepted-callback'],
    ['queued', 'rejected-callback'],
  ]);
  assert.equal(diagnostics.render_accepted, 1);
  assert.equal(diagnostics.render_rejected, 1);
  assert.ok(diagnostics.recent_events.some((event) => (
    event.type === 'adapterCallbackError'
    && event.reason === 'subscribeRecords.render_accepted'
    && event.itemId === acceptedCommand.itemId
  )));
  assert.ok(diagnostics.recent_events.some((event) => (
    event.type === 'adapterCallbackError'
    && event.reason === 'subscribeRecords.render_rejected'
    && event.itemId === rejectedCommand.itemId
  )));
});

test('orchestrator remembers record-backed events on adapter records', async () => {
  const records = new Map();
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Remember render target') return '렌더 기억 대상';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const renderCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'remember-render-target',
    text: 'Remember render target',
    renderStrategy: 'window-text',
  });
  const skippedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'remember-skipped-target',
    text: 'Remember skipped target',
    renderStrategy: 'window-text',
  });
  const failedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'remember-failed-target',
    text: 'Remember failed target',
    renderStrategy: 'window-text',
  });
  records.set(renderCommand.itemId, {
    name: 'render-record',
    generation: renderCommand.generation,
    current: true,
    status: 'detected',
  });
  records.set(skippedCommand.itemId, {
    name: 'skipped-record',
    status: 'detected',
  });
  records.set(failedCommand.itemId, {
    name: 'failed-record',
    status: 'detected',
  });

  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    records,
    getRenderGeneration(record) {
      return record.generation;
    },
    isRenderTargetCurrent(record) {
      return record.current === true;
    },
    onRenderQueued() {
      return true;
    },
    onSkipped() {},
    onFailed() {},
  });

  orchestrator.requestItemTranslation(renderCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  const skippedHandle = orchestrator.requestItemTranslation(skippedCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  assert.equal(await skippedHandle.promise, 'Remember skipped target');
  orchestrator.retireItem(failedCommand.itemId, 'failed', {
    eventType: 'item.failed',
    message: 'adapter failed',
  });
  unsubscribe();

  assert.equal(records.get(renderCommand.itemId).status, 'completed');
  assert.equal(records.get(renderCommand.itemId).lastEventType, 'item.render_queued');
  assert.equal(records.get(skippedCommand.itemId).status, 'skipped');
  assert.equal(records.get(skippedCommand.itemId).lastEventType, 'requestSkipped');
  assert.equal(records.get(skippedCommand.itemId).lastEventReason, 'cache-only-miss');
  assert.equal(records.get(failedCommand.itemId).status, 'failed');
  assert.equal(records.get(failedCommand.itemId).lastEventType, 'item.failed');
  assert.equal(records.get(failedCommand.itemId).lastEventReason, 'adapter failed');
});

test('adapter contract wraps cache-only orchestrator lifecycle for adapter records', async () => {
  const surface = {};
  const records = new Map();
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Contract source') return '계약 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: orchestrator,
  });
  const record = {
    name: 'contract-record',
  };

  const observed = contract.observeRecord(record, {
    kind: 'drawText',
    surface,
    slotKey: 'contract-record',
    text: 'Old contract source',
    renderStrategy: 'window-text',
  }, {}, {
    records,
  });

  assert.equal(observed.itemId.startsWith('item-'), true);
  assert.equal(record.recordId, observed.itemId);
  assert.equal(records.get(observed.itemId), record);
  assert.equal(contract.isRecordObserved(record), true);
  assert.equal(contract.getRecordStatus(record), 'detected');

  const updated = contract.updateItem(record, {
    sourceText: 'Contract source',
    renderStrategy: 'window-text',
  }, {
    eventType: 'item.updated',
    message: 'contract source changed',
  });
  assert.equal(updated.id, observed.itemId);
  assert.equal(contract.requestItemTranslation(record, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  }), true);
  assert.equal(contract.getRecordStatus(record), 'pending');
  assert.equal(contract.isRecordRequestActive(record), true);

  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.active[0].translation, '계약 번역');
  assert.equal(diagnostics.renderQueue.at(-1).translatedText, '계약 번역');

  assert.equal(contract.retireItem(record, 'disappeared', {
    message: 'window removed',
    recordDetached: true,
  }).status, 'disappeared');
  assert.equal(contract.getRecordStatus(record), 'disappeared');
  assert.equal(contract.isRecordActive(record), false);
  assert.equal(contract.updateItem(record, {
    metadata: { detached: true },
  }).id, observed.itemId);

  assert.equal(contract.retireItem(record, 'removed').status, 'removed');
  assert.equal(contract.isRecordActive(record), false);
  assert.equal(contract.requestItemTranslation(record), false);
});

test('adapter contract forwards recordDraw through cache-only lifecycle', () => {
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Contract draw source') return '계약 수신';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: orchestrator,
  });
  const record = { name: 'draw-record' };

  const observed = contract.observeRecord(record, {
    kind: 'drawText',
    surface: {},
    slotKey: 'contract-draw',
    text: 'Contract draw source',
    renderStrategy: 'window-text',
  });
  const rendered = contract.recordDraw(record, 'drawText replay', {
    receivedTranslation: '계약 수신',
    drawnText: '계약 화면',
  });

  const diagnostics = orchestrator.diagnostics();
  assert.equal(observed.itemId, record.recordId);
  assert.equal(rendered.translationReceived, '계약 수신');
  assert.equal(rendered.translationDrawn, '계약 화면');
  assert.equal(contract.getRecordStatus(record), 'completed');
  assert.deepEqual(diagnostics.active[0].history.slice(-1).map((event) => [event.type, event.reason]), [
    ['item.rendered', 'drawText replay'],
  ]);
});

test('adapter contract uses mycode-style ownership payload tokens', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const contract = createAdapterContract({
    adapterId: 'sprite-text',
    defaultHook: 'glyph',
    orchestratorGateway: orchestrator,
  });
  const competingContract = createAdapterContract({
    adapterId: 'bitmap-text',
    defaultHook: 'drawText',
    orchestratorGateway: orchestrator,
  });

  const surfaceClaim = contract.claimSurface({
    target: surface,
    slotKey: 'sprite-surface',
    priority: 50,
    metadata: { reason: 'parent run' },
  });
  assert.equal(surfaceClaim.status, 'claimed');
  assert.equal(surfaceClaim.token.kind, 'surface');
  assert.equal(contract.isContractError({ code: 'RPG_TRANSLATOR_ADAPTER_CONTRACT' }), true);
  assert.equal(isAdapterContractError({ code: 'LIVE_TRANSLATOR_ADAPTER_CONTRACT' }), true);

  const textClaim = contract.claimText({
    target: surface,
    slotKey: 'sprite:glyph',
    text: 'Owned glyph',
    provisional: true,
    priority: 50,
  });
  assert.equal(textClaim.status, 'provisional');
  assert.equal(textClaim.accepted, true);
  assert.equal(textClaim.token.kind, 'text');

  const finalized = contract.finalizeTextClaim(textClaim.token, {
    target: surface,
    slotKey: 'sprite:glyph',
    text: 'Owned glyph',
  });
  assert.equal(finalized.status, 'claimed');

  const competing = competingContract.claimText({
    target: surface,
    slotKey: 'sprite:glyph',
    text: 'Owned glyph',
    priority: 10,
  });
  assert.equal(competing.status, 'denied');

  assert.equal(contract.releaseTextClaim(textClaim.token, 'done'), true);
  assert.equal(contract.releaseSurface(surfaceClaim.token, 'done'), true);
  assert.equal(orchestrator.diagnostics().text_releases, 1);
  assert.equal(orchestrator.diagnostics().surface_releases, 1);
});

test('adapter contract preempts lower-priority provisional ownership', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const bitmapContract = createAdapterContract({
    adapterId: 'bitmap-text',
    defaultHook: 'drawText',
    orchestratorGateway: orchestrator,
  });
  const spriteContract = createAdapterContract({
    adapterId: 'sprite-text',
    defaultHook: 'glyph',
    orchestratorGateway: orchestrator,
  });

  const provisional = bitmapContract.claimText({
    target: surface,
    slotKey: 'bitmap:fallback',
    text: 'Glyph',
    provisional: true,
    priority: 10,
  });
  assert.equal(provisional.status, 'provisional');
  assert.equal(provisional.token.kind, 'text');

  const surfaceClaim = spriteContract.claimSurface({
    target: surface,
    slotKey: 'sprite:parent',
    priority: 50,
  });
  assert.equal(surfaceClaim.status, 'claimed');

  const finalized = bitmapContract.finalizeTextClaim(provisional.token, {
    target: surface,
    slotKey: 'bitmap:fallback',
    text: 'Glyph',
  });
  assert.equal(finalized.status, 'denied');
  assert.equal(finalized.reason, 'stale-claim');
  assert.equal(bitmapContract.releaseTextClaim(provisional.token, 'too late'), false);

  const lowerSurface = bitmapContract.claimSurface({
    target: surface,
    slotKey: 'bitmap:surface',
    priority: 10,
  });
  assert.equal(lowerSurface.status, 'denied');
  assert.equal(lowerSurface.reason, 'surface-owned');
  assert.equal(lowerSurface.ownerAdapter, 'sprite-text');
});

test('adapter contract blocks bitmap fallback glyphs covered by message source ownership', () => {
  const orchestrator = new TextOrchestrator({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const messageContract = createAdapterContract({
    adapterId: 'message',
    defaultHook: 'message',
    orchestratorGateway: orchestrator,
  });
  const bitmapContract = createAdapterContract({
    adapterId: 'bitmap-text',
    defaultHook: 'drawText',
    orchestratorGateway: orchestrator,
  });

  const messageSource = messageContract.claimText({
    target: {},
    slotKey: 'message:block',
    text: 'A hidden message glyph',
    searchText: 'A hidden message glyph',
    mode: 'messageGlyphSource',
    priority: 100,
  });
  assert.equal(messageSource.status, 'claimed');

  const glyphFallback = bitmapContract.claimText({
    target: {},
    slotKey: 'bitmap:glyph',
    text: 'hidden',
    mode: 'bitmapFallback',
    priority: 10,
  });
  assert.equal(glyphFallback.status, 'denied');
  assert.equal(glyphFallback.reason, 'message-glyph-source');
  assert.equal(glyphFallback.ownerAdapter, 'message');
});

test('adapter contract gates observeRecord with finalized ownership tokens', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Owned source') return '소유된 원문';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const bitmapContract = createAdapterContract({
    adapterId: 'bitmap-text',
    defaultHook: 'drawText',
    orchestratorGateway: orchestrator,
  });
  const spriteContract = createAdapterContract({
    adapterId: 'sprite-text',
    defaultHook: 'glyph',
    orchestratorGateway: orchestrator,
  });

  const provisional = bitmapContract.claimText({
    target: surface,
    slotKey: 'bitmap:owned',
    text: 'Owned source',
    provisional: true,
    priority: 20,
  });
  const rejectedRecord = {};
  assert.equal(bitmapContract.observeRecord(rejectedRecord, {
    kind: 'drawText',
    surface,
    slotKey: 'bitmap:owned',
    text: 'Owned source',
    renderStrategy: 'bitmap-text',
  }, {}, {
    ownershipRequired: true,
    ownershipToken: provisional.token,
  }), null);
  assert.equal(bitmapContract.isRecordObserved(rejectedRecord), false);

  const finalized = bitmapContract.finalizeTextClaim(provisional.token, {
    target: surface,
    slotKey: 'bitmap:owned',
    text: 'Owned source',
  });
  assert.equal(finalized.status, 'claimed');

  const acceptedRecord = {};
  const observed = bitmapContract.observeRecord(acceptedRecord, {
    kind: 'drawText',
    surface,
    slotKey: 'bitmap:owned',
    text: 'Owned source',
    renderStrategy: 'bitmap-text',
  }, {}, {
    ownershipRequired: true,
    ownershipToken: provisional.token,
  });
  assert.equal(observed.itemId.startsWith('item-'), true);
  assert.equal(bitmapContract.isRecordObserved(acceptedRecord), true);

  const surfaceClaim = spriteContract.claimSurface({
    target: surface,
    slotKey: 'sprite:preempt',
    priority: 50,
  });
  assert.equal(surfaceClaim.status, 'claimed');

  const preemptedRecord = {};
  assert.equal(bitmapContract.observeRecord(preemptedRecord, {
    kind: 'drawText',
    surface,
    slotKey: 'bitmap:owned-again',
    text: 'Owned source',
    renderStrategy: 'bitmap-text',
  }, {}, {
    ownershipRequired: true,
    ownershipToken: provisional.token,
  }), null);
});

test('adapter contract deduplicates tokenized subscriptions', () => {
  const counts = {
    subscribe: 0,
    surface: 0,
    records: 0,
  };
  const gateway = {
    observeRecord() {
      return { itemId: 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    retireItem() {
      return {};
    },
    subscribe() {
      counts.subscribe += 1;
      return () => {};
    },
    subscribeSurfaceDraws() {
      counts.surface += 1;
      return () => {};
    },
    subscribeRecords() {
      counts.records += 1;
      return () => {};
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });

  assert.equal(contract.subscribe(() => {}, 'same-token'), true);
  assert.equal(contract.subscribe(() => {}, 'same-token'), true);
  assert.equal(contract.subscribe(() => {}, 'other-token'), true);
  assert.equal(counts.subscribe, 2);

  assert.equal(contract.subscribeSurfaceDraws({ token: 'surface-token', onDraw() {} }), true);
  assert.equal(contract.subscribeSurfaceDraws({ token: 'surface-token', onDraw() {} }), true);
  assert.equal(counts.surface, 1);

  assert.equal(contract.subscribeRecords({ token: 'records-token', onRenderQueued() {} }), true);
  assert.equal(contract.subscribeRecords({ token: 'records-token', onRenderQueued() {} }), true);
  assert.equal(counts.records, 1);
});

test('adapter contract contains direct subscribeRecords render callback errors', () => {
  let wrapped = null;
  const gateway = {
    observeRecord(payload) {
      return { itemId: payload.id || 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    subscribe() {
      return () => {};
    },
    subscribeRecords(subscription) {
      wrapped = subscription;
      return () => {};
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });
  const record = {};

  contract.observeRecord(record, {
    id: 'direct-error-record',
    kind: 'drawText',
    surface: {},
    slotKey: 'direct-error-slot',
    text: 'Direct error source',
    renderStrategy: 'window-text',
  });
  assert.equal(contract.subscribeRecords({
    token: 'direct-error-records',
    renderStrategy: 'window-text',
    onRenderQueued() {
      throw new Error('direct render callback exploded');
    },
  }), true);
  assert.equal(typeof wrapped.onRenderQueued, 'function');

  let decision = null;
  assert.doesNotThrow(() => {
    decision = wrapped.onRenderQueued(record, {
      id: 'direct-command',
      itemId: 'direct-error-record',
      strategy: 'window-text',
      text: 'Direct error source',
      generation: 1,
    }, {
      recordId: 'direct-error-record',
      itemId: 'direct-error-record',
      commandId: 'direct-command',
      strategy: 'window-text',
      commandGeneration: 1,
    });
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'adapter-render-error');
  assert.equal(decision.itemId, 'direct-error-record');
  assert.equal(decision.commandId, 'direct-command');
  assert.equal(decision.details.errorMessage, 'direct render callback exploded');
});

test('adapter contract direct subscribeRecords rejects stale render generations', () => {
  let wrapped = null;
  const rendered = [];
  const rejected = [];
  const gateway = {
    observeRecord(payload) {
      return { itemId: payload.id || 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    subscribe() {
      return () => {};
    },
    subscribeRecords(subscription) {
      wrapped = subscription;
      return () => {};
    },
    recordRenderRejected(itemId, decision) {
      rejected.push([itemId, decision.reason, decision.details.targetGeneration, decision.details.commandGeneration]);
      return { status: 'rejected' };
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });
  const record = { generation: 3, current: true };

  contract.observeRecord(record, {
    id: 'direct-stale-record',
    kind: 'drawText',
    surface: {},
    slotKey: 'direct-stale-slot',
    text: 'Direct stale source',
    renderStrategy: 'window-text',
  });
  assert.equal(contract.subscribeRecords({
    token: 'direct-stale-records',
    renderStrategy: 'window-text',
    getRenderGeneration(target) {
      return target.generation;
    },
    isRenderTargetCurrent(target) {
      return target.current === true;
    },
    onRenderQueued(target, command) {
      rendered.push([target === record, command.text]);
      return true;
    },
    onRenderRejected(target, decision) {
      rejected.push(['callback', target === record, decision.reason]);
    },
  }), true);
  assert.equal(typeof wrapped.onRenderQueued, 'function');

  const decision = wrapped.onRenderQueued(record, {
    id: 'direct-stale-command',
    itemId: 'direct-stale-record',
    strategy: 'window-text',
    text: 'Direct stale source',
    generation: 1,
  }, {
    recordId: 'direct-stale-record',
    itemId: 'direct-stale-record',
    commandId: 'direct-stale-command',
    strategy: 'window-text',
    commandGeneration: 1,
  });

  assert.deepEqual(rendered, []);
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'generation-mismatch');
  assert.deepEqual(rejected, [
    ['direct-stale-record', 'generation-mismatch', 3, 1],
    ['callback', true, 'generation-mismatch'],
  ]);
  assert.equal(contract.getRecordStatus(record), 'detected');
});

test('adapter contract maps mycode public methods onto gateway backing subscribe', () => {
  const records = new Map();
  const routed = [];
  let subscribed = null;
  const gateway = {
    observeRecord(payload) {
      return { itemId: payload.id || 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });
  const record = {};

  const observed = contract.observeRecord(record, {
    id: 'fallback-record',
    kind: 'drawText',
    surface: {},
    slotKey: 'fallback-slot',
    text: 'Fallback source',
    renderStrategy: 'window-text',
  }, {}, { records });

  assert.equal(observed.itemId, 'fallback-record');
  assert.equal(contract.hasRequiredMethods(), true);
  assert.equal(contract.hasRequiredMethods(['subscribeRecords']), true);
  assert.equal(contract.subscribeRecords({
    token: 'fallback-records',
    records,
    onSkipped(target, event, route) {
      routed.push([target === record, event.type, route.recordId]);
    },
  }), true);
  assert.equal(typeof subscribed, 'function');

  subscribed({ type: 'item.skipped', id: 'fallback-record', message: 'missing cache' });

  assert.deepEqual(routed, [
    [true, 'item.skipped', 'fallback-record'],
  ]);
  assert.equal(contract.getRecordStatus(record), 'skipped');
});

test('adapter contract fallback subscribeRecords rejects stale render generations', () => {
  const records = new Map();
  const rendered = [];
  const rejected = [];
  const rejectedCallbacks = [];
  let subscribed = null;
  const gateway = {
    observeRecord(payload) {
      return { itemId: payload.id || 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    recordRenderRejected(itemId, decision) {
      rejected.push([itemId, decision.reason, decision.details.targetGeneration, decision.details.commandGeneration]);
      return { status: 'rejected' };
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });
  const record = { generation: 2, current: true };

  contract.observeRecord(record, {
    id: 'fallback-stale-record',
    kind: 'drawText',
    surface: {},
    slotKey: 'fallback-stale-slot',
    text: 'Fallback stale source',
    renderStrategy: 'window-text',
  }, {}, { records });
  assert.equal(contract.subscribeRecords({
    token: 'fallback-stale-records',
    records,
    renderStrategy: 'window-text',
    getRenderGeneration(target) {
      return target.generation;
    },
    isRenderTargetCurrent(target) {
      return target.current === true;
    },
    onRenderQueued(target, command) {
      rendered.push([target === record, command.text]);
      return true;
    },
    onRenderRejected(target, decision) {
      rejectedCallbacks.push([target === record, decision.reason]);
    },
  }), true);

  subscribed({
    type: 'item.render_queued',
    id: 'fallback-stale-record',
    details: {
      id: 'command-stale',
      itemId: 'fallback-stale-record',
      strategy: 'window-text',
      text: 'Fallback stale source',
      generation: 1,
    },
  });

  assert.deepEqual(rendered, []);
  assert.deepEqual(rejected, [
    ['fallback-stale-record', 'generation-mismatch', 2, 1],
  ]);
  assert.deepEqual(rejectedCallbacks, [
    [true, 'generation-mismatch'],
  ]);
  assert.equal(contract.getRecordStatus(record), 'detected');
});

test('adapter contract fallback subscribeRecords requires a current render validator', () => {
  const records = new Map();
  const rendered = [];
  const rejected = [];
  let subscribed = null;
  const gateway = {
    observeRecord(payload) {
      return { itemId: payload.id || 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    recordRenderRejected(itemId, decision) {
      rejected.push([itemId, decision.reason]);
      return { status: 'rejected' };
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });
  const record = { generation: 1 };

  contract.observeRecord(record, {
    id: 'fallback-validator-record',
    kind: 'drawText',
    surface: {},
    slotKey: 'fallback-validator-slot',
    text: 'Fallback validator source',
    renderStrategy: 'window-text',
  }, {}, { records });
  assert.equal(contract.subscribeRecords({
    token: 'fallback-validator-records',
    records,
    renderStrategy: 'window-text',
    getRenderGeneration(target) {
      return target.generation;
    },
    onRenderQueued(target, command) {
      rendered.push([target === record, command.text]);
      return true;
    },
  }), true);

  subscribed({
    type: 'item.render_queued',
    id: 'fallback-validator-record',
    details: {
      id: 'command-validator',
      itemId: 'fallback-validator-record',
      strategy: 'window-text',
      text: 'Fallback validator source',
      generation: 1,
    },
  });

  assert.deepEqual(rendered, []);
  assert.deepEqual(rejected, [
    ['fallback-validator-record', 'missing-current-validator'],
  ]);
  assert.equal(contract.getRecordStatus(record), 'detected');
});

test('adapter contract contains fallback subscribeRecords render callback errors', () => {
  const records = new Map();
  const rejected = [];
  let subscribed = null;
  const gateway = {
    observeRecord(payload) {
      return { itemId: payload.id || 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    recordRenderRejected(itemId, decision) {
      rejected.push([itemId, decision.reason, decision.strategy]);
      return { status: 'rejected' };
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });
  const record = {};

  contract.observeRecord(record, {
    id: 'fallback-error-record',
    kind: 'drawText',
    surface: {},
    slotKey: 'fallback-error-slot',
    text: 'Fallback error source',
    renderStrategy: 'window-text',
  }, {}, { records });
  assert.equal(contract.subscribeRecords({
    token: 'fallback-error-records',
    records,
    renderStrategy: 'window-text',
    getRenderGeneration() {
      return 1;
    },
    isRenderTargetCurrent() {
      return true;
    },
    onRenderQueued() {
      throw new Error('fallback render callback exploded');
    },
  }), true);

  assert.doesNotThrow(() => subscribed({
    type: 'item.render_queued',
    id: 'fallback-error-record',
    details: {
      id: 'command-1',
      itemId: 'fallback-error-record',
      strategy: 'window-text',
      text: 'Fallback error source',
      generation: 1,
    },
  }));
  assert.deepEqual(rejected, [
    ['fallback-error-record', 'adapter-render-error', 'window-text'],
  ]);
});

test('adapter contract contains fallback subscribeRecords record event callback errors', () => {
  const records = new Map();
  let subscribed = null;
  const gateway = {
    observeRecord(payload) {
      return { itemId: payload.id || 'item-1' };
    },
    requestItemTranslation() {
      return true;
    },
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
  };
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: gateway,
  });
  const record = {};

  contract.observeRecord(record, {
    id: 'fallback-record-event-error',
    kind: 'drawText',
    surface: {},
    slotKey: 'fallback-event-error-slot',
    text: 'Fallback event error source',
    renderStrategy: 'window-text',
  }, {}, { records });
  assert.equal(contract.subscribeRecords({
    token: 'fallback-event-error-records',
    records,
    onSkipped() {
      throw new Error('fallback skipped callback exploded');
    },
  }), true);

  assert.doesNotThrow(() => subscribed({
    type: 'item.skipped',
    id: 'fallback-record-event-error',
    message: 'cache miss skipped',
  }));
  assert.equal(contract.getRecordStatus(record), 'skipped');
});

test('adapter contract remembers subscribed render skip and failure events', async () => {
  const records = new Map();
  const events = [];
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Contract subscribed source') return '계약 구독 번역';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const contract = createAdapterContract({
    adapterId: 'window-text',
    defaultHook: 'drawText',
    orchestratorGateway: orchestrator,
  });
  const renderRecord = { name: 'render-record' };
  const skippedRecord = { name: 'skipped-record' };
  const failedRecord = { name: 'failed-record' };

  const renderObserved = contract.observeRecord(renderRecord, {
    kind: 'drawText',
    surface: {},
    slotKey: 'contract-subscribed-render',
    text: 'Old subscribed source',
    renderStrategy: 'window-text',
  }, {}, { records });
  const skippedObserved = contract.observeRecord(skippedRecord, {
    kind: 'drawText',
    surface: {},
    slotKey: 'contract-subscribed-skip',
    text: 'Missing subscribed source',
    renderStrategy: 'window-text',
  }, {}, { records });
  const failedObserved = contract.observeRecord(failedRecord, {
    kind: 'drawText',
    surface: {},
    slotKey: 'contract-subscribed-fail',
    text: 'Failed subscribed source',
    renderStrategy: 'window-text',
  }, {}, { records });
  renderRecord.generation = renderObserved.generation;
  renderRecord.current = true;

  assert.equal(contract.subscribeRecords({
    renderStrategy: 'window-text',
    records,
    getRenderGeneration(record) {
      return record.generation;
    },
    isRenderTargetCurrent(record) {
      return record.current === true;
    },
    onRenderQueued(record, command) {
      events.push(['queued', record.name, command.translatedText]);
      return true;
    },
    onSkipped(record, event, route) {
      events.push(['skipped', record.name, event.type, route.reason]);
    },
    onFailed(record, event, route) {
      events.push(['failed', record.name, event.type, route.reason]);
    },
  }), true);

  contract.updateItem(renderRecord, {
    sourceText: 'Contract subscribed source',
    renderStrategy: 'window-text',
  });
  assert.equal(contract.requestItemTranslation(renderRecord, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  }), true);
  assert.equal(contract.getRecordStatus(renderRecord), 'completed');
  assert.equal(contract.isRecordRequestActive(renderRecord), false);

  assert.equal(contract.requestItemTranslation(skippedRecord, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  }), true);
  assert.equal(contract.getRecordStatus(skippedRecord), 'skipped');
  assert.equal(contract.isRecordRequestActive(skippedRecord), false);

  orchestrator.retireItem(failedObserved.itemId, 'failed', {
    eventType: 'item.translation_noop',
    message: 'cache-only noop',
  });
  assert.equal(contract.getRecordStatus(failedRecord), 'failed');
  assert.equal(contract.isRecordRequestActive(failedRecord), false);
  assert.deepEqual(events, [
    ['queued', 'render-record', '계약 구독 번역'],
    ['skipped', 'skipped-record', 'requestSkipped', 'cache-only-miss'],
    ['failed', 'failed-record', 'item.translation_noop', 'cache-only noop'],
  ]);
  assert.equal(records.get(renderObserved.itemId), renderRecord);
  assert.equal(records.get(skippedObserved.itemId), skippedRecord);
  assert.equal(records.get(failedObserved.itemId), failedRecord);
});

test('orchestrator exposes cache-only adapter lifecycle and eligibility APIs', () => {
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Lifecycle target') return '수명주기 대상';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const command = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'lifecycle-target',
    text: 'Lifecycle target',
    renderStrategy: 'window-text',
  });

  assert.equal(orchestrator.setItemTranslationPriority(command.itemId, 250, 'visible-redetected'), true);
  assert.equal(orchestrator.setItemVisibility(command.itemId, false, {
    reason: 'window-hidden',
    screenState: 'hidden',
  }).visible, false);
  assert.equal(orchestrator.backgroundItem(command.itemId, {
    reason: 'message-window-closed',
    priority: 100,
  }).backgrounded, true);
  assert.equal(orchestrator.recordDecision(command.itemId, 'redraw', 'drawTextEx fallback', {
    strategy: 'messageRedraw',
  }).id, command.itemId);
  assert.deepEqual(orchestrator.describeTextEligibility({ text: '' }), {
    eligible: false,
    skip: true,
    category: 'empty',
    reason: 'emptyInput',
    sourceHint: 'policy',
    providerEligible: false,
    providerCategory: 'empty',
    providerReason: 'emptyInput',
    providerSourceHint: 'policy',
    text: '',
    normalizedText: '',
    details: {
      category: 'empty',
      reason: 'emptyInput',
      providerEligible: false,
      providerCategory: 'empty',
      providerReason: 'emptyInput',
      hasText: false,
    },
  });
  assert.equal(orchestrator.describeTextEligibility({
    text: 'Chapter One',
    visibleText: 'Chapter One',
  }).eligible, true);

  assert.equal(orchestrator.retireItem(command.itemId, 'disappeared', {
    message: 'window removed',
  }).status, 'disappeared');
  const diagnostics = orchestrator.diagnostics();
  assert.equal(diagnostics.active_items, 0);
  assert.equal(diagnostics.archived_items, 1);
  assert.equal(diagnostics.archived[0].priority, 100);
  assert.equal(diagnostics.archived[0].visible, false);
  assert.equal(diagnostics.archived[0].screenState, 'background');
  assert.equal(diagnostics.archived[0].backgrounded, true);
  assert.equal(diagnostics.render_rejected, 1);
  assert.deepEqual(diagnostics.renderQueue.slice(-1).map((entry) => [
    entry.id,
    entry.renderStatus,
    entry.renderReason,
  ]), [[command.id, 'rejected', 'window removed']]);
  assert.deepEqual(diagnostics.recent_events.slice(-6).map((event) => [event.type, event.reason]), [
    ['item.priority_changed', 'visible-redetected'],
    ['item.hidden', 'window-hidden'],
    ['item.backgrounded', 'message-window-closed'],
    ['decision.redraw', 'drawTextEx fallback'],
    ['renderRejected', 'window removed'],
    ['item.disappeared', 'window removed'],
  ]);
});

test('orchestrator routes record-backed skipped and failed lifecycle events', async () => {
  const records = new Map();
  const events = [];
  const orchestrator = new TextOrchestrator({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const skippedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'skipped-target',
    text: 'Skipped target',
    renderStrategy: 'window-text',
  });
  const failedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'failed-target',
    text: 'Failed target',
    renderStrategy: 'window-text',
  });
  records.set(skippedCommand.itemId, { name: 'skipped', status: 'detected' });
  records.set(failedCommand.itemId, { name: 'failed', status: 'detected' });

  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    records,
    onSkipped(record, event, route) {
      events.push(['skipped', record.name, event.type, route.reason]);
    },
    onFailed(record, event, route) {
      events.push(['failed', record.name, event.type, route.reason]);
    },
  });

  const handle = orchestrator.requestItemTranslation(skippedCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  assert.equal(handle.getStatus(), 'miss');
  assert.equal(await handle.promise, 'Skipped target');
  orchestrator.retireItem(failedCommand.itemId, 'failed', {
    eventType: 'item.failed',
    message: 'adapter failed',
  });
  unsubscribe();

  assert.deepEqual(events, [
    ['skipped', 'skipped', 'requestSkipped', 'cache-only-miss'],
    ['failed', 'failed', 'item.failed', 'adapter failed'],
  ]);
});

test('orchestrator contains record-backed lifecycle callback errors', async () => {
  const records = new Map();
  const events = [];
  const orchestrator = new TextOrchestrator({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  const skippedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'resolve-error-target',
    text: 'Resolve error target',
    renderStrategy: 'window-text',
  });
  const failedCommand = orchestrator.observeRecord({
    adapter: 'window-text',
    kind: 'drawText',
    surface: {},
    slotKey: 'failed-after-error-target',
    text: 'Failed after error target',
    renderStrategy: 'window-text',
  });
  records.set(failedCommand.itemId, { name: 'failed', status: 'detected' });

  const unsubscribe = orchestrator.subscribeRecords({
    renderStrategy: 'window-text',
    records,
    resolveRecord(recordId) {
      if (recordId === skippedCommand.itemId) {
        throw new Error('resolve exploded');
      }
      return records.get(recordId) || null;
    },
    onSkipped() {
      events.push(['skipped']);
    },
    onFailed(record, event, route) {
      events.push(['failed', record.name, event.type, route.reason]);
    },
    onMissingRecord() {
      events.push(['missing']);
    },
  });

  const handle = orchestrator.requestItemTranslation(skippedCommand.itemId, {
    renderStrategy: 'window-text',
    sourceHint: 'cache-only',
  });
  assert.equal(handle.getStatus(), 'miss');
  assert.equal(await handle.promise, 'Resolve error target');
  orchestrator.retireItem(failedCommand.itemId, 'failed', {
    eventType: 'item.failed',
    message: 'adapter failed',
  });
  unsubscribe();

  const diagnostics = orchestrator.diagnostics();
  assert.deepEqual(events, [
    ['failed', 'failed', 'item.failed', 'adapter failed'],
  ]);
  assert.ok(diagnostics.recent_events.some((event) => (
    event.type === 'adapterCallbackError'
    && event.reason === 'subscribeRecords.skipped.resolveRecord'
    && event.itemId === skippedCommand.itemId
  )));
});

test('orchestrator defers surface draws to candidate adapter subscriptions', () => {
  const bitmap = {};
  const events = [];
  const orchestrator = new TextOrchestrator({ translate: () => null });
  const unsubscribe = orchestrator.subscribeSurfaceDraws((event) => {
    events.push([
      event.type,
      event.adapterId,
      event.sourceAdapter,
      event.status,
      event.payload.text,
      event.payload.x,
    ]);
    return { action: 'replace', text: 'Glyph KO', reason: 'cache-hit' };
  }, { adapterId: 'sprite-text' });

  const result = orchestrator.recordSurfaceDraw({
    target: bitmap,
    adapterId: 'bitmap-text',
    text: 'Glyph JP',
    x: 12,
    y: 4,
    maxWidth: 80,
    lineHeight: 24,
    align: 'center',
    candidateAdapters: ['sprite-text'],
  });
  unsubscribe();

  assert.equal(result.status, 'deferred');
  assert.equal(result.ownerAdapter, 'bitmap-text');
  assert.equal(result.reason, 'deferred-to-owner-candidate');
  assert.deepEqual(result.drawDecision, {
    action: 'replace-native-draw',
    text: 'Glyph KO',
    x: NaN,
    y: NaN,
    maxWidth: NaN,
    lineHeight: NaN,
    align: '',
    reason: 'cache-hit',
  });
  assert.deepEqual(events, [
    ['surface.draw', 'sprite-text', 'bitmap-text', 'deferred', 'Glyph JP', 12],
  ]);
});

test('orchestrator releases surface ownership explicitly', () => {
  const surface = {};
  const orchestrator = new TextOrchestrator({ translate: () => null });

  assert.equal(orchestrator.claimSurface(surface, 'window-text'), true);
  assert.equal(orchestrator.claimSurface(surface, 'bitmap-text'), false);
  assert.equal(orchestrator.releaseSurface(surface, 'other-owner'), false);
  assert.equal(orchestrator.releaseSurface(surface, 'window-text'), true);
  assert.equal(orchestrator.claimSurface(surface, 'bitmap-text'), true);
  assert.equal(orchestrator.diagnostics().ownership_conflicts, 1);
  assert.equal(orchestrator.diagnostics().surface_claims, 2);
  assert.equal(orchestrator.diagnostics().surface_releases, 1);
});

test('message wrapper preserves escapes and wraps soft lines by capacity', () => {
  assert.deepEqual(
    MessageWrapper.wrap('\\C[3]Emma\\C[0] has a very long thought', { capacity: 12 }),
    ['\\C[3]Emma\\C[0] has a', 'very long', 'thought'],
  );
  assert.deepEqual(
    MessageWrapper.wrap('아이콘 \\I[12] 테스트', { capacity: 10 }),
    ['아이콘 \\I[12]', '테스트'],
  );
});

test('message wrapper avoids plugin soft wraps in one-line message windows', () => {
  const oneLineWindow = {
    contents: { height: 24 },
    lineHeight() { return 24; },
    contentsWidth() { return 60; },
    textWidth(text) { return String(text).length * 10; },
  };

  assert.deepEqual(
    MessageWrapper.wrap('This translated line would normally wrap', { window: oneLineWindow }),
    ['This translated line would normally wrap'],
  );
});

test('message wrapper derives capacity from contents bitmap metrics', () => {
  const messageWindow = {
    contents: {
      width: 60,
      height: 48,
      measureTextWidth(text) { return String(text).length * 10; },
    },
    lineHeight() { return 24; },
  };

  assert.deepEqual(
    MessageWrapper.wrap('alpha beta gamma', { window: messageWindow }),
    ['alpha', 'beta', 'gamma'],
  );
});

test('message wrapper uses contents font size when lineHeight is unavailable', () => {
  const oneLineWindow = {
    contents: {
      width: 60,
      height: 27,
      fontSize: 20,
      measureTextWidth(text) { return String(text).length * 10; },
    },
  };

  assert.deepEqual(
    MessageWrapper.wrap('alpha beta gamma', { window: oneLineWindow }),
    ['alpha beta gamma'],
  );
});

test('message wrapper treats multi-letter RPG Maker escapes as one zero-width token', () => {
  assert.deepEqual(
    MessageWrapper.wrap('\\MSG[12] Alpha beta', { capacity: 6 }),
    ['\\MSG[12] Alpha', 'beta'],
  );
});

test('message wrapper preserves form-feed page breaks inside the rendered line', () => {
  assert.deepEqual(
    MessageWrapper.wrap('Alpha\fBeta', { capacity: 20 }),
    ['Alpha\fBeta'],
  );
});

test('message wrapper uses window textWidth for soft wrap decisions', () => {
  const messageWindow = {
    contents: { width: 60, height: 96 },
    lineHeight() { return 24; },
    textWidth(text) {
      if (text === 'W') return 30;
      return String(text).length * 10;
    },
  };

  assert.deepEqual(
    MessageWrapper.wrap('WWW x', { window: messageWindow }),
    ['WW', 'W x'],
  );
});

test('message wrapper applies font-size escapes before measuring following text', () => {
  let scale = 1;
  const messageWindow = {
    contents: { width: 60, height: 96 },
    lineHeight() { return 24; },
    makeFontBigger() { scale = 2; },
    makeFontSmaller() { scale = 1; },
    textWidth(text) { return String(text).length * 10 * scale; },
  };

  assert.deepEqual(
    MessageWrapper.wrap('\\{abc d', { window: messageWindow }),
    ['\\{abc', 'd'],
  );
});

test('message wrapper restores font settings after measured wrapping', () => {
  let scale = 1;
  const messageWindow = {
    contents: { width: 60, height: 96 },
    lineHeight() { return 24; },
    resetFontSettings() { scale = 1; },
    makeFontBigger() { scale = 2; },
    textWidth(text) { return String(text).length * 10 * scale; },
  };

  assert.deepEqual(
    MessageWrapper.wrap('\\{abc d', { window: messageWindow }),
    ['\\{abc', 'd'],
  );
  assert.equal(scale, 1);
});

test('message wrapper resets font settings after a message page break', () => {
  let scale = 1;
  const messageWindow = {
    contents: { width: 80, height: 96 },
    lineHeight() { return 24; },
    resetFontSettings() { scale = 1; },
    makeFontBigger() { scale = 2; },
    textWidth(text) { return String(text).length * 10 * scale; },
  };

  assert.deepEqual(
    MessageWrapper.wrap('\\{ab\fabc d', { window: messageWindow }),
    ['\\{ab\fabc d'],
  );
});

test('message wrapper accounts for message start x when measuring wrap width', () => {
  const messageWindow = {
    contents: { width: 100, height: 96 },
    lineHeight() { return 24; },
    newLineX() { return 40; },
    textWidth(text) { return String(text).length * 10; },
  };

  assert.deepEqual(
    MessageWrapper.wrap('abcdefg', { window: messageWindow }),
    ['abcdef', 'g'],
  );
});

test('message wrapper falls back to text padding for message start x', () => {
  const messageWindow = {
    contents: { width: 100, height: 96 },
    lineHeight() { return 24; },
    textPadding() { return 40; },
    textWidth(text) { return String(text).length * 10; },
  };

  assert.deepEqual(
    MessageWrapper.wrap('abcdefg', { window: messageWindow }),
    ['abcdef', 'g'],
  );
});

test('startup toast appears once and auto-dismisses', () => {
  const removed = [];
  const body = { appended: [], appendChild(node) { this.appended.push(node); } };
  const document = {
    body,
    createElement(tag) {
      return {
        tag,
        textContent: '',
        style: {},
        remove() {
          removed.push(this.textContent);
        },
      };
    },
  };
  const timers = [];
  const toast = new StartupToast({
    document,
    setTimeout(fn) {
      timers.push(fn);
    },
  });

  toast.show({ startup_toast_text: 'RPG-Translator 작동중' });
  toast.show({ startup_toast_text: 'RPG-Translator 작동중' });
  timers[0]();

  assert.equal(body.appended.length, 1);
  assert.equal(body.appended[0].textContent, 'RPG-Translator 작동중');
  assert.deepEqual(removed, ['RPG-Translator 작동중']);
});

test('message and window adapters translate cache hits in synthetic RPG Maker harness', () => {
  const index = {
    translate({ text }) {
      if (text === '\\C[1]こんにちは') return '\\C[1]안녕';
      if (text === '世界') return '세계';
      return null;
    },
  };
  const calls = [];
  const root = {
    $gameMessage: {
      _texts: ['\\C[1]こんにちは'],
    },
    Window_Message: function WindowMessage() {},
    Window_Base: function WindowBase() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {
    calls.push(['startMessage', root.$gameMessage._texts[0]]);
  };
  root.Window_Base.prototype.drawText = function drawText(text, x, y, width) {
    calls.push(['drawText', text, x, y, width]);
  };
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text, x, y) {
    calls.push(['drawTextEx', text, x, y]);
    return text.length;
  };

  MessageAdapter.install(root, index);
  WindowTextAdapter.install(root, index);

  new root.Window_Message().startMessage();
  const base = new root.Window_Base();
  base.drawText('世界', 1, 2, 3);
  const drawTextExResult = base.drawTextEx('missing', 4, 5);

  assert.deepEqual(calls, [
    ['startMessage', '\\C[1]안녕'],
    ['drawText', '세계', 1, 2, 3],
    ['drawTextEx', 'missing', 4, 5],
  ]);
  assert.equal(drawTextExResult, 'missing'.length);
});

test('window text adapter bypasses dedicated message windows', () => {
  const index = {
    translate({ text }) {
      if (text === 'Message JP') return 'Message KO';
      return null;
    },
  };
  const calls = [];
  const root = {
    Window_Base: function WindowBase() {},
    Window_Message: function WindowMessage() {},
  };
  root.Window_Base.prototype.drawText = function drawText(text) {
    calls.push(text);
  };
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) {
    calls.push(text);
    return text.length;
  };
  root.Window_Message.prototype = Object.create(root.Window_Base.prototype);
  root.Window_Message.prototype.constructor = root.Window_Message;

  WindowTextAdapter.install(root, index);
  const messageWindow = new root.Window_Message();
  messageWindow.drawText('Message JP');

  assert.deepEqual(calls, ['Message JP']);
});

test('window text adapter retires entries when window contents are mutated', () => {
  const index = {
    translate({ text }) {
      if (text === 'Menu JP') return 'Menu KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Window_Base: function WindowBase() {
      this.contents = {
        clear() {
          calls.push(['contents-clear']);
        },
      };
    },
  };
  root.Window_Base.prototype.drawText = function drawText(text, x, y) {
    calls.push(['drawText', text, x, y]);
  };
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) {
    calls.push(['drawTextEx', text]);
    return text.length;
  };

  WindowTextAdapter.install(root, orchestrator);
  const windowInstance = new root.Window_Base();
  windowInstance.drawText('Menu JP', 1, 2);

  assert.deepEqual(calls, [['drawText', 'Menu KO', 1, 2]]);
  assert.equal(orchestrator.diagnostics().active_items, 1);

  windowInstance.contents.clear();

  assert.deepEqual(calls, [['drawText', 'Menu KO', 1, 2], ['contents-clear']]);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.claimSurface(windowInstance, 'bitmap-text'), true);
  assert.equal(
    orchestrator.claimText(`window:${windowInstance.__rpgTranslatorWindowTextState.windowId}:drawText:1:2::`, 'bitmap-text:slot'),
    true,
  );
});

test('window text adapter retires entries when window contents are recreated', () => {
  const index = {
    translate({ text }) {
      if (text === 'Recreate Menu JP') return 'Recreate Menu KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Window_Base: function WindowBase() {
      this.contents = {};
    },
  };
  root.Window_Base.prototype.drawText = function drawText(text, x, y) {
    calls.push(['drawText', text, x, y]);
  };
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) {
    calls.push(['drawTextEx', text]);
    return text.length;
  };
  root.Window_Base.prototype.createContents = function createContents() {
    this.contents = {};
    calls.push(['createContents']);
  };

  WindowTextAdapter.install(root, orchestrator);
  const windowInstance = new root.Window_Base();
  windowInstance.drawText('Recreate Menu JP', 3, 4);

  assert.deepEqual(calls, [['drawText', 'Recreate Menu KO', 3, 4]]);
  assert.equal(orchestrator.diagnostics().active_items, 1);

  windowInstance.createContents();

  assert.deepEqual(calls, [['drawText', 'Recreate Menu KO', 3, 4], ['createContents']]);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.claimSurface(windowInstance, 'bitmap-text'), true);
  assert.equal(
    orchestrator.claimText(`window:${windowInstance.__rpgTranslatorWindowTextState.windowId}:drawText:3:4::`, 'bitmap-text:slot'),
    true,
  );
});

test('window text adapter respects ownership and stale render rejection', () => {
  const staleIndex = {
    translate({ text }) {
      if (text === 'Stale JP') return 'Stale KO';
      return null;
    },
  };
  const staleOrchestrator = new TextOrchestrator(staleIndex, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const staleTranslator = Object.create(staleOrchestrator);
  staleTranslator.observeRecord = (request) => {
    const command = staleOrchestrator.observeRecord(request);
    staleOrchestrator.markSurfaceChanged(request.surface);
    return command;
  };
  staleTranslator.acceptRender = (...args) => staleOrchestrator.acceptRender(...args);
  staleTranslator.claimSurface = (...args) => staleOrchestrator.claimSurface(...args);
  staleTranslator.claimText = (...args) => staleOrchestrator.claimText(...args);
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Window_Base: function WindowBase() {},
  };
  root.Window_Base.prototype.drawText = function drawText(text) {
    this.lastText = text;
  };
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) {
    this.lastText = text;
    return text.length;
  };

  WindowTextAdapter.install(root, staleTranslator);
  const staleWindow = new root.Window_Base();
  staleWindow.drawText('Stale JP', 1, 2);
  assert.equal(staleWindow.lastText, 'Stale JP');
  assert.equal(staleOrchestrator.diagnostics().render_rejected, 1);

  const ownedOrchestrator = new TextOrchestrator(staleIndex, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const otherRoot = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Window_Base: function OtherBase() {},
  };
  otherRoot.Window_Base.prototype.drawText = function drawText(text) { this.lastText = text; };
  otherRoot.Window_Base.prototype.drawTextEx = function drawTextEx(text) { this.lastText = text; return text.length; };
  WindowTextAdapter.install(otherRoot, ownedOrchestrator);
  const conflictWindow = new otherRoot.Window_Base();
  assert.equal(ownedOrchestrator.claimSurface(conflictWindow, 'bitmap-text'), true);
  conflictWindow.drawText('Stale JP', 1, 2);
  assert.equal(conflictWindow.lastText, 'Stale JP');
  assert.equal(ownedOrchestrator.diagnostics().active_items, 0);
});

test('window text adapter defers hidden window cache hits until ready', () => {
  const index = {
    translate({ text }) {
      if (text === 'Hidden JP') return 'Hidden KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Window_Base: function WindowBase() {
      this.visible = false;
      this.openness = 0;
      this.contents = {};
    },
  };
  root.Window_Base.prototype.drawText = function drawText(text, x, y, width, align) {
    calls.push(['drawText', text, x, y, width, align]);
  };
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) {
    calls.push(['drawTextEx', text]);
    return text.length;
  };
  root.Window_Base.prototype.update = function update() {
    calls.push(['update']);
  };

  WindowTextAdapter.install(root, orchestrator);
  const hiddenWindow = new root.Window_Base();
  hiddenWindow.drawText('Hidden JP', 1, 2, 80, 'center');

  assert.deepEqual(calls, [
    ['drawText', 'Hidden JP', 1, 2, 80, 'center'],
  ]);
  assert.equal(orchestrator.diagnostics().render_accepted, 0);

  hiddenWindow.visible = true;
  hiddenWindow.openness = 255;
  hiddenWindow.update();

  assert.deepEqual(calls, [
    ['drawText', 'Hidden JP', 1, 2, 80, 'center'],
    ['update'],
    ['drawText', 'Hidden KO', 1, 2, 80, 'center'],
  ]);
  assert.equal(orchestrator.diagnostics().render_accepted, 1);
});

test('message adapter translates joined message blocks instead of individual 401 lines', () => {
  const requests = [];
  const index = {
    translate(request) {
      requests.push(request.text);
      if (request.text === 'Line one\nLine two') return '첫 줄\n둘째 줄';
      if (request.text === 'Line one') return 'LINE SHOULD NOT BE USED';
      return null;
    },
  };
  const calls = [];
  const root = {
    $gameMessage: {
      _texts: ['Line one', 'Line two'],
      allText() {
        return this._texts.join('\n');
      },
    },
    Window_Message: function WindowMessage() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {
    calls.push(this.constructor.name, root.$gameMessage._texts.slice());
  };

  MessageAdapter.install(root, index);
  new root.Window_Message().startMessage();

  assert.deepEqual(requests, ['Line one\nLine two']);
  assert.deepEqual(root.$gameMessage._texts, ['첫 줄', '둘째 줄']);
  assert.deepEqual(calls, ['WindowMessage', ['첫 줄', '둘째 줄']]);
});

test('message adapter wraps translated blocks when line counts differ', () => {
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    $gameMessage: { _texts: ['short', 'block'] },
    Window_Message: function WindowMessage() {},
  };
  const calls = [];
  root.Window_Message.prototype.contentsWidth = () => 120;
  root.Window_Message.prototype.textWidth = () => 10;
  root.Window_Message.prototype.startMessage = function startMessage() {
    calls.push(root.$gameMessage._texts.slice());
  };
  const translator = {
    translateText(request) {
      if (request.text === 'short\nblock') return 'A translated sentence that wraps';
      return null;
    },
  };

  MessageAdapter.install(root, translator);
  new root.Window_Message().startMessage();

  assert.deepEqual(calls, [['A translated', 'sentence', 'that wraps']]);
});

test('message adapter retires active message item when Game_Message.clear runs', () => {
  const clearCalls = [];
  function GameMessage() {
    this._texts = ['Message JP'];
    this.cleared = false;
  }
  GameMessage.prototype.clear = function clear() {
    this.cleared = true;
    this._texts = [];
  };
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      foresightScanner: {
        clearSnapshot(reason) {
          clearCalls.push(reason || '');
        },
      },
    },
    $gameMessage: new GameMessage(),
    Game_Message: GameMessage,
    Window_Message: function WindowMessage() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  const index = new LookupIndex({
    manifest: { schema_version: 1, key_schema_version: 'v1', source_language: 'ja', target_language: 'ko' },
    records: [
      {
        cache_key: CacheKeyBuilder.build({
          engine: 'mz',
          sourceLanguage: 'ja',
          targetLanguage: 'ko',
          normalizedText: 'Message JP',
          controlCodeSignature: '',
          contextHash: null,
        }),
        source_text_id: 10,
        source_hash: '1'.repeat(64),
        source_language: 'ja',
        target_language: 'ko',
        normalized_text: 'Message JP',
        visible_text: 'Message JP',
        translation: 'Message KO',
        control_code_signature: '',
        context_hash: null,
      },
    ],
  });
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.startMessage();
  assert.deepEqual(root.$gameMessage._texts, ['Message KO']);
  assert.equal(orchestrator.diagnostics().active_items, 1);

  root.$gameMessage.clear();
  assert.equal(root.$gameMessage.cleared, true);
  assert.deepEqual(clearCalls, ['game-message-clear']);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.diagnostics().surface_releases, 1);
  assert.equal(orchestrator.diagnostics().text_releases, 1);
});

test('message adapter exposes processCompleteMessage for completed payload translation', () => {
  const requests = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    $gameMessage: { _texts: ['Complete JP'] },
    Window_Message: function WindowMessage() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      requests.push(request.text);
      if (request.text === 'Complete JP') return 'Complete KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  assert.equal(typeof messageWindow.processCompleteMessage, 'function');

  messageWindow.processCompleteMessage({
    visible: 'Complete JP',
    resolved: 'Complete JP',
    translationSource: 'Complete JP',
  }, 7);

  assert.deepEqual(requests, ['Complete JP']);
  assert.deepEqual(root.$gameMessage._texts, ['Complete KO']);
  assert.equal(orchestrator.diagnostics().active_items, 1);
});

test('message adapter redraws completed messages through drawTextEx fallback', () => {
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    $gameMessage: { _texts: ['Rendered JP'] },
    Window_Message: function WindowMessage() {
      this.visible = true;
      this.contents = {
        clear() {
          calls.push(['clear']);
        },
      };
    },
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Message.prototype.isOpen = () => true;
  root.Window_Message.prototype.resetFontSettings = function resetFontSettings() {
    calls.push(['resetFontSettings']);
  };
  root.Window_Message.prototype.drawTextEx = function drawTextEx(text, x, y) {
    calls.push(['drawTextEx', text, x, y]);
    return text.length;
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Rendered JP') return 'Rendered KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.processCompleteMessage({
    visible: 'Rendered JP',
    resolved: 'Rendered JP',
    translationSource: 'Rendered JP',
  }, 'session-1');

  assert.deepEqual(calls, [
    ['clear'],
    ['resetFontSettings'],
    ['drawTextEx', 'Rendered KO', 0, 0],
  ]);
  assert.equal(orchestrator.diagnostics().render_accepted, 1);
});

test('message adapter redraws message faces before fallback text', () => {
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    $gameMessage: { _texts: ['Face JP'] },
    Window_Message: function WindowMessage() {
      this.visible = true;
      this.contents = {
        clear() {
          calls.push(['clear']);
        },
      };
    },
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Message.prototype.isOpen = () => true;
  root.Window_Message.prototype.resetFontSettings = function resetFontSettings() {
    calls.push(['resetFontSettings']);
  };
  root.Window_Message.prototype.drawMessageFace = function drawMessageFace() {
    calls.push(['drawMessageFace']);
  };
  root.Window_Message.prototype.drawTextEx = function drawTextEx(text, x, y) {
    calls.push(['drawTextEx', text, x, y]);
    return text.length;
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Face JP') return 'Face KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.processCompleteMessage({
    visible: 'Face JP',
    resolved: 'Face JP',
    translationSource: 'Face JP',
  }, 'session-face');

  assert.deepEqual(calls, [
    ['clear'],
    ['resetFontSettings'],
    ['drawMessageFace'],
    ['drawTextEx', 'Face KO', 0, 0],
  ]);
});

test('message adapter applies and restores fallback text scale', () => {
  const calls = [];
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      config: { gameMessage: { textScale: 50 } },
    },
    $gameMessage: { _texts: ['Scale JP'] },
    Window_Message: function WindowMessage() {
      this.visible = true;
      this.contents = {
        fontSize: 20,
        clear() {
          calls.push(['clear', this.fontSize]);
        },
      };
    },
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Message.prototype.isOpen = () => true;
  root.Window_Message.prototype.resetFontSettings = function resetFontSettings() {
    calls.push(['resetFontSettings', this.contents.fontSize]);
  };
  root.Window_Message.prototype.drawTextEx = function drawTextEx(text, x, y) {
    calls.push(['drawTextEx', text, x, y, this.contents.fontSize]);
    return text.length;
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Scale JP') return 'Scale KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.processCompleteMessage({
    visible: 'Scale JP',
    resolved: 'Scale JP',
    translationSource: 'Scale JP',
  }, 'session-scale');

  assert.deepEqual(calls, [
    ['clear', 20],
    ['resetFontSettings', 20],
    ['drawTextEx', 'Scale KO', 0, 0, 10],
  ]);
  assert.equal(messageWindow.contents.fontSize, 20);
});

test('message adapter reapplies text scale after native replay recreates contents', () => {
  const calls = [];
  const renderedFonts = [];
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      config: { gameMessage: { textScale: 50 } },
    },
    $gameMessage: { _texts: ['Recreate JP'] },
    Window_Message: function WindowMessage() {
      this.visible = true;
      this.contents = { fontSize: 20 };
      this.pause = false;
      this._waitCount = 0;
    },
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Message.prototype.isOpen = () => true;
  root.Window_Message.prototype.createContents = function createContents() {
    this.contents = { fontSize: 20 };
    calls.push(['createContents', this.contents.fontSize]);
  };
  root.Window_Message.prototype.createTextState = function createTextState(text, x, y) {
    return { text, index: 0, x, y, startX: x, startY: y };
  };
  root.Window_Message.prototype.newPage = function newPage(textState) {
    this.createContents();
    calls.push(['newPage', textState.text, this.contents.fontSize]);
  };
  root.Window_Message.prototype.processCharacter = function processCharacter(textState) {
    renderedFonts.push(this.contents.fontSize);
    textState.index += 1;
  };
  root.Window_Message.prototype.isEndOfText = function isEndOfText(textState) {
    return textState.index >= textState.text.length;
  };
  root.Window_Message.prototype.onEndOfText = function onEndOfText() {
    calls.push(['onEndOfText', this.contents.fontSize]);
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Recreate JP') return 'Recreate KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.processCompleteMessage({
    visible: 'Recreate JP',
    resolved: 'Recreate JP',
    translationSource: 'Recreate JP',
  }, 'session-recreate');

  assert.deepEqual(calls, [
    ['createContents', 20],
    ['newPage', 'Recreate KO', 10],
    ['onEndOfText', 10],
  ]);
  assert.deepEqual([...new Set(renderedFonts)], [10]);
  assert.equal(messageWindow.contents.fontSize, 20);
});

test('message adapter prefers native message replay when engine hooks are available', () => {
  const calls = [];
  const rendered = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    $gameMessage: { _texts: ['Native JP'] },
    Window_Message: function WindowMessage() {
      this.visible = true;
      this.contents = {};
      this.pause = false;
      this._waitCount = 0;
    },
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Message.prototype.isOpen = () => true;
  root.Window_Message.prototype.createTextState = function createTextState(text, x, y) {
    calls.push(['createTextState', text, x, y]);
    return { text, index: 0, x, y, startX: x, startY: y };
  };
  root.Window_Message.prototype.newPage = function newPage(textState) {
    calls.push(['newPage', textState.text]);
  };
  root.Window_Message.prototype.processCharacter = function processCharacter(textState) {
    rendered.push(textState.text[textState.index]);
    textState.index += 1;
  };
  root.Window_Message.prototype.isEndOfText = function isEndOfText(textState) {
    return textState.index >= textState.text.length;
  };
  root.Window_Message.prototype.flushTextState = function flushTextState(textState) {
    calls.push(['flushTextState', textState.index]);
  };
  root.Window_Message.prototype.onEndOfText = function onEndOfText() {
    calls.push(['onEndOfText']);
  };
  root.Window_Message.prototype.drawTextEx = function drawTextEx() {
    calls.push(['drawTextEx']);
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Native JP') return 'Native KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.processCompleteMessage({
    visible: 'Native JP',
    resolved: 'Native JP',
    translationSource: 'Native JP',
  }, 'session-native');

  assert.deepEqual(calls, [
    ['createTextState', 'Native KO', 0, 0],
    ['newPage', 'Native KO'],
    ['flushTextState', 9],
    ['onEndOfText'],
  ]);
  assert.equal(rendered.join(''), 'Native KO');
  assert.equal(messageWindow._showFast, true);
  assert.equal(messageWindow._lineShowFast, true);
});

test('message adapter converts escapes while preserving origin-aware hard breaks', () => {
  const requests = [];
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      config: { gameMessage: { originAwareLineBreaks: true } },
    },
    $gameMessage: {
      _texts: ['Value \\V[1]', 'Second line'],
    },
    Window_Message: function WindowMessage() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Message.prototype.convertEscapeCharacters = function convertEscapeCharacters(text) {
    return String(text).replace(/\\V\[1\]/g, '42').replace(/\n/g, ' ');
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      requests.push(request.text);
      if (request.text === 'Value 42\nSecond line') return '값 42\n두 번째 줄';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.startMessage();

  assert.deepEqual(requests, ['Value 42\nSecond line']);
  assert.deepEqual(root.$gameMessage._texts, ['값 42', '두 번째 줄']);
});

test('message adapter attaches interpreter message origin for cache-only foresight', () => {
  const list = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Current message'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Next message'] },
    { code: 0, indent: 0, parameters: [] },
  ];
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Next message') return '다음 메시지';
      return null;
    },
  };
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    $gameMessage: {
      _texts: ['Current message'],
      isBusy() { return false; },
    },
    Game_Interpreter: function GameInterpreter() {
      this._list = list;
      this._index = 0;
    },
    Window_Message: function WindowMessage() {},
  };
  root.Game_Interpreter.prototype.command101 = function command101() {
    return true;
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const interpreter = new root.Game_Interpreter();
  assert.equal(interpreter.command101(), true);

  assert.equal(root.$gameMessage._trMessageOrigin.rawText, 'Current message');
  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: root.$gameMessage._trMessageOrigin,
  });

  assert.deepEqual(blocks.map((block) => block.rawText), ['Next message']);
  assert.deepEqual(requests, ['Next message']);
  assert.equal(blocks[0].cacheStatus, 'hit');
});

test('message adapter schedules cache-only foresight scan when message starts', () => {
  const list = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Current message'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Next message'] },
    { code: 0, indent: 0, parameters: [] },
  ];
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Next message') return '다음 메시지';
      return null;
    },
  };
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      foresightScanner: scanner,
    },
    $gameMessage: {
      _texts: ['Current message'],
      isBusy() { return false; },
    },
    Game_Interpreter: function GameInterpreter() {
      this._list = list;
      this._index = 0;
    },
    Window_Message: function WindowMessage() {},
  };
  root.Game_Interpreter.prototype.command101 = function command101() {
    return true;
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const interpreter = new root.Game_Interpreter();
  assert.equal(interpreter.command101(), true);

  new root.Window_Message().startMessage();

  assert.equal(scanner.getSnapshot().recent_scans.length, 1);
  assert.equal(scanner.getSnapshot().cache_hits, 1);
  assert.deepEqual(requests, ['Current message', 'Next message']);
});

test('message adapter schedules foresight from completed payload origin', () => {
  const list = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Current message'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Payload next'] },
  ];
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Payload next') return '페이로드 다음';
      return null;
    },
  };
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      foresightScanner: scanner,
    },
    $gameMessage: { _texts: [] },
    Window_Message: function WindowMessage() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.processCompleteMessage({
    translationSource: 'Current message',
    visible: 'Current message',
    messageOrigin: {
      list,
      startIndex: 0,
      nextIndex: 2,
      indent: 0,
      rawText: 'Current message',
      interpreterId: 'map',
    },
  }, 11);

  assert.equal(scanner.getSnapshot().recent_scans.length, 1);
  assert.equal(scanner.getSnapshot().cache_hits, 1);
  assert.deepEqual(requests, ['Current message', 'Payload next']);
});

test('message adapter preserves child interpreter parent frames for cache-only foresight', () => {
  const parentList = [
    { code: 117, indent: 0, parameters: [5] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Parent resume'] },
  ];
  const childList = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Child current'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Child next'] },
  ];
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Child next') return '자식 다음';
      if (text === 'Parent resume') return '부모 재개';
      return null;
    },
  };
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    $dataCommonEvents: {
      5: { id: 5, name: 'Common 5', list: childList },
    },
    $gameMessage: {
      _texts: ['Child current'],
      isBusy() { return false; },
    },
    Game_Interpreter: function GameInterpreter(list = parentList, index = 0) {
      this._list = list;
      this._index = index;
      this._childInterpreter = null;
    },
    Window_Message: function WindowMessage() {},
  };
  root.Game_Interpreter.prototype.executeCommand = function executeCommand() {
    this.setupChild(childList);
    return true;
  };
  root.Game_Interpreter.prototype.setupChild = function setupChild(list) {
    this._childInterpreter = new root.Game_Interpreter(list, 0);
    return true;
  };
  root.Game_Interpreter.prototype.command101 = function command101() {
    return true;
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const parentInterpreter = new root.Game_Interpreter(parentList, 0);
  root.$gameMap = { _interpreter: parentInterpreter };
  assert.equal(parentInterpreter.executeCommand(), true);
  const childInterpreter = parentInterpreter._childInterpreter;
  assert.ok(childInterpreter);
  assert.equal(childInterpreter._trForesightCommonEventId, 5);
  assert.equal(childInterpreter._trForesightCommonEventName, 'Common 5');
  assert.equal(childInterpreter._trForesightParentFrames.length, 1);

  childInterpreter.command101();
  const origin = root.$gameMessage._trMessageOrigin;
  assert.equal(origin.commonEventId, 5);
  assert.equal(origin.commonEventName, 'Common 5');
  assert.equal(origin.frames.length, 2);

  const blocks = scanner.collectUpcomingMessageBlocks({ currentMessageOrigin: origin });

  assert.deepEqual(blocks.map((block) => [block.rawText, block.translation, block.listId]), [
    ['Child next', '자식 다음', 'common:5'],
    ['Parent resume', '부모 재개', 'map'],
  ]);
  assert.deepEqual(requests, ['Child next', 'Parent resume']);
});

test('message adapter falls back to processCharacter completed text capture', () => {
  const requests = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    $gameMessage: { _texts: ['Fallback JP'] },
    Window_Message: function WindowMessage() {},
  };
  root.Window_Message.prototype.processCharacter = function processCharacter(textState) {
    textState.index = textState.text.length;
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      requests.push(request.text);
      if (request.text === 'Fallback JP') return 'Fallback KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  const textState = { text: 'Fallback JP', index: 0 };
  messageWindow.processCharacter(textState);
  messageWindow.processCharacter(textState);

  assert.deepEqual(requests, ['Fallback JP']);
  assert.deepEqual(root.$gameMessage._texts, ['Fallback KO']);
  assert.equal(orchestrator.diagnostics().active_items, 1);
});

test('message adapter retires active item when message window hides', () => {
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    $gameMessage: { _texts: ['Hide JP'] },
    Window_Message: function WindowMessage() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Message.prototype.hide = function hide() {
    this.hidden = true;
  };
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Hide JP') return 'Hide KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    renderGuard: new RenderGuard(),
  });

  assert.equal(MessageAdapter.install(root, orchestrator), true);
  const messageWindow = new root.Window_Message();
  messageWindow.startMessage();
  assert.equal(orchestrator.diagnostics().active_items, 1);

  messageWindow.hide();

  assert.equal(messageWindow.hidden, true);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.diagnostics().surface_releases, 1);
  assert.equal(orchestrator.diagnostics().text_releases, 1);
});

test('foresight scanner predicts message blocks choices and common events through cache only', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Next line 1\nNext line 2') return '다음 1\n다음 2';
      if (text === 'Choice A') return '선택 A';
      if (text === 'Common hello') return '공통 안녕';
      return null;
    },
  };
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commonEvents: {
      7: {
        name: 'Common 7',
        list: [
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Common hello'] },
        ],
      },
    },
  });
  const list = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Current block'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Next line 1'] },
    { code: 401, indent: 0, parameters: ['Next line 2'] },
    { code: 102, indent: 0, parameters: [['Choice A', 'Choice miss']] },
    { code: 117, indent: 0, parameters: [7] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 2,
      indent: 0,
      interpreterId: 'map',
      frames: [],
    },
  });

  assert.deepEqual(blocks.map((block) => [block.kind, block.rawText, block.translation, block.cacheStatus]), [
    ['message_block', 'Next line 1\nNext line 2', '다음 1\n다음 2', 'hit'],
    ['choice', 'Choice A', '선택 A', 'hit'],
    ['choice', 'Choice miss', null, 'miss'],
    ['message_block', 'Common hello', '공통 안녕', 'hit'],
  ]);
  assert.deepEqual(requests, ['Next line 1\nNext line 2', 'Choice A', 'Choice miss', 'Common hello']);

  const snapshot = scanner.getSnapshot();
  assert.equal(snapshot.recent_scans[0].stop_reason, 'end-of-list');
  assert.equal(snapshot.recent_scans[0].blocks, 4);
  assert.equal(snapshot.cache_hits, 3);
  assert.equal(snapshot.cache_misses, 1);
  assert.equal(snapshot.command_counts['101'], 2);
  assert.equal(snapshot.command_counts['102'], 1);
  assert.equal(snapshot.command_counts['117'], 1);
});

test('foresight scanner annotates choice and conditional branch paths', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Go branch') return '가기 분기';
      if (text === 'Stay branch') return '대기 분기';
      if (text === 'Condition true') return '조건 참';
      if (text === 'Condition false') return '조건 거짓';
      return null;
    },
  };
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const list = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Current block'] },
    { code: 102, indent: 0, parameters: [['Go', 'Stay']] },
    { code: 402, indent: 0, parameters: [0, 'Go'] },
    { code: 101, indent: 1, parameters: [] },
    { code: 401, indent: 1, parameters: ['Go branch'] },
    { code: 402, indent: 0, parameters: [1, 'Stay'] },
    { code: 101, indent: 1, parameters: [] },
    { code: 401, indent: 1, parameters: ['Stay branch'] },
    { code: 404, indent: 0, parameters: [] },
    { code: 111, indent: 0, parameters: [0, 1, 0] },
    { code: 101, indent: 1, parameters: [] },
    { code: 401, indent: 1, parameters: ['Condition true'] },
    { code: 411, indent: 0, parameters: [] },
    { code: 101, indent: 1, parameters: [] },
    { code: 401, indent: 1, parameters: ['Condition false'] },
    { code: 412, indent: 0, parameters: [] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 2,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.kind, block.rawText, block.translation]), [
    ['choice', 'Go', null],
    ['choice', 'Stay', null],
    ['message_block', 'Go branch', '가기 분기'],
    ['message_block', 'Stay branch', '대기 분기'],
    ['message_block', 'Condition true', '조건 참'],
    ['message_block', 'Condition false', '조건 거짓'],
  ]);
  assert.deepEqual(
    blocks.filter((block) => block.kind === 'message_block').map((block) => block.metadata),
    [
      { lineCount: 1, fromCommonEvent: false, branchKind: 'choice', branchDepth: 1, branchPath: [0], branchIndex: 0, branchCount: 2, branchLabel: 'Go', parentCommandIndex: 2 },
      { lineCount: 1, fromCommonEvent: false, branchKind: 'choice', branchDepth: 1, branchPath: [1], branchIndex: 1, branchCount: 2, branchLabel: 'Stay', parentCommandIndex: 2 },
      { lineCount: 1, fromCommonEvent: false, branchKind: 'conditional', branchDepth: 1, branchPath: [0], branchIndex: 0, branchCount: 2, branchLabel: 'Condition true', parentCommandIndex: 10 },
      { lineCount: 1, fromCommonEvent: false, branchKind: 'conditional', branchDepth: 1, branchPath: [1], branchIndex: 1, branchCount: 2, branchLabel: 'Condition false', parentCommandIndex: 10 },
    ],
  );
  assert.deepEqual(requests, ['Go', 'Stay', 'Go branch', 'Stay branch', 'Condition true', 'Condition false']);

  const snapshot = scanner.getSnapshot();
  assert.equal(snapshot.recent_scans[0].branch_paths, 4);
  assert.deepEqual(snapshot.recent_scans[0].path_stops.map((stop) => stop.stop_reason), [
    'branch-end',
    'branch-end',
    'branch-end',
    'branch-end',
  ]);
});

test('foresight scanner preserves branch path through common event frames', () => {
  const index = {
    translate({ text }) {
      if (text === 'Common branch message') return '공통 분기 메시지';
      return null;
    },
  };
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commonEvents: {
      3: {
        name: 'Branch Common',
        list: [
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Common branch message'] },
        ],
      },
    },
  });
  const list = [
    { code: 102, indent: 0, parameters: [['Run common']] },
    { code: 402, indent: 0, parameters: [0, 'Run common'] },
    { code: 117, indent: 1, parameters: [3] },
    { code: 404, indent: 0, parameters: [] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  const commonBlock = blocks.find((block) => block.rawText === 'Common branch message');
  assert.equal(commonBlock.translation, '공통 분기 메시지');
  assert.deepEqual(commonBlock.metadata, {
    lineCount: 1,
    fromCommonEvent: true,
    branchKind: 'choice',
    branchDepth: 1,
    branchPath: [0],
    branchIndex: 0,
    branchCount: 1,
    branchLabel: 'Run common',
    parentCommandIndex: 0,
  });
});

test('foresight scanner resumes parent frame after child message origin frames', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Child next') return '자식 다음';
      if (text === 'Parent resume') return '부모 재개';
      return null;
    },
  };
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const parentList = [
    { code: 117, indent: 0, parameters: [5] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Parent resume'] },
  ];
  const childList = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Child current'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Child next'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list: childList,
      startIndex: 0,
      nextIndex: 2,
      indent: 0,
      interpreterId: 'map:common:5',
      listId: 'common:5',
      commonEventId: 5,
      frames: [
        {
          list: parentList,
          index: 1,
          expectedIndent: 0,
          interpreterId: 'map',
          listId: 'map',
        },
        {
          list: childList,
          index: 2,
          expectedIndent: 0,
          interpreterId: 'map:common:5',
          listId: 'common:5',
          commonEventId: 5,
        },
      ],
    },
  });

  assert.deepEqual(blocks.map((block) => [block.rawText, block.translation, block.listId]), [
    ['Child next', '자식 다음', 'common:5'],
    ['Parent resume', '부모 재개', 'map'],
  ]);
  assert.deepEqual(requests, ['Child next', 'Parent resume']);
});

test('foresight scanner rejects stale interpreter message origins', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const originalList = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Current'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Stale next'] },
  ];
  const replacementList = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Replacement'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      interpreter: { _list: replacementList },
      list: originalList,
      startIndex: 0,
      nextIndex: 2,
      indent: 0,
      interpreterId: 'map',
      listId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'miss');
  assert.equal(scan.stop_reason, 'current-message-unattached');
});

test('foresight scanner reports common event nested-list missing id and list stops', () => {
  const scanner = new ForesightScanner({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commonEvents: {},
  });
  const missingIdList = [
    { code: 117, indent: 0, parameters: [] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Stale missing id text'] },
  ];

  let blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list: missingIdList,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  let scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'common-event-missing-id');
  assert.equal(scan.path_stops[0].stop_reason, 'common-event-missing-id');
  assert.deepEqual(scan.path_stops[0].nested_list, {
    type: 'common-event',
    id: null,
    name: '',
    depth: 1,
    length: 0,
  });

  const missingList = [
    { code: 117, indent: 0, parameters: [9] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Stale missing list text'] },
  ];

  blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list: missingList,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'common-event-missing-list');
  assert.equal(scan.path_stops[0].stop_reason, 'common-event-missing-list');
  assert.deepEqual(scan.path_stops[0].nested_list, {
    type: 'common-event',
    id: 9,
    name: '',
    depth: 1,
    length: 0,
  });
});

test('foresight scanner reports common event cycles as nested-list stops', () => {
  const scanner = new ForesightScanner({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commonEvents: {
      1: {
        name: 'Recursive Common',
        list: [
          { code: 117, indent: 0, parameters: [1] },
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Stale recursive common text'] },
        ],
      },
    },
  });
  const list = [
    { code: 117, indent: 0, parameters: [1] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After recursive common text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'common-event-cycle');
  assert.equal(scan.common_event_pushes, 1);
  assert.equal(scan.path_stops[0].stop_reason, 'common-event-cycle');
  assert.deepEqual(scan.path_stops[0].nested_list, {
    type: 'common-event',
    id: 1,
    name: 'Recursive Common',
    depth: 2,
    length: 3,
  });
});

test('foresight scanner reports common event depth limits as nested-list stops', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    maxNestedDepth: 1,
    commonEvents: {
      1: {
        name: 'Entry Common',
        list: [
          { code: 117, indent: 0, parameters: [2] },
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Stale entry common text'] },
        ],
      },
      2: {
        name: 'Too Deep Common',
        list: [
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Too deep common text'] },
        ],
      },
    },
  });
  const list = [
    { code: 117, indent: 0, parameters: [1] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After depth limit text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'common-event-depth-limit');
  assert.equal(scan.common_event_pushes, 1);
  assert.equal(scan.command_counts['117'], 2);
  assert.equal(scan.path_stops[0].stop_reason, 'common-event-depth-limit');
  assert.deepEqual(scan.path_stops[0].nested_list, {
    type: 'common-event',
    id: 2,
    name: 'Too Deep Common',
    depth: 2,
    length: 2,
  });
});

test('foresight scanner follows command catalog embedded nested lists', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      if (text === 'Embedded nested text') return '임베디드 중첩 텍스트';
      if (text === 'After embedded text') return '임베디드 후 텍스트';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commandCatalog: {
      900: {
        label: 'Plugin Inline Event',
        scanBehavior: 'advance',
        nestedLists: [
          { path: 'parameters[0].list', name: 'Inline actions' },
        ],
      },
    },
  });
  const list = [
    {
      code: 900,
      indent: 0,
      parameters: [{
        list: [
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Embedded nested text'] },
        ],
      }],
    },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After embedded text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.kind, block.rawText, block.translation, block.listId]), [
    ['message_block', 'Embedded nested text', '임베디드 중첩 텍스트', 'map:nested:0:0'],
    ['message_block', 'After embedded text', '임베디드 후 텍스트', 'map'],
  ]);
  assert.deepEqual(requests, ['Embedded nested text', 'After embedded text']);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.stop_reason, 'end-of-list');
  assert.equal(scan.command_counts['900'], 1);
});

test('foresight scanner normalizes nested-list string specs and runtime order', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return text === 'First runtime nested text'
        ? '첫 런타임 중첩 텍스트'
        : '둘째 런타임 중첩 텍스트';
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commandCatalog: {
      903: {
        label: 'Ordered Inline Events',
        scanBehavior: 'advance',
        nestedLists: [
          { path: 'parameters[0].second', name: 'Second runtime', runtimeOrder: 20 },
          'parameters[0].first',
          { path: 'parameters[0].first', name: 'Duplicate first', runtimeOrder: 0 },
        ],
      },
    },
  });
  const list = [
    {
      code: 903,
      indent: 0,
      parameters: [{
        first: [
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['First runtime nested text'] },
        ],
        second: [
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Second runtime nested text'] },
        ],
      }],
    },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.rawText, block.translation, block.listId]), [
    ['First runtime nested text', '첫 런타임 중첩 텍스트', 'map:nested:0:0'],
    ['Second runtime nested text', '둘째 런타임 중첩 텍스트', 'map:nested:0:1'],
  ]);
  assert.deepEqual(requests, ['First runtime nested text', 'Second runtime nested text']);
});

test('foresight scanner derives catalog behavior from classification and context staleness', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return text === 'After linear context command' ? '컨텍스트 명령 뒤' : null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commandCatalog: {
      904: {
        label: 'Linear Context Command',
        classification: 'linear',
        stalenessRisk: 'context',
      },
    },
  });
  const list = [
    { code: 904, indent: 0, parameters: [] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After linear context command'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.rawText, block.translation]), [
    ['After linear context command', '컨텍스트 명령 뒤'],
  ]);
  assert.deepEqual(requests, ['After linear context command']);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.stop_reason, 'end-of-list');
  assert.equal(scan.staleness_risks, 1);
  assert.deepEqual(scan.command_actions.find((action) => action.code === 904), {
    code: 904,
    label: 'Linear Context Command',
    scan_behavior: 'advance',
    staleness_risk: 'context',
    reason: '',
  });
});

test('foresight scanner does not follow barrier catalog nested lists', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commandCatalog: {
      901: {
        label: 'Unsafe Inline Event',
        scanBehavior: 'barrier',
        nestedLists: [
          { path: 'parameters[0].list', name: 'Unsafe actions' },
        ],
      },
    },
  });
  const list = [
    {
      code: 901,
      indent: 0,
      parameters: [{
        list: [
          { code: 101, indent: 0, parameters: [] },
          { code: 401, indent: 0, parameters: ['Unsafe nested text'] },
        ],
      }],
    },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Stale after barrier text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'barrier-command');
  assert.equal(scan.path_stops[0].code, 901);
});

test('foresight scanner reports unavailable explicit nested-list catalog commands', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commandCatalog: {
      902: {
        label: 'Explicit Nested Event',
        scanBehavior: 'nested-list',
      },
    },
  });
  const list = [
    { code: 902, indent: 0, parameters: [] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Stale unavailable nested text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'nested-list-unavailable');
  assert.equal(scan.path_stops[0].stop_reason, 'nested-list-unavailable');
  assert.equal(scan.path_stops[0].code, 902);
  assert.equal(scan.path_stops[0].label, 'Explicit Nested Event');
  assert.deepEqual(scan.command_actions[0], {
    code: 902,
    label: 'Explicit Nested Event',
    scan_behavior: 'nested-list',
    staleness_risk: 'external',
    reason: '',
    action: 'barrier',
    stop_reason: 'nested-list-unavailable',
    nested_list: null,
  });
});

test('foresight scanner stops at label jumps with target diagnostics', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      return null;
    },
  };
  const scanner = new ForesightScanner(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const list = [
    { code: 119, indent: 0, parameters: ['AfterJump'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Stale skipped text'] },
    { code: 118, indent: 0, parameters: ['AfterJump'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Jump target text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);

  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'control-flow-target');
  assert.equal(scan.control_flow_targets, 1);
  assert.deepEqual(scan.path_stops, [{
    index: 0,
    stop_reason: 'control-flow-target',
    branch_depth: 0,
    branch_path: [],
    code: 119,
    label: 'Jump to Label',
    control_flow_target: {
      kind: 'jump-label',
      source_index: 0,
      target_index: 3,
      target_code: 118,
      target_label: 'Label',
      target_name: 'AfterJump',
      label_name: 'AfterJump',
      direction: 'forward',
      via_index: null,
      via_code: null,
      via_label: '',
    },
  }]);
});

test('foresight scanner stops at loop control flow instead of scanning stale loop bodies', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const list = [
    { code: 112, indent: 0, parameters: [] },
    { code: 101, indent: 1, parameters: [] },
    { code: 401, indent: 1, parameters: ['Loop body text'] },
    { code: 413, indent: 0, parameters: [] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After loop text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);

  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'control-flow-target');
  assert.equal(scan.control_flow_targets, 1);
  assert.equal(scan.path_stops[0].control_flow_target.kind, 'loop-repeat');
  assert.equal(scan.path_stops[0].control_flow_target.target_index, 3);
  assert.equal(scan.path_stops[0].control_flow_target.via_code, 413);
});

test('foresight scanner advances transparent movement routes before later messages', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      if (text === 'After route text') return '이동 후 텍스트';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const list = [
    {
      code: 205,
      indent: 0,
      parameters: [0, {
        list: [
          { code: 1, parameters: [] },
          { code: 45, parameters: ['this.setOpacity(128);'] },
          { code: 0, parameters: [] },
        ],
      }],
    },
    { code: 505, indent: 0, parameters: [{ code: 2, parameters: [] }] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After route text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.kind, block.rawText, block.translation]), [
    ['message_block', 'After route text', '이동 후 텍스트'],
  ]);
  assert.deepEqual(requests, ['After route text']);

  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'scanned');
  assert.equal(scan.stop_reason, 'end-of-list');
  assert.equal(scan.route_commands, 1);
  assert.equal(scan.route_barriers, 0);
});

test('foresight scanner stops at unreadable movement route commands', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const list = [
    {
      code: 205,
      indent: 0,
      parameters: [0, {
        list: [
          { code: 999, parameters: [] },
          { code: 0, parameters: [] },
        ],
      }],
    },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Unsafe stale route text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);

  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'movement-route-barrier');
  assert.equal(scan.route_commands, 1);
  assert.equal(scan.route_barriers, 1);
  assert.equal(scan.route_barrier_code, 999);
  assert.equal(scan.route_barrier_label, 'Unknown movement-route command 999');
  assert.equal(scan.path_stops[0].stop_reason, 'movement-route-barrier');
});

test('foresight scanner uses movement route command catalog metadata', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      if (text === 'After custom route text') return '커스텀 이동 뒤';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    commandCatalog: {
      movementRouteCommands: {
        999: {
          label: 'Custom Safe Route Step',
          classification: 'linear',
          scanBehavior: 'advance',
          stalenessRisk: 'context',
        },
      },
    },
  });
  const list = [
    {
      code: 205,
      indent: 0,
      parameters: [0, {
        list: [
          { code: 999, parameters: [] },
          { code: 0, parameters: [] },
        ],
      }],
    },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After custom route text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.kind, block.rawText, block.translation]), [
    ['message_block', 'After custom route text', '커스텀 이동 뒤'],
  ]);
  assert.deepEqual(requests, ['After custom route text']);
  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'scanned');
  assert.equal(scan.stop_reason, 'end-of-list');
  assert.equal(scan.route_barriers, 0);
  assert.deepEqual(scan.route_command_actions.find((action) => action.code === 999), {
    code: 999,
    label: 'Custom Safe Route Step',
    scan_behavior: 'advance',
    staleness_risk: 'context',
    reason: '',
  });
});

test('foresight scanner follows catalog transparent commands and records staleness', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      if (text === 'After transparent commands') return '투명 명령 뒤';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const list = [
    { code: 121, indent: 0, parameters: [1, 1, 0] },
    { code: 351, indent: 0, parameters: [] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['After transparent commands'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.kind, block.rawText, block.translation]), [
    ['message_block', 'After transparent commands', '투명 명령 뒤'],
  ]);
  assert.deepEqual(requests, ['After transparent commands']);

  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'scanned');
  assert.equal(scan.stop_reason, 'end-of-list');
  assert.equal(scan.staleness_risks, 1);
  assert.deepEqual(scan.command_actions.filter((action) => action.code === 121 || action.code === 351), [
    {
      code: 121,
      label: 'Control Switches',
      scan_behavior: 'advance',
      staleness_risk: 'state',
      reason: '',
    },
    {
      code: 351,
      label: 'Open Menu Screen',
      scan_behavior: 'advance',
      staleness_risk: '',
      reason: '',
    },
  ]);
});

test('foresight scanner stops at catalog barrier commands before stale messages', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const list = [
    { code: 115, indent: 0, parameters: [] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Stale exit text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks, []);
  assert.deepEqual(requests, []);

  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'blocked');
  assert.equal(scan.stop_reason, 'barrier-command');
  assert.equal(scan.path_stops[0].code, 115);
  assert.equal(scan.path_stops[0].label, 'Exit Event Processing');
});

test('foresight scanner records budget limit path stops', () => {
  const requests = [];
  const scanner = new ForesightScanner({
    translate({ text }) {
      requests.push(text);
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    budget: 1,
    maxBlocks: 10,
  });
  const list = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['First foresight text'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Second stale text'] },
  ];

  const blocks = scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => block.rawText), ['First foresight text']);
  assert.deepEqual(requests, ['First foresight text']);

  const scan = scanner.getSnapshot().recent_scans[0];
  assert.equal(scan.status, 'scanned');
  assert.equal(scan.stop_reason, 'budget-limit');
  assert.deepEqual(scan.budget, {
    initial: 1,
    limit: 1,
    message_limit: 10,
    spent: 1,
    remaining: 0,
    message_cost: 1,
  });
  assert.deepEqual(scan.path_stops, [{
    index: 2,
    stop_reason: 'budget-limit',
    branch_depth: 0,
    branch_path: [],
    code: null,
    label: '',
    control_flow_target: null,
  }]);
});

test('foresight scanner records message and scan limit path stops', () => {
  const scanner = new ForesightScanner({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    maxBlocks: 1,
    budget: 5,
  });
  const list = [
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['First limited text'] },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Second limited text'] },
  ];

  scanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  const messageLimitScan = scanner.getSnapshot().recent_scans[0];
  assert.equal(messageLimitScan.stop_reason, 'message-limit');
  assert.equal(messageLimitScan.path_stops[0].stop_reason, 'message-limit');
  assert.equal(messageLimitScan.path_stops[0].index, 2);

  const scanLimitScanner = new ForesightScanner({
    translate() {
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    maxCommands: 1,
  });

  scanLimitScanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  const scanLimitScan = scanLimitScanner.getSnapshot().recent_scans[0];
  assert.equal(scanLimitScan.stop_reason, 'scan-limit');
  assert.equal(scanLimitScan.path_stops[0].stop_reason, 'scan-limit');
  assert.equal(scanLimitScan.path_stops[0].index, 2);
});

test('bitmap sprite and pixi lite adapters translate cache hits in synthetic RPG Maker harness', () => {
  const index = {
    translate({ text }) {
      if (text === 'Bitmap JP') return 'Bitmap KO';
      if (text === 'Sprite JP') return 'Sprite KO';
      if (text === 'Pixi JP') return 'Pixi KO';
      if (text === 'BitmapText JP') return 'BitmapText KO';
      return null;
    },
  };
  const calls = [];
  const root = {
    Bitmap: function Bitmap() {},
    Sprite: function Sprite(bitmap) {
      this.bitmap = bitmap || {};
    },
    PIXI: {},
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, width) {
    calls.push(['bitmap', text, x, y, width]);
  };
  root.Sprite.prototype.update = function update() {
    calls.push(['sprite-update', this.bitmap._rpgTranslatorGlyphText]);
  };
  root.PIXI.Text = function PixiText(text) {
    this._text = text;
  };
  Object.defineProperty(root.PIXI.Text.prototype, 'text', {
    get() { return this._text; },
    set(value) {
      this._text = value;
      calls.push(['pixi-text', value]);
    },
    configurable: true,
  });
  root.PIXI.BitmapText = function PixiBitmapText(text) {
    this._text = text;
  };
  Object.defineProperty(root.PIXI.BitmapText.prototype, 'text', {
    get() { return this._text; },
    set(value) {
      this._text = value;
      calls.push(['pixi-bitmap-text', value]);
    },
    configurable: true,
  });

  BitmapTextAdapter.install(root, index);
  SpriteTextAdapter.install(root, index);
  PixiTextAdapter.install(root, index);

  const bitmap = new root.Bitmap();
  bitmap.drawText('Bitmap JP', 1, 2, 3);
  const spriteBitmap = { _rpgTranslatorGlyphText: 'Sprite JP' };
  new root.Sprite(spriteBitmap).update();
  const pixiText = new root.PIXI.Text('');
  pixiText.text = 'Pixi JP';
  const pixiBitmapText = new root.PIXI.BitmapText('');
  pixiBitmapText.text = 'BitmapText JP';

  assert.deepEqual(calls, [
    ['bitmap', 'Bitmap KO', 1, 2, 3],
    ['sprite-update', 'Sprite KO'],
    ['pixi-text', 'Pixi KO'],
    ['pixi-bitmap-text', 'BitmapText KO'],
  ]);
});

test('bitmap text adapter publishes surface draws before native draw', () => {
  const calls = [];
  const surfaceEvents = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Bitmap: function Bitmap() {
      this.fontSize = 24;
    },
    SceneManager: {
      updateScene() {},
    },
  };
  root.Bitmap.prototype.measureTextWidth = (text) => String(text || '').length * 8;
  root.Bitmap.prototype.drawText = function drawText(text, x, y, width, height, align) {
    calls.push([text, x, y, width, height, align]);
  };
  const orchestrator = new TextOrchestrator({ translate: () => null }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  orchestrator.subscribeSurfaceDraws((event) => {
    surfaceEvents.push([
      event.type,
      event.adapterId,
      event.sourceAdapter,
      event.status,
      event.payload.text,
      event.payload.maxWidth,
    ]);
    return { action: 'replace-native-draw', text: 'Surface KO' };
  }, { adapterId: 'sprite-text' });

  BitmapTextAdapter.install(root, orchestrator);
  new root.Bitmap().drawText('Surface JP', 5, 6, 70, 24, 'right');

  assert.deepEqual(surfaceEvents, [
    ['surface.draw', 'sprite-text', 'bitmap-text', 'deferred', 'Surface JP', 70],
  ]);
  assert.deepEqual(calls, [
    ['Surface KO', 5, 6, 70, 24, 'right'],
  ]);
  assert.equal(orchestrator.diagnostics().observed_items, 0);
});

test('sprite text adapter consumes deferred bitmap surface draws', () => {
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Bitmap: function Bitmap() {
      this.fontSize = 24;
    },
    Sprite: function Sprite(bitmap) {
      this.bitmap = bitmap || null;
    },
    SceneManager: {
      updateScene() {},
    },
  };
  root.Bitmap.prototype.measureTextWidth = (text) => String(text || '').length * 8;
  root.Bitmap.prototype.drawText = function drawText(text, x, y, width, height, align) {
    calls.push([text, x, y, width, height, align]);
  };
  root.Sprite.prototype.update = function update() {};
  const orchestrator = new TextOrchestrator({
    translate(request) {
      if (request.text === 'Surface JP') return 'Surface KO';
      return null;
    },
  }, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });

  SpriteTextAdapter.install(root, orchestrator);
  BitmapTextAdapter.install(root, orchestrator);
  new root.Bitmap().drawText('Surface JP', 5, 6, 70, 24, 'right');

  assert.deepEqual(calls, [
    ['Surface KO', 5, 6, 70, 24, 'right'],
  ]);
  assert.equal(orchestrator.diagnostics().cache_hits, 1);
  assert.equal(orchestrator.diagnostics().render_accepted, 1);
});

test('sprite text adapter renders cache hits through overlay lifecycle', () => {
  const index = {
    translate({ text }) {
      if (text === 'Sprite JP') return 'Sprite KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Bitmap: function Bitmap(width, height) {
      this.width = width || 120;
      this.height = height || 32;
    },
    Sprite: function Sprite(bitmap) {
      this.bitmap = bitmap || null;
      this.children = [];
      this.visible = true;
      this.opacity = 180;
      this.x = 4;
      this.y = 8;
    },
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, width, height, align) {
    this._lastDrawText = text;
    calls.push(['drawText', text, x, y, width, height, align]);
  };
  root.Sprite.prototype.addChildAt = function addChildAt(child, index) {
    if (child.parent && child.parent !== this && typeof child.parent.removeChild === 'function') {
      child.parent.removeChild(child);
    }
    this.children = this.children.filter((candidate) => candidate !== child);
    this.children.splice(index, 0, child);
    child.parent = this;
    calls.push(['addChildAt', index, child.bitmap && child.bitmap._lastDrawText]);
    return child;
  };
  root.Sprite.prototype.addChild = function addChild(child) {
    this.children.push(child);
    child.parent = this;
    calls.push(['addChild', child.bitmap && child.bitmap._lastDrawText]);
    return child;
  };
  root.Sprite.prototype.removeChild = function removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    calls.push(['removeChild']);
    return child;
  };
  root.Sprite.prototype.update = function update() {
    calls.push(['sprite-update', this.bitmap && this.bitmap._rpgTranslatorGlyphText]);
  };
  root.Sprite.prototype.destroy = function destroy() {
    this._destroyed = true;
    calls.push(['destroy']);
  };

  assert.equal(SpriteTextAdapter.install(root, orchestrator), true);
  const parent = new root.Sprite(null);
  const spriteBitmap = { width: 120, height: 32, _rpgTranslatorGlyphText: 'Sprite JP' };
  const sprite = new root.Sprite(spriteBitmap);
  parent.addChild(sprite);
  sprite.update();

  assert.equal(spriteBitmap._rpgTranslatorGlyphText, 'Sprite JP');
  assert.equal(parent.children.length, 2);
  assert.equal(parent.children[0], sprite);
  assert.equal(parent.children[1]._rpgTranslatorSpriteTextOverlay, true);
  assert.equal(parent.children[1].bitmap._lastDrawText, 'Sprite KO');
  assert.equal(parent.children[1].visible, true);
  assert.equal(parent.children[1].opacity, 180);
  assert.equal(orchestrator.diagnostics().active_items, 1);

  sprite.visible = false;
  sprite.update();
  assert.equal(parent.children[1].visible, false);

  sprite.destroy();
  assert.equal(parent.children.length, 1);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.claimSurface(sprite, 'bitmap-text'), true);
  assert.equal(orchestrator.claimText(`sprite:${sprite.__rpgTranslatorSpriteTextState.id}:glyph`, 'bitmap-text:slot'), true);
});

test('sprite text adapter groups sibling glyph sprites into one parent run overlay', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'ABC') return '가나다';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    Bitmap: function Bitmap(width, height) {
      this.width = width || 120;
      this.height = height || 32;
    },
    Sprite: function Sprite(bitmap) {
      this.bitmap = bitmap || null;
      this.children = [];
      this.visible = true;
      this.opacity = 255;
      this.x = 0;
      this.y = 0;
    },
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, width, height, align) {
    this._lastDrawText = text;
    calls.push(['drawText', text, x, y, width, height, align]);
  };
  root.Sprite.prototype.addChild = function addChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  };
  root.Sprite.prototype.addChildAt = function addChildAt(child, index) {
    this.children = this.children.filter((candidate) => candidate !== child);
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
  };
  root.Sprite.prototype.removeChild = function removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    return child;
  };
  root.Sprite.prototype.update = function update() {};
  root.Sprite.prototype.destroy = function destroy() {
    this._destroyed = true;
  };

  assert.equal(SpriteTextAdapter.install(root, orchestrator), true);
  const parent = new root.Sprite(null);
  const makeGlyph = (text, x) => {
    const sprite = new root.Sprite({ width: 16, height: 24, _rpgTranslatorGlyphText: text });
    sprite.x = x;
    sprite.y = 4;
    parent.addChild(sprite);
    return sprite;
  };
  const a = makeGlyph('A', 0);
  const b = makeGlyph('B', 11);
  const c = makeGlyph('C', 22);

  a.update();

  assert.deepEqual(requests, ['ABC']);
  assert.equal(parent.children.length, 4);
  assert.equal(parent.children[0], a);
  assert.equal(parent.children[1], b);
  assert.equal(parent.children[2], c);
  const runOverlay = parent.children[3];
  assert.equal(runOverlay._rpgTranslatorSpriteTextParentRunOverlay, true);
  assert.equal(runOverlay.bitmap._lastDrawText, '가나다');
  assert.equal(a.bitmap._rpgTranslatorGlyphText, 'A');
  assert.equal(b.bitmap._rpgTranslatorGlyphText, 'B');
  assert.equal(c.bitmap._rpgTranslatorGlyphText, 'C');
  const parentRunState = parent.__rpgTranslatorSpriteTextParentRunState;
  const parentRunKey = Array.from(parentRunState.runs.keys())[0];
  const parentRunSlotKey = `sprite-run:${parentRunState.id}:${parentRunKey}`;

  b.visible = false;
  a.update();
  assert.equal(runOverlay.visible, false);

  parent.removeChild(b);
  a.update();
  assert.equal(parent.children.includes(runOverlay), false);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.claimText(parentRunSlotKey, 'bitmap-text:slot'), true);
});

test('sprite text adapter retires parent run overlays when glyph child is removed by index', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'ABC') return '가나다';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    Bitmap: function Bitmap(width, height) {
      this.width = width || 120;
      this.height = height || 32;
    },
    Sprite: function Sprite(bitmap) {
      this.bitmap = bitmap || null;
      this.children = [];
      this.visible = true;
      this.opacity = 255;
      this.x = 0;
      this.y = 0;
    },
  };
  root.Bitmap.prototype.drawText = function drawText(text) {
    this._lastDrawText = text;
  };
  root.Sprite.prototype.addChild = function addChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  };
  root.Sprite.prototype.addChildAt = function addChildAt(child, index) {
    this.children = this.children.filter((candidate) => candidate !== child);
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
  };
  root.Sprite.prototype.removeChild = function removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    return child;
  };
  root.Sprite.prototype.removeChildAt = function removeChildAt(index) {
    const child = this.children.splice(index, 1)[0] || null;
    if (child) child.parent = null;
    return child;
  };
  root.Sprite.prototype.update = function update() {};

  assert.equal(SpriteTextAdapter.install(root, orchestrator), true);
  const parent = new root.Sprite(null);
  const makeGlyph = (text, x) => {
    const sprite = new root.Sprite({ width: 16, height: 24, _rpgTranslatorGlyphText: text });
    sprite.x = x;
    sprite.y = 4;
    parent.addChild(sprite);
    return sprite;
  };
  const a = makeGlyph('A', 0);
  const b = makeGlyph('B', 11);
  const c = makeGlyph('C', 22);

  a.update();

  assert.deepEqual(requests, ['ABC']);
  assert.equal(parent.children.length, 4);
  const runOverlay = parent.children[3];
  assert.equal(runOverlay._rpgTranslatorSpriteTextParentRunOverlay, true);

  assert.equal(parent.removeChildAt(1), b);

  assert.deepEqual(parent.children, [a, c]);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(parent.children.includes(runOverlay), false);
});

test('sprite text adapter retires only children actually returned by removeChildren', () => {
  const index = {
    translate({ text }) {
      if (text === 'Sprite JP') return 'Sprite KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'ja', targetLanguage: 'ko' },
    Bitmap: function Bitmap(width, height) {
      this.width = width || 120;
      this.height = height || 32;
    },
    Sprite: function Sprite(bitmap) {
      this.bitmap = bitmap || null;
      this.children = [];
      this.visible = true;
      this.opacity = 255;
      this.x = 0;
      this.y = 0;
    },
  };
  root.Bitmap.prototype.drawText = function drawText(text) {
    this._lastDrawText = text;
  };
  root.Sprite.prototype.addChild = function addChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  };
  root.Sprite.prototype.addChildAt = function addChildAt(child, index) {
    this.children = this.children.filter((candidate) => candidate !== child);
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
  };
  root.Sprite.prototype.removeChild = function removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    return child;
  };
  root.Sprite.prototype.removeChildren = function removeChildren(begin = 0, end = this.children.length) {
    const removed = this.children.splice(begin, end - begin);
    removed.forEach((child) => {
      child.parent = null;
    });
    return removed;
  };
  root.Sprite.prototype.update = function update() {};

  assert.equal(SpriteTextAdapter.install(root, orchestrator), true);
  const parent = new root.Sprite(null);
  const sprite = new root.Sprite({ width: 120, height: 32, _rpgTranslatorGlyphText: 'Sprite JP' });
  const unrelated = new root.Sprite(null);
  parent.addChild(sprite);
  sprite.update();

  assert.equal(parent.children.length, 2);
  const overlay = parent.children[1];
  assert.equal(overlay._rpgTranslatorSpriteTextOverlay, true);
  assert.equal(overlay.bitmap._lastDrawText, 'Sprite KO');

  parent.addChild(unrelated);
  assert.deepEqual(parent.removeChildren(2, 3), [unrelated]);

  assert.equal(parent.children[0], sprite);
  assert.equal(parent.children[1], overlay);
  assert.equal(overlay.parent, parent);
  assert.equal(orchestrator.diagnostics().active_items, 1);
  assert.equal(orchestrator.diagnostics().archived_items, 0);
});

test('bitmap text adapter aggregates same-line fragments and retires on mutation', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Hello World') return '안녕 세계';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    Bitmap: function Bitmap() {
      this.width = 320;
      this.height = 80;
      this.fontSize = 20;
    },
    SceneManager: {
      updateScene() {
        calls.push(['frame']);
      },
    },
  };
  root.Bitmap.prototype.textWidth = function textWidth(text) {
    return String(text).length * 10;
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, maxWidth, lineHeight, align) {
    calls.push(['drawText', text, x, y, maxWidth, lineHeight, align]);
  };
  root.Bitmap.prototype.clearRect = function clearRect(x, y, width, height) {
    calls.push(['clearRect', x, y, width, height]);
  };

  BitmapTextAdapter.install(root, orchestrator);
  const bitmap = new root.Bitmap();
  bitmap.drawText('Hello ', 0, 0, 80, 24, 'left');
  bitmap.drawText('World', 61, 0, 80, 24, 'left');

  assert.deepEqual(calls, [
    ['drawText', 'Hello ', 0, 0, 80, 24, 'left'],
    ['drawText', 'World', 61, 0, 80, 24, 'left'],
  ]);
  assert.equal(orchestrator.diagnostics().active_items, 0);

  root.SceneManager.updateScene();

  assert.deepEqual(requests, ['Hello World']);
  assert.deepEqual(calls.slice(2), [
    ['frame'],
    ['drawText', '안녕 세계', 0, 0, 111, 24, 'left'],
  ]);
  assert.equal(orchestrator.diagnostics().active_items, 1);
  const bitmapSlotKey = Array.from(bitmap.__rpgTranslatorBitmapTextState.entries.keys())[0];

  bitmap.clearRect(0, 0, 160, 24);

  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.claimSurface(bitmap, 'sprite-text'), true);
  assert.equal(orchestrator.claimText(bitmapSlotKey, 'sprite-text:slot'), true);
});

test('bitmap text adapter flushes queued fragments through every frame render hook', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Queued') return '번역';
      if (text === 'Second') return '두번째';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    Bitmap: function Bitmap() {
      this.width = 160;
      this.height = 80;
      this.fontSize = 20;
    },
    SceneManager: {
      updateScene() {
        calls.push(['updateScene']);
      },
      renderScene() {
        calls.push(['renderScene']);
      },
    },
    Graphics: {
      render() {
        calls.push(['graphics-render']);
      },
    },
  };
  root.Bitmap.prototype.textWidth = function textWidth(text) {
    return String(text).length * 10;
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, maxWidth, lineHeight, align) {
    calls.push(['drawText', text, x, y, maxWidth, lineHeight, align]);
  };

  BitmapTextAdapter.install(root, orchestrator);
  const bitmap = new root.Bitmap();

  bitmap.drawText('Queued', 0, 0, 80, 24, 'left');
  root.Graphics.render();

  const graphicsReplayIndex = calls.findIndex((call) => call[0] === 'drawText' && call[1] === '번역');
  const graphicsNativeIndex = calls.findIndex((call) => call[0] === 'graphics-render');
  assert.ok(graphicsReplayIndex > -1);
  assert.ok(graphicsNativeIndex > -1);
  assert.ok(graphicsReplayIndex < graphicsNativeIndex);
  assert.deepEqual(requests, ['Queued']);
  assert.equal(orchestrator.diagnostics().active_items, 1);

  bitmap.drawText('Second', 0, 30, 80, 24, 'left');
  root.SceneManager.renderScene();

  const sceneReplayIndex = calls.findIndex((call) => call[0] === 'drawText' && call[1] === '두번째');
  const sceneNativeIndex = calls.findIndex((call) => call[0] === 'renderScene');
  assert.ok(sceneReplayIndex > -1);
  assert.ok(sceneNativeIndex > -1);
  assert.ok(sceneReplayIndex < sceneNativeIndex);
  assert.deepEqual(requests, ['Queued', 'Second']);
});

test('bitmap text adapter bypasses small-text and normal-character marker draws', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Tiny') return '작게';
      if (text === 'Glyph') return '글리프';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    Bitmap: function Bitmap() {
      this.width = 160;
      this.height = 80;
      this.fontSize = 20;
    },
    Window_Base: function WindowBase() {
      this.contents = new root.Bitmap();
    },
    SceneManager: {
      updateScene() {
        calls.push(['frame']);
      },
    },
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, maxWidth, lineHeight, align) {
    calls.push(['drawText', text, x, y, maxWidth, lineHeight, align]);
  };
  root.Bitmap.prototype.drawSmallText = function drawSmallText(text) {
    return this.drawText(text, 0, 0, 80, 24, 'left');
  };
  root.Window_Base.prototype.processNormalCharacter = function processNormalCharacter(textState) {
    return this.contents.drawText(textState.text, 0, 24, 80, 24, 'left');
  };

  BitmapTextAdapter.install(root, orchestrator);
  const bitmap = new root.Bitmap();
  const windowBase = new root.Window_Base();

  bitmap.drawSmallText('Tiny');
  windowBase.processNormalCharacter({ text: 'Glyph' });
  root.SceneManager.updateScene();

  assert.deepEqual(requests, []);
  assert.deepEqual(calls, [
    ['drawText', 'Tiny', 0, 0, 80, 24, 'left'],
    ['drawText', 'Glyph', 0, 24, 80, 24, 'left'],
    ['frame'],
  ]);
  assert.equal(orchestrator.diagnostics().active_items, 0);
});

test('bitmap text adapter preserves existing entries during marker-active mutations', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Base') return '기본';
      if (text === 'Tiny') return '작게';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    Bitmap: function Bitmap() {
      this.width = 160;
      this.height = 80;
      this.fontSize = 20;
    },
    SceneManager: {
      updateScene() {
        calls.push(['frame']);
      },
    },
  };
  root.Bitmap.prototype.textWidth = function textWidth(text) {
    return String(text).length * 10;
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, maxWidth, lineHeight, align) {
    calls.push(['drawText', text, x, y, maxWidth, lineHeight, align]);
  };
  root.Bitmap.prototype.clearRect = function clearRect(x, y, width, height) {
    calls.push(['clearRect', x, y, width, height]);
  };
  root.Bitmap.prototype.drawSmallText = function drawSmallText(text) {
    this.clearRect(0, 0, 80, 24);
    return this.drawText(text, 0, 0, 80, 24, 'left');
  };

  BitmapTextAdapter.install(root, orchestrator);
  const bitmap = new root.Bitmap();

  bitmap.drawText('Base', 0, 0, 80, 24, 'left');
  root.SceneManager.updateScene();
  assert.deepEqual(requests, ['Base']);
  assert.equal(orchestrator.diagnostics().active_items, 1);

  bitmap.drawSmallText('Tiny');
  root.SceneManager.updateScene();

  assert.deepEqual(requests, ['Base']);
  assert.equal(orchestrator.diagnostics().active_items, 1);
  assert.equal(orchestrator.diagnostics().archived_items, 0);
  assert.deepEqual(calls.slice(-3), [
    ['clearRect', 0, 0, 80, 24],
    ['drawText', 'Tiny', 0, 0, 80, 24, 'left'],
    ['frame'],
  ]);
});

test('bitmap text adapter observes alternate drawText methods', () => {
  const requests = [];
  const index = {
    translate({ text }) {
      requests.push(text);
      if (text === 'Styled') return '스타일';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: { engine: 'mz', sourceLanguage: 'en', targetLanguage: 'ko' },
    Bitmap: function Bitmap() {
      this.width = 160;
      this.height = 80;
      this.fontSize = 20;
    },
    SceneManager: {
      updateScene() {
        calls.push(['frame']);
      },
    },
  };
  root.Bitmap.prototype.textWidth = function textWidth(text) {
    return String(text).length * 10;
  };
  root.Bitmap.prototype.drawText = function drawText(text, x, y, maxWidth, lineHeight, align) {
    calls.push(['drawText', text, x, y, maxWidth, lineHeight, align]);
  };
  root.Bitmap.prototype.drawTextS = function drawTextS(text, x, y, maxWidth, lineHeight, align) {
    calls.push(['drawTextS', text, x, y, maxWidth, lineHeight, align]);
  };

  BitmapTextAdapter.install(root, orchestrator);
  const bitmap = new root.Bitmap();

  bitmap.drawTextS('Styled', 4, 8, 80, 24, 'center');
  root.SceneManager.updateScene();

  assert.deepEqual(requests, ['Styled']);
  assert.deepEqual(calls, [
    ['drawTextS', 'Styled', 4, 8, 80, 24, 'center'],
    ['frame'],
    ['drawTextS', '스타일', 4, 8, 80, 24, 'center'],
  ]);
  assert.equal(orchestrator.diagnostics().active_items, 1);
});

test('pixi text adapter retires removed objects and restores translated text scale', () => {
  const index = {
    translate({ text }) {
      if (text === 'Pixi JP') return 'Pixi KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const calls = [];
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      config: { textScaleOthers: 50 },
    },
    PIXI: {},
    SceneManager: {
      updateScene() {
        calls.push(['scene-update']);
      },
    },
  };
  root.PIXI.Container = function Container() {
    this.children = [];
  };
  root.PIXI.Container.prototype.removeChild = function removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    return child;
  };
  root.PIXI.Text = function PixiText(text) {
    this._text = text;
    this.style = { fontSize: 20 };
    this.visible = true;
    this.renderable = true;
  };
  Object.defineProperty(root.PIXI.Text.prototype, 'text', {
    get() { return this._text; },
    set(value) {
      this._text = value;
      calls.push(['pixi-text', value, this.style.fontSize]);
    },
    configurable: true,
  });

  assert.equal(PixiTextAdapter.install(root, orchestrator), true);
  const container = new root.PIXI.Container();
  const pixiText = new root.PIXI.Text('');
  pixiText.parent = container;
  container.children.push(pixiText);

  pixiText.text = 'Pixi JP';
  assert.equal(pixiText.text, 'Pixi KO');
  assert.equal(pixiText.style.fontSize, 10);
  assert.equal(pixiText._rpgTranslatorPixiVisible, true);
  assert.equal(orchestrator.diagnostics().active_items, 1);

  container.removeChild(pixiText);
  assert.equal(pixiText._rpgTranslatorPixiItemId, null);
  assert.equal(pixiText.style.fontSize, 20);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
  assert.equal(orchestrator.claimSurface(pixiText, 'window-text'), true);
  assert.equal(orchestrator.claimText(`pixi:${pixiText._rpgTranslatorPixiObjectId}:text`, 'window-text:slot'), true);
});

test('pixi text adapter reports frame visibility and priority changes', () => {
  const index = {
    translate({ text }) {
      if (text === 'Pixi JP') return 'Pixi KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const events = [];
  orchestrator.subscribe((event) => {
    if (['item.hidden', 'item.visible', 'item.priority_changed'].includes(event.type)) {
      events.push([
        event.type,
        event.payload && event.payload.reason,
        event.payload && event.payload.priority,
        event.payload && event.payload.details && event.payload.details.screenState,
      ]);
    }
  });
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
    },
    PIXI: {},
    SceneManager: {
      updateScene() {},
    },
  };
  root.PIXI.Container = function Container() {
    this.children = [];
    this.visible = true;
    this.renderable = true;
  };
  root.PIXI.Text = function PixiText(text) {
    this._text = text;
    this.visible = true;
    this.renderable = true;
  };
  Object.defineProperty(root.PIXI.Text.prototype, 'text', {
    get() { return this._text; },
    set(value) { this._text = value; },
    configurable: true,
  });

  assert.equal(PixiTextAdapter.install(root, orchestrator), true);
  const container = new root.PIXI.Container();
  const pixiText = new root.PIXI.Text('');
  pixiText.parent = container;
  container.children.push(pixiText);

  pixiText.text = 'Pixi JP';
  assert.equal(orchestrator.diagnostics().active[0].visible, true);

  container.visible = false;
  root.SceneManager.updateScene();

  assert.equal(pixiText._rpgTranslatorPixiVisible, false);
  assert.equal(orchestrator.diagnostics().active[0].visible, false);
  assert.equal(orchestrator.diagnostics().active[0].priority, 100);
  assert.equal(orchestrator.diagnostics().active[0].screenState, 'hidden');

  container.visible = true;
  root.SceneManager.updateScene();

  assert.equal(pixiText._rpgTranslatorPixiVisible, true);
  assert.equal(orchestrator.diagnostics().active[0].visible, true);
  assert.equal(orchestrator.diagnostics().active[0].priority, 750);
  assert.equal(orchestrator.diagnostics().active[0].screenState, 'visible');
  assert.deepEqual(events, [
    ['item.priority_changed', 'pixi-text-hidden', 100, 'hidden'],
    ['item.hidden', 'pixi-text-hidden', 100, 'hidden'],
    ['item.priority_changed', 'pixi-text-visible', 750, 'visible'],
    ['item.visible', 'pixi-text-visible', 750, 'visible'],
  ]);
});

test('pixi text adapter reports detached screen state for unparented text', () => {
  const index = {
    translate({ text }) {
      if (text === 'Detached JP') return 'Detached KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
    },
    PIXI: {},
    SceneManager: {
      updateScene() {},
    },
  };
  root.PIXI.Text = function PixiText(text) {
    this._text = text;
    this.visible = true;
    this.renderable = true;
  };
  Object.defineProperty(root.PIXI.Text.prototype, 'text', {
    get() { return this._text; },
    set(value) { this._text = value; },
    configurable: true,
  });

  assert.equal(PixiTextAdapter.install(root, orchestrator), true);
  const pixiText = new root.PIXI.Text('');
  pixiText.text = 'Detached JP';

  const active = orchestrator.diagnostics().active[0];
  assert.equal(pixiText.text, 'Detached KO');
  assert.equal(pixiText._rpgTranslatorPixiVisible, false);
  assert.equal(active.visible, false);
  assert.equal(active.screenState, 'detached');
  assert.equal(active.priority, 250);
});

test('pixi text adapter leaves native text when another owner claimed the surface', () => {
  const index = {
    translate({ text }) {
      if (text === 'Pixi JP') return 'Pixi KO';
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
    },
    PIXI: {},
  };
  root.PIXI.Text = function PixiText(text) {
    this._text = text;
  };
  Object.defineProperty(root.PIXI.Text.prototype, 'text', {
    get() { return this._text; },
    set(value) { this._text = value; },
    configurable: true,
  });

  assert.equal(PixiTextAdapter.install(root, orchestrator), true);
  const pixiText = new root.PIXI.Text('');
  assert.equal(orchestrator.claimSurface(pixiText, 'window-text'), true);

  pixiText.text = 'Pixi JP';

  assert.equal(pixiText.text, 'Pixi JP');
  assert.equal(orchestrator.diagnostics().active_items, 0);
});

test('pixi text adapter retires removeChildAt removeChildren and destroyed text objects', () => {
  const index = {
    translate({ text }) {
      if (text.endsWith(' JP')) return text.replace(' JP', ' KO');
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
    },
    PIXI: {},
  };
  root.PIXI.Container = function Container() {
    this.children = [];
  };
  root.PIXI.Container.prototype.removeChildAt = function removeChildAt(index) {
    const [removed] = this.children.splice(index, 1);
    if (removed) removed.parent = null;
    return removed;
  };
  root.PIXI.Container.prototype.removeChildren = function removeChildren(begin, end) {
    const removed = this.children.splice(begin, end - begin);
    removed.forEach((child) => { child.parent = null; });
    return removed;
  };
  root.PIXI.Text = function PixiText(text) {
    this._text = text;
    this.visible = true;
    this.renderable = true;
  };
  Object.defineProperty(root.PIXI.Text.prototype, 'text', {
    get() { return this._text; },
    set(value) { this._text = value; },
    configurable: true,
  });
  root.PIXI.Text.prototype.destroy = function destroy() {
    this.destroyed = true;
  };

  assert.equal(PixiTextAdapter.install(root, orchestrator), true);
  const container = new root.PIXI.Container();
  const first = new root.PIXI.Text('');
  const second = new root.PIXI.Text('');
  const third = new root.PIXI.Text('');
  for (const child of [first, second, third]) {
    child.parent = container;
    container.children.push(child);
  }

  first.text = 'First JP';
  second.text = 'Second JP';
  third.text = 'Third JP';
  assert.equal(orchestrator.diagnostics().active_items, 3);

  assert.equal(container.removeChildAt(0), first);
  assert.equal(orchestrator.diagnostics().active_items, 2);
  assert.equal(orchestrator.diagnostics().archived_items, 1);

  assert.deepEqual(container.removeChildren(0, 1), [second]);
  assert.equal(orchestrator.diagnostics().active_items, 1);
  assert.equal(orchestrator.diagnostics().archived_items, 2);

  third.destroy();
  assert.equal(third._rpgTranslatorPixiItemId, null);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 3);
});

test('pixi text adapter installs lifecycle hooks on both PIXI container classes', () => {
  const index = {
    translate({ text }) {
      if (text.endsWith(' JP')) return text.replace(' JP', ' KO');
      return null;
    },
  };
  const orchestrator = new TextOrchestrator(index, {
    engine: 'mz',
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
  });
  const root = {
    RPGTranslatorOverlay: {
      engine: 'mz',
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
    },
    PIXI: {},
  };
  root.PIXI.Container = function Container() {
    this.children = [];
  };
  root.PIXI.Container.prototype.removeChild = function removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    return child;
  };
  root.PIXI.DisplayObjectContainer = function DisplayObjectContainer() {
    this.children = [];
  };
  root.PIXI.DisplayObjectContainer.prototype.removeChild = function removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    return child;
  };
  root.PIXI.Text = function PixiText(text) {
    this._text = text;
    this.visible = true;
    this.renderable = true;
  };
  Object.defineProperty(root.PIXI.Text.prototype, 'text', {
    get() { return this._text; },
    set(value) { this._text = value; },
    configurable: true,
  });

  assert.equal(PixiTextAdapter.install(root, orchestrator), true);
  const modernContainer = new root.PIXI.Container();
  const legacyContainer = new root.PIXI.DisplayObjectContainer();
  const modernText = new root.PIXI.Text('');
  const legacyText = new root.PIXI.Text('');
  modernText.parent = modernContainer;
  legacyText.parent = legacyContainer;
  modernContainer.children.push(modernText);
  legacyContainer.children.push(legacyText);

  modernText.text = 'Modern JP';
  legacyText.text = 'Legacy JP';
  assert.equal(orchestrator.diagnostics().active_items, 2);

  modernContainer.removeChild(modernText);
  assert.equal(orchestrator.diagnostics().active_items, 1);
  assert.equal(orchestrator.diagnostics().archived_items, 1);

  legacyContainer.removeChild(legacyText);
  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 2);
});

test('boot installs cache-only overlay without provider surfaces', async () => {
  const root = {
    document: { body: null },
    $gameMessage: { _texts: [] },
    Window_Message: function WindowMessage() {},
    Window_Base: function WindowBase() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Base.prototype.drawText = function drawText() {};
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) { return text.length; };

  await Boot.install(root, {
    bundle: {
      manifest: { schema_version: 1, key_schema_version: 'v1', source_language: 'ja', target_language: 'ko' },
      config: { startup_toast_enabled: false },
      records: [],
    },
    engine: 'mz',
  });

  assert.equal(root.RPGTranslatorOverlay.installed, true);
  assert.equal(root.RPGTranslatorOverlay.provider, undefined);
  assert.equal(root.RPGTranslatorOverlay.translationQueue, undefined);
});

test('boot exposes runtime diagnostics and records adapter install timing', async () => {
  const root = {
    document: { body: null },
    $gameMessage: { _texts: [] },
    Window_Message: function WindowMessage() {},
    Window_Base: function WindowBase() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Base.prototype.drawText = function drawText() {};
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) { return text.length; };

  await Boot.install(root, {
    now: (() => {
      let value = 0;
      return () => {
        value += 3;
        return value;
      };
    })(),
    bundle: {
      manifest: { schema_version: 1, key_schema_version: 'v1', source_language: 'ja', target_language: 'ko' },
      config: {
        diagnostics_enabled: true,
        startup_toast_enabled: false,
      },
      records: [],
    },
    engine: 'mz',
  });

  const diagnostics = root.RPGTranslatorOverlay.runtimeDiagnostics;
  assert.ok(diagnostics);
  const conflictSurface = {};
  root.RPGTranslatorOverlay.orchestrator.claimSurface(conflictSurface, 'window-text');
  root.RPGTranslatorOverlay.orchestrator.claimSurface(conflictSurface, 'bitmap-text');
  const missCommand = root.RPGTranslatorOverlay.orchestrator.observeRecord({
    adapter: 'diagnostics-test',
    kind: 'text',
    text: 'Missing menu text',
    surface: conflictSurface,
  });
  root.RPGTranslatorOverlay.orchestrator.acceptRender(missCommand, conflictSurface, 'Missing menu text');
  root.RPGTranslatorOverlay.foresightScanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list: [
        { code: 101, indent: 0, parameters: [] },
        { code: 401, indent: 0, parameters: ['Current'] },
        { code: 101, indent: 0, parameters: [] },
        { code: 401, indent: 0, parameters: ['Next'] },
      ],
      nextIndex: 2,
      indent: 0,
      interpreterId: 'map',
    },
  });
  const snapshot = diagnostics.snapshot({ detailView: true });
  assert.deepEqual(snapshot.adapterInstallStatus.map((entry) => entry.adapter), [
    'message',
    'window-text',
    'bitmap-text',
    'sprite-text',
    'pixi-text',
  ]);
  assert.equal(snapshot.performance.timings.some((entry) => entry.name === 'hook.install.message.ms'), true);
  assert.equal(snapshot.orchestrator.cache_misses, 1);
  assert.equal(snapshot.orchestrator.active_items, 1);
  assert.equal(snapshot.orchestrator.ownership_conflicts, 1);
  assert.equal(snapshot.orchestrator.render_rejected, 1);
  assert.deepEqual(snapshot.orchestrator.recent_events.map((event) => [event.type, event.reason]), [
    ['ownershipConflict', 'ownership-conflict'],
    ['observed', 'observed'],
    ['cacheMiss', 'cache-miss'],
    ['renderQueued', 'miss'],
    ['renderRejected', 'cache-miss'],
  ]);
  assert.equal(snapshot.foresight.cache_misses, 1);
  assert.equal(snapshot.foresight.recent_scans[0].stop_reason, 'end-of-list');
});

test('boot passes exported foresight command catalog to scanner', async () => {
  const root = {
    document: { body: null },
    $gameMessage: { _texts: [] },
    Window_Message: function WindowMessage() {},
    Window_Base: function WindowBase() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Base.prototype.drawText = function drawText() {};
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) { return text.length; };

  await Boot.install(root, {
    bundle: {
      manifest: { schema_version: 1, key_schema_version: 'v1', source_language: 'en', target_language: 'ko' },
      config: {
        startup_toast_enabled: false,
        foresight_command_catalog: {
          movementRouteCommands: {
            999: {
              label: 'Custom Route Advance',
              classification: 'linear',
              scanBehavior: 'advance',
            },
          },
        },
      },
      records: [],
    },
    engine: 'mz',
  });

  const list = [
    {
      code: 205,
      indent: 0,
      parameters: [0, {
        list: [
          { code: 999, parameters: [] },
          { code: 0, parameters: [] },
        ],
      }],
    },
    { code: 101, indent: 0, parameters: [] },
    { code: 401, indent: 0, parameters: ['Catalog-routed text'] },
  ];

  const blocks = root.RPGTranslatorOverlay.foresightScanner.collectUpcomingMessageBlocks({
    currentMessageOrigin: {
      list,
      nextIndex: 0,
      indent: 0,
      interpreterId: 'map',
    },
  });

  assert.deepEqual(blocks.map((block) => [block.kind, block.rawText, block.cacheStatus]), [
    ['message_block', 'Catalog-routed text', 'miss'],
  ]);
  assert.equal(root.RPGTranslatorOverlay.foresightScanner.getSnapshot().recent_scans[0].route_barriers, 0);
});

test('boot clears cache-only foresight state on map transfers', async () => {
  const root = {
    document: { body: null },
    $gameMessage: { _texts: [] },
    Window_Message: function WindowMessage() {},
    Window_Base: function WindowBase() {},
    Game_Player: function GamePlayer() {},
  };
  root.Window_Message.prototype.startMessage = function startMessage() {};
  root.Window_Base.prototype.drawText = function drawText() {};
  root.Window_Base.prototype.drawTextEx = function drawTextEx(text) { return text.length; };
  root.Game_Player.prototype.reserveTransfer = function reserveTransfer() {
    this.reserved = true;
    return 'reserved';
  };
  root.Game_Player.prototype.performTransfer = function performTransfer() {
    this.performed = true;
    return 'performed';
  };

  await Boot.install(root, {
    bundle: {
      manifest: { schema_version: 1, key_schema_version: 'v1', source_language: 'en', target_language: 'ko' },
      config: { startup_toast_enabled: false },
      records: [],
    },
    engine: 'mz',
  });

  const origin = {
    list: [
      { code: 101, indent: 0, parameters: [] },
      { code: 401, indent: 0, parameters: ['Current'] },
      { code: 101, indent: 0, parameters: [] },
      { code: 401, indent: 0, parameters: ['Next'] },
    ],
    nextIndex: 2,
    indent: 0,
    interpreterId: 'map',
  };
  const player = new root.Game_Player();

  root.RPGTranslatorOverlay.foresightScanner.collectUpcomingMessageBlocks({ currentMessageOrigin: origin });
  assert.equal(root.RPGTranslatorOverlay.foresightScanner.getSnapshot().recent_scans.length, 1);
  assert.equal(player.reserveTransfer(), 'reserved');
  assert.equal(player.reserved, true);
  assert.equal(root.RPGTranslatorOverlay.foresightScanner.getSnapshot().recent_scans.length, 0);

  root.RPGTranslatorOverlay.foresightScanner.collectUpcomingMessageBlocks({ currentMessageOrigin: origin });
  assert.equal(root.RPGTranslatorOverlay.foresightScanner.getSnapshot().recent_scans.length, 1);
  assert.equal(player.performTransfer(), 'performed');
  assert.equal(player.performed, true);
  assert.equal(root.RPGTranslatorOverlay.foresightScanner.getSnapshot().recent_scans.length, 0);

  root.RPGTranslatorOverlay.foresightScanner.clearSnapshot = function clearSnapshotFailure() {
    throw new Error('diagnostics unavailable');
  };
  assert.equal(player.reserveTransfer(), 'reserved');
});

test('RPG Maker plugin entry loads support modules in deterministic order and boots overlay', async () => {
  const loaded = [];
  const baseUrl = 'file:///game/js/plugins/rpg-translator/';
  const root = {
    Utils: { RPGMAKER_NAME: 'MZ' },
    RPGTranslatorOverlay: {
      Boot: {
        async install(scope, options) {
          loaded.push(['boot', options.baseUrl, options.engine]);
          scope.bootOptions = options;
          return { installed: true };
        },
      },
    },
  };

  await RuntimeEntry.install(root, {
    baseUrl,
    loadScript: async (url) => {
      loaded.push(url);
    },
  });

  assert.deepEqual(loaded, [
    `${baseUrl}text-codec.js`,
    `${baseUrl}runtime-miss-logger.js`,
    `${baseUrl}lookup-index.js`,
    `${baseUrl}render-guard.js`,
    `${baseUrl}wrapping.js`,
    `${baseUrl}runtime-diagnostics.js`,
    `${baseUrl}orchestrator.js`,
    `${baseUrl}adapter-contract.js`,
    `${baseUrl}foresight-scanner.js`,
    `${baseUrl}cache-loader.js`,
    `${baseUrl}message-adapter.js`,
    `${baseUrl}window-text-adapter.js`,
    `${baseUrl}bitmap-text-adapter.js`,
    `${baseUrl}sprite-text-adapter.js`,
    `${baseUrl}pixi-text-adapter.js`,
    `${baseUrl}startup-toast.js`,
    `${baseUrl}boot.js`,
    ['boot', baseUrl, 'mz'],
  ]);
  assert.equal(root.bootOptions.baseUrl, baseUrl);
});

test('runtime source files do not contain provider or launcher surfaces', () => {
  const banned = [
    'ProviderClient',
    'translate_batch',
    'apiKey',
    'Authorization',
    'launcher',
    'monitor',
    'precacher',
    'diagnostics window',
  ];
  for (const entry of fs.readdirSync(path.join(__dirname, '..'))) {
    if (!entry.endsWith('.js')) continue;
    const content = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8');
    for (const word of banned) {
      assert.equal(content.includes(word), false, `${entry} contains banned surface ${word}`);
    }
  }
});
