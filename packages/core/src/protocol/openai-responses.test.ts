import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '../index';

test('drops background before raw forwarding while preserving unknown fields', async () => {
  const body = Bun.zstdCompressSync(
    new TextEncoder().encode(
      JSON.stringify({
        model: 'gpt-5.6-terra',
        input: 'hello',
        background: true,
        beta_field: { retain: true },
      }),
    ),
  );
  const raw = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: {
      'content-encoding': 'zstd',
      'content-length': String(body.byteLength),
      'content-type': 'application/json',
    },
    body,
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});

  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'upstream-model', new Set(), {});

  expect(forwarded.headers.get('content-encoding')).toBeNull();
  expect(forwarded.headers.get('content-length')).toBeNull();
  expect(await forwarded.json()).toEqual({
    model: 'upstream-model',
    input: 'hello',
    beta_field: { retain: true },
  });
});

test('forwards the original body bytes verbatim when model, background, and effort are unchanged', async () => {
  // A same-model request with no background and an already-supported effort must
  // not be round-tripped through JSON, which would truncate integers beyond
  // Number.MAX_SAFE_INTEGER and drop the client's exact byte representation.
  const bodyText = '{"model":"upstream-model","input":"hi","seed":9007199254740993}';
  const raw = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});
  const forwarded = await openAIResponsesAdapter.rawRequest(
    raw,
    parsed,
    'upstream-model',
    new Set(['low', 'medium', 'high']),
    {},
  );
  expect(await forwarded.text()).toBe(bodyText);
});

test('accepts null instructions before raw forwarding', async () => {
  const bodyText = '{"model":"upstream-model","input":"hi","instructions":null}';
  const raw = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });

  const parsed = await openAIResponsesAdapter.parse(raw, {});
  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'upstream-model', new Set(), {});

  expect(await forwarded.text()).toBe(bodyText);
});

test('reports a safe diagnostic when background mode is downgraded', async () => {
  const raw = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-terra', input: 'hello', background: true }),
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});

  expect(openAIResponsesAdapter.requestDiagnostics(parsed, {})).toEqual([
    { feature: 'background', action: 'dropped', effectiveMode: 'synchronous' },
  ]);
});
