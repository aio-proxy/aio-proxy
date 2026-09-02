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
  const stringState: StringScanState = {
    inString: false,
    escaped: false,
    expectingKey: false,
    readingKey: false,
    keyValue: '',
    keyTooLong: false,
  };
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
    if (stringState.inString) return stepString(stringState, character);
    if (isWhitespace(character)) return;
    if (stringState.pendingKey !== undefined) {
      if (character === ':') {
        startCapture();
        return;
      }
      stringState.pendingKey = undefined;
    }
    if (character === '"') {
      stringState.inString = true;
      stringState.escaped = false;
      if (stringState.expectingKey && depth === 1) {
        stringState.readingKey = true;
        stringState.keyValue = '';
        stringState.keyUnicode = undefined;
        stringState.keyTooLong = false;
      }
      return;
    }
    if (character === '{' || character === '[') {
      depth += 1;
      stringState.expectingKey = character === '{';
      return;
    }
    if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1);
      stringState.expectingKey = false;
      return;
    }
    if (character === ',') stringState.expectingKey = depth >= 1;
  };
  const startCapture = (): void => {
    capturing = true;
    captureKey = stringState.pendingKey;
    stringState.pendingKey = undefined;
    capture = '';
    captureStartDepth = depth;
    discardingCapture = false;
  };
  const stepCapture = (character: string): void => {
    if (capture === '' && isWhitespace(character)) return;
    if (!discardingCapture && capture.length >= MAX_USAGE_VALUE_CHARS) {
      discardingCapture = true;
      capture = '';
      captureKey = undefined;
    }

    if (stringState.inString) {
      if (!discardingCapture) capture += character;
      if (stringState.escaped) {
        stringState.escaped = false;
        return;
      }
      if (character === '\\') {
        stringState.escaped = true;
        return;
      }
      if (character === '"') {
        stringState.inString = false;
        if (depth === captureStartDepth) finishCapture();
      }
      return;
    }

    if (character === '"') {
      if (!discardingCapture) capture += character;
      stringState.inString = true;
      stringState.escaped = false;
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
    stringState.expectingKey = false;
  };

  return {
    consume,
    end: () => {
      if (capturing) finishCapture();
    },
    text: () => wrapCaptured(id, status, lastUsage),
  };
}

type StringScanState = {
  inString: boolean;
  escaped: boolean;
  expectingKey: boolean;
  readingKey: boolean;
  keyValue: string;
  keyUnicode?: string;
  keyTooLong: boolean;
  pendingKey?: string;
};

function stepString(state: StringScanState, character: string): void {
  if (state.readingKey && state.keyUnicode !== undefined) {
    if (/^[0-9a-f]$/iu.test(character)) {
      state.keyUnicode += character;
      if (state.keyUnicode.length === 4) {
        appendKeyCharacter(state, String.fromCharCode(Number.parseInt(state.keyUnicode, 16)));
        state.keyUnicode = undefined;
        state.escaped = false;
      }
    } else {
      state.keyUnicode = undefined;
      state.escaped = false;
      state.keyTooLong = true;
    }
    return;
  }
  if (state.escaped) {
    if (state.readingKey) {
      if (character === 'u') {
        state.keyUnicode = '';
        return;
      }
      const decoded = decodeJsonString(`\\${character}`);
      if (decoded === undefined) state.keyTooLong = true;
      else appendKeyCharacter(state, decoded);
    }
    state.escaped = false;
    return;
  }
  if (character === '\\') {
    state.escaped = true;
    return;
  }
  if (character === '"') {
    state.inString = false;
    if (state.readingKey) {
      const key = state.keyTooLong ? undefined : state.keyValue;
      if (key !== undefined && (USAGE_KEYS.has(key) || IDENTITY_KEYS.has(key))) state.pendingKey = key;
      state.readingKey = false;
      state.keyValue = '';
      state.keyUnicode = undefined;
      state.keyTooLong = false;
      state.expectingKey = false;
    }
    return;
  }
  if (state.readingKey) appendKeyCharacter(state, character);
}

function appendKeyCharacter(state: StringScanState, character: string): void {
  if (state.keyValue.length < MAX_CANDIDATE_KEY_CHARS) state.keyValue += character;
  else state.keyTooLong = true;
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
