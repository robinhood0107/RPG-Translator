// 텍스트와 배경 연산의 순서·겹침 영역을 계산합니다. 번역을 다시 그릴 때 뒤에 그린 그래픽도 보존해야 합니다.
(function attach(root) {
  class ReplayState {
    static normalizeRect(rect) {
      if (!rect || typeof rect !== 'object') return null;
      const x = finite(rect.x, 0);
      const y = finite(rect.y, 0);
      const width = finite(rect.width, 0);
      const height = finite(rect.height, 0);
      if (width <= 0 || height <= 0) return null;
      return { x, y, width, height };
    }

    static rectsOverlap(left, right) {
      const a = ReplayState.normalizeRect(left);
      const b = ReplayState.normalizeRect(right);
      if (!a || !b) return false;
      return a.x < b.x + b.width
        && a.x + a.width > b.x
        && a.y < b.y + b.height
        && a.y + a.height > b.y;
    }

    static unionRect(left, right) {
      const a = ReplayState.normalizeRect(left);
      const b = ReplayState.normalizeRect(right);
      if (!a) return b;
      if (!b) return a;
      const x1 = Math.min(a.x, b.x);
      const y1 = Math.min(a.y, b.y);
      const x2 = Math.max(a.x + a.width, b.x + b.width);
      const y2 = Math.max(a.y + a.height, b.y + b.height);
      return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
    }

    static nextDrawOrder(state) {
      if (!state) return 0;
      state.drawOrderCounter = (Number(state.drawOrderCounter) || 0) + 1;
      return state.drawOrderCounter;
    }

    static sortedOverlappingOps(ops, bounds, beforeOrder) {
      const rect = ReplayState.normalizeRect(bounds);
      if (!Array.isArray(ops) || !rect) return [];
      return ops
        .filter((op) => op && op.drawOrder < beforeOrder && ReplayState.rectsOverlap(rect, op.bounds))
        .sort((a, b) => a.drawOrder - b.drawOrder);
    }

    static sortedOverlappingOpsAfter(ops, bounds, afterOrder) {
      const rect = ReplayState.normalizeRect(bounds);
      if (!Array.isArray(ops) || !rect) return [];
      return ops
        .filter((op) => op && op.drawOrder > afterOrder && ReplayState.rectsOverlap(rect, op.bounds))
        .sort((a, b) => a.drawOrder - b.drawOrder);
    }

    static partitionOverlappingOps(ops, bounds, drawOrder) {
      const order = Number(drawOrder);
      if (!Number.isFinite(order)) {
        return { before: [], after: [] };
      }
      return {
        before: ReplayState.sortedOverlappingOps(ops, bounds, order),
        after: ReplayState.sortedOverlappingOpsAfter(ops, bounds, order),
      };
    }

    static replayOps(target, ops, depthKey, clipRect) {
      if (!target || !Array.isArray(ops) || !ops.length) return 0;
      const key = depthKey || '__rpgTranslatorReplayDepth';
      target[key] = (target[key] || 0) + 1;
      const rect = ReplayState.normalizeRect(clipRect);
      const context = target.context || target._context;
      const clipped = rect && context && ['save', 'restore', 'beginPath', 'rect', 'clip'].every((name) => typeof context[name] === 'function');
      if (clipped) { context.save(); context.beginPath(); context.rect(rect.x, rect.y, rect.width, rect.height); context.clip(); }
      let count = 0;
      try {
        ops.forEach((op) => {
          if (!op || typeof op.original !== 'function') return;
          ReplayState.withTextStyle(target, op.drawStyle, () => op.original.apply(target, Array.isArray(op.args) ? op.args : []));
          count += 1;
        });
      } finally {
        if (clipped) context.restore();
        target[key] = Math.max(0, (target[key] || 1) - 1);
      }
      return count;
    }

    static captureTextStyle(target) {
      const style = {};
      for (const key of ['fontFace', 'fontSize', 'fontBold', 'fontItalic', 'textColor', 'outlineColor', 'outlineWidth', 'paintOpacity']) {
        if (target && key in target) style[key] = target[key];
      }
      return style;
    }

    static withTextStyle(target, style, callback) {
      if (!target || !style) return callback();
      const previous = ReplayState.captureTextStyle(target);
      Object.assign(target, style);
      try { return callback(); } finally { Object.assign(target, previous); }
    }

    static filterOutsideRect(items, rect) {
      const bounds = ReplayState.normalizeRect(rect);
      if (!bounds || !Array.isArray(items)) return Array.isArray(items) ? items : [];
      return items.filter((item) => !item || !ReplayState.rectsOverlap(bounds, item.bounds));
    }
  }

  function finite(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  publish(root, { ReplayState });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
