import { expect, test } from 'bun:test';

import type { AgentManagedMarker, AgentOAuthError } from '@aio-proxy/types';

import { pollDeviceAuthorization, refreshAgentCredential, requestDeviceAuthorization } from './oauth-client';

const MARKER = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'opencode',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3',
  endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;
const TOKEN = {
  token_type: 'Bearer',
  access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
  refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
  expires_in: 900,
} as const;
const DEVICE = {
  device_code: 'd'.repeat(43),
  user_code: 'ABCD-EFGH',
  verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
  verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
} as const;

const jsonError = (status: number, error: AgentOAuthError['error']): Response => Response.json({ error }, { status });

function oauthFixture(responses: Response[]) {
  let timestamp = 1_000;
  const forms: Array<Record<string, string>> = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  return {
    marker: MARKER,
    forms,
    sleeps,
    events,
    now: () => timestamp,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      events.push(`sleep:${milliseconds}`);
      timestamp += milliseconds;
    },
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push('fetch');
      forms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected OAuth request');
      return response;
    },
  };
}

test('device polling follows pending and slow_down without changing identity fields', async () => {
  const f = oauthFixture([jsonError(400, 'authorization_pending'), jsonError(400, 'slow_down'), Response.json(TOKEN)]);
  await expect(
    pollDeviceAuthorization(f.marker, DEVICE, {
      fetch: f.fetch,
      sleep: f.sleep,
      now: f.now,
    }),
  ).resolves.toEqual(TOKEN);
  expect(f.sleeps).toEqual([5_000, 5_000, 10_000]);
  expect(f.events).toEqual(['sleep:5000', 'fetch', 'sleep:5000', 'fetch', 'sleep:10000', 'fetch']);
  expect(f.forms).toEqual([
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'aio-proxy-opencode',
      device_code: DEVICE.device_code,
    },
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'aio-proxy-opencode',
      device_code: DEVICE.device_code,
    },
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'aio-proxy-opencode',
      device_code: DEVICE.device_code,
    },
  ]);
});

test.each(['access_denied', 'expired_token'] as const)('device polling stops on %s', async (code) => {
  const f = oauthFixture([jsonError(400, code)]);
  await expect(
    pollDeviceAuthorization(f.marker, DEVICE, {
      fetch: f.fetch,
      sleep: f.sleep,
      now: f.now,
    }),
  ).rejects.toMatchObject({ code });
});

test('refresh sends one fixed-client form and parses the token response', async () => {
  const f = oauthFixture([Response.json(TOKEN)]);
  await expect(refreshAgentCredential(f.marker, 'aio_agent_rt_v1_old', { fetch: f.fetch })).resolves.toEqual(TOKEN);
  expect(f.forms).toEqual([
    {
      grant_type: 'refresh_token',
      client_id: 'aio-proxy-opencode',
      refresh_token: 'aio_agent_rt_v1_old',
    },
  ]);
});

test('device response cannot redirect approval away from the marker origin', async () => {
  await expect(
    requestDeviceAuthorization(MARKER, {
      fetch: async () =>
        Response.json({
          ...DEVICE,
          verification_uri: 'https://attacker.example/approve',
          verification_uri_complete: 'https://attacker.example/approve#code=ABCD-EFGH',
        }),
    }),
  ).rejects.toMatchObject({ code: 'invalid_response' });
});
