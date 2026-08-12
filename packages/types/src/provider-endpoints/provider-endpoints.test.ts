import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import {
  ApiEndpointsInputSchema,
  apiProviderEndpoints,
  ProviderProtocol,
  validateApiEndpoints,
} from './provider-endpoints';

const issuesOf = (provider: unknown): readonly string[] => {
  const collected: string[] = [];
  const ctx = {
    addIssue: (issue: { readonly message?: string }) => {
      collected.push(issue.message ?? '');
    },
  } as unknown as z.RefinementCtx;
  validateApiEndpoints(provider as never, ctx);
  return collected;
};

const issueRecordsOf = (provider: unknown): readonly { message: string; path: readonly (string | number)[] }[] => {
  const collected: { message: string; path: readonly (string | number)[] }[] = [];
  const ctx = {
    addIssue: (issue: { readonly message?: string; readonly path?: readonly (string | number)[] }) => {
      collected.push({ message: issue.message ?? '', path: issue.path ?? [] });
    },
  } as unknown as z.RefinementCtx;
  validateApiEndpoints(provider as never, ctx);
  return collected;
};

describe('apiProviderEndpoints', () => {
  test('legacy pair alone normalizes to a single origin endpoint', () => {
    expect(
      apiProviderEndpoints({ protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://api.openai.com/v1' }),
    ).toEqual([{ protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://api.openai.com/v1', mode: 'origin' }]);
  });

  test('legacy pair merges before endpoints entries and keeps entry auth', () => {
    const endpoints = apiProviderEndpoints({
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.moonshot.cn/v1',
      endpoints: [
        { protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.moonshot.cn/anthropic/v1', auth: 'bearer' },
      ],
    });
    expect(endpoints).toEqual([
      { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://api.moonshot.cn/v1', mode: 'origin' },
      {
        protocol: ProviderProtocol.Anthropic,
        baseURL: 'https://api.moonshot.cn/anthropic/v1',
        auth: 'bearer',
        mode: 'sdk',
      },
    ]);
  });

  test('shared object expands per protocol in order with sdk mode', () => {
    expect(
      apiProviderEndpoints({
        endpoints: {
          baseURL: 'https://gw.example.com/v1',
          protocol: [ProviderProtocol.OpenAIResponse, ProviderProtocol.Anthropic],
        },
      }),
    ).toEqual([
      { protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://gw.example.com/v1', mode: 'sdk' },
      { protocol: ProviderProtocol.Anthropic, baseURL: 'https://gw.example.com/v1', mode: 'sdk' },
    ]);
  });

  test('throws when no endpoint is declared', () => {
    expect(() => apiProviderEndpoints({})).toThrow(TypeError);
  });
});

describe('validateApiEndpoints', () => {
  test('ignores non-api providers', () => {
    expect(issuesOf({ kind: 'oauth' })).toEqual([]);
  });

  test('rejects a lone protocol or lone baseURL', () => {
    expect(issuesOf({ kind: 'api', protocol: 'anthropic' })).toEqual([
      'protocol and baseURL must be provided together',
    ]);
    expect(issuesOf({ kind: 'api', baseURL: 'https://a.test' })).toEqual([
      'protocol and baseURL must be provided together',
    ]);
  });

  test('requires the legacy pair or endpoints', () => {
    expect(issuesOf({ kind: 'api' })).toEqual(['protocol/baseURL or endpoints is required']);
  });

  test('rejects duplicate protocols across the legacy pair and endpoints', () => {
    expect(
      issuesOf({
        kind: 'api',
        protocol: 'anthropic',
        baseURL: 'https://a.test',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://b.test' }],
      }),
    ).toEqual(['Duplicate endpoint protocol "anthropic"']);
  });

  test('rejects duplicate protocols inside the endpoints array', () => {
    expect(
      issueRecordsOf({
        kind: 'api',
        endpoints: [
          { protocol: 'anthropic', baseURL: 'https://a.test/v1' },
          { protocol: 'anthropic', baseURL: 'https://b.test/v1' },
        ],
      }),
    ).toEqual([{ message: 'Duplicate endpoint protocol "anthropic"', path: ['endpoints', 1, 'protocol'] }]);
  });

  test('rejects duplicate protocols inside the shared object', () => {
    expect(
      issuesOf({ kind: 'api', endpoints: { baseURL: 'https://gw.test/v1', protocol: ['anthropic', 'anthropic'] } }),
    ).toEqual(['Duplicate endpoint protocol "anthropic"']);
  });

  test('rejects auth on a non-anthropic entry', () => {
    expect(
      issuesOf({ kind: 'api', endpoints: [{ protocol: 'gemini', baseURL: 'https://g.test', auth: 'bearer' }] }),
    ).toEqual(['auth is only supported on anthropic endpoints']);
  });

  test('skips template strings so authoring configs validate after expansion', () => {
    expect(
      issuesOf({
        kind: 'api',
        protocol: 'anthropic',
        baseURL: 'https://a.test',
        endpoints: [{ protocol: '{{env.PROTO}}', baseURL: 'https://b.test' }],
      }),
    ).toEqual([]);
  });

  test('rejects bearer auth without apiKey', () => {
    expect(
      issueRecordsOf({
        kind: 'api',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1', auth: 'bearer' }],
      }),
    ).toEqual([{ message: "auth 'bearer' requires apiKey", path: ['endpoints', 0, 'auth'] }]);
  });

  test('accepts bearer auth with apiKey', () => {
    expect(
      issuesOf({
        kind: 'api',
        apiKey: 'k',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1', auth: 'bearer' }],
      }),
    ).toEqual([]);
  });

  test('accepts bearer auth with templated apiKey', () => {
    expect(
      issuesOf({
        kind: 'api',
        apiKey: '{{env.KEY}}',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1', auth: 'bearer' }],
      }),
    ).toEqual([]);
  });
});

describe('ApiEndpointsInputSchema', () => {
  test('rejects an empty array and an empty shared protocol list', () => {
    expect(ApiEndpointsInputSchema.safeParse([]).success).toBeFalse();
    expect(ApiEndpointsInputSchema.safeParse({ baseURL: 'https://gw.test/v1', protocol: [] }).success).toBeFalse();
  });

  test('rejects auth on the shared object form instead of stripping it', () => {
    expect(
      ApiEndpointsInputSchema.safeParse({ baseURL: 'https://gw.test/v1', protocol: ['anthropic'], auth: 'bearer' })
        .success,
    ).toBeFalse();
  });

  test('rejects an unknown key on an array entry instead of stripping it', () => {
    expect(
      ApiEndpointsInputSchema.safeParse([
        { protocol: 'anthropic', baseURL: 'https://a.test/v1', headers: { 'x-a': 'b' } },
      ]).success,
    ).toBeFalse();
  });
});
