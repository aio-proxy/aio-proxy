import { describe, expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CLAUDE_OAUTH_BETA } from '../oauth';
import type { ClaudeCredential } from '../schema';
import { ClaudeCatalogError, discoverClaudeModels, initialClaudeCatalogFallback } from './catalog';

const extra = { protocol: 'anthropic' } as const;

describe('Claude model catalog', () => {
  test('pages official models and keeps only claude language ids', async () => {
    const requests: Request[] = [];
    const inits: Array<RuntimeRequestInit | undefined> = [];
    const catalog = await discoverClaudeModels(context(), {
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        inits.push(init);
        const url = new URL(String(input));
        if (!url.searchParams.get('after_id')) {
          return Response.json({
            data: [
              { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', type: 'model' },
              { id: 'not-claude', type: 'model' },
              { id: '  ', type: 'model' },
            ],
            has_more: true,
            last_id: 'claude-sonnet-5',
          });
        }
        return Response.json({
          data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5', type: 'model' }],
          has_more: false,
        });
      },
    });
    expect(requests[0]?.url.startsWith('https://api.anthropic.com/v1/models')).toBe(true);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer access-token');
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(new URL(requests[1]!.url).searchParams.get('after_id')).toBe('claude-sonnet-5');
    expect(catalog.language).toEqual([
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', extra },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', extra },
    ]);
    expect(catalog.image).toEqual([]);
  });

  test('falls back only for retryable discovery failures', () => {
    expect(initialClaudeCatalogFallback(new ClaudeCatalogError('network', true))?.language).toEqual([
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', extra },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', extra },
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', extra },
    ]);
    expect(initialClaudeCatalogFallback(new ClaudeCatalogError('unauthorized', false, 401))).toBeUndefined();
    expect(initialClaudeCatalogFallback(new DOMException('cancelled', 'AbortError'))).toBeUndefined();
  });

  test('treats a successful empty catalog as authoritative', async () => {
    const catalog = await discoverClaudeModels(context(), {
      fetch: async () => Response.json({ data: [], has_more: false }),
    });
    expect(catalog.language).toEqual([]);
  });
});

function context() {
  return {
    credentials: staticPort(),
    options: {},
    signal: new AbortController().signal,
  };
}

function staticPort(): CredentialPort<ClaudeCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: { accessToken: 'access-token', refreshToken: 'refresh', expiresAt: Number.MAX_SAFE_INTEGER },
    }),
    refresh: async () => {
      throw new Error('fresh credential must not refresh');
    },
  };
}
