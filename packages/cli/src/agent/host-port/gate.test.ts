import { expect, test } from 'bun:test';

import { shouldEnableAgentHost } from './gate';

const loopback = async () => 'http://127.0.0.1:9317';

test('local Agent setup is offered only for a loopback endpoint with a home and no opt-out', async () => {
  expect(await shouldEnableAgentHost({ env: {}, resolveEndpoint: loopback, home: () => '/home/me' })).toBe(true);
  expect(
    await shouldEnableAgentHost({
      env: { AIO_PROXY_AGENT_HOST: 'disabled' },
      resolveEndpoint: loopback,
      home: () => '/home/me',
    }),
  ).toBe(false);
  expect(
    await shouldEnableAgentHost({
      env: {},
      resolveEndpoint: async () => {
        throw new Error('Agent integrations require a loopback aio-proxy endpoint');
      },
      home: () => '/home/me',
    }),
  ).toBe(false);
  expect(await shouldEnableAgentHost({ env: {}, resolveEndpoint: loopback, home: () => '' })).toBe(false);
});
