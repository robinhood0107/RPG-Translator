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

    static replayOps(target, ops, depthKey) {
      if (!target || !Array.isArray(ops) || !ops.length) return 0;
      const key = depthKey || '__rpgTranslatorReplayDepth';
      target[key] = (target[key] || 0) + 1;
      let count = 0;
      try {
        ops.forEach((op) => {
          if (!op || typeof op.original !== 'function') return;
          op.original.apply(target, Array.isArray(op.args) ? op.args : []);
          count += 1;
        });
      } finally {
        target[key] = Math.max(0, (target[key] || 1) - 1);
      }
      return count;
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
