import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import cursorPlugin, { createCursorPlugin, englishPresentationText } from '.';
import type { CursorCredential } from './schema';

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, CursorCredential>> {
  let registered: OAuthAdapter<Record<string, never>, CursorCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, never>, CursorCredential>;
        },
      },
    } as never,
    undefined,
  );
  if (registered === undefined) throw new Error('Cursor OAuth adapter was not registered');
  return registered;
}

test('registers SDK v2 presentation metadata on the descriptor and adapter', async () => {
  const adapter = await adapterFrom(cursorPlugin);
  expect(adapter.id).toBe('default');
  expect(adapter.displayName).toBe('Login with Cursor');
  expect(cursorPlugin.metadata).toEqual({
    displayName: 'Cursor',
    description: 'Use a Cursor account to access models',
    icon: 'cursor',
  });
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: expect.any(Number) });
});

test('createRuntime builds a v4 provider-only runtime', async () => {
  const adapter = await adapterFrom(
    createCursorPlugin(englishPresentationText, {
      transport: {
        openRun: () =>
          Promise.resolve({
            write: () => {},
            end: () => {},
            frames: (async function* () {})(),
            trailers: Promise.resolve({ 'grpc-status': '0' }),
          }),
        unary: () => Promise.reject(new Error('unused')),
      },
    }),
  );
  const runtime = await adapter.createRuntime({
    credentials: {} as never,
    options: {},
    catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
    fetch: globalThis.fetch,
  });
  expect(runtime.provider.specificationVersion).toBe('v4');
  expect(runtime.raw).toBeUndefined();
});
