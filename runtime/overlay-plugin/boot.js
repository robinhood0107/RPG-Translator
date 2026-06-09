(function attach(root) {
  const SUPPORT_DIRECTORY = 'rpg-translator';
  const PLUGIN_ENTRY_FILE = 'RPGTranslator.js';
  const RUNTIME_SCRIPT_LOAD_ORDER = [
    'text-codec.js',
    'runtime-miss-logger.js',
    'lookup-index.js',
    'render-guard.js',
    'wrapping.js',
    'runtime-diagnostics.js',
    'orchestrator.js',
    'adapter-contract.js',
    'foresight-scanner.js',
    'cache-loader.js',
    'message-adapter.js',
    'window-text-adapter.js',
    'bitmap-text-adapter.js',
    'sprite-text-adapter.js',
    'pixi-text-adapter.js',
    'startup-toast.js',
    'boot.js',
  ];
  const REQUIRED_RUNTIME_FILES = [PLUGIN_ENTRY_FILE].concat(RUNTIME_SCRIPT_LOAD_ORDER);

  const { CacheLoader } = loadDependency(root, './cache-loader');
  const { LookupIndex } = loadDependency(root, './lookup-index');
  const { BitmapTextAdapter } = loadDependency(root, './bitmap-text-adapter');
  const { MessageAdapter } = loadDependency(root, './message-adapter');
  const { PixiTextAdapter } = loadDependency(root, './pixi-text-adapter');
  const { RenderGuard } = loadDependency(root, './render-guard');
  const { RuntimeDiagnostics } = loadDependency(root, './runtime-diagnostics');
  const { RuntimeMissLogger } = loadDependency(root, './runtime-miss-logger');
  const { TextOrchestrator } = loadDependency(root, './orchestrator');
  const { ForesightScanner } = loadDependency(root, './foresight-scanner');
  const { SpriteTextAdapter } = loadDependency(root, './sprite-text-adapter');
  const { StartupToast } = loadDependency(root, './startup-toast');
  const { WindowTextAdapter } = loadDependency(root, './window-text-adapter');

  class Boot {
    static async install(scope = root, options = {}) {
      const overlay = scope.RPGTranslatorOverlay || {};
      if (overlay.installed) return overlay;

      const bundle = options.bundle || await CacheLoader.load(options.baseUrl || '', options.fetch);
      validateRuntimeLoadContract(bundle.config || {});
      const missLogger = RuntimeMissLogger
        ? RuntimeMissLogger.fromConfig(bundle.config || {}, options.missLogger || {})
        : null;
      const index = new LookupIndex(Object.assign({}, bundle, { missLogger }));
      const runtimeDiagnostics = RuntimeDiagnostics
        ? new RuntimeDiagnostics({
          settings: bundle.config || {},
          now: options.now,
        })
        : null;
      const orchestrator = TextOrchestrator
        ? new TextOrchestrator(index, {
          engine: options.engine || 'unknown',
          sourceLanguage: bundle.manifest.source_language,
          targetLanguage: bundle.manifest.target_language,
          renderGuard: RenderGuard ? new RenderGuard() : null,
          diagnostics: runtimeDiagnostics,
        })
        : index;
      const foresightScanner = ForesightScanner
        ? new ForesightScanner(index, {
          engine: options.engine || 'unknown',
          sourceLanguage: bundle.manifest.source_language,
          targetLanguage: bundle.manifest.target_language,
          commonEvents: scope.$dataCommonEvents,
          commandCatalog: resolveCommandCatalog(options, bundle),
        })
        : null;
      if (runtimeDiagnostics
        && orchestrator
        && typeof orchestrator.diagnostics === 'function'
        && typeof runtimeDiagnostics.setOrchestratorSnapshotProvider === 'function') {
        runtimeDiagnostics.setOrchestratorSnapshotProvider(() => {
          const snapshot = Object.assign({}, orchestrator.diagnostics());
          delete snapshot.runtime_diagnostics;
          return snapshot;
        });
      }
      if (runtimeDiagnostics
        && foresightScanner
        && typeof runtimeDiagnostics.setForesightSnapshotProvider === 'function') {
        runtimeDiagnostics.setForesightSnapshotProvider(() => foresightScanner.getSnapshot());
      }
      const nextOverlay = Object.assign(overlay, {
        installed: true,
        engine: options.engine || 'unknown',
        sourceLanguage: bundle.manifest.source_language,
        targetLanguage: bundle.manifest.target_language,
        index,
        orchestrator,
        foresightScanner,
        runtimeDiagnostics,
      });
      scope.RPGTranslatorOverlay = nextOverlay;

      installAdapter(runtimeDiagnostics, 'message', () => MessageAdapter.install(scope, orchestrator));
      installAdapter(runtimeDiagnostics, 'window-text', () => WindowTextAdapter.install(scope, orchestrator));
      installAdapter(runtimeDiagnostics, 'bitmap-text', () => BitmapTextAdapter.install(scope, orchestrator));
      installAdapter(runtimeDiagnostics, 'sprite-text', () => SpriteTextAdapter.install(scope, orchestrator));
      installAdapter(runtimeDiagnostics, 'pixi-text', () => PixiTextAdapter.install(scope, orchestrator));
      if (bundle.config && bundle.config.startup_toast_enabled !== false) {
        new StartupToast({ document: scope.document, setTimeout: scope.setTimeout }).show(bundle.config);
      }
      return nextOverlay;
    }
  }

  function validateRuntimeLoadContract(config) {
    const contract = config.runtime_load_contract
      || config.runtimeLoadContract
      || config.runtime_loadContract
      || null;
    if (!contract) return;

    const schemaVersion = getContractValue(contract, 'schema_version', 'schemaVersion');
    if (schemaVersion !== undefined && Number(schemaVersion) !== 1) {
      throw new Error(`runtime load contract schema_version ${schemaVersion} is unsupported`);
    }

    const supportDirectory = getContractValue(contract, 'support_directory', 'supportDirectory');
    if (supportDirectory !== SUPPORT_DIRECTORY) {
      throw new Error(`runtime load contract support_directory must be ${SUPPORT_DIRECTORY}`);
    }

    const pluginEntryFile = getContractValue(contract, 'plugin_entry_file', 'pluginEntryFile');
    if (pluginEntryFile !== PLUGIN_ENTRY_FILE) {
      throw new Error(`runtime load contract plugin_entry_file must be ${PLUGIN_ENTRY_FILE}`);
    }

    const scriptLoadOrder = getContractValue(contract, 'script_load_order', 'scriptLoadOrder') || [];
    if (!sameStringArray(scriptLoadOrder, RUNTIME_SCRIPT_LOAD_ORDER)) {
      throw new Error('runtime load contract script_load_order does not match the cache-only runtime');
    }

    const requiredRuntimeFiles = getContractValue(contract, 'required_runtime_files', 'requiredRuntimeFiles') || [];
    if (!sameStringArray(requiredRuntimeFiles, REQUIRED_RUNTIME_FILES)) {
      throw new Error('runtime load contract required_runtime_files does not match the cache-only runtime');
    }
  }

  function getContractValue(contract, snakeName, camelName) {
    if (Object.prototype.hasOwnProperty.call(contract, snakeName)) return contract[snakeName];
    if (Object.prototype.hasOwnProperty.call(contract, camelName)) return contract[camelName];
    return undefined;
  }

  function sameStringArray(actual, expected) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (actual[index] !== expected[index]) return false;
    }
    return true;
  }

  function resolveCommandCatalog(options, bundle) {
    const config = bundle && bundle.config && typeof bundle.config === 'object'
      ? bundle.config
      : {};
    return options.commandCatalog
      || bundle.commandCatalog
      || config.foresight_command_catalog
      || config.foresightCommandCatalog
      || config.command_catalog
      || config.commandCatalog
      || null;
  }

  function loadDependency(scope, modulePath) {
    const overlay = scope.RPGTranslatorOverlay || {};
    const dependencyNames = {
      './cache-loader': 'CacheLoader',
      './lookup-index': 'LookupIndex',
      './bitmap-text-adapter': 'BitmapTextAdapter',
      './message-adapter': 'MessageAdapter',
      './pixi-text-adapter': 'PixiTextAdapter',
      './render-guard': 'RenderGuard',
      './runtime-diagnostics': 'RuntimeDiagnostics',
      './runtime-miss-logger': 'RuntimeMissLogger',
      './orchestrator': 'TextOrchestrator',
      './foresight-scanner': 'ForesightScanner',
      './sprite-text-adapter': 'SpriteTextAdapter',
      './startup-toast': 'StartupToast',
      './window-text-adapter': 'WindowTextAdapter',
    };
    const dependencyName = dependencyNames[modulePath];
    if (dependencyName && overlay[dependencyName]) return overlay;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      return require(modulePath);
    }
    return overlay;
  }

  function installAdapter(runtimeDiagnostics, adapter, callback) {
    if (runtimeDiagnostics && typeof runtimeDiagnostics.measureAdapterInstall === 'function') {
      return runtimeDiagnostics.measureAdapterInstall(adapter, callback);
    }
    return callback();
  }

  publish(root, { Boot });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
