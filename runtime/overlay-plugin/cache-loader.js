(function attach(root) {
  const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;
  const RUNTIME_CONFIG_SCHEMA_VERSION = 1;
  const RUNTIME_KEY_SCHEMA_VERSION = 'v1';

  class CacheLoader {
    static async load(baseUrl, fetchImpl) {
      const fetcher = fetchImpl || root.fetch;
      if (typeof fetcher !== 'function') throw new Error('fetch function is required');
      const manifest = await loadJson(fetcher, joinUrl(baseUrl, 'manifest.json'));
      const config = await loadJson(fetcher, joinUrl(baseUrl, 'overlay-config.json'));
      validateManifest(manifest);
      validateConfig(config);
      const records = [];
      for (const cacheFile of manifest.cache_files || []) {
        const text = await loadText(fetcher, joinUrl(baseUrl, cacheFile));
        for (const line of text.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (trimmed) records.push(JSON.parse(trimmed));
        }
      }
      if (records.length !== manifest.record_count) {
        throw new Error(`manifest record_count ${manifest.record_count} does not match cache records ${records.length}`);
      }
      return { manifest, config, records };
    }
  }

  async function loadJson(fetcher, url) {
    return JSON.parse(await loadText(fetcher, url));
  }

  async function loadText(fetcher, url) {
    const response = await fetcher(url);
    if (!response || response.ok === false) throw new Error(`failed to load ${url}`);
    return response.text();
  }

  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('manifest must be an object');
    }
    const schemaVersion = getObjectValue(manifest, 'schema_version', 'schemaVersion');
    if (Number(schemaVersion) !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
      throw new Error(`manifest schema_version ${schemaVersion} is unsupported`);
    }
    const keySchemaVersion = getObjectValue(manifest, 'key_schema_version', 'keySchemaVersion');
    if (keySchemaVersion !== RUNTIME_KEY_SCHEMA_VERSION) {
      throw new Error(`manifest key_schema_version must be ${RUNTIME_KEY_SCHEMA_VERSION}`);
    }
    const sourceLanguage = getObjectValue(manifest, 'source_language', 'sourceLanguage');
    if (!isNonEmptyString(sourceLanguage)) {
      throw new Error('manifest source_language is required');
    }
    const targetLanguage = getObjectValue(manifest, 'target_language', 'targetLanguage');
    if (!isNonEmptyString(targetLanguage)) {
      throw new Error('manifest target_language is required');
    }
    if (!Array.isArray(manifest.cache_files)) {
      throw new Error('manifest cache_files must be an array');
    }
    const recordCount = getObjectValue(manifest, 'record_count', 'recordCount');
    if (!Number.isInteger(recordCount) || recordCount < 0) {
      throw new Error('manifest record_count must be a number');
    }
  }

  function validateConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('overlay config must be an object');
    }
    const schemaVersion = getObjectValue(config, 'schema_version', 'schemaVersion');
    if (schemaVersion !== undefined && Number(schemaVersion) !== RUNTIME_CONFIG_SCHEMA_VERSION) {
      throw new Error(`overlay config schema_version ${schemaVersion} is unsupported`);
    }
    const diagnosticsEnabled = getObjectValue(config, 'diagnostics_enabled', 'diagnosticsEnabled');
    if (diagnosticsEnabled !== undefined && typeof diagnosticsEnabled !== 'boolean') {
      throw new Error('overlay config diagnostics_enabled must be a boolean when present');
    }
    const startupToastEnabled = getObjectValue(config, 'startup_toast_enabled', 'startupToastEnabled');
    if (startupToastEnabled !== undefined && typeof startupToastEnabled !== 'boolean') {
      throw new Error('overlay config startup_toast_enabled must be a boolean when present');
    }
    const startupToastText = getObjectValue(config, 'startup_toast_text', 'startupToastText');
    if (startupToastText !== undefined && typeof startupToastText !== 'string') {
      throw new Error('overlay config startup_toast_text must be a string when present');
    }
  }

  function getObjectValue(object, snakeName, camelName) {
    if (Object.prototype.hasOwnProperty.call(object, snakeName)) return object[snakeName];
    if (Object.prototype.hasOwnProperty.call(object, camelName)) return object[camelName];
    return undefined;
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function joinUrl(baseUrl, file) {
    if (!baseUrl) return file;
    return `${String(baseUrl).replace(/\/?$/u, '/')}${file}`;
  }

  publish(root, { CacheLoader });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
