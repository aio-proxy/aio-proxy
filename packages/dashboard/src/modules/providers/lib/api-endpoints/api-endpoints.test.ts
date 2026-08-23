import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';

import {
  apiConnectionIssues,
  apiDraftFromProvider,
  apiDraftToMutation,
  emptySharedDraft,
  sharedConversionIssue,
  switchApiEndpointShape,
  type ApiEndpointDraft,
} from './api-endpoints';

const shared = (overrides: Partial<Extract<ApiEndpointDraft, { shape: 'shared' }>> = {}): ApiEndpointDraft => ({
  shape: 'shared',
  baseURL: 'https://gw.example/v1',
  protocols: [ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic],
  ...overrides,
});

const separate = (
  entries: Extract<ApiEndpointDraft, { shape: 'separate' }>['entries'] = [
    { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://a.example/v1' },
    { protocol: ProviderProtocol.Anthropic, baseURL: 'https://b.example/anthropic/v1', auth: 'bearer' },
  ],
): ApiEndpointDraft => ({ shape: 'separate', entries });

describe('apiDraftFromProvider', () => {
  test('a single protocol/baseURL pair becomes a shared draft with one protocol', () => {
    expect(
      apiDraftFromProvider({
        kind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAIResponse,
        baseURL: 'https://api.openai.com/v1',
      }),
    ).toEqual({
      shape: 'shared',
      baseURL: 'https://api.openai.com/v1',
      protocols: [ProviderProtocol.OpenAIResponse],
    });
  });

  test('a shared endpoints object becomes a shared draft', () => {
    expect(
      apiDraftFromProvider({
        kind: ProviderKind.Api,
        endpoints: {
          baseURL: 'https://gw.example/v1',
          protocol: [ProviderProtocol.OpenAIResponse, ProviderProtocol.Anthropic],
        },
      }),
    ).toEqual({
      shape: 'shared',
      baseURL: 'https://gw.example/v1',
      protocols: [ProviderProtocol.OpenAIResponse, ProviderProtocol.Anthropic],
    });
  });

  test('an endpoints array with two URLs becomes a separate draft', () => {
    expect(
      apiDraftFromProvider({
        kind: ProviderKind.Api,
        endpoints: [
          { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://a.example/v1' },
          { protocol: ProviderProtocol.Anthropic, baseURL: 'https://b.example/anthropic/v1', auth: 'bearer' },
        ],
      }),
    ).toEqual(
      separate([
        { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://a.example/v1' },
        { protocol: ProviderProtocol.Anthropic, baseURL: 'https://b.example/anthropic/v1', auth: 'bearer' },
      ]),
    );
  });

  test('a legacy pair plus extra endpoints becomes a separate draft with the pair first', () => {
    expect(
      apiDraftFromProvider({
        kind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: 'https://api.moonshot.cn/v1',
        endpoints: [{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.moonshot.cn/anthropic/v1' }],
      }),
    ).toEqual(
      separate([
        { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://api.moonshot.cn/v1' },
        { protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.moonshot.cn/anthropic/v1' },
      ]),
    );
  });
});

describe('apiDraftToMutation', () => {
  test('one shared protocol writes the legacy pair and omits endpoints', () => {
    expect(
      apiDraftToMutation({
        shape: 'shared',
        baseURL: 'https://api.openai.com/v1',
        protocols: [ProviderProtocol.OpenAIResponse],
      }),
    ).toEqual({ protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://api.openai.com/v1' });
  });

  test('several shared protocols write the shared endpoints object', () => {
    expect(apiDraftToMutation(shared())).toEqual({
      endpoints: {
        baseURL: 'https://gw.example/v1',
        protocol: [ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic],
      },
    });
  });

  test('separate rows write an endpoints array', () => {
    expect(apiDraftToMutation(separate())).toEqual({
      endpoints: [
        { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://a.example/v1' },
        { protocol: ProviderProtocol.Anthropic, baseURL: 'https://b.example/anthropic/v1', auth: 'bearer' },
      ],
    });
  });

  test('default anthropic auth is omitted from the array form', () => {
    expect(
      apiDraftToMutation(
        separate([{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.anthropic.com', auth: 'x-api-key' }]),
      ),
    ).toEqual({
      endpoints: [{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.anthropic.com' }],
    });
  });
});

describe('switchApiEndpointShape', () => {
  test('shared to separate copies the shared URL onto every selected protocol', () => {
    expect(switchApiEndpointShape(shared(), 'separate')).toEqual(
      separate([
        { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://gw.example/v1' },
        { protocol: ProviderProtocol.Anthropic, baseURL: 'https://gw.example/v1' },
      ]),
    );
  });

  test('an empty shared draft becomes one blank separate row', () => {
    expect(switchApiEndpointShape(emptySharedDraft(), 'separate')).toEqual({
      shape: 'separate',
      entries: [{ protocol: '', baseURL: '' }],
    });
  });

  test('separate rows with one URL fold back into a shared draft', () => {
    expect(
      switchApiEndpointShape(
        separate([
          { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://same.example/v1' },
          { protocol: ProviderProtocol.Anthropic, baseURL: 'https://same.example/v1', auth: 'x-api-key' },
        ]),
        'shared',
      ),
    ).toEqual({
      shape: 'shared',
      baseURL: 'https://same.example/v1',
      protocols: [ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic],
    });
  });

  test('separate rows with different URLs stay separate', () => {
    const draft = separate();
    expect(switchApiEndpointShape(draft, 'shared')).toEqual(draft);
  });
});

describe('sharedConversionIssue', () => {
  test('blocks folding when URLs or bearer auth would be lost', () => {
    expect(sharedConversionIssue(separate().entries)).toBe(
      'dashboard.providers.form.endpoints_shared_conversion_blocked',
    );
  });

  test('allows folding when every row shares a URL and default auth', () => {
    expect(
      sharedConversionIssue([
        { protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://same.example/v1' },
        { protocol: ProviderProtocol.Anthropic, baseURL: 'https://same.example/v1', auth: 'x-api-key' },
      ]),
    ).toBeUndefined();
  });
});

describe('apiConnectionIssues', () => {
  test('a blank shared draft needs a URL and at least one protocol', () => {
    expect(apiConnectionIssues(emptySharedDraft(), { apiKey: '', hasApiKey: false })).toBe('missing');
  });

  test('a typed but unusable shared URL is a bad address', () => {
    expect(apiConnectionIssues(shared({ baseURL: 'api.example.com' }), { apiKey: '', hasApiKey: false })).toBe(
      'bad-url',
    );
  });

  test('a complete shared draft is ready', () => {
    expect(apiConnectionIssues(shared(), { apiKey: '', hasApiKey: false })).toBeUndefined();
  });

  test('a separate row without a protocol or URL is missing', () => {
    expect(
      apiConnectionIssues(
        { shape: 'separate', entries: [{ protocol: '', baseURL: '' }] },
        { apiKey: '', hasApiKey: false },
      ),
    ).toBe('missing');
  });

  test('anthropic bearer without a key is a missing key', () => {
    expect(
      apiConnectionIssues(
        separate([{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.anthropic.com', auth: 'bearer' }]),
        { apiKey: '', hasApiKey: false },
      ),
    ).toBe('bearer-key');
  });

  test('a stored key satisfies anthropic bearer', () => {
    expect(
      apiConnectionIssues(
        separate([{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.anthropic.com', auth: 'bearer' }]),
        { apiKey: '', hasApiKey: true },
      ),
    ).toBeUndefined();
  });
});
