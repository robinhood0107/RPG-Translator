// 버전이 있는 키와 별칭으로 캐시를 조회합니다. 캐시 미스는 원문을 유지하고 제한된 진단 목록에 기록합니다.
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
      this.mailbox = bundle.mailbox || null;
      this.runtimeConnectionError = bundle.runtimeConnectionError || null;
      this.technicalTokens = typeof bundle.technicalTokens === 'function' ? bundle.technicalTokens : () => bundle.technicalTokens || [];
      this.technicalPassThroughs = 0;
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

    keyFor(request, analysis) {
      return CacheKeyBuilder.build({
        engine: request.engine || 'unknown',
        sourceLanguage: request.sourceLanguage || this.manifest.source_language || '',
        targetLanguage: request.targetLanguage || this.manifest.target_language || '',
        normalizedText: analysis.normalizedText, controlCodeSignature: analysis.controlCodeSignature,
        contextHash: request.contextHash || null,
      });
    }

    isDeclaredTechnicalText(request) {
      if (request.adapter === 'message' || /message|scroll/.test(request.kind || '')) return false;
      const visible=TextCodec.analyze(request.text).visibleText;
      if (!/^[A-Za-z\d\s:/%.+()[\]\-]+$/.test(visible)) return false;
      const ordinary=new Set(['ON','OFF','YES','NO','GO','UP','OK','LOG']);
      const tokens=new Set(this.technicalTokens().filter(value=>typeof value==='string' && (/^[A-Z]{2,3}$/.test(value)||value==='Lv') && !ordinary.has(value)));
      const words=visible.match(/[A-Za-z]+/g)||[];
      return words.length>0 && words.every(word=>tokens.has(word));
    }

    isDynamicCounter(request) {
      return runtimeNumericText(request).numbers.length > 0;
    }

    translate(request) {
      const original = TextCodec.analyze(request.text);
      const direct = this.byKey.get(this.keyFor(request,original));
      if (direct) {this.cacheHits += 1;return direct.translation;}
      if (this.isDeclaredTechnicalText(request)) {this.technicalPassThroughs+=1;return original.normalizedText;}
      const numeric = runtimeNumericText(request);
      const analysis = TextCodec.analyze(numeric.text);
      const cacheKey = this.keyFor(request,analysis);
      const record = this.byKey.get(cacheKey);
      if (record) {this.cacheHits += 1;return restoreRuntimeNumbers(record.translation,numeric.numbers);}
      this.cacheMisses += 1;
      if (this.rememberMiss(cacheKey)) this.recordMiss(Object.assign({},request,{text:numeric.text}),analysis,cacheKey);
      return null;
    }

    diagnostics() {
      const result = {
        cache_hits: this.cacheHits,
        cache_misses: this.cacheMisses,
        recent_misses: this.recentMisses.slice(),
      };
      if (this.technicalPassThroughs) result.technical_passthroughs=this.technicalPassThroughs;
      if (this.runtimeConnectionError) result.translation_error = this.runtimeConnectionError;
      if (this.mailbox) {
        result.pending_translations = this.mailbox.pending.size;
        result.translation_error = this.mailbox.lastError;
      }
      return result;
    }

    requestTranslation(request) {
      if (!this.mailbox) return Promise.resolve(null);
      const original=TextCodec.analyze(request.text);
      const direct = this.byKey.get(this.keyFor(request,original));
      if (direct) return Promise.resolve(direct.translation);
      if (this.isDeclaredTechnicalText(request)) return Promise.resolve(original.normalizedText);
      if ((request.targetLanguage || this.manifest.target_language)==='ko' && /[가-힣]/u.test(original.visibleText)
        && !/[A-Za-z\u3040-\u30ff\u3400-\u9fff]/u.test(original.visibleText)) return Promise.resolve(null);
      const numeric = runtimeNumericText(request);
      const analysis = TextCodec.analyze(numeric.text);
      const cacheKey = this.keyFor(request,analysis);
      const cached = this.byKey.get(cacheKey);
      if (cached) return Promise.resolve(restoreRuntimeNumbers(cached.translation,numeric.numbers));
      return this.mailbox.request({
        schema_version:1,cache_key:cacheKey,text:analysis.normalizedText,
        engine:request.engine || 'unknown',
        source_language:request.sourceLanguage || this.manifest.source_language || '',
        target_language:request.targetLanguage || this.manifest.target_language || '',
        context_hash:request.contextHash || null,adapter:request.adapter || 'unknown',
        kind:request.kind || 'text',window_type:request.windowType || null,priority:Number.isFinite(request.priority) ? request.priority : (request.adapter === 'message' ? 1000 : 750),
      }).then(translation=>{
        if (translation) this.byKey.set(cacheKey,{cache_key:cacheKey,translation});
        return translation ? restoreRuntimeNumbers(translation,numeric.numbers) : null;
      });
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

  function runtimeNumericText(request) {
    const text = String(request.text ?? '');
    const analysis = TextCodec.analyze(text);
    const unchanged = {text:analysis.normalizedText,numbers:[]};
    if (request.adapter === 'message' || /message|scroll/.test(request.kind || '') || text.length > 512
      || text.includes('{{RPGT_NUM_') || text.includes('¤')
      || (analysis.visibleText.match(/[\p{L}]/gu) || []).length < 1
      || /^\[?[A-Z]\d+(?:-[A-Z]\d+)*\]?$/.test(analysis.visibleText.trim())) return unchanged;
    const encoded = TextCodec.encodeForProvider(text);
    const numbers = [];
    // 수치만 바뀌는 HUD는 같은 요청을 공유합니다. 제어문자 안의 ID는 코덱으로 보호합니다.
    const template = encoded.providerText.replace(/\d+(?:\.\d+)?/gu,value=>{
      const id=numbers.length;numbers.push(value);return `{{RPGT_NUM_${id}}}`;
    });
    if (!numbers.length) return unchanged;
    return {text:TextCodec.restoreProviderTranslation(template,encoded),numbers};
  }

  function restoreRuntimeNumbers(translation,numbers) {
    if (!numbers.length) return translation;
    if (typeof translation !== 'string') return null;
    const seen = new Set();let valid=true;
    const text = translation.replace(/\{\{RPGT_NUM_(\d+)\}\}/g,(_,value)=>{
      const index=Number(value);
      if (index >= numbers.length || seen.has(index)) {valid=false;return '';}
      seen.add(index);return numbers[index];
    });
    return valid && seen.size===numbers.length && !text.includes('{{RPGT_NUM_') ? text : null;
  }

  class RuntimeMailboxClient {
    constructor(directory, options = {}) {
      this.directory = directory;
      this.fs = options.fs || require('fs').promises;
      this.path = options.path || require('path');
      if (!this.fs || typeof this.fs.mkdir !== 'function') throw new Error('runtime asynchronous file I/O is unavailable');
      this.pending = new Map();
      this.failures = new Map();
      this.lastError = null;
      this.timer = null;
      this.polling = false;
      this.sequence = 0;
      this.instanceId = require('crypto').randomBytes(8).toString('hex');
      this.ready = null;
    }

    static fromConfig(config, baseUrl) {
      if (!config || config.runtime_translation_enabled !== true || typeof require !== 'function') return null;
      try {
        const path = require('path');
        const url = new URL(baseUrl);
        const base = url.protocol === 'file:'
          ? require('url').fileURLToPath(url)
          : url.protocol === 'chrome-extension:'
            ? path.resolve((root.nw && root.nw.App && root.nw.App.startPath) || process.cwd(), decodeURIComponent(url.pathname).replace(/^\/+/, ''))
            : null;
        if (!base) throw new Error('runtime mailbox requires a local game resource URL');
        return new RuntimeMailboxClient(path.resolve(base, '../../../rpg-translator/runtime'));
      } catch (error) {
        throw new Error(`runtime mailbox initialization failed: ${error.message}`);
      }
    }

    request(request) {
      const text = String(request.text || '');
      if (!/[\p{L}]/u.test(TextCodec.analyze(text).visibleText)) return Promise.resolve(null);
      if (request.target_language === 'ko' && /[가-힣]/u.test(text) && !/[A-Za-z\u3040-\u30ff\u3400-\u9fff]/u.test(text)) return Promise.resolve(null);
      if (/^[A-Za-z]$/.test(text) && /bitmap|sprite/.test(request.adapter)) return Promise.resolve(null);
      if (!/^ck:v1:[a-f0-9]{64}$/.test(request.cache_key) || text.length > 16384) return Promise.resolve(null);
      const key = request.cache_key;
      const failure = this.failures.get(key);
      if (failure && Date.now() < failure.retryAt) return Promise.resolve(null);
      if (this.pending.has(key)) return this.pending.get(key).promise;
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const entry = { request, promise, resolve, startedAt: Date.now(), queued: false };
      this.pending.set(key, entry);
      this.prepare().then(async () => {
        // 재시작 후에는 검수·수정한 DB를 다시 확인하도록 이전 응답을 그대로 재사용하지 않습니다.
        const response = this.path.join(this.directory, 'responses', `${key.slice(6)}.json`);
        await this.fs.unlink(response).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await this.fs.unlink(this.path.join(this.directory,'requests',`${key.slice(6)}.rejected`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        const name = `${key.slice(6)}.json`;
        const target = this.path.join(this.directory, 'requests', name);
        const temporary = `${target}.${this.instanceId}.${this.sequence++}.tmp`;
        return this.fs.writeFile(temporary, JSON.stringify(request), 'utf8').then(() => this.fs.rename(temporary, target)).catch(async (error) => {
          if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
          await this.fs.access(target);
          await this.fs.unlink(temporary).catch(() => {});
        }).then(() => {
          entry.queued = true;
          if (!this.timer) this.timer = setInterval(() => this.poll(), 200);
        });
      }).catch((error) => this.finish(entry, null, error.message));
      return promise;
    }

    prepare() {
      if (!this.ready) this.ready = Promise.all(['requests', 'responses'].map((name) => this.fs.mkdir(this.path.join(this.directory, name), { recursive: true })));
      return this.ready;
    }

    async readReply(entry) {
      const file = this.path.join(this.directory, 'responses', `${entry.request.cache_key.slice(6)}.json`);
      let reply;
      try { reply = JSON.parse(await this.fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
      if (reply.schema_version !== 1 || reply.cache_key !== entry.request.cache_key || reply.text !== entry.request.text) {
        this.finish(entry, null, 'runtime response does not match the request');
      } else if (reply.error) {
        await this.fs.unlink(file).catch(() => {});
        this.finish(entry, null, String(reply.error));
      } else if (typeof reply.translation === 'string' && reply.translation.trim() === entry.request.text.trim() && reply.unchanged_allowed !== true) {
        await this.fs.unlink(file).catch(() => {});
        if (entry.queued) this.finish(entry, null, 'runtime response left translatable text unchanged');
        return false;
      } else if (typeof reply.translation === 'string' && reply.translation.trim()) {
        this.finish(entry, reply.translation, null);
      } else {
        this.finish(entry, null, 'runtime response has no translation');
      }
      return true;
    }

    async poll() {
      if (this.polling) return;
      this.polling = true;
      try {
        let workerAlive = false;
        try {
          const status = JSON.parse(await this.fs.readFile(this.path.join(this.directory, 'status.json'), 'utf8'));
          workerAlive = status.schema_version === 1 && status.running === true && Math.abs(Date.now() - Number(status.updated_at)) < 90000;
        } catch (_) { /* 응답 파일 교체 중이거나 작업자가 없으면 기존 연결 대기 시간을 적용합니다. */ }
        for (const entry of this.pending.values()) {
          if (!entry.queued) continue;
          // 정상 작업자가 앞선 문장을 처리하는 시간은 연결 끊김으로 오판하지 않습니다.
          if (workerAlive) entry.startedAt = Date.now();
          if (Date.now() - entry.startedAt > 120000) this.finish(entry, null, 'runtime translation timed out');
          else {
            const rejected = this.path.join(this.directory, 'requests', `${entry.request.cache_key.slice(6)}.rejected`);
            let invalid = false;
            try { await this.fs.access(rejected); invalid = true; } catch (error) {
              if (error.code !== 'ENOENT') { this.finish(entry,null,error.message); continue; }
            }
            if (invalid) this.finish(entry, null, 'runtime request was rejected');
            else await this.readReply(entry).catch((error) => this.finish(entry, null, error.message));
          }
        }
      } finally {
        this.polling = false;
        if (!this.pending.size && this.timer) { clearInterval(this.timer); this.timer = null; }
      }
    }

    finish(entry, translation, error) {
      if (!this.pending.delete(entry.request.cache_key)) return;
      this.lastError = error || null;
      if (error) {
        const attempts = (this.failures.get(entry.request.cache_key)?.attempts || 0) + 1;
        this.failures.set(entry.request.cache_key, { attempts, retryAt: Date.now() + Math.min(60000, 5000 * 2 ** Math.min(attempts - 1, 4)) });
        if (this.failures.size > 1024) this.failures.delete(this.failures.keys().next().value);
      } else this.failures.delete(entry.request.cache_key);
      entry.resolve(translation);
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

  publish(root, { CacheKeyBuilder, LookupIndex, RuntimeMailboxClient });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
