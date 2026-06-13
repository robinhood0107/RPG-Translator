(function attach(root) {
  const { TextCodec } = loadDependency(root, './text-codec');

  class CacheKeyBuilder {
    static build(parts) {
      const bytes = [];
      updateField(bytes, 'schema', 'v1');
      updateField(bytes, 'engine', parts.engine || 'unknown');
      updateField(bytes, 'source_language', parts.sourceLanguage || '');
      updateField(bytes, 'target_language', parts.targetLanguage || '');
      updateField(bytes, 'normalized_text', parts.normalizedText || '');
      updateField(bytes, 'control_code_signature', parts.controlCodeSignature || '');
      updateField(bytes, 'context_hash', parts.contextHash || '');
      return `ck:v1:${sha256Hex(bytes)}`;
    }
  }

  class LookupIndex {
    constructor(bundle) {
      this.manifest = bundle.manifest || {};
      this.records = Array.isArray(bundle.records) ? bundle.records : [];
      this.byKey = new Map();
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.recentMisses = [];
      this.missLogger = bundle.missLogger || null;
      this.maxNegativeMisses = Number.isFinite(bundle.maxNegativeMisses)
        ? Math.max(0, Math.floor(bundle.maxNegativeMisses))
        : 1024;
      this.negativeMissKeys = new Set();
      this.negativeMissOrder = [];
      for (const record of this.records) {
        if (record && typeof record.cache_key === 'string') {
          this.byKey.set(record.cache_key, record);
        }
        if (record && Array.isArray(record.cache_aliases)) {
          for (const alias of record.cache_aliases) {
            if (typeof alias === 'string' && alias.length > 0) {
              this.byKey.set(alias, record);
            }
          }
        }
      }
    }

    translate(request) {
      const analysis = TextCodec.analyze(request.text);
      const cacheKey = CacheKeyBuilder.build({
        engine: request.engine || 'unknown',
        sourceLanguage: request.sourceLanguage || this.manifest.source_language || '',
        targetLanguage: request.targetLanguage || this.manifest.target_language || '',
        normalizedText: analysis.normalizedText,
        controlCodeSignature: analysis.controlCodeSignature,
        contextHash: request.contextHash || null,
      });
      const record = this.byKey.get(cacheKey);
      if (record) {
        this.cacheHits += 1;
        return record.translation;
      }
      this.cacheMisses += 1;
      if (this.rememberMiss(cacheKey)) {
        this.recordMiss(request, analysis, cacheKey);
      }
      return null;
    }

    diagnostics() {
      return {
        cache_hits: this.cacheHits,
        cache_misses: this.cacheMisses,
        recent_misses: this.recentMisses.slice(),
      };
    }

    recordMiss(request, analysis, cacheKey) {
      const miss = {
        text: String(request.text || ''),
        normalized_text: analysis.normalizedText,
        control_code_signature: analysis.controlCodeSignature,
        cache_key: cacheKey,
        engine: request.engine || 'unknown',
        source_language: request.sourceLanguage || this.manifest.source_language || '',
        target_language: request.targetLanguage || this.manifest.target_language || '',
        context_hash: request.contextHash || null,
      };
      attachOptionalMissMetadata(miss, request);
      this.recentMisses.push({
        text: miss.text,
        normalized_text: miss.normalized_text,
        control_code_signature: miss.control_code_signature,
        cache_key: miss.cache_key,
      });
      if (this.recentMisses.length > 20) {
        this.recentMisses.shift();
      }
      if (this.missLogger && typeof this.missLogger.recordMiss === 'function') {
        this.missLogger.recordMiss(miss);
      }
    }

    rememberMiss(cacheKey) {
      if (this.maxNegativeMisses === 0) return true;
      if (this.negativeMissKeys.has(cacheKey)) return false;
      this.negativeMissKeys.add(cacheKey);
      this.negativeMissOrder.push(cacheKey);
      while (this.negativeMissOrder.length > this.maxNegativeMisses) {
        const oldest = this.negativeMissOrder.shift();
        this.negativeMissKeys.delete(oldest);
      }
      return true;
    }
  }

  function attachOptionalMissMetadata(miss, request) {
    for (const [outputKey, requestKey] of [
      ['adapter', 'adapter'],
      ['kind', 'kind'],
      ['methodName', 'methodName'],
      ['slotKey', 'slotKey'],
      ['screenState', 'screenState'],
      ['owner', 'owner'],
      ['sceneName', 'sceneName'],
      ['reason', 'reason'],
    ]) {
      const value = request && request[requestKey];
      if (typeof value === 'string' && value.trim()) miss[outputKey] = value;
    }
    for (const [outputKey, requestKey] of [['mapId', 'mapId'], ['eventId', 'eventId']]) {
      const value = Number(request && request[requestKey]);
      if (Number.isFinite(value)) miss[outputKey] = value;
    }
    if (request && Object.prototype.hasOwnProperty.call(request, 'visible')) {
      miss.visible = request.visible === true;
    }
    const bbox = request && request.bbox;
    if (bbox && typeof bbox === 'object') {
      const normalized = {};
      for (const key of ['x', 'y', 'width', 'height']) {
        const value = Number(bbox[key]);
        if (Number.isFinite(value)) normalized[key] = value;
      }
      if (Object.keys(normalized).length) miss.bbox = normalized;
    }
  }

  function updateField(bytes, name, value) {
    const valueBytes = utf8Bytes(String(value));
    pushUtf8(bytes, name);
    bytes.push(0);
    pushUtf8(bytes, valueBytes.length.toString());
    bytes.push(0);
    for (const byte of valueBytes) bytes.push(byte);
    bytes.push(0xff);
  }

  function pushUtf8(bytes, text) {
    for (const byte of utf8Bytes(String(text))) bytes.push(byte);
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    const encoded = unescape(encodeURIComponent(text));
    const bytes = [];
    for (let index = 0; index < encoded.length; index += 1) bytes.push(encoded.charCodeAt(index));
    return bytes;
  }

  function sha256Hex(bytes) {
    const crypto = tryNodeCrypto();
    if (crypto) return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    return pureSha256Hex(bytes);
  }

  function tryNodeCrypto() {
    try {
      if (typeof require === 'function') return require('crypto');
    } catch (_error) {
      return null;
    }
    return null;
  }

  function pureSha256Hex(bytes) {
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const data = bytes.slice();
    const bitLength = data.length * 8;
    data.push(0x80);
    while ((data.length % 64) !== 56) data.push(0);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    data.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
    data.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

    const words = new Array(64);
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        const i = offset + index * 4;
        words[index] = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
      }
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + ch + constants[index] + words[index]) >>> 0;
        const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }
    return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  function rotateRight(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function loadDependency(root, modulePath) {
    const overlay = root.RPGTranslatorOverlay || {};
    if (overlay.TextCodec) return overlay;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      return require(modulePath);
    }
    return overlay;
  }

  publish(root, { CacheKeyBuilder, LookupIndex });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
