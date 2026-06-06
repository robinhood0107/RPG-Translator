const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { Boot } = require('../boot');
const { CacheKeyBuilder, LookupIndex } = require('../lookup-index');
const { CacheLoader } = require('../cache-loader');
const { MessageAdapter } = require('../message-adapter');
const { RenderGuard } = require('../render-guard');
const { RuntimeEntry } = require('../RPGTranslator');
const { StartupToast } = require('../startup-toast');
const { TextCodec } = require('../text-codec');
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
    `${baseUrl}lookup-index.js`,
    `${baseUrl}cache-loader.js`,
    `${baseUrl}message-adapter.js`,
    `${baseUrl}window-text-adapter.js`,
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
