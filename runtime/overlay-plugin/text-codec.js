(function attach(root) {
  const CONTROL_CODE_PLACEHOLDER = '\u00a4';

  class TextCodec {
    static analyze(input) {
      const originalText = String(input ?? '');
      const normalizedText = normalizeLineEndings(originalText);
      const controlCodes = collectControlCodes(normalizedText);
      const visibleText = stripControlCodes(normalizedText);
      return {
        originalText,
        normalizedText,
        visibleText,
        controlCodes,
        controlCodeSignature: controlCodes.join('|'),
      };
    }

    static encodeForProvider(input) {
      const normalized = normalizeLineEndings(String(input ?? ''));
      let providerText = '';
      const controlCodes = [];
      let index = 0;

      while (index < normalized.length) {
        const end = controlCodeEnd(normalized, index);
        if (end !== null) {
          controlCodes.push(normalized.slice(index, end));
          providerText += CONTROL_CODE_PLACEHOLDER;
          index = end;
        } else {
          const char = nextChar(normalized, index);
          providerText += char.value;
          index += char.length;
        }
      }

      return {
        providerText,
        controlCodes,
        controlCodeSignature: controlCodes.join('|'),
      };
    }

    static restoreProviderTranslation(translation, state) {
      const controlCodes = Array.isArray(state && state.controlCodes) ? state.controlCodes : [];
      let placeholderCount = 0;
      for (const char of String(translation ?? '')) {
        if (char === CONTROL_CODE_PLACEHOLDER) placeholderCount += 1;
      }
      if (placeholderCount !== controlCodes.length) {
        throw new Error(`placeholder mismatch: expected ${controlCodes.length}, got ${placeholderCount}`);
      }

      let output = '';
      let controlIndex = 0;
      for (const char of String(translation ?? '')) {
        if (char === CONTROL_CODE_PLACEHOLDER) {
          output += controlCodes[controlIndex] || '';
          controlIndex += 1;
        } else {
          output += char;
        }
      }
      return output;
    }
  }

  function normalizeLineEndings(input) {
    return String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function collectControlCodes(input) {
    const tokens = [];
    let index = 0;
    while (index < input.length) {
      const end = controlCodeEnd(input, index);
      if (end !== null) {
        tokens.push(input.slice(index, end));
        index = end;
      } else {
        index += nextChar(input, index).length;
      }
    }
    return tokens;
  }

  function stripControlCodes(input) {
    let output = '';
    let index = 0;
    while (index < input.length) {
      const end = controlCodeEnd(input, index);
      if (end !== null) {
        index = end;
      } else {
        const char = nextChar(input, index);
        output += char.value;
        index += char.length;
      }
    }
    return output;
  }

  function controlCodeEnd(input, start) {
    const marker = input[start];
    if (marker !== '\\' && marker !== '\u001b') return null;
    let end = start + 1;
    const first = input[end];
    if (!first) return null;

    if (isIdentifierControlChar(first)) {
      while (end < input.length && isIdentifierControlChar(input[end])) {
        end += 1;
      }
    } else if (!/\s/u.test(first) && !isAsciiWordChar(first)) {
      end += 1;
    } else {
      return null;
    }

    if (input[end] === '[') {
      end = consumeUntil(input, end, ']');
    } else if (input[end] === '<') {
      end = consumeUntil(input, end, '>');
    }
    return end;
  }

  function consumeUntil(input, start, terminator) {
    let end = start;
    while (end < input.length) {
      const char = nextChar(input, end);
      end += char.length;
      if (char.value === terminator) break;
    }
    return end;
  }

  function isIdentifierControlChar(char) {
    return /^[A-Za-z0-9_#]$/u.test(char);
  }

  function isAsciiWordChar(char) {
    return /^[A-Za-z0-9_]$/u.test(char);
  }

  function nextChar(input, index) {
    const code = input.codePointAt(index);
    if (code === undefined) return { value: '', length: 1 };
    const value = String.fromCodePoint(code);
    return { value, length: value.length };
  }

  publish(root, { TextCodec });
})(globalThis);

function publish(root, api) {
  root.RPGTranslatorOverlay = Object.assign(root.RPGTranslatorOverlay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}
