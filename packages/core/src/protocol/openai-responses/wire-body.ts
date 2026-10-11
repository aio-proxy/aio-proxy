import { isPlainObject } from 'es-toolkit/predicate';

import { abortError, currentRequestBodyLimits, readJsonRequest } from '../request';

type WireBody = {
  readonly body: unknown;
  readonly encodedLimit: number;
  readonly decodedLimit: number;
  readonly contentEncoding: string | null;
  readonly lockedAfterRead: boolean;
  readonly abortedAtRead: boolean;
};

// Parsing and raw rewriting share one wire document. Weak ownership keeps it
// scoped to this inbound Request, including provider fallback, without
// extending its lifetime. Validation must receive detached containers so its
// result cannot mutate the wire document's otherwise unknown fields.
const wireBodies = new WeakMap<Request, WireBody>();

export async function readResponsesValidationBody(raw: Request): Promise<unknown> {
  return detachedWireContainers(await readResponsesWireBody(raw));
}

export async function readResponsesWireBody(raw: Request): Promise<unknown> {
  const limits = currentRequestBodyLimits();
  const contentEncoding = raw.headers.get('content-encoding');
  const cached = wireBodies.get(raw);
  if (
    cached !== undefined &&
    cached.encodedLimit === limits.encoded &&
    cached.decodedLimit === limits.decoded &&
    cached.contentEncoding === contentEncoding
  ) {
    // Bun may expose its own clone/tee lock on the retained inbound stream.
    // Reject a new external lock, but preserve reads supported by raw.clone().
    if (raw.bodyUsed || (raw.body?.locked === true && !cached.lockedAfterRead))
      throw new TypeError('Cannot read a used or locked request body');
    // The existing reader lets an already buffered read settle on a pre-aborted
    // signal. Preserve that case; a later disconnect must stop cached replay.
    if (raw.signal.aborted && !cached.abortedAtRead) throw abortError(raw.signal.reason);
    return cached.body;
  }
  wireBodies.delete(raw);
  const body = await readJsonRequest(raw, limits);
  wireBodies.set(raw, {
    body,
    encodedLimit: limits.encoded,
    decodedLimit: limits.decoded,
    contentEncoding,
    lockedAfterRead: raw.body?.locked === true,
    abortedAtRead: raw.signal.aborted,
  });
  return body;
}

// Unknown wire fields may be arbitrarily deep. Recursive clone helpers would
// reject documents the existing loose schemas accept. Copy just containers in
// an iterative walk; immutable image/base64 strings remain shared.
function detachedWireContainers(body: unknown): unknown {
  if (!Array.isArray(body) && !isPlainObject(body)) return body;
  const result = Array.isArray(body) ? new Array<unknown>(body.length) : {};
  const pending = [{ source: body, target: result }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    for (const key of Object.keys(entry.source)) {
      const value: unknown = Reflect.get(entry.source, key);
      const container = Array.isArray(value) || isPlainObject(value);
      const copy = container ? (Array.isArray(value) ? new Array<unknown>(value.length) : {}) : value;
      // JSON's __proto__ is an ordinary own field, never a prototype setter.
      Object.defineProperty(entry.target, key, { value: copy, writable: true, configurable: true, enumerable: true });
      if (Array.isArray(value) || isPlainObject(value)) {
        pending.push({ source: value, target: copy as unknown[] | Record<string, unknown> });
      }
    }
  }
  return result;
}
