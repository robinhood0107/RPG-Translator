// 엔진 어댑터 밖에서 직접 그린 Canvas 문구를 처리합니다. 배경이 바뀐 지연 응답은 다시 그리지 않습니다.
(function attach(root) {
  const STYLE_KEYS = ['font', 'textAlign', 'textBaseline', 'direction', 'fillStyle', 'strokeStyle',
    'lineWidth', 'lineJoin', 'globalAlpha', 'globalCompositeOperation', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY'];

  class CanvasTextAdapter {
    static install(scope, translator) {
      const prototype = scope.CanvasRenderingContext2D && scope.CanvasRenderingContext2D.prototype;
      if (!prototype || prototype.__rpgTranslatorCanvasInstalled || !translator || !translator.observeRecord) return false;
      prototype.__rpgTranslatorCanvasInstalled = true;
      const states = new WeakMap();
      const overlay = scope.RPGTranslatorOverlay || (scope.RPGTranslatorOverlay = {});
      let nextId = 1;
      let nextClipId = 1;
      function stateFor(context) {
        if (!states.has(context)) states.set(context, { id: nextId++, records: new Map(), replay: false, clipId: 0, clips: [] });
        return states.get(context);
      }
      function owned(context) {
        const bitmap = context.__rpgTranslatorBitmapOwner;
        const owner = bitmap && bitmap.__rpgTranslatorWindowOwner;
        return overlay.__nativeCanvasTextDepth > 0 || (bitmap && bitmap.__rpgTranslatorBitmapReplayDepth > 0)
          || (owner && (owner.__rpgTranslatorWindowTextDrawDepth > 0 || owner.__rpgTranslatorMessageRedrawDepth > 0));
      }
      function retire(context) {
        const state = states.get(context);
        if (!state || state.replay || owned(context)) return;
        for (const entry of state.records.values()) translator.archiveItem(entry.command.itemId, 'canvas-repainted');
        state.records.clear();
      }
      for (const name of ['save', 'restore', 'clip']) {
        const original = prototype[name];
        if (typeof original !== 'function') continue;
        prototype[name] = function(...args) {
          const state = stateFor(this);
          const result = original.apply(this, args);
          if (name === 'save') state.clips.push(state.clipId);
          else if (name === 'restore') state.clipId = state.clips.pop() ?? 0;
          else state.clipId = nextClipId++;
          return result;
        };
      }
      for (const name of ['clearRect', 'fillRect', 'strokeRect', 'drawImage', 'putImageData', 'fill', 'stroke']) {
        const original = prototype[name];
        if (typeof original !== 'function') continue;
        prototype[name] = function(...args) { retire(this); return original.apply(this, args); };
      }
      for (const method of ['fillText', 'strokeText']) {
        const original = prototype[method];
        if (typeof original !== 'function') continue;
        prototype[method] = function(value, x, y, maxWidth) {
          const state = stateFor(this);
          if (state.replay || owned(this)) return original.apply(this, arguments);
          if (value !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) {
            retire(this);
            return original.apply(this, arguments);
          }
          const text = String(value);
          const matrix = typeof this.getTransform === 'function' ? this.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
          const key = `${x}:${y}:${this.font}:${this.textAlign}:${this.textBaseline}:${[matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]}`;
          if (!/[\p{L}]/u.test(text)) {
            const bounds = textBounds(this, text, x, y, maxWidth, matrix);
            for (const [otherKey, other] of state.records) if (overlaps(bounds, other.bounds)) {
              translator.archiveItem(other.command.itemId, 'canvas-overwritten'); state.records.delete(otherKey);
            }
            return original.apply(this, arguments);
          }
          let entry = state.records.get(key);
          if (entry && (entry.text !== text || entry.width !== this.canvas.width || entry.height !== this.canvas.height)) { translator.archiveItem(entry.command.itemId, 'canvas-text-changed'); state.records.delete(key); entry = null; }
          const style = Object.fromEntries(STYLE_KEYS.filter(k => k in this).map(k => [k, this[k]]));
          if (!entry) {
            const bounds = textBounds(this, text, x, y, maxWidth, matrix);
            // 다른 문구가 같은 픽셀을 덮었다면 이전 배경을 복원하지 않습니다.
            for (const [otherKey, other] of state.records) if (overlaps(bounds, other.bounds)) {
              translator.archiveItem(other.command.itemId, 'canvas-overwritten'); state.records.delete(otherKey);
            }
            let background = null;
            const request = {
              text, surface: this.canvas, adapter: 'canvas-text', kind: 'text',
              engine: overlay.engine, sourceLanguage: overlay.sourceLanguage, targetLanguage: overlay.targetLanguage, slotKey: `canvas:${state.id}:${key}`
            };
            const command = translator.observeRecord(request);
            if (!command) return original.apply(this, arguments);
            try { if (command.status !== 'hit' && bounds.width * bounds.height <= 1048576) background = this.getImageData(bounds.x, bounds.y, bounds.width, bounds.height); }
            catch (_) { /* 읽기 제한이 있는 Canvas는 다음 네이티브 그리기의 캐시 적중만 적용합니다. */ }
            entry = { text, request, command, bounds, background, clipId: state.clipId, paints: new Map(), width: this.canvas.width, height: this.canvas.height };
            state.records.set(key, entry);
          }
          if (entry.command.status !== 'hit' && entry.pending === false && Date.now() >= (entry.retryAt || 0)) {
            entry.command = translator.observeRecord(entry.request) || entry.command;
            entry.retryAt = Date.now() + 1000;
          }
          entry.paints.set(method, { original, style, args: Array.from(arguments), matrix });
          const context = this;
          function paint(ready, paints) {
            if (!ready || !translator.acceptRender(ready, context.canvas, text)) return false;
            state.replay = true;
            try {
              for (const op of paints) {
                context.save();
                try {
                  Object.assign(context, op.style);
                  if (typeof context.setTransform === 'function') context.setTransform(op.matrix.a, op.matrix.b, op.matrix.c, op.matrix.d, op.matrix.e, op.matrix.f);
                  const sourceWidth = Number(context.measureText(text).width) || 1;
                  const targetWidth = Number(context.measureText(ready.translatedText).width) || 1;
                  const available = Number(op.args[3]) > 0 ? Number(op.args[3]) : sourceWidth;
                  if (targetWidth > available) context.font = context.font.replace(/([\d.]+)px/, (_, size) => `${Number(size) * available / targetWidth}px`);
                  op.original.call(context, ready.translatedText, op.args[1], op.args[2], op.args[3]);
                } finally { context.restore(); }
              }
              return true;
            } finally { state.replay = false; }
          }
          if (entry.command.status === 'hit') { paint(entry.command, [entry.paints.get(method)]); return undefined; }
          if (!entry.subscribed) {
            entry.subscribed = true; entry.pending = true; translator.onTranslationReady(entry.command, ready => {
              if (state.records.get(key) !== entry || !entry.background || state.clipId !== entry.clipId || context.canvas.width !== entry.width || context.canvas.height !== entry.height) return false;
              if (!translator.acceptRender(ready, context.canvas, text)) return false;
              state.replay = true;
              try { context.putImageData(entry.background, entry.bounds.x, entry.bounds.y); }
              finally { state.replay = false; }
              entry.command = ready;
              return paint(ready, entry.paints.values());
            });
            Promise.resolve(entry.command.completion).then(() => { entry.pending = false; entry.subscribed = false; }, () => { entry.pending = false; entry.subscribed = false; });
          }
          return original.apply(this, arguments);
        };
      }
      // 이미 전용 어댑터가 소유한 비트맵·PIXI 글자를 Canvas에서 중복 관찰하지 않습니다.
      function guard(prototype, name) {
        const original = prototype && prototype[name];
        if (typeof original !== 'function') return;
        const wrapped = function(...args) {
          const context = this.context || this._context;
          if (context) context.__rpgTranslatorBitmapOwner = this;
          overlay.__nativeCanvasTextDepth = (overlay.__nativeCanvasTextDepth || 0) + 1;
          try { return original.apply(this, args); } finally { overlay.__nativeCanvasTextDepth -= 1; }
        };
        Object.assign(wrapped, original); prototype[name] = wrapped;
      }
      for (const name of ['drawText', 'drawTextS', 'drawTextM']) guard(scope.Bitmap && scope.Bitmap.prototype, name);
      guard(scope.PIXI && scope.PIXI.Text && scope.PIXI.Text.prototype, 'updateText');
      return true;
    }
  }

  function textBounds(context, text, x, y, maxWidth, m) {
    const metrics = context.measureText(text);
    const size = Number((context.font.match(/([\d.]+)px/) || [])[1]) || 24;
    const width = Math.min(Number(maxWidth) > 0 ? Number(maxWidth) : Infinity, Number(metrics.width) || 1);
    let left = Number(x) || 0;
    if (context.textAlign === 'center') left -= width / 2;
    else if (context.textAlign === 'right' || context.textAlign === 'end') left -= width;
    const baseline = context.textBaseline;
    const top = (Number(y) || 0) - (baseline === 'top' || baseline === 'hanging' ? 0 : baseline === 'middle' ? size / 2 : size);
    const padding = Math.ceil((Number(context.lineWidth) || 1) + size * .3);
    const corners = [[left - padding, top - padding], [left + width + padding, top - padding], [left - padding, top + size + padding], [left + width + padding, top + size + padding]]
      .map(([px, py]) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f]);
    const x1 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[0]))));
    const y1 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[1]))));
    return {
      x: x1, y: y1, width: Math.max(1, Math.min(context.canvas.width, Math.ceil(Math.max(...corners.map(p => p[0])))) - x1),
      height: Math.max(1, Math.min(context.canvas.height, Math.ceil(Math.max(...corners.map(p => p[1])))) - y1)
    };
  }
  function overlaps(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, { CanvasTextAdapter });
  if (typeof module !== 'undefined' && module.exports) module.exports = { CanvasTextAdapter };
})(globalThis);
