(function attach(root) {
  const DEFAULT_FILE = 'runtime-misses.jsonl';

  class RuntimeMissLogger {
    constructor(options = {}) {
      this.enabled = options.enabled !== false;
      this.directory = options.directory || '';
      this.fileName = options.fileName || DEFAULT_FILE;
      this.fs = options.fs || tryRequire('fs');
      this.path = options.path || tryRequire('path');
      this.now = options.now || (() => new Date().toISOString());
      this.lastError = null;
    }

    static fromConfig(config = {}, options = {}) {
      return new RuntimeMissLogger({
        enabled: config.diagnostics_enabled === true,
        directory: options.directory || config.diagnostics_dir || '',
        fileName: options.fileName || config.diagnostics_miss_file || DEFAULT_FILE,
        fs: options.fs,
        path: options.path,
        now: options.now,
      });
    }

    recordMiss(miss) {
      if (!this.enabled || !this.fs || !this.path || !this.directory) return false;
      const entry = Object.assign({ timestamp: this.now() }, miss);
      try {
        this.fs.mkdirSync(this.directory, { recursive: true });
        this.fs.appendFileSync(
          this.path.join(this.directory, this.fileName),
          `${JSON.stringify(entry)}\n`,
          'utf8',
        );
        this.lastError = null;
        return true;
      } catch (error) {
        this.lastError = error && error.message ? error.message : String(error);
        return false;
      }
    }
  }

  function tryRequire(name) {
    try {
      if (typeof require === 'function') return require(name);
    } catch (_error) {
      return null;
    }
    return null;
  }

  publish(root, { RuntimeMissLogger });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
