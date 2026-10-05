import { afterEach, expect, test } from 'bun:test';
import { brotliCompressSync, deflateRawSync, deflateSync } from 'node:zlib';

import { openAIResponsesAdapter, RequestBodyTooLargeError, withRequestBodyLimits } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { cleanup, diagnostics, materializePluginProvider, runtimeFixture } from './test-support';

afterEach(cleanup);

const MODEL = 'gpt-5.5';
const formats = [
  ['gzip', Bun.gzipSync],
  ['x-gzip', Bun.gzipSync],
  ['br', brotliCompressSync],
  ['deflate', deflateSync],
  ['deflate', deflateRawSync],
  ['zstd', Bun.zstdCompressSync],
] as const;

async function transport(calls: Request[]) {
  const previousClientId = Reflect.get(globalThis, '__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__');
  Reflect.set(globalThis, '__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__', previousClientId ?? 'test-client-id');
  const { createOpenAIChatGPTRuntime } = await import('../../../plugins/openai-chatgpt/src/runtime/runtime');
  if (previousClientId === undefined) Reflect.deleteProperty(globalThis, '__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__');
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: { language: [{ id: MODEL }], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
      createRuntime: (context) =>
        createOpenAIChatGPTRuntime(
          {
            ...context,
            credentials: {
              read: async () => ({
                revision: 1,
                value: {
                  accessToken: 'fake-token',
                  accountId: 'fake-account',
                  refreshToken: 'fake-refresh',
                  expiresAt: Date.now() + 60_000,
                },
              }),
              refresh: async () => {
                throw new Error('must not refresh');
              },
            },
          },
          { userAgent: 'fixed-test-agent' },
        ),
    },
  );
  const plugin = '@aio-proxy/plugin-openai-chatgpt';
  const account = fixture.repository.readAccount('person')!;
  const adapter = fixture.plugins.registry.resolveOAuth('@example/oauth', 'default')!;
  const result = await materializePluginProvider({
    config: { id: 'person', kind: ProviderKind.OAuth, enabled: true, plugin, capability: 'default' },
    repository: { ...fixture.repository, readAccount: () => ({ ...account, plugin }) },
    plugins: {
      ...fixture.plugins,
      plugins: new Map([
        [plugin, { packageName: plugin, builtIn: true, version: '1.0.0', state: { status: 'ready' } }],
      ]),
      registry: { ...fixture.plugins.registry, resolveOAuth: () => adapter },
    },
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    runtimeFetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ id: 'resp_ok', status: 'completed', output: [] });
    },
  });
  const raw = result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAIResponse, modelId: MODEL });
  if (raw === undefined) throw new Error('ChatGPT transport missing');
  return raw;
}

function request(bytes: Uint8Array, encoding: string, operation: 'create' | 'compact') {
  return new Request(`https://proxy.test/v1/responses${operation === 'compact' ? '/compact' : ''}?trace=1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-encoding': encoding,
      'content-length': String(bytes.length),
    },
    body: bytes,
  });
}

test.each(formats)(
  'real ChatGPT create rewrites %s Responses under the host scope and preserves TAIL',
  async (encoding, compress) => {
    const calls: Request[] = [];
    const rawTransport = await transport(calls);
    const original = compress(
      Buffer.from(JSON.stringify({ model: MODEL, input: 'TAIL', store: true, max_output_tokens: 1 })),
    );
    await withRequestBodyLimits({ encoded: 4096, decoded: 4096 }, async () => {
      const raw = request(original, encoding, 'create');
      const parsed = await openAIResponsesAdapter.parse(raw, {});
      const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, MODEL, new Set(), {});
      expect(forwarded.headers.get('content-encoding')).toBe(encoding);
      expect((await rawTransport.invoke(forwarded)).status).toBe(200);
    });
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses?trace=1');
    expect(sent.headers.get('content-encoding')).toBeNull();
    expect(sent.headers.get('content-length')).toBeNull();
    expect(await sent.json()).toEqual({
      model: MODEL,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'TAIL' }] }],
      store: false,
    });
  },
);

test('ChatGPT create retains adapter model/effort rewrites while compact keeps its original compressed bytes', async () => {
  const calls: Request[] = [];
  const rawTransport = await transport(calls);
  for (const operation of ['create', 'compact'] as const) {
    const original = Bun.gzipSync(
      Buffer.from(
        JSON.stringify({
          model: operation === 'create' ? 'alias' : MODEL,
          input: 'TAIL',
          reasoning: { effort: 'high' },
        }),
      ),
    );
    const raw = request(original, 'gzip', operation);
    const parsed = await openAIResponsesAdapter.parse(raw, { operation });
    const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, MODEL, new Set(['low']), { operation });
    await rawTransport.invoke(forwarded);
    const sent = calls.at(-1)!;
    if (operation === 'create') {
      expect(sent.headers.get('content-encoding')).toBeNull();
      expect(await sent.json()).toMatchObject({ model: MODEL, reasoning: { effort: 'low' }, store: false });
    } else {
      expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses/compact?trace=1');
      expect(sent.headers.get('content-encoding')).toBe('gzip');
      expect(sent.headers.get('content-length')).toBe(String(original.length));
      expect(new Uint8Array(await sent.arrayBuffer())).toEqual(original);
    }
  }
});

test('real ChatGPT create enforces the active scoped decoded budget before upstream', async () => {
  const calls: Request[] = [];
  const rawTransport = await transport(calls);
  const raw = request(
    Bun.gzipSync(Buffer.from(JSON.stringify({ model: MODEL, input: 'x'.repeat(2000) }))),
    'gzip',
    'create',
  );
  const parsed = await openAIResponsesAdapter.parse(raw, {});
  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, MODEL, new Set(), {});
  await expect(
    withRequestBodyLimits({ encoded: 1024, decoded: 512 }, () => rawTransport.invoke(forwarded)),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  expect(calls).toHaveLength(0);
});
