(function attach(root) {
  class StartupToast {
    constructor(options = {}) {
      this.document = options.document || root.document;
      this.setTimeout = resolveTimer(options.setTimeout);
      this.shown = false;
    }

    show(config = {}) {
      if (this.shown) return;
      this.shown = true;
      const doc = this.document;
      if (!doc || !doc.body || typeof doc.createElement !== 'function') return;
      const node = doc.createElement('div');
      node.textContent = config.startup_toast_text || 'RPG-Translator 작동중';
      Object.assign(node.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        zIndex: '999999',
        padding: '6px 10px',
        background: 'rgba(20, 20, 20, 0.82)',
        color: '#fff',
        font: '12px sans-serif',
        borderRadius: '4px',
        pointerEvents: 'none',
      });
      doc.body.appendChild(node);
      if (typeof this.setTimeout === 'function') {
        this.setTimeout(() => {
          if (typeof node.remove === 'function') node.remove();
        }, 1800);
      }
    }
  }

  function resolveTimer(timer) {
    if (timer && timer === root.setTimeout) return root.setTimeout.bind(root);
    if (timer) return timer;
    return root.setTimeout ? root.setTimeout.bind(root) : null;
  }

  publish(root, { StartupToast });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
