const USAGE_KEYS = new Set(['usage', 'usageMetadata']);
const IDENTITY_KEYS = new Set(['id', 'status']);
const MAX_CANDIDATE_KEY_CHARS = Math.max(...[...USAGE_KEYS, ...IDENTITY_KEYS].map((key) => key.length));
// Token-count objects are tiny. Cap the captured value so a malicious or
// mislabeled "usage" payload cannot become an unbounded second buffer.
const MAX_USAGE_VALUE_CHARS = 8 * 1024;

export type JsonUsageScan = {
  readonly push: (chunk: Uint8Array) => void;
  // Flush the UTF-8 decoder and finish a value that ends at EOF.
  readonly finish: () => void;
  // Complete JSON document containing retained top-level usage and identity fields.
  readonly text: () => string | undefined;
};

// Extracts top-level usage and identity fields from a JSON stream without
// retaining the rest of the body. Nested fields are ignored.
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
  let keyTooLong = false;
  let pendingKey: string | undefined;
  let capturing = false;
  let captureKey: string | undefined;
  let capture = '';
  let captureStartDepth = 0;
  let discardingCapture = false;
  let lastUsage: readonly [string, string] | undefined;
  let id: string | undefined;
  let status: string | undefined;
  const consume = (text: string): void => {
    for (const character of text) step(character);
  };
  const step = (character: string): void => {
    if (capturing) return stepCapture(character);
    if (inString) return stepString(character);
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
        keyTooLong = false;
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
    discardingCapture = false;
  };
  const appendKeyCharacter = (character: string): void => {
    if (keyRaw.length < MAX_CANDIDATE_KEY_CHARS) keyRaw += character;
    else keyTooLong = true;
  };
  const stepString = (character: string): void => {
    if (escaped) {
      if (readingKey) appendKeyCharacter(character);
      escaped = false;
      return;
    }
    if (character === '\\') {
      if (readingKey) appendKeyCharacter(character);
      escaped = true;
      return;
    }
    if (character === '"') {
      inString = false;
      if (readingKey) {
        const key = keyTooLong ? undefined : decodeJsonString(keyRaw);
        if (key !== undefined && (USAGE_KEYS.has(key) || IDENTITY_KEYS.has(key))) pendingKey = key;
        readingKey = false;
        keyRaw = '';
        keyTooLong = false;
        expectingKey = false;
      }
      return;
    }
    if (readingKey) appendKeyCharacter(character);
  };
  const stepCapture = (character: string): void => {
    if (capture === '' && isWhitespace(character)) return;
    if (!discardingCapture && capture.length >= MAX_USAGE_VALUE_CHARS) {
      discardingCapture = true;
      capture = '';
      captureKey = undefined;
    }

    if (inString) {
      if (!discardingCapture) capture += character;
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
      if (!discardingCapture) capture += character;
      inString = true;
      escaped = false;
      return;
    }

    if (character === '{' || character === '[') {
      if (!discardingCapture) capture += character;
      depth += 1;
      return;
    }

    if (character === '}' || character === ']') {
      if (!discardingCapture) capture += character;
      depth -= 1;
      if (depth === captureStartDepth) finishCapture();
      return;
    }

    if (depth === captureStartDepth && (character === ',' || character === '}' || character === ']')) {
      finishCapture();
      step(character);
      return;
    }

    if (!discardingCapture) capture += character;
  };

  const finishCapture = (): void => {
    capturing = false;
    if (captureKey !== undefined) {
      if (USAGE_KEYS.has(captureKey) && validValue(capture) !== undefined) lastUsage = [captureKey, capture];
      if (IDENTITY_KEYS.has(captureKey)) {
        const value = stringValue(capture);
        if (captureKey === 'id') id = value;
        if (captureKey === 'status') status = value;
      }
    }
    capture = '';
    captureKey = undefined;
    discardingCapture = false;
    expectingKey = false;
  };

  return {
    consume,
    end: () => {
      if (capturing) finishCapture();
    },
    text: () => wrapCaptured(id, status, lastUsage),
  };
}

function wrapCaptured(
  id: string | undefined,
  status: string | undefined,
  usage: readonly [string, string] | undefined,
): string | undefined {
  const entries = [
    ...(id === undefined ? [] : [[JSON.stringify('id'), JSON.stringify(id)]]),
    ...(status === undefined ? [] : [[JSON.stringify('status'), JSON.stringify(status)]]),
    ...(usage === undefined ? [] : [[JSON.stringify(usage[0]), usage[1]]]),
  ];
  return entries.length === 0 ? undefined : `{${entries.map(([key, value]) => `${key}:${value}`).join(',')}}`;
}

function validValue(value: string): unknown | undefined {
  return value === '' ? undefined : parseJson(value);
}

function stringValue(value: string): string | undefined {
  const parsed = validValue(value);
  return typeof parsed === 'string' ? parsed : undefined;
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
