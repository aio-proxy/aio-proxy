const USAGE_KEYS = new Set(['usage', 'usageMetadata']);
// Token-count objects are tiny. Cap the captured value so a malicious or
// mislabeled "usage" payload cannot become an unbounded second buffer.
const MAX_USAGE_VALUE_CHARS = 8 * 1024;

export type JsonUsageScan = {
  readonly push: (chunk: Uint8Array) => void;
  // Flush the UTF-8 decoder and finish a value that ends at EOF.
  readonly finish: () => void;
  // Complete JSON document containing only the last top-level usage object.
  readonly text: () => string | undefined;
};

// Extracts a top-level `usage` / `usageMetadata` object from a JSON stream
// without retaining the rest of the body. Nested objects with those keys
// (for example a vector item) are ignored.
export function createJsonUsageScan(): JsonUsageScan {
  const decoder = new TextDecoder();
  const scanner = createScanner();
  return {
    push: (chunk) => scanner.consume(decoder.decode(chunk, { stream: true })),
    finish: () => {
      scanner.consume(decoder.decode());
      scanner.end();
    },
    text: () => scanner.text(),
  };
}

function createScanner() {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectingKey = false;
  let readingKey = false;
  let keyRaw = '';
  let pendingKey: string | undefined;
  let capturing = false;
  let captureKey: string | undefined;
  let capture = '';
  let captureStartDepth = 0;
  let lastWrapper: string | undefined;

  const consume = (text: string): void => {
    for (const character of text) step(character);
  };

  const step = (character: string): void => {
    if (capturing) {
      stepCapture(character);
      return;
    }
    if (inString) {
      stepString(character);
      return;
    }
    if (isWhitespace(character)) return;
    if (pendingKey !== undefined) {
      if (character === ':') {
        startCapture();
        return;
      }
      pendingKey = undefined;
    }
    if (character === '"') {
      inString = true;
      escaped = false;
      if (expectingKey && depth === 1) {
        readingKey = true;
        keyRaw = '';
      }
      return;
    }
    if (character === '{' || character === '[') {
      depth += 1;
      expectingKey = character === '{';
      return;
    }
    if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1);
      expectingKey = false;
      return;
    }
    if (character === ',') expectingKey = depth >= 1;
  };

  const startCapture = (): void => {
    capturing = true;
    captureKey = pendingKey;
    pendingKey = undefined;
    capture = '';
    captureStartDepth = depth;
  };

  const stepString = (character: string): void => {
    if (escaped) {
      if (readingKey) keyRaw += character;
      escaped = false;
      return;
    }
    if (character === '\\') {
      if (readingKey) keyRaw += character;
      escaped = true;
      return;
    }
    if (character === '"') {
      inString = false;
      if (readingKey) {
        const key = decodeJsonString(keyRaw);
        if (key !== undefined && USAGE_KEYS.has(key)) pendingKey = key;
        readingKey = false;
        keyRaw = '';
        expectingKey = false;
      }
      return;
    }
    if (readingKey) keyRaw += character;
  };

  const stepCapture = (character: string): void => {
    if (capture === '' && isWhitespace(character)) return;
    if (capture.length >= MAX_USAGE_VALUE_CHARS) {
      capturing = false;
      capture = '';
      captureKey = undefined;
      return;
    }

    if (inString) {
      capture += character;
      if (escaped) {
        escaped = false;
        return;
      }
      if (character === '\\') {
        escaped = true;
        return;
      }
      if (character === '"') {
        inString = false;
        if (depth === captureStartDepth) finishCapture();
      }
      return;
    }

    if (character === '"') {
      capture += character;
      inString = true;
      escaped = false;
      return;
    }

    if (character === '{' || character === '[') {
      capture += character;
      depth += 1;
      return;
    }

    if (character === '}' || character === ']') {
      capture += character;
      depth -= 1;
      if (depth === captureStartDepth) finishCapture();
      return;
    }

    if (depth === captureStartDepth && (character === ',' || character === '}' || character === ']')) {
      finishCapture();
      step(character);
      return;
    }

    capture += character;
  };

  const finishCapture = (): void => {
    capturing = false;
    if (captureKey !== undefined) {
      const wrapper = wrapUsage(captureKey, capture);
      if (wrapper !== undefined) lastWrapper = wrapper;
    }
    capture = '';
    captureKey = undefined;
    expectingKey = false;
  };

  return {
    consume,
    end: () => {
      if (capturing) finishCapture();
    },
    text: () => lastWrapper,
  };
}

function wrapUsage(key: string, value: string): string | undefined {
  if (value === '') return undefined;
  const text = `{${JSON.stringify(key)}:${value}}`;
  return parseJson(text) === undefined ? undefined : text;
}

function decodeJsonString(raw: string): string | undefined {
  const parsed = parseJson(`"${raw}"`);
  return typeof parsed === 'string' ? parsed : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\n' || character === '\r' || character === '\t';
}
