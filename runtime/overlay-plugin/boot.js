(function attach(root) {
  const { CacheLoader } = loadDependency(root, './cache-loader');
  const { LookupIndex } = loadDependency(root, './lookup-index');
  const { BitmapTextAdapter } = loadDependency(root, './bitmap-text-adapter');
  const { MessageAdapter } = loadDependency(root, './message-adapter');
  const { PixiTextAdapter } = loadDependency(root, './pixi-text-adapter');
  const { RenderGuard } = loadDependency(root, './render-guard');
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
      const missLogger = RuntimeMissLogger
        ? RuntimeMissLogger.fromConfig(bundle.config || {}, options.missLogger || {})
        : null;
      const index = new LookupIndex(Object.assign({}, bundle, { missLogger }));
      const orchestrator = TextOrchestrator
        ? new TextOrchestrator(index, {
          engine: options.engine || 'unknown',
          sourceLanguage: bundle.manifest.source_language,
          targetLanguage: bundle.manifest.target_language,
          renderGuard: RenderGuard ? new RenderGuard() : null,
        })
        : index;
      const foresightScanner = ForesightScanner
        ? new ForesightScanner(index, {
          engine: options.engine || 'unknown',
          sourceLanguage: bundle.manifest.source_language,
          targetLanguage: bundle.manifest.target_language,
          commonEvents: scope.$dataCommonEvents,
        })
        : null;
      const nextOverlay = Object.assign(overlay, {
        installed: true,
        engine: options.engine || 'unknown',
        sourceLanguage: bundle.manifest.source_language,
        targetLanguage: bundle.manifest.target_language,
        index,
        orchestrator,
        foresightScanner,
      });
      scope.RPGTranslatorOverlay = nextOverlay;

      MessageAdapter.install(scope, orchestrator);
      WindowTextAdapter.install(scope, orchestrator);
      BitmapTextAdapter.install(scope, orchestrator);
      SpriteTextAdapter.install(scope, orchestrator);
      PixiTextAdapter.install(scope, orchestrator);
      if (bundle.config && bundle.config.startup_toast_enabled !== false) {
        new StartupToast({ document: scope.document, setTimeout: scope.setTimeout }).show(bundle.config);
      }
      return nextOverlay;
    }
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

  publish(root, { Boot });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
