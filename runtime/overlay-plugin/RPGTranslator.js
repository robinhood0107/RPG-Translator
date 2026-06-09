(function attach(root) {
  const SUPPORT_DIRECTORY = 'rpg-translator';
  const MODULE_FILES = [
    'text-codec.js',
    'runtime-miss-logger.js',
    'lookup-index.js',
    'render-guard.js',
    'wrapping.js',
    'orchestrator.js',
    'cache-loader.js',
    'message-adapter.js',
    'window-text-adapter.js',
    'bitmap-text-adapter.js',
    'sprite-text-adapter.js',
    'pixi-text-adapter.js',
    'startup-toast.js',
    'boot.js',
  ];

  class RuntimeEntry {
    static moduleFiles() {
      return MODULE_FILES.slice();
    }

    static supportBaseUrl(documentRef) {
      const doc = documentRef || root.document;
      const script = doc && doc.currentScript;
      const scriptUrl = script && script.src ? script.src : 'RPGTranslator.js';
      return joinUrl(scriptUrl.replace(/[^/]*$/u, ''), `${SUPPORT_DIRECTORY}/`);
    }

    static async install(scope = root, options = {}) {
      const doc = options.document || scope.document || root.document;
      const baseUrl = ensureTrailingSlash(options.baseUrl || RuntimeEntry.supportBaseUrl(doc));
      const loadScript = options.loadScript || ((url) => injectScript(doc, url));
      for (const file of MODULE_FILES) {
        await loadScript(joinUrl(baseUrl, file));
      }
      const overlay = scope.RPGTranslatorOverlay || {};
      if (!overlay.Boot || typeof overlay.Boot.install !== 'function') {
        throw new Error('RPGTranslator Boot module was not loaded');
      }
      return overlay.Boot.install(scope, {
        baseUrl,
        engine: options.engine || detectEngine(scope),
      });
    }

    static autoInstall(scope = root) {
      if (isCommonJs() || scope.RPGTranslatorDisableAutoInstall) return;
      RuntimeEntry.install(scope).catch((error) => {
        scope.RPGTranslatorOverlay = Object.assign(scope.RPGTranslatorOverlay || {}, {
          bootError: error.message,
        });
        if (scope.console && typeof scope.console.error === 'function') {
          scope.console.error(`[RPGTranslator] ${error.message}`);
        }
      });
    }
  }

  function injectScript(doc, url) {
    return new Promise((resolve, reject) => {
      if (!doc || typeof doc.createElement !== 'function') {
        reject(new Error('RPGTranslator requires a browser document'));
        return;
      }
      const parent = doc.head || doc.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') {
        reject(new Error('RPGTranslator cannot find a script insertion point'));
        return;
      }
      const script = doc.createElement('script');
      script.src = url;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`failed to load ${url}`));
      parent.appendChild(script);
    });
  }

  function detectEngine(scope) {
    const name = scope.Utils && typeof scope.Utils.RPGMAKER_NAME === 'string'
      ? scope.Utils.RPGMAKER_NAME.toLowerCase()
      : '';
    if (name.includes('mz')) return 'mz';
    if (name.includes('mv')) return 'mv';
    return 'unknown';
  }

  function joinUrl(baseUrl, file) {
    return `${String(baseUrl).replace(/\/?$/u, '/')}${file}`;
  }

  function ensureTrailingSlash(value) {
    return String(value).replace(/\/?$/u, '/');
  }

  function isCommonJs() {
    return typeof module !== 'undefined' && module.exports;
  }

  publish(root, { RuntimeEntry });
  RuntimeEntry.autoInstall(root);
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
