import { expect, test } from 'bun:test';

import { defaultCliDeps } from '../../dashboard-assets';
import { localAgentHost } from '../../run/run';
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

test('Docker, remote endpoint, bind mismatch, and missing home never inject a local catalog factory', async () => {
  for (const gate of [
    { env: { AIO_PROXY_AGENT_HOST: 'disabled' }, resolveEndpoint: loopback, home: () => '/tmp/test-home' },
    {
      env: {},
      resolveEndpoint: async () => {
        throw new Error('non-loopback endpoint');
      },
      home: () => '/tmp/test-home',
    },
    { env: {}, resolveEndpoint: async () => 'http://127.0.0.1:1234', home: () => '/tmp/test-home' },
    { env: {}, resolveEndpoint: loopback, home: () => '' },
  ])
    expect(await localAgentHost('127.0.0.1', 9317, defaultCliDeps, gate)).toBeUndefined();
});
