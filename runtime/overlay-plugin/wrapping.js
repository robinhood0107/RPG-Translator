(function attach(root) {
  class MessageWrapper {
    static wrap(text, options = {}) {
      const capacity = resolveCapacity(options.window, options.capacity);
      const allowSoftWrap = canSoftWrap(options.window);
      const output = [];
      for (const hardLine of String(text ?? '').replace(/\r\n?/gu, '\n').split('\n')) {
        if (allowSoftWrap) pushWrappedLine(output, hardLine, capacity);
        else pushUnwrappedLine(output, hardLine);
      }
      return output.length > 0 ? output : [''];
    }
  }

  function pushUnwrappedLine(output, line) {
    const tokens = tokenize(line);
    let current = '';
    for (const token of tokens) {
      if (token.type === 'page') {
        output.push(cleanupLine(current));
        current = '';
        output.push(token.raw);
        continue;
      }
      current += token.raw;
    }
    output.push(cleanupLine(current));
  }

  function pushWrappedLine(output, line, capacity) {
    const tokens = tokenize(line);
    let current = '';
    let width = 0;
    let lastBreak = -1;
    for (const token of tokens) {
      if (token.type === 'page') {
        output.push(cleanupLine(current));
        current = '';
        width = 0;
        lastBreak = -1;
        output.push(token.raw);
        continue;
      }
      const nextWidth = width + token.width;
      if (width > 0 && token.width > 0 && nextWidth > capacity) {
        if (token.breakable) {
          output.push(cleanupLine(current));
          current = '';
          width = 0;
        } else if (lastBreak >= 0) {
          output.push(cleanupLine(current.slice(0, lastBreak)));
          current = current.slice(lastBreak).trimStart();
          width = measureLine(current);
        } else {
          output.push(cleanupLine(current));
          current = '';
          width = 0;
        }
        lastBreak = -1;
        if (token.breakable) continue;
      }
      current += token.raw;
      width += token.width;
      if (token.breakable) lastBreak = current.length;
    }
    output.push(cleanupLine(current));
  }

  function tokenize(line) {
    const tokens = [];
    for (let index = 0; index < line.length;) {
      const char = line[index];
      if (char === '\x1b' || char === '\\') {
        const token = readEscapeToken(line, index);
        tokens.push(token);
        index += token.raw.length;
        continue;
      }
      if (char === '\f') {
        tokens.push({ type: 'page', raw: char, width: 0, breakable: false });
        index += 1;
        continue;
      }
      const codePoint = line.codePointAt(index);
      const raw = String.fromCodePoint(codePoint);
      tokens.push({
        type: 'text',
        raw,
        width: charWidth(raw),
        breakable: /\s/u.test(raw),
      });
      index += raw.length;
    }
    return tokens;
  }

  function readEscapeToken(line, start) {
    const prefix = line[start];
    const rest = line.slice(start + 1);
    const match = rest.match(/^([A-Za-z]+|[{}.$|!><^\\])(?:\[(\d+)\])?/u);
    if (!match) {
      return { type: 'text', raw: prefix, width: 0, breakable: false };
    }
    const raw = `${prefix}${match[0]}`;
    const command = match[1].toUpperCase();
    const width = command === 'I' ? 2 : 0;
    return { type: 'escape', raw, width, breakable: false };
  }

  function resolveCapacity(windowInstance, explicitCapacity) {
    if (Number.isFinite(explicitCapacity) && explicitCapacity > 0) {
      return Math.max(4, Math.floor(explicitCapacity));
    }
    const contentsWidth = resolveContentsWidth(windowInstance);
    const unit = resolveTextUnit(windowInstance);
    if (Number.isFinite(contentsWidth) && contentsWidth > unit) {
      return Math.max(8, Math.floor(contentsWidth / unit));
    }
    return 42;
  }

  function resolveContentsWidth(windowInstance) {
    if (!windowInstance) return NaN;
    if (typeof windowInstance.contentsWidth === 'function') {
      return Number(windowInstance.contentsWidth());
    }
    if (windowInstance.contents && Number.isFinite(Number(windowInstance.contents.width))) {
      return Number(windowInstance.contents.width);
    }
    return Number(windowInstance.width || 0) - 48;
  }

  function resolveTextUnit(windowInstance) {
    if (!windowInstance) return 12;
    if (typeof windowInstance.textWidth === 'function') {
      return Math.max(1, Number(windowInstance.textWidth('M')) || 12);
    }
    if (windowInstance.contents && typeof windowInstance.contents.measureTextWidth === 'function') {
      return Math.max(1, Number(windowInstance.contents.measureTextWidth('M')) || 12);
    }
    return 12;
  }

  function canSoftWrap(windowInstance) {
    if (!windowInstance) return true;
    const contentsHeight = Number(windowInstance.contents && windowInstance.contents.height);
    const lineHeight = resolveLineHeight(windowInstance);
    if (!Number.isFinite(contentsHeight) || contentsHeight <= 0 || contentsHeight === Number.MAX_SAFE_INTEGER) {
      return true;
    }
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return true;
    return contentsHeight >= lineHeight * 2;
  }

  function resolveLineHeight(windowInstance) {
    if (!windowInstance) return NaN;
    if (typeof windowInstance.lineHeight === 'function') {
      const nativeLineHeight = Number(windowInstance.lineHeight());
      if (Number.isFinite(nativeLineHeight) && nativeLineHeight > 0) {
        return Math.max(1, Math.ceil(nativeLineHeight));
      }
    }
    const fontSize = Number(windowInstance.contents && windowInstance.contents.fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0) return fontSize + 8;
    return 32;
  }

  function measureLine(line) {
    return tokenize(line).reduce((total, token) => total + token.width, 0);
  }

  function charWidth(char) {
    if (!char || /\s/u.test(char)) return 1;
    const code = char.codePointAt(0);
    if (
      (code >= 0x1100 && code <= 0x11ff)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff01 && code <= 0xff60)
    ) {
      return 2;
    }
    return 1;
  }

  function cleanupLine(line) {
    return String(line ?? '').replace(/[ \t]+$/u, '');
  }

  publish(root, { MessageWrapper });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
