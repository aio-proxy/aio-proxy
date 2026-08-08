import { expect, test } from 'bun:test';

import { definePlugin } from '@aio-proxy/plugin-sdk';

import { loadPluginRegistry } from './loader';

test('invalid metadata icon logs a safe package-scoped warning', async () => {
  const invalidIcon = 'data:text/html,private-icon-payload';
  const logs: { readonly event: string; readonly context: Readonly<Record<string, unknown>> }[] = [];
  await loadPluginRegistry({
    enablements: [{ packageName: '@example/icons' }],
    builtIns: [
      {
        packageName: '@example/icons',
        version: '1.0.0',
        descriptor: definePlugin(() => {}, { icon: invalidIcon as never }),
      },
    ],
    diagnostics: (code, options) => ({
      code,
      retryable: options.retryable,
      summary: code,
      occurredAt: new Date(0).toISOString(),
    }),
    importPackage: async () => ({}),
    logger: (entry) => logs.push(entry),
    secrets: { readPluginSecret: () => undefined },
  });

  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ event: 'plugin.metadata.icon.invalid', context: { plugin: '@example/icons' } });
  expect(JSON.stringify(logs[0])).not.toContain(invalidIcon);
});

test('a throwing metadata icon warning sink does not prevent the plugin becoming ready', async () => {
  const snapshot = await loadPluginRegistry({
    enablements: [{ packageName: '@example/icons' }],
    builtIns: [
      {
        packageName: '@example/icons',
        version: '1.0.0',
        descriptor: definePlugin(() => {}, { icon: 'data:text/html,private-icon-payload' as never }),
      },
    ],
    diagnostics: (code, options) => ({
      code,
      retryable: options.retryable,
      summary: code,
      occurredAt: new Date(0).toISOString(),
    }),
    importPackage: async () => ({}),
    logger: () => {
      throw new Error('warning sink failed');
    },
    secrets: { readPluginSecret: () => undefined },
  });

  expect(snapshot.plugins.get('@example/icons')).toMatchObject({ state: { status: 'ready' } });
  expect(snapshot.plugins.get('@example/icons')?.icon).toBeUndefined();
});
