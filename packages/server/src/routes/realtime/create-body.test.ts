import { expect, test } from 'bun:test';

import { readRealtimeCreateBody, REALTIME_CREATE_BODY_LIMIT, withUpstreamModel } from './create-body';

test('a multipart offer becomes JSON and takes its requested model from the session part', async () => {
  const form = new FormData();
  form.set('sdp', 'v=0\r\n');
  form.set('session', JSON.stringify({ model: 'gpt-realtime', voice: 'cedar' }));

  const result = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));
  if (result instanceof Response) throw new Error(`expected a normalized body, got ${result.status}`);

  expect(result.contentType).toBe('application/json');
  expect(result.requestedModel).toBe('gpt-realtime');
  expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
    sdp: 'v=0\r\n',
    session: { model: 'gpt-realtime', voice: 'cedar' },
  });
});

test('a multipart offer missing sdp, or with an unparseable session, is 400 realtime_invalid_offer', async () => {
  const missingSdp = new FormData();
  missingSdp.set('session', '{}');
  const emptySdp = new FormData();
  emptySdp.set('sdp', '');
  const badSession = new FormData();
  badSession.set('sdp', 'v=0\r\n');
  badSession.set('session', 'not json');

  for (const form of [missingSdp, emptySdp, badSession]) {
    const result = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_invalid_offer');
  }
});

test('a file-delivered session part is honored, not silently dropped along with its model', async () => {
  const form = new FormData();
  form.set('sdp', 'v=0\r\n');
  form.set(
    'session',
    new Blob([JSON.stringify({ model: 'gpt-4o-realtime-preview', voice: 'cedar' })], { type: 'application/json' }),
    'session.json',
  );

  const result = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));
  if (result instanceof Response) throw new Error(`expected a normalized body, got ${result.status}`);

  // A dropped session part would 201 with the codex fallback model and lose `voice`.
  expect(result.requestedModel).toBe('gpt-4o-realtime-preview');
  expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
    sdp: 'v=0\r\n',
    session: { model: 'gpt-4o-realtime-preview', voice: 'cedar' },
  });
});

test('a file-delivered sdp part is accepted rather than reported as missing', async () => {
  const form = new FormData();
  form.set('sdp', new Blob(['v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n'], { type: 'application/sdp' }), 'offer.sdp');

  const result = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));
  if (result instanceof Response) throw new Error(`expected a normalized body, got ${result.status}`);

  expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' });
  expect(result.requestedModel).toBe('gpt-live-1-codex');
});

test('a part whose bytes cannot be read is a 400 that quotes neither the reason nor the filename', async () => {
  const form = new FormData();
  form.set('sdp', new Blob(['v=0\r\n']), 'offer.sdp');
  form.set('session', new Blob(['{}']), 'session.json');
  const request = new Request('http://x/v1/live', { method: 'POST', body: form });

  const original = Blob.prototype.text;
  // The only way to reach the `text()` rejection branch: a real detached backing store is
  // not constructible in-process, and the module must still answer rather than reject.
  Blob.prototype.text = function (): Promise<string> {
    return Promise.reject(new Error('backing store gone: /tmp/offer.sdp'));
  };
  let result: Awaited<ReturnType<typeof readRealtimeCreateBody>>;
  try {
    result = await readRealtimeCreateBody(request);
  } finally {
    Blob.prototype.text = original;
  }

  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('realtime_invalid_offer');
  expect(body.error.message).toBe('The realtime offer could not be read.');
  expect(body.error.message).not.toContain('offer.sdp');
  expect(body.error.message).not.toContain('backing store');
});

test('raw SDP and text/plain offers are forwarded verbatim with the normalized model', async () => {
  const result = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n',
      headers: { 'content-type': 'application/sdp' },
    }),
  );
  if (result instanceof Response) throw new Error(`expected a normalized body, got ${result.status}`);

  expect(result.contentType).toBe('application/sdp');
  expect(new TextDecoder().decode(result.body)).toBe('v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n');
  expect(result.requestedModel).toBe('gpt-live-1-codex');
});

test('a JSON offer reads model, then falls back to session.model', async () => {
  const topLevel = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', model: 'gpt-realtime' }));
  const nested = await readRealtimeCreateBody(
    jsonRequest({ sdp: 'v=0', session: { model: 'gpt-4o-realtime-preview' } }),
  );
  const absent = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0' }));

  expect((topLevel as { requestedModel: string }).requestedModel).toBe('gpt-realtime');
  expect((nested as { requestedModel: string }).requestedModel).toBe('gpt-4o-realtime-preview');
  expect((absent as { requestedModel: string }).requestedModel).toBe('gpt-live-1-codex');
});

// `normalizeRealtimeModel` trims before it maps, so an untrimmed requested model disagrees
// with its own normalized form — and the exclusion check compares `excludedModels` against
// both. `" gpt-realtime "` matched neither, so a provider excluding `gpt-realtime` stayed
// eligible for a request the wire body was then rewritten to `gpt-live-1-codex` for.
// Whitespace-only is treated as naming no model at all, so the `session.model` fallback and
// then the Codex default apply rather than a blank selection key reaching the selector.
test('a requested model is trimmed at the boundary, and a blank one names no model', async () => {
  const padded = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', model: ' gpt-realtime ' }));
  const paddedNested = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', session: { model: '\tcustom-live ' } }));
  const blankFallsBack = await readRealtimeCreateBody(
    jsonRequest({ sdp: 'v=0', model: '   ', session: { model: 'custom-live-model' } }),
  );
  const blankThroughout = await readRealtimeCreateBody(
    jsonRequest({ sdp: 'v=0', model: '  ', session: { model: '' } }),
  );

  expect((padded as { requestedModel: string }).requestedModel).toBe('gpt-realtime');
  expect((paddedNested as { requestedModel: string }).requestedModel).toBe('custom-live');
  expect((blankFallsBack as { requestedModel: string }).requestedModel).toBe('custom-live-model');
  expect((blankThroughout as { requestedModel: string }).requestedModel).toBe('gpt-live-1-codex');
});

// The 128-character bound measures the trimmed id, not the padding: an id that fits once the
// whitespace is gone is a legitimate id, and rejecting it would 400 a servable request. The
// over-long half is the control — trimming must not become a way past the bound.
test('the model length bound is measured after the trim', async () => {
  const atCapPadded = `   ${'a'.repeat(128)}   `;
  const overCapPadded = `   ${'a'.repeat(129)}   `;

  const accepted = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', model: atCapPadded }));
  const refused = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', model: overCapPadded }));

  expect((accepted as { requestedModel: string }).requestedModel).toBe('a'.repeat(128));
  expect((refused as Response).status).toBe(400);
  expect(((await (refused as Response).json()) as { error: { code: string } }).error.code).toBe(
    'realtime_invalid_model',
  );
});

// The requested model is echoed into `realtime.call_failed`, which the log bridge maps to
// `error`, so an unbounded caller string here is both a disclosure channel and a
// log-amplification lever. Rejected rather than truncated: truncating could turn an over-long
// id into a prefix that matches a *different* model a provider advertises.
test('a model id over 128 characters is 400 realtime_invalid_model, in every place one can be supplied', async () => {
  const overlong = `gpt-${'x'.repeat(200)}`;
  const form = new FormData();
  form.set('sdp', 'v=0\r\n');
  form.set('session', JSON.stringify({ model: overlong }));

  const supplied = [
    await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', model: overlong })),
    await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', session: { model: overlong } })),
    await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form })),
  ];

  for (const result of supplied) {
    expect((result as Response).status).toBe(400);
    expect((await (result as Response).json()).error).toMatchObject({
      type: 'invalid_request_error',
      code: 'realtime_invalid_model',
      param: null,
    });
  }

  // The boundary is inclusive, so a legitimate 128-character id is still served rather than
  // rejected — and the accepted value is the whole id, never a prefix of it.
  const atCap = `gpt-${'x'.repeat(124)}`;
  const accepted = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', model: atCap }));
  expect((accepted as { requestedModel: string }).requestedModel).toBe(atCap);
});

test('an unaccepted content type is 415 and an oversize body is 413', async () => {
  const wrongType = await readRealtimeCreateBody(
    new Request('http://x/v1/live', { method: 'POST', body: 'x', headers: { 'content-type': 'application/xml' } }),
  );
  expect((wrongType as Response).status).toBe(415);

  const oversize = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v'.repeat(16 * 1024 * 1024 + 1),
      headers: { 'content-type': 'application/sdp' },
    }),
  );
  expect((oversize as Response).status).toBe(413);
});

test('a body of exactly the 16 MiB cap is accepted, so the boundary is inclusive', async () => {
  const result = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v'.repeat(REALTIME_CREATE_BODY_LIMIT),
      headers: { 'content-type': 'application/sdp' },
    }),
  );
  if (result instanceof Response) throw new Error(`expected exactly ${REALTIME_CREATE_BODY_LIMIT} bytes to pass`);
  expect(result.body.byteLength).toBe(REALTIME_CREATE_BODY_LIMIT);
});

test('an absent content type is 415, matching the empty-string spelling', async () => {
  const absent = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: 'v=0\r\n' }));
  const empty = await readRealtimeCreateBody(
    new Request('http://x/v1/live', { method: 'POST', body: 'v=0\r\n', headers: { 'content-type': '' } }),
  );

  for (const result of [absent, empty]) {
    expect((result as Response).status).toBe(415);
    expect(((await (result as Response).json()) as { error: { code: string } }).error.code).toBe(
      'realtime_unsupported_media_type',
    );
  }
});

test('a content-encoded offer is 415 rather than misrouted', async () => {
  const gzipped = Bun.gzipSync(
    new TextEncoder().encode(JSON.stringify({ sdp: 'v=0', model: 'gpt-4o-realtime-preview' })),
  );

  for (const encoding of ['gzip', 'GZIP', ' br ', 'identity, gzip', 'gzip,identity']) {
    const result = await readRealtimeCreateBody(
      new Request('http://x/v1/live', {
        method: 'POST',
        body: gzipped,
        headers: { 'content-type': 'application/json', 'content-encoding': encoding },
      }),
    );
    expect((result as Response).status, `${encoding} should be refused`).toBe(415);
    expect(((await (result as Response).json()) as { error: { code: string } }).error.code).toBe(
      'realtime_unsupported_media_type',
    );
  }
});

test('identity and empty content-encoding mean no encoding, matching core requestContentEncoding', async () => {
  for (const encoding of ['identity', '', 'IDENTITY', '  identity  ', 'identity, identity', ',']) {
    const result = await readRealtimeCreateBody(
      new Request('http://x/v1/live', {
        method: 'POST',
        body: JSON.stringify({ sdp: 'v=0', model: 'gpt-4o-realtime-preview' }),
        headers: { 'content-type': 'application/json', 'content-encoding': encoding },
      }),
    );
    if (result instanceof Response) {
      throw new Error(`content-encoding ${JSON.stringify(encoding)} should be plaintext, got ${result.status}`);
    }
    expect(result.requestedModel).toBe('gpt-4o-realtime-preview');
  }
});

test('every terminal early return releases the client stream instead of leaving it unread', async () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['unsupported type', { 'content-type': 'application/xml' }],
    ['content-encoding', { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
    ['over-declared length', { 'content-type': 'application/sdp', 'content-length': '20000000' }],
  ];

  for (const [label, headers] of cases) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://x/v1/live', {
      method: 'POST',
      body: stream,
      headers,
      duplex: 'half',
    } as RequestInit);

    const result = await readRealtimeCreateBody(request);
    expect(result).toBeInstanceOf(Response);
    expect(cancelled, `${label} left the client stream unread`).toBe(true);
  }
});

test('an overrun body is cancelled rather than drained, so a live producer is not read to completion', async () => {
  let cancelled = false;
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += 4 * 1024 * 1024;
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request('http://x/v1/live', {
    method: 'POST',
    body: stream,
    headers: { 'content-type': 'application/sdp' },
    duplex: 'half',
  } as RequestInit);

  const result = await readRealtimeCreateBody(request);

  expect((result as Response).status).toBe(413);
  expect(cancelled).toBe(true);
  // A never-ending producer only terminates because the read stopped at the cap.
  expect(produced).toBeLessThanOrEqual(REALTIME_CREATE_BODY_LIMIT + 4 * 1024 * 1024);
});

test('a client that dies mid-upload is a 400, not a rejected promise', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('v=0\r\n'));
    },
    pull(controller) {
      controller.error(new Error('client went away'));
    },
  });
  const request = new Request('http://x/v1/live', {
    method: 'POST',
    body: stream,
    headers: { 'content-type': 'application/sdp' },
    duplex: 'half',
  } as RequestInit);

  const result = await readRealtimeCreateBody(request);

  expect(result).toBeInstanceOf(Response);
  const body = (await (result as Response).json()) as { error: { code: string; message: string } };
  expect((result as Response).status).toBe(400);
  expect(body.error.code).toBe('realtime_invalid_offer');
  expect(body.error.message).not.toContain('v=0');
  expect(body.error.message).not.toContain('client went away');
});

test('the cap holds for a chunked body that declares no length or under-declares one', async () => {
  // Annotated because TS otherwise infers a union of the two heterogeneous literals, which is
  // not assignable to `Record<string, string>` — an error only the IDE sees, since both
  // `tsc -p packages/server` and the root `lint:types` exclude test files.
  const cases: Array<Record<string, string>> = [
    { 'content-type': 'application/sdp' },
    { 'content-type': 'application/sdp', 'content-length': '3' },
  ];
  for (const headers of cases) {
    const result = await readRealtimeCreateBody(oversizeStreamRequest(headers));
    expect((result as Response).status).toBe(413);
  }
});

test('an accepted content type still matches when it carries parameters', async () => {
  const sdp = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v=0\r\n',
      headers: { 'content-type': 'Application/SDP; charset=utf-8' },
    }),
  );
  expect((sdp as { contentType: string }).contentType).toBe('application/sdp');

  const form = new FormData();
  form.set('sdp', 'v=0\r\n');
  const multipart = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));
  expect((multipart as { contentType: string }).contentType).toBe('application/json');
});

test('a multipart offer whose body cannot be parsed is 400, not a thrown TypeError', async () => {
  const noBoundary = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v=0\r\n',
      headers: { 'content-type': 'multipart/form-data' },
    }),
  );
  const truncated = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: '--xyz\r\n',
      headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
    }),
  );

  for (const result of [noBoundary, truncated]) {
    expect((result as Response).status).toBe(400);
    const body = (await (result as Response).json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('realtime_invalid_offer');
    expect(body.error.message).not.toContain('v=0');
  }
});

test('an empty body and malformed JSON both fall back to the normalized model', async () => {
  const empty = await readRealtimeCreateBody(
    new Request('http://x/v1/live', { method: 'POST', headers: { 'content-type': 'application/json' } }),
  );
  const malformed = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    }),
  );

  expect((empty as { requestedModel: string }).requestedModel).toBe('gpt-live-1-codex');
  expect((malformed as { requestedModel: string }).requestedModel).toBe('gpt-live-1-codex');
  expect(new TextDecoder().decode((malformed as { body: Uint8Array }).body)).toBe('{ not json');
});

test('withUpstreamModel is repeatable and never invents a model field', async () => {
  const noModel = (await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0' }))) as never;

  const once = withUpstreamModel(noModel, 'gpt-live-1-codex');
  const twice = withUpstreamModel(once, 'gpt-live-1-codex');

  expect(JSON.parse(new TextDecoder().decode(once.body))).toEqual({ sdp: 'v=0' });
  expect(JSON.parse(new TextDecoder().decode(twice.body))).toEqual({ sdp: 'v=0' });
  expect(once.requestedModel).toBe('gpt-live-1-codex');
});

test('withUpstreamModel rewrites both model fields for JSON and leaves SDP untouched', async () => {
  const json = await readRealtimeCreateBody(
    jsonRequest({ sdp: 'v=0', model: 'gpt-realtime', session: { model: 'gpt-realtime', voice: 'cedar' } }),
  );
  const sdp = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v=0\r\n',
      headers: { 'content-type': 'application/sdp' },
    }),
  );

  const rewritten = withUpstreamModel(json as never, 'gpt-live-1-codex');
  expect(JSON.parse(new TextDecoder().decode(rewritten.body))).toEqual({
    sdp: 'v=0',
    model: 'gpt-live-1-codex',
    session: { model: 'gpt-live-1-codex', voice: 'cedar' },
  });

  const untouched = withUpstreamModel(sdp as never, 'gpt-live-1-codex');
  expect(new TextDecoder().decode(untouched.body)).toBe('v=0\r\n');
  expect(untouched.contentType).toBe('application/sdp');
});

// The nested rewrite is guarded exactly as the top-level one is. An unconditional nested write
// gave an offer that named no model a `session.model` the caller never sent, denying the upstream
// its own default — and the case is reachable: `session` carries voice, turn detection, and tool
// settings that are useful without a model.
test('a session that names no model does not gain one', async () => {
  const parsed = (await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', session: { voice: 'cedar' } }))) as never;

  const rewritten = withUpstreamModel(parsed, 'gpt-live-1-codex');

  expect(JSON.parse(new TextDecoder().decode(rewritten.body))).toEqual({ sdp: 'v=0', session: { voice: 'cedar' } });
});

test('a multipart session too deeply nested to re-serialize is 400, not a rejected promise', async () => {
  const form = new FormData();
  form.set('sdp', 'v=0\r\n');
  form.set('session', deeplyNestedJson());

  const result = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));

  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('realtime_invalid_offer');
  // All three multipart 400s share the code, so only the message distinguishes the
  // `encodeJson` guard under test from the parse branch that precedes it.
  expect(body.error.message).toBe('The multipart realtime offer could not be parsed.');
  expect(body.error.message).not.toContain('v=0');
});

test('withUpstreamModel returns the body unchanged when the payload cannot be re-serialized', async () => {
  const read = await readRealtimeCreateBody(jsonRequest(undefined, deeplyNestedJson()));
  if (read instanceof Response) throw new Error(`expected the deep offer to parse, got ${read.status}`);
  expect(read.requestedModel).toBe('gpt-realtime');

  const rewritten = withUpstreamModel(read, 'gpt-live-1-codex');

  expect(rewritten).toBe(read);
});

/** Deep enough that `JSON.parse` accepts it but `JSON.stringify` overflows the stack. The
 *  self-check separates the two throws: a future engine that also failed the parse would
 *  otherwise leave the `encodeJson` guard untested while the assertion still passed. Depth is
 *  far past the observed 50 000 threshold — parse still succeeds at 5 000 000 — so the headroom
 *  is orders of magnitude rather than the 2.5x it was. */
function deeplyNestedJson(): string {
  const depth = 1_000_000;
  const text = `{"model":"gpt-realtime","deep":${'['.repeat(depth)}1${']'.repeat(depth)}}`;
  const parsed = JSON.parse(text) as unknown;
  expect(() => JSON.stringify(parsed)).toThrow(RangeError);
  return text;
}

function jsonRequest(body: unknown, raw?: string): Request {
  return new Request('http://x/v1/live', {
    method: 'POST',
    body: raw ?? JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function oversizeStreamRequest(headers: Record<string, string>): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Two chunks so the cap is reached mid-stream rather than on the first read.
      controller.enqueue(new Uint8Array(16 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  return new Request('http://x/v1/live', { method: 'POST', body: stream, headers, duplex: 'half' } as RequestInit);
}
