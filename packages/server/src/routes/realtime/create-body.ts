import { isPlainObject } from 'es-toolkit/predicate';

import { realtimeBodyTooLarge, realtimeInvalidOffer, realtimeUnsupportedMediaType } from './errors';
import { CODEX_REALTIME_MODEL } from './model';

/** The reference's `maxBodySize`. The server-wide `MAX_REQUEST_BODY_SIZE` is sized
 *  for image-edit multipart (~851 MB); buffering that for an SDP fallback would be
 *  a memory bomb. */
export const REALTIME_CREATE_BODY_LIMIT = 16_777_216;

export type RealtimeCreateBody = {
  /** Explicitly backed by `ArrayBuffer`, not `ArrayBufferLike`: each create attempt
   *  builds a fresh `Request` from these bytes, and only the narrowed form satisfies
   *  `BodyInit`. */
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly requestedModel: string;
};

const ACCEPTED = ['application/sdp', 'text/plain', 'application/json', 'multipart/form-data'] as const;

const MULTIPART = 'multipart/form-data';
const JSON_TYPE = 'application/json';

export async function readRealtimeCreateBody(request: Request): Promise<RealtimeCreateBody | Response> {
  const rawContentType = request.headers.get('content-type') ?? '';
  const contentType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ACCEPTED.includes(contentType as (typeof ACCEPTED)[number])) {
    await cancelRequestBody(request);
    return realtimeUnsupportedMediaType();
  }

  // A `Content-Encoding` create is refused rather than decoded: every downstream step
  // here reads the buffered bytes as UTF-8 JSON, so an encoded body would lose the
  // client's requested model to the fallback and silently skip the upstream model
  // rewrite, sending a body selection never agreed to. The cap would also measure
  // compressed bytes, so a 16 MiB archive could decompress far past it. Adding a
  // decoding path is outside what this endpoint was designed for, and `identity` is
  // rejected with the rest because permitting it buys nothing.
  if (request.headers.get('content-encoding') !== null) {
    await cancelRequestBody(request);
    return realtimeUnsupportedMediaType();
  }

  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > REALTIME_CREATE_BODY_LIMIT) {
    await cancelRequestBody(request);
    return realtimeBodyTooLarge();
  }

  const bytes = await readCappedBody(request);
  if (bytes === 'too-large') return realtimeBodyTooLarge();
  if (bytes === 'unreadable') return realtimeInvalidOffer('The realtime offer could not be read.');

  if (contentType === MULTIPART) return await readMultipart(bytes, rawContentType);
  if (contentType !== JSON_TYPE) return { body: bytes, contentType, requestedModel: CODEX_REALTIME_MODEL };
  return {
    body: bytes,
    contentType,
    requestedModel: jsonRequestedModel(parseJson(new TextDecoder().decode(bytes))),
  };
}

/** Mirrors `cancelRequestBody` in `packages/core/src/protocol/request.ts`: every
 *  terminal path releases the client's stream instead of leaving it unread. */
async function cancelRequestBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {}
}

/** A create may arrive chunked with no `Content-Length`, so the declared-length check
 *  cannot be the only guard. Reading through the stream stops at the cap instead of
 *  materializing an arbitrarily large body first. */
async function readCappedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | 'too-large' | 'unreadable'> {
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let outcome: 'ok' | 'too-large' | 'unreadable' = 'ok';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REALTIME_CREATE_BODY_LIMIT) {
        outcome = 'too-large';
        break;
      }
      chunks.push(value);
    }
  } catch {
    // The client aborted mid-upload. `readRealtimeCreateBody` promises a terminal
    // `Response`, so this becomes one rather than a rejection the route would have to
    // convert into a 500. The reason is discarded: it can quote offer bytes.
    outcome = 'unreadable';
  } finally {
    reader.releaseLock();
  }
  if (outcome !== 'ok') {
    await cancelRequestBody(request);
    return outcome;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readMultipart(
  bytes: Uint8Array<ArrayBuffer>,
  rawContentType: string,
): Promise<RealtimeCreateBody | Response> {
  // `boundary` is mandatory on multipart and its absence makes the body unparseable;
  // `formData` rejects rather than returning empty, and the rejection must not surface
  // the offer bytes.
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'content-type': rawContentType } }).formData();
  } catch {
    return realtimeInvalidOffer('The multipart realtime offer could not be parsed.');
  }

  const sdp = form.get('sdp');
  if (typeof sdp !== 'string' || sdp.length === 0) {
    return realtimeInvalidOffer('A multipart realtime offer must carry a non-empty sdp part.');
  }
  const rawSession = form.get('session');
  let session: unknown;
  if (typeof rawSession === 'string' && rawSession.length > 0) {
    session = parseJson(rawSession);
    if (session === undefined) return realtimeInvalidOffer('The multipart session part is not valid JSON.');
  }
  const payload = session === undefined ? { sdp } : { sdp, session };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  if (body.byteLength > REALTIME_CREATE_BODY_LIMIT) return realtimeBodyTooLarge();
  return { body, contentType: JSON_TYPE, requestedModel: jsonRequestedModel(payload) };
}

/** Normalization applies to selection; the wire body still needs the upstream model
 *  written into it. SDP and text bodies carry no model field, so they pass through.
 *
 *  A body with no `model` at all keeps none: the reference's `rewriteCallRequestModel`
 *  also only reassigns keys that are already present and returns the body unchanged
 *  otherwise, leaving the upstream free to apply its own default. */
export function withUpstreamModel(body: RealtimeCreateBody, normalized: string): RealtimeCreateBody {
  if (body.contentType !== JSON_TYPE) return body;
  const payload = parseJson(new TextDecoder().decode(body.body));
  if (!isPlainObject(payload)) return body;
  const session = payload['session'];
  const rewritten = {
    ...payload,
    ...(Object.hasOwn(payload, 'model') ? { model: normalized } : {}),
    ...(isPlainObject(session) ? { session: { ...session, model: normalized } } : {}),
  };
  return { ...body, body: new TextEncoder().encode(JSON.stringify(rewritten)) };
}

function jsonRequestedModel(payload: unknown): string {
  if (!isPlainObject(payload)) return CODEX_REALTIME_MODEL;
  const top = payload['model'];
  if (typeof top === 'string' && top.length > 0) return top;
  const session = payload['session'];
  if (isPlainObject(session)) {
    const nested = session['model'];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return CODEX_REALTIME_MODEL;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
