import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';
import { AliasConfigSchema } from '@aio-proxy/types';

import cursorPlugin, { createCursorPlugin, englishPresentationText } from '..';
import { defaultCursorAliases } from '../catalog';
import type { CursorCredential } from '../schema';

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
  expect(adapter.supportsProxy).toBe(false);
  expect(cursorPlugin.metadata).toEqual({
    displayName: 'Cursor',
    description: 'Use a Cursor account to access models',
    icon: 'cursor',
  });
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: expect.any(Number) });
});

test('Cursor adapter registers defaultAliases on catalog', async () => {
  const adapter = await adapterFrom(cursorPlugin);
  expect(adapter.catalog.defaultAliases).toBe(defaultCursorAliases);
});

test('Cursor adapter suggests array-when aliases that AliasConfigSchema accepts', async () => {
  const adapter = await adapterFrom(cursorPlugin);
  const catalog = {
    language: [{ id: 'claude-opus-4-8-medium' }, { id: 'claude-opus-4-8-thinking-high' }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    extra: {
      cursorFamilies: [
        {
          name: 'claude-opus-4-8',
          variants: [{ slug: 'claude-opus-4-8-medium' }, { slug: 'claude-opus-4-8-thinking-high' }],
        },
      ],
    },
  };
  const aliases = adapter.catalog.defaultAliases!(catalog);
  expect(Object.keys(aliases).length).toBeGreaterThan(0);
  for (const config of Object.values(aliases)) {
    expect(() => AliasConfigSchema.parse(config)).not.toThrow();
  }
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

// `hasQuota` on the dashboard card is `adapter.quota !== undefined`, and the reader has to
// receive the plugin's injected fetch or the capability is dead on arrival.
test('exposes a quota capability that reads through the injected fetcher', async () => {
  const accessToken = ['h', Buffer.from(JSON.stringify({ sub: 'auth0|user_01ABC' })).toString('base64url'), 's'].join(
    '.',
  );
  const adapter = await adapterFrom(
    createCursorPlugin(englishPresentationText, {
      fetch: (async (input: string | URL) => {
        if (String(input) === 'https://cursor.com/api/usage-summary') {
          return Response.json({ membershipType: 'ultra', individualUsage: { plan: { totalPercentUsed: 20 } } });
        }
        return new Response('nope', { status: 404 });
      }) as never,
    }),
  );

  const snapshot = await adapter.quota!.read({
    credentials: {
      read: async () => ({
        value: { accessToken, refreshToken: 'r', expiresAt: Number.MAX_SAFE_INTEGER },
        revision: 1,
      }),
      refresh: async () => {
        throw new Error('unused');
      },
    },
    options: {},
    signal: new AbortController().signal,
  });

  expect(snapshot).toStrictEqual({
    items: [{ id: 'plan', displayName: { default: 'Plan usage', 'zh-Hans': '套餐用量' }, remainingRatio: 0.8 }],
    plan: 'Cursor Ultra',
  });
  // Cursor has no redeem endpoint, so there is nothing to reset.
  expect(adapter.quota?.reset).toBeUndefined();
});
