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
