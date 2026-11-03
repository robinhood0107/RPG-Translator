// 그리기 표면의 세대와 원문을 대조합니다. 교체·폐기된 표면에 지연된 번역을 그리지 않도록 합니다.
(function attach(root) {
  class RenderGuard {
    constructor() {
      this.generations = new WeakMap();
    }

    capture(surface, sourceText) {
      const generation = this.generationFor(surface);
      return { generation, sourceText: String(sourceText ?? '') };
    }

    canRender(token, surface, sourceText) {
      return Boolean(
        token
          && token.generation === this.generationFor(surface)
          && token.sourceText === String(sourceText ?? ''),
      );
    }

    markSurfaceChanged(surface) {
      this.generations.set(surface, this.generationFor(surface) + 1);
    }

    generationFor(surface) {
      if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) return 0;
      return this.generations.get(surface) || 0;
    }
  }

  publish(root, { RenderGuard });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
