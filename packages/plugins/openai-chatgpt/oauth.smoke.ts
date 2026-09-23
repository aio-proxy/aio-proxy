import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import { openAIChatGPTClientId } from './rslib.config';
import type { ChatGPTCredential } from './src/schema';

test('build embeds the ChatGPT OAuth client ID without leaving source plaintext', async () => {
  const [source, config, setup, artifact] = await Promise.all([
    Bun.file('./src/oauth-flow.ts').text(),
    Bun.file('./rslib.config.ts').text(),
    Bun.file('./test/setup.ts').text(),
    Bun.file('./dist/oauth-flow.js').text(),
  ]);

  expect(new Bun.CryptoHasher('sha256').update(openAIChatGPTClientId).digest('hex')).toBe(
    '584341c2f0e88ad1f7c6856553d81dc4776ff42c43951daed3e2d8d91552eaa2',
  );
  for (const text of [source, config, setup]) {
    expect(text.includes(openAIChatGPTClientId)).toBe(false);
    expect(text.includes(btoa(openAIChatGPTClientId))).toBe(false);
  }
  expect(artifact.includes(openAIChatGPTClientId)).toBe(true);
  expect(artifact.includes('__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__')).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
});

test('clean build resolves the current runtime entry and exposes Responses raw capability', async () => {
  const [{ default: descriptor }, pluginArtifact] = await Promise.all([
    import('./dist/index.js'),
    Bun.file('./dist/plugin/plugin.js').text(),
  ]);
  const adapter = await registeredAdapter(descriptor);
  const runtime = await adapter.createRuntime({
    credentials: {
      read: async () => ({
        revision: 1,
        value: {
          accessToken: 'artifact-access',
          accountId: 'artifact-account',
          expiresAt: Date.now() + 60_000,
          refreshToken: 'artifact-refresh',
        },
      }),
      refresh: async () => {
        throw new Error('artifact test must not refresh credentials');
      },
    },
    options: {},
    catalog: {
      language: [{ id: 'gpt-artifact' }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    },
  });

  expect(pluginArtifact).toContain('from "../runtime/index.js"');
  expect(runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-artifact' })).toBeDefined();
  expect(runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-artifact' })).toBeUndefined();
});

async function registeredAdapter<Options>(
  descriptor: PluginDescriptor<Options>,
): Promise<OAuthAdapter<Record<string, unknown>, ChatGPTCredential>> {
  let adapter: OAuthAdapter<Record<string, unknown>, ChatGPTCredential> | undefined;
  const options = (
    descriptor.metadata.options === undefined ? undefined : await descriptor.metadata.options.schema.parseAsync({})
  ) as Options;
  await descriptor.setup(
    {
      oauth: {
        register(value) {
          adapter = value as OAuthAdapter<Record<string, unknown>, ChatGPTCredential>;
        },
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
        child() {
          return this;
        },
      },
    },
    options,
  );
  if (adapter === undefined) throw new Error('built plugin did not register its OAuth adapter');
  return adapter;
}
