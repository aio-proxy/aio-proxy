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
});

describe('ApiEndpointsInputSchema', () => {
  test('rejects an empty array and an empty shared protocol list', () => {
    expect(ApiEndpointsInputSchema.safeParse([]).success).toBeFalse();
    expect(ApiEndpointsInputSchema.safeParse({ baseURL: 'https://gw.test/v1', protocol: [] }).success).toBeFalse();
  });
});
