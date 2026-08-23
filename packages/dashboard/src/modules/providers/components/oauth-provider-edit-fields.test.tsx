import { m } from '@aio-proxy/i18n';
import { ProviderKind, type OAuthProvider } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useOAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { providerPluginPresentationsQueryOptions } from '../services/provider-plugin-labels';
import { OAuthProviderEditFields } from './oauth-provider-edit-fields';

const PROVIDER = {
  kind: ProviderKind.OAuth,
  plugin: '@aio-proxy/plugin-google-antigravity',
  capability: 'default',
} as OAuthProvider;

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});
queryClient.setQueryData(providerPluginPresentationsQueryOptions().queryKey, {
  plugins: [
    {
      packageName: '@aio-proxy/plugin-google-antigravity',
      displayName: 'Google Antigravity',
      icon: 'antigravity-color',
    },
  ],
});
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

test('shows the plugin name and icon instead of the package id', () => {
  const { result } = renderHook(() => useOAuthProviderForm(() => undefined, undefined), { wrapper });

  render(
    <OAuthProviderEditFields
      provider={PROVIDER}
      oauth={{ accountLabel: 'ops@acme.dev', publicValues: {}, form: [], models: [] }}
      accountForm={result.current}
      onReauthorize={rs.fn()}
      isReauthorizing={false}
      isReauthorizeBlocked={false}
    />,
    { wrapper },
  );

  expect(screen.getByText('Google Antigravity')).toBeInTheDocument();
  expect(screen.queryByText(/@aio-proxy\/plugin-google-antigravity/u)).toBeNull();
  expect(screen.getByRole('img', { hidden: true })).toBeTruthy();
  expect(screen.getByRole('status')).toHaveTextContent('ops@acme.dev');
  expect(screen.getByText(m['dashboard.providers.oauth.reauthorize_helper']())).toBeTruthy();
  expect(screen.getAllByText(/ops@acme\.dev/u)).toHaveLength(1);
});
