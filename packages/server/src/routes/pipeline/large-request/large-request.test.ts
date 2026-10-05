import { expect, test } from 'bun:test';

import {
  anthropicMessagesAdapter,
  currentRequestBodyLimits,
  openAIResponsesAdapter,
  readRequestText,
} from '@aio-proxy/core';
import { ConfigSchema, ProviderProtocol } from '@aio-proxy/types';

import { rawProvider, REQUESTED_MODEL } from '../../../../__tests__/pipeline-helpers';
import { handleProtocolRequest } from '../index';
import { pipeline } from '../test-support';

const MiB = 1_024 * 1_024;
const success = () => Response.json({ id: 'resp_ok', status: 'completed', output: [] });
const config = (maxBytes: number) => ConfigSchema.parse({ server: { requestBody: { maxBytes } }, providers: {} });

function body(padding = MiB + 100, encrypted = false) {
  return JSON.stringify({
    model: REQUESTED_MODEL,
    input: [
      ...(encrypted
        ? [
            {
              type: 'agent_message',
              author: '/root',
              recipient: '/root/child',
              content: [{ type: 'encrypted_content', encrypted_content: 'repair me' }],
            },
          ]
        : []),
      { role: 'user', content: 'x'.repeat(padding) },
      { role: 'user', content: 'TAIL' },
    ],
  });
}

function request(text: string, compressed = false) {
  const bytes = compressed ? Bun.gzipSync(Buffer.from(text)) : Buffer.from(text);
  return new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(compressed ? { 'content-encoding': 'gzip' } : {}) },
    body: bytes,
  });
}

test.each([false, true])(
  'custom admission rejects an oversized %s encoded/decoded Responses body before upstream',
  async (compressed) => {
    const primary = rawProvider({ id: 'primary', protocol: ProviderProtocol.OpenAIResponse });
    const harness = pipeline([primary], { adapter: openAIResponsesAdapter, config: config(MiB) });
    const response = await harness.run(request(body(), compressed));
    expect(response.status).toBe(413);
    expect(primary.calls.raw).toHaveLength(0);
  },
);

test.each(['responses', 'compact', 'rewrite', 'fallback', 'encrypted-retry'] as const)(
  'keeps the scoped budget and complete tail through %s',
  async (mode) => {
    const seen: Array<{ body: { input: Array<{ content: unknown }> }; encoding: string | null; limit: number }> = [];
    const capture = async (upstream: Request) => {
      // Reread through the shared reader as real raw rewrite/retry code does.
      const text = await readRequestText(upstream);
      seen.push({
        body: JSON.parse(text),
        encoding: upstream.headers.get('content-encoding'),
        limit: currentRequestBodyLimits().decoded,
      });
    };
    const primary = rawProvider({
      id: 'primary',
      modelId: mode === 'rewrite' ? 'wire-model' : REQUESTED_MODEL,
      protocol: ProviderProtocol.OpenAIResponse,
      priority: 1,
      invoke: async (upstream) => {
        await capture(upstream);
        if (mode === 'fallback') return new Response('unavailable', { status: 503 });
        if (mode === 'encrypted-retry' && seen.length === 1) {
          return Response.json({ error: { code: 'invalid_encrypted_content', message: 'x' } }, { status: 400 });
        }
        return success();
      },
    });
    const backup = rawProvider({
      id: 'backup',
      modelId: REQUESTED_MODEL,
      protocol: ProviderProtocol.OpenAIResponse,
      invoke: async (upstream) => {
        await capture(upstream);
        return success();
      },
    });
    const harness = pipeline(mode === 'fallback' ? [primary, backup] : [primary], {
      adapter: openAIResponsesAdapter,
      config: config(2 * MiB),
    });
    const raw = request(body(MiB + 100, mode === 'encrypted-retry'), true);
    const response =
      mode === 'compact'
        ? await handleProtocolRequest({
            adapter: openAIResponsesAdapter,
            context: { operation: 'compact' },
            rawRequest: raw,
            source: harness.source,
          })
        : await harness.run(raw);
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(mode === 'fallback' || mode === 'encrypted-retry' ? 2 : 1);
    for (const hop of seen) {
      expect(hop.body.input.at(-1)?.content).toBe('TAIL');
      expect(hop.limit).toBe(2 * MiB);
    }
    if (mode === 'rewrite') expect(seen[0]?.encoding).toBeNull();
    if (mode === 'encrypted-retry') expect(seen[1]?.encoding).toBeNull();
    expect(primary.calls.raw).toHaveLength(mode === 'encrypted-retry' ? 2 : 1);
    expect(backup.calls.raw).toHaveLength(mode === 'fallback' ? 1 : 0);
  },
);

test('same-protocol raw passthrough preserves the original gzip bytes and encoding', async () => {
  const text = body();
  const original = Bun.gzipSync(Buffer.from(text));
  let forwarded: Uint8Array | undefined;
  let encoding: string | null = null;
  const primary = rawProvider({
    id: 'primary',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (upstream) => {
      encoding = upstream.headers.get('content-encoding');
      forwarded = new Uint8Array(await upstream.arrayBuffer());
      return success();
    },
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter, config: config(2 * MiB) });
  expect((await harness.run(request(text, true))).status).toBe(200);
  expect(encoding).toBe('gzip');
  expect(forwarded).toEqual(original);
});

test('default admission forwards a real 65 MiB Responses JSON with its complete tail', async () => {
  let tail: unknown;
  const primary = rawProvider({
    id: 'primary',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (upstream) => {
      const parsed = (await upstream.json()) as { input: Array<{ content: string }> };
      tail = parsed.input.at(-1)?.content;
      return success();
    },
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter });
  expect((await harness.run(request(body(65 * MiB)))).status).toBe(200);
  expect(tail).toBe('TAIL');
  expect(primary.calls.raw).toHaveLength(1);
}, 30_000);

test('a hot update changes new requests while an in-flight Responses reread retains its acquired budget', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let tail: unknown;
  const primary = rawProvider({
    id: 'primary',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (upstream) => {
      entered.resolve();
      if (primary.calls.raw.length === 1) await release.promise;
      const parsed = JSON.parse(await readRequestText(upstream)) as { input: Array<{ content: string }> };
      tail = parsed.input.at(-1)?.content;
      expect(currentRequestBodyLimits().decoded).toBe(2 * MiB);
      return success();
    },
  });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter, config: config(2 * MiB) });
  let snapshot = harness.source.currentProviderSnapshot();
  harness.source.acquireProviderSnapshot = () => ({ snapshot, release() {} });
  // Responses must use the lease snapshot even if the current snapshot disagrees.
  harness.source.currentProviderSnapshot = () => ({ ...snapshot, config: config(MiB) });
  const first = harness.run(request(body()));
  await entered.promise;
  snapshot = { ...snapshot, config: config(MiB) };
  try {
    const second = await harness.run(request(body()));
    expect(second.status).toBe(413);
  } finally {
    release.resolve();
  }
  expect((await first).status).toBe(200);
  expect(tail).toBe('TAIL');
  expect(primary.calls.raw).toHaveLength(1);
});

test('non-Responses requests capture the current configuration once before parsing and rereads', async () => {
  let snapshots = 0;
  let tail: unknown;
  const primary = rawProvider({
    id: 'primary',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.Anthropic,
    invoke: async (upstream) => {
      const parsed = JSON.parse(await readRequestText(upstream)) as { messages: Array<{ content: string }> };
      tail = parsed.messages.at(-1)?.content;
      expect(currentRequestBodyLimits().decoded).toBe(2 * MiB);
      return Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    },
  });
  const harness = pipeline([primary], { adapter: anthropicMessagesAdapter, config: config(2 * MiB) });
  const snapshot = harness.source.currentProviderSnapshot();
  harness.source.currentProviderSnapshot = () => {
    snapshots += 1;
    return snapshots === 1 ? snapshot : { ...snapshot, config: config(MiB) };
  };
  const response = await harness.run(
    new Request('https://proxy.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: REQUESTED_MODEL,
        max_tokens: 16,
        messages: [
          { role: 'user', content: 'x'.repeat(MiB + 100) },
          { role: 'user', content: 'TAIL' },
        ],
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(tail).toBe('TAIL');
  expect(snapshots).toBe(1);
});

test('scope includes Responses pre-observation while its privacy probe keeps a separate 64 MiB budget', async () => {
  let probeBudget: number | undefined;
  const primary = rawProvider({ id: 'primary', modelId: REQUESTED_MODEL, protocol: ProviderProtocol.OpenAIResponse });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter, config: config(2 * MiB) });
  const source = {
    ...harness.source,
    async preObservationCapturePolicy(_request: Request, _snapshot: unknown, maxBytes: number) {
      probeBudget = maxBytes;
      expect(currentRequestBodyLimits().decoded).toBe(2 * MiB);
      return { capturePayload: false };
    },
  };
  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: request(body()),
    source,
  });
  expect(response.status).toBe(200);
  expect(probeBudget).toBe(64 * MiB);
});

test('configured preflight rejects a declared encoded size before parsing a tiny body', async () => {
  const primary = rawProvider({ id: 'primary', protocol: ProviderProtocol.OpenAIResponse });
  const harness = pipeline([primary], { adapter: openAIResponsesAdapter, config: config(MiB) });
  const raw = request(body(10));
  raw.headers.set('content-length', String(2 * MiB));
  const response = await harness.run(raw);
  expect(response.status).toBe(413);
  expect(primary.calls.raw).toHaveLength(0);
});
