// HTML로 표시하는 게임 문구를 관찰합니다. 입력값과 선택지 식별자는 바꾸지 않습니다.
(function attach(root) {
  class DomTextAdapter {
    static install(scope, translator) {
      const document = scope && scope.document;
      if (!document || !document.body || !scope.MutationObserver || !translator || !translator.observeRecord) return false;
      const overlay = scope.RPGTranslatorOverlay || {};
      if (overlay.__domTextObserver) return true;
      const records = new WeakMap();
      let nextId = 1;

      const ignored = (element, attribute) => !element || !!(element.closest && (
        element.closest('script,style,noscript,[data-rpg-translator-toast],[data-rpg-translator-ui],#errorPrinter,#loadingSpinner')
        || (!attribute && element.closest('textarea,input,[contenteditable]'))
      ));

      function attributesFor(element) {
        const names = ['title', 'placeholder', 'aria-label'];
        if (['OPTION', 'OPTGROUP'].includes(element.tagName)) names.push('label');
        if (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(String(element.getAttribute('type') || '').toLowerCase())) names.push('value');
        return names;
      }

      function observe(node, attribute = null) {
        const element = attribute ? node : node.parentElement;
        if (ignored(element, attribute) || node.isConnected === false || (attribute === 'value' && !attributesFor(element).includes('value'))) return;
        const raw = attribute ? node.getAttribute(attribute) : node.nodeValue;
        if (typeof raw !== 'string' || !/[\p{L}]/u.test(raw)) return;
        let slots = records.get(node);
        if (!slots) { slots = new Map(); records.set(node, slots); }
        const key = attribute || 'text';
        const previous = slots.get(key);
        if (previous && previous.drawn === raw) return;
        const source = raw.trim();
        const prefix = raw.slice(0, raw.indexOf(source));
        const suffix = raw.slice(prefix.length + source.length);
        const record = { id: previous ? previous.id : nextId++, source, drawn: null };
        slots.set(key, record);
        const command = translator.observeRecord({
          engine: overlay.engine || 'unknown', sourceLanguage: overlay.sourceLanguage,
          targetLanguage: overlay.targetLanguage, text: source, surface: node,
          adapter: 'dom-text', kind: attribute || 'text-node', slotKey: `dom:${record.id}:${key}`,
        });
        function render(ready) {
          if (!ready || node.isConnected === false || slots.get(key) !== record
            || (attribute === 'value' && !attributesFor(element).includes('value'))) return false;
          const current = attribute ? node.getAttribute(attribute) : node.nodeValue;
          if (current !== raw || !translator.acceptRender(ready, node, source)) return false;
          record.drawn = prefix + ready.translatedText + suffix;
          if (attribute) node.setAttribute(attribute, record.drawn);
          else {
            // option의 표시 문구가 바뀌어도 실제 선택 값은 그대로 유지합니다.
            if (element.tagName === 'OPTION' && !element.hasAttribute('value')) element.value = element.textContent;
            node.nodeValue = record.drawn;
          }
          return true;
        }
        if (command && command.status === 'hit') render(command);
        else if (typeof translator.onTranslationReady === 'function') translator.onTranslationReady(command, render);
      }

      function scan(node) {
        if (!node) return;
        if (node.nodeType === 3) { observe(node); return; }
        if (node.nodeType !== 1 && node.nodeType !== 11) return;
        if (node.nodeType === 1) for (const name of attributesFor(node)) {
          if (node.hasAttribute(name)) observe(node, name);
        }
        const walker = document.createTreeWalker(node, 4);
        let text;
        while ((text = walker.nextNode())) observe(text);
        if (node.querySelectorAll) for (const element of node.querySelectorAll('[title],[placeholder],[aria-label],input,option[label],optgroup[label]')) {
          for (const name of attributesFor(element)) if (element.hasAttribute(name)) observe(element, name);
        }
      }

      function retire(node) {
        translator.retireSurface(node, 'dom-detached');
        if (node.nodeType === 1 || node.nodeType === 11) {
          const walker = document.createTreeWalker(node, 4);
          let text;
          while ((text = walker.nextNode())) translator.retireSurface(text, 'dom-detached');
          if (node.querySelectorAll) for (const element of node.querySelectorAll('*')) translator.retireSurface(element, 'dom-detached');
        }
      }

      const observer = new scope.MutationObserver((changes) => {
        for (const change of changes) {
          if (change.type === 'characterData') observe(change.target);
          else if (change.type === 'attributes') {
            if (change.attributeName === 'type') scan(change.target);
            else observe(change.target, change.attributeName);
          }
          else {
            for (const node of change.removedNodes || []) retire(node);
            for (const node of change.addedNodes || []) scan(node);
          }
        }
      });
      observer.observe(document.body, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label', 'value', 'type', 'label']
      });
      overlay.__domTextObserver = observer;
      scan(document.body);
      const title = document.querySelector && document.querySelector('title');
      if (title) scan(title);
      if (document.head) observer.observe(document.head, { subtree: true, childList: true, characterData: true });
      return true;
    }
  }

  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, { DomTextAdapter });
  if (typeof module !== 'undefined' && module.exports) module.exports = { DomTextAdapter };
})(globalThis);
