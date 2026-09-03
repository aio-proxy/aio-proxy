import { describe, expect, test } from '@rstest/core';

import {
  ProviderPackageRequestError,
  providerInstallRequestBody,
  providerPackageStatusQueryOptions,
  throwRequestError,
} from '../services/provider-options-schema-service';

describe('provider options schema service', () => {
  test('package status query key includes the package', () => {
    expect(providerPackageStatusQueryOptions('@ai-sdk/openai').queryKey).toEqual([
      'providers',
      'package-status',
      '@ai-sdk/openai',
    ]);
  });

  test('install requests omit false confirmation and include confirmed untrusted consent', () => {
    expect(providerInstallRequestBody('@ai-sdk/openai', false)).toEqual({ npm: '@ai-sdk/openai' });
    expect(providerInstallRequestBody('community-provider', true)).toEqual({
      npm: 'community-provider',
      confirmed: true,
    });
    expect(providerInstallRequestBody('@vendor/internal-provider', true, '  https://registry.corp.example/  ')).toEqual(
      {
        npm: '@vendor/internal-provider',
        confirmed: true,
        registry: 'https://registry.corp.example/',
      },
    );
    expect(providerInstallRequestBody('@vendor/internal-provider', true, '   ')).toEqual({
      npm: '@vendor/internal-provider',
      confirmed: true,
    });
  });

  test('non-JSON error responses still produce a typed request error', async () => {
    const error = await throwRequestError(new Response('upstream exploded', { status: 502 })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderPackageRequestError);
    expect(error).toMatchObject({ status: 502, code: 'request_failed' });
  });
});
