import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { providerStub } from '@/lib/provider-fixtures';

const mocks = rs.hoisted(() => ({
  catalog: {
    providers: [] as ReturnType<typeof providerStub>[],
    plugins: [],
    status: 'ready' as const,
  },
}));

rs.mock('@/hooks/use-provider-catalog', () => ({
  useProviderCatalogContext: () => mocks.catalog,
}));

import { ProviderLabel } from './provider-label';

test('passes the resolved Provider view to children', () => {
  mocks.catalog.providers = [
    providerStub({
      id: 'chatgpt',
      name: 'ChatGPT account',
      kind: ProviderKind.OAuth,
      plugin: '@aio-proxy/plugin-openai-chatgpt',
      capability: 'default',
      accountLabel: 'person@example.com',
    }),
  ];
  mocks.catalog.plugins = [
    {
      packageName: '@aio-proxy/plugin-openai-chatgpt',
      displayName: 'OpenAI ChatGPT',
      builtin: true,
      enabled: true,
      hasOptions: false,
      state: { status: 'ready' },
    },
  ];

  render(
    <ProviderLabel providerId="chatgpt">
      {({ name, kindLabel, oauthService, accountLabel }) => (
        <div>
          <span>{name}</span>
          <span>{kindLabel}</span>
          <span>{oauthService}</span>
          <span>{accountLabel}</span>
        </div>
      )}
    </ProviderLabel>,
  );

  expect(screen.getByText('ChatGPT account')).toBeInTheDocument();
  expect(screen.getByText('OAuth')).toBeInTheDocument();
  expect(screen.getByText('OpenAI ChatGPT')).toBeInTheDocument();
  expect(screen.getByText('person@example.com')).toBeInTheDocument();
});

test('falls back to the Provider ID when the catalog has no matching Provider', () => {
  mocks.catalog.providers = [];

  render(
    <ProviderLabel providerId="deleted-provider">
      {({ name, status }) => <span>{`${status}:${name}`}</span>}
    </ProviderLabel>,
  );

  expect(screen.getByText('missing:deleted-provider')).toBeInTheDocument();
});
