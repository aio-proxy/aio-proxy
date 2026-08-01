import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import cursorPlugin, { createCursorPlugin } from '.';
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

test('registers a default Cursor adapter with a static catalog and cursor icon', async () => {
  const adapter = await adapterFrom(cursorPlugin);
  expect(adapter.id).toBe('default');
  expect(adapter.icon).toBe('cursor');
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: 'static' });
  await expect(
    adapter.catalog.discover({ credentials: {} as never, options: {}, signal: new AbortController().signal }),
  ).resolves.toMatchObject({ language: expect.any(Array) });
});

test('createRuntime throws until Phase 2 implements the runtime', async () => {
  const adapter = await adapterFrom(createCursorPlugin());
  await expect(
    adapter.createRuntime({ credentials: {} as never, options: {}, catalog: adapter.catalog as never }),
  ).rejects.toThrow(/not implemented in Phase 1/);
});
