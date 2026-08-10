import { expect, test } from 'bun:test';

import { createPluginReads } from './read';

test('includes descriptor presentation fields in plugin summaries', () => {
  const reads = createPluginReads({
    access: {
      builtInNames: new Set(),
      withDescriptor: async () => {
        throw new Error('not used');
      },
      withSnapshot: (read) =>
        read({
          config: { plugins: [{ packageName: '@example/plugin' }] },
          plugins: {
            plugins: new Map([
              [
                '@example/plugin',
                {
                  packageName: '@example/plugin',
                  displayName: 'Example',
                  icon: 'openai',
                  builtIn: true,
                  state: { status: 'ready' },
                },
              ],
            ]),
          },
        } as never),
    },
    configStore: {} as never,
    repository: {} as never,
  });

  const pluginSummary = reads.summaries()[0];
  expect(pluginSummary).toMatchObject({ displayName: 'Example', icon: 'openai' });
  expect(pluginSummary).not.toHaveProperty('label');
});
