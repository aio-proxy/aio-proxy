import { expect, test } from 'bun:test';

import type { AccountContext } from '@aio-proxy/plugin-sdk';

import type { ChatGPTCredential } from '../schema';
import { resetOpenAIChatGPTQuota } from './reset';

const credential: ChatGPTCredential = {
  accessToken: 'reset-access-token',
  accountId: 'account-123',
  expiresAt: Number.MAX_SAFE_INTEGER,
  refreshToken: 'reset-refresh-token',
};

function context(signal = new AbortController().signal): AccountContext<ChatGPTCredential, Record<string, never>> {
  return {
    credentials: {
      read: async () => ({ value: credential, revision: 1 }),
      refresh: async () => ({ status: 'superseded', snapshot: { value: credential, revision: 2 } }),
    },
    options: {},
    signal,
  };
}

test('redeems a credit with an idempotency key the upstream has not seen', async () => {
  const requests: { url: string; method: string | undefined; headers: Headers; body: unknown }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ ok: true });
  };

  await resetOpenAIChatGPTQuota(context(), fetcher as never);
  await resetOpenAIChatGPTQuota(context(), fetcher as never);

  const [first, second] = requests;
  expect(first?.url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  expect(first?.method).toBe('POST');
  expect(first?.headers.get('Authorization')).toBe('Bearer reset-access-token');
  expect(first?.headers.get('ChatGPT-Account-Id')).toBe('account-123');
  expect(first?.headers.get('Content-Type')).toBe('application/json');
  const firstId = (first?.body as { redeem_request_id?: unknown } | undefined)?.redeem_request_id;
  expect(typeof firstId).toBe('string');
  // Each call is an intentional redemption, not a retry: reusing the key would make the second a no-op.
  expect((second?.body as { redeem_request_id?: unknown } | undefined)?.redeem_request_id).not.toBe(firstId);
});

test('fails when the upstream rejects the redemption', async () => {
  const fetcher = async (): Promise<Response> => new Response('nope', { status: 409 });
  await expect(resetOpenAIChatGPTQuota(context(), fetcher as never)).rejects.toThrow(
    'ChatGPT reset-credit redemption failed with 409',
  );
});

test('passes the caller signal through so a cancelled reset does not redeem', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    return Response.json({ ok: true });
  };

  await expect(resetOpenAIChatGPTQuota(context(controller.signal), fetcher as never)).rejects.toThrow();
});
