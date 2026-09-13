import { expect, test } from 'bun:test';

import { AgentRuntimeError } from '@aio-proxy/agent-provider-runtime';
import type { AgentDeviceCodeResponse, AgentTokenResponse } from '@aio-proxy/types';

import type { GrokDeadline, GrokMarker } from '../../grok';
import { createGrokTransport } from './transport';

const MARKER = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'grok',
  installationId: '11111111-1111-4111-8111-111111111111',
  adapterVersion: '0.21.0',
  endpoint: 'http://127.0.0.1:9317',
} as const satisfies GrokMarker;

const TOKEN = {
  token_type: 'Bearer',
  access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
  refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
  expires_in: 900,
} as const satisfies AgentTokenResponse;

const DEVICE = {
  device_code: 'd'.repeat(43),
  user_code: 'ABCD-EFGH',
  verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
  verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
} as const satisfies AgentDeviceCodeResponse;

const RT = `aio_agent_rt_v1_${'b'.repeat(43)}`;

const budget = (signal: AbortSignal = AbortSignal.timeout(5_000)): GrokDeadline => ({
  deadline: Date.now() + 5_000,
  signal,
});

test('refresh rejects a 307 and never follows Location off origin', async () => {
  const calls: Array<{ readonly url: string; readonly redirect?: RequestRedirect }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, redirect: init?.redirect });
    if (url.includes('outside.invalid')) throw new Error('followed redirect');
    return new Response(null, { status: 307, headers: { Location: 'https://outside.invalid/oauth/token' } });
  };
  const transport = createGrokTransport(MARKER, budget(), { fetch });
  await expect(transport.refresh(MARKER, RT)).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.redirect).toBe('manual');
  expect(calls[0]?.url).toBe('http://127.0.0.1:9317/oauth/token');
  expect(calls.some((call) => call.url.includes('outside.invalid'))).toBe(false);
});

test('invalid device verification URL is rejected by the runtime', async () => {
  const transport = createGrokTransport(MARKER, budget(), {
    fetch: async () =>
      Response.json({
        ...DEVICE,
        verification_uri: 'https://attacker.example/approve',
        verification_uri_complete: 'https://attacker.example/approve#code=ABCD-EFGH',
      }),
  });
  await expect(transport.device(MARKER)).rejects.toMatchObject({ code: 'invalid_response' });
});

test('invalid_grant is distinct from HTTP 500 and network failures', async () => {
  const grant = createGrokTransport(MARKER, budget(), {
    fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
  });
  await expect(grant.refresh(MARKER, RT)).rejects.toMatchObject({ code: 'invalid_grant' });

  const server = createGrokTransport(MARKER, budget(), {
    fetch: async () => new Response('unavailable', { status: 500 }),
  });
  await expect(server.refresh(MARKER, RT)).rejects.toMatchObject({ code: 'invalid_response' });

  const offline = createGrokTransport(MARKER, budget(), {
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await expect(offline.refresh(MARKER, RT)).rejects.toMatchObject({ code: 'network' });
  await expect(offline.refresh(MARKER, RT)).rejects.toBeInstanceOf(AgentRuntimeError);
});

test('cancelled polling sleep ends without waiting the full interval', async () => {
  const controller = new AbortController();
  let fetches = 0;
  const transport = createGrokTransport(MARKER, budget(controller.signal), {
    fetch: async () => {
      fetches += 1;
      return Response.json(TOKEN);
    },
    now: () => 1_000,
  });
  const pending = transport.poll(MARKER, DEVICE);
  await Bun.sleep(20);
  controller.abort();
  const started = performance.now();
  await expect(pending).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(fetches).toBe(0);
});

test('OAuth destination with a foreign origin or userinfo never reaches fetch', async () => {
  let fetches = 0;
  const fetch: typeof globalThis.fetch = async () => {
    fetches += 1;
    return Response.json(TOKEN);
  };
  const transport = createGrokTransport(MARKER, budget(), { fetch });
  await expect(transport.refresh({ ...MARKER, endpoint: 'http://127.0.0.1:9318' }, RT)).rejects.toThrow(
    /network|destination rejected/,
  );
  await expect(transport.refresh({ ...MARKER, endpoint: 'http://user:pass@127.0.0.1:9317' }, RT)).rejects.toThrow(
    /network|destination rejected/,
  );
  expect(fetches).toBe(0);
});

test('refresh succeeds on the marker origin without following redirects', async () => {
  const calls: string[] = [];
  const transport = createGrokTransport(MARKER, budget(), {
    fetch: async (input, init) => {
      calls.push(String(input instanceof Request ? input.url : input));
      expect(init?.redirect).toBe('manual');
      return Response.json(TOKEN);
    },
  });
  await expect(transport.refresh(MARKER, RT)).resolves.toEqual(TOKEN);
  expect(calls).toEqual(['http://127.0.0.1:9317/oauth/token']);
});
