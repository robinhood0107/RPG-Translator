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
const { PixiTextAdapter } = require('../pixi-text-adapter');
const { RenderGuard } = require('../render-guard');
const { RuntimeEntry } = require('../RPGTranslator');
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
  assert.deepEqual(orchestrator.diagnostics(), {
    observed_items: 1,
    cache_hits: 1,
    cache_misses: 0,
    render_accepted: 1,
    render_rejected: 1,
    active_items: 1,
    detached_items: 0,
    archived_items: 0,
    queued_render_commands: 1,
  });
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

  b.visible = false;
  a.update();
  assert.equal(runOverlay.visible, false);

  parent.removeChild(b);
  a.update();
  assert.equal(parent.children.includes(runOverlay), false);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
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

  bitmap.clearRect(0, 0, 160, 24);

  assert.equal(orchestrator.diagnostics().active_items, 0);
  assert.equal(orchestrator.diagnostics().archived_items, 1);
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
    `${baseUrl}orchestrator.js`,
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
