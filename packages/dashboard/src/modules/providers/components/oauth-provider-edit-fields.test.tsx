import { m } from '@aio-proxy/i18n';
import { ProviderKind, type OAuthProvider } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { render, renderHook, screen } from '@testing-library/react';

import { useOAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { OAuthProviderEditFields } from './oauth-provider-edit-fields';

const PROVIDER = {
  kind: ProviderKind.OAuth,
  plugin: '@aio-proxy/plugin-codex',
  capability: 'codex',
} as OAuthProvider;

test('confirms the connected account once, as a status, without dropping the save-semantics helper', () => {
  const { result } = renderHook(() => useOAuthProviderForm(() => undefined, undefined));

  render(
    <OAuthProviderEditFields
      provider={PROVIDER}
      oauth={{ accountLabel: 'ops@acme.dev', publicValues: {}, form: [], models: [] }}
      accountForm={result.current}
      onReauthorize={rs.fn()}
      isReauthorizing={false}
      isReauthorizeBlocked={false}
    />,
  );

  // A screen reader is told the provider is connected; before this there was no positive signal in
  // the section at all, only copy about when account edits are persisted.
  expect(screen.getByRole('status')).toHaveTextContent('ops@acme.dev');
  expect(screen.getByText(m['dashboard.providers.oauth.reauthorize_helper']())).toBeTruthy();
  // Once: the read-only table above the row used to repeat the account name.
  expect(screen.getAllByText(/ops@acme\.dev/u)).toHaveLength(1);
});
