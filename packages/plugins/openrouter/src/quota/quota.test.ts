import { expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { OpenRouterCredential } from '../schema/index';
import { readOpenRouterQuota } from './quota';

test('maps a finite key limit to a remaining credit ratio', async () => {
  const inits: RuntimeRequestInit[] = [];
  let url = '';
  const snapshot = await readOpenRouterQuota(context(), {
    fetch: async (input, init) => {
      url = String(input);
      inits.push(init ?? {});
      return Response.json({
        data: { label: 'sk-or-v1-au7...890', limit: 100, limit_remaining: 74.5, usage: 25.5, limit_reset: 'monthly' },
      });
    },
  });
  expect(url).toBe('https://openrouter.ai/api/v1/key');
  expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
  expect(snapshot).toEqual({
    items: [{ id: 'credits', displayName: { default: 'Credits', 'zh-Hans': '额度' }, remainingRatio: 0.745 }],
  });
  expect(snapshot.items[0]).not.toHaveProperty('resetsAt');
});

test('returns no items when the key has no spending cap', async () => {
  const snapshot = await readOpenRouterQuota(context(), {
    fetch: async () => Response.json({ data: { label: 'sk-or-v1-x', limit: null, limit_remaining: null, usage: 1 } }),
  });
  expect(snapshot).toEqual({ items: [] });
});

test('fails closed on a non-2xx key probe', async () => {
  await expect(
    readOpenRouterQuota(context(), { fetch: async () => new Response('nope', { status: 401 }) }),
  ).rejects.toThrow(/key/i);
});

test('rejects a negative spending limit as invalid data', async () => {
  await expect(
    readOpenRouterQuota(context(), {
      fetch: async () => Response.json({ data: { label: 'sk-or-v1-x', limit: -1, limit_remaining: 0 } }),
    }),
  ).rejects.toThrow(/invalid data/i);
});

function context() {
  return {
    credentials: {
      read: async () => ({ revision: 1, value: { apiKey: 'sk-or-v1-test-key' } }),
      refresh: async () => {
        throw new Error('durable OpenRouter keys must not refresh');
      },
    } satisfies CredentialPort<OpenRouterCredential>,
    options: {},
    signal: new AbortController().signal,
  };
}
