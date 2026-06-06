(function attach(root) {
  class CacheLoader {
    static async load(baseUrl, fetchImpl) {
      const fetcher = fetchImpl || root.fetch;
      if (typeof fetcher !== 'function') throw new Error('fetch function is required');
      const manifest = await loadJson(fetcher, joinUrl(baseUrl, 'manifest.json'));
      const config = await loadJson(fetcher, joinUrl(baseUrl, 'overlay-config.json'));
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
