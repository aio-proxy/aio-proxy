import { describe, expect, test } from 'bun:test';

import { redactSecrets, retainAuthoredTemplateStrings } from './provider-secrets';

describe('redactSecrets', () => {
  test('masks top-level and provider proxy values plus every header value as ****', () => {
    expect(
      redactSecrets({
        proxy: 'http://user:password@proxy.example:8080',
        providers: [
          {
            proxy: '{{env.PROVIDER_PROXY}}',
            headers: { Authorization: 'Bearer expanded-secret', 'X-Tenant': 'expanded-tenant' },
          },
        ],
      }),
    ).toEqual({
      proxy: '****',
      providers: [
        {
          proxy: '****',
          headers: { Authorization: '****', 'X-Tenant': '****' },
        },
      ],
    });
  });
});

describe('retainAuthoredTemplateStrings', () => {
  const env = {
    PROVIDER_PROXY: 'http://user:password@proxy.example:8080',
    UPSTREAM_TOKEN: 'expanded-secret',
    API_BASE_URL: 'https://api.example/v1',
  };

  test('expanded values equal to a prior template expansion restore authored templates', () => {
    const authored = {
      proxy: '{{env.PROVIDER_PROXY}}',
      headers: { Authorization: 'Bearer {{env.UPSTREAM_TOKEN}}' },
      baseURL: '{{env.API_BASE_URL}}',
    };
    const submitted = {
      proxy: 'http://user:password@proxy.example:8080',
      headers: { Authorization: 'Bearer expanded-secret' },
      baseURL: 'https://api.example/v1',
    };

    expect(retainAuthoredTemplateStrings(authored, submitted, env)).toEqual(authored);
  });

  test('keys absent from the submitted object are not copied back', () => {
    const authored = {
      proxy: '{{env.PROVIDER_PROXY}}',
      headers: { Authorization: 'Bearer {{env.UPSTREAM_TOKEN}}' },
      weight: 3,
    };
    const submitted = { weight: 5 };

    expect(retainAuthoredTemplateStrings(authored, submitted, env)).toEqual({ weight: 5 });
  });
});
