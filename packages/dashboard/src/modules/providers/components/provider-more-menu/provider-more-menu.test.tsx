import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderMoreMenu } from './provider-more-menu';

const mocks = rs.hoisted(() => ({ mutate: rs.fn() }));

rs.mock('../../hooks/use-provider-credential-refresh', () => ({
  useProviderCredentialRefresh: () => ({ mutate: mocks.mutate, isPending: false }),
}));
rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));

afterEach(() => {
  mocks.mutate.mockReset();
});

test('offers a credential refresh only when the plugin declares the capability', () => {
  const { rerender } = render(
    <ProviderMoreMenu provider={providerStub({ canRefreshCredential: false })} onDelete={rs.fn()} />,
  );
  fireEvent.click(screen.getByRole('button'));
  expect(screen.queryByTestId('provider-refresh-credential')).toBeNull();

  rerender(<ProviderMoreMenu provider={providerStub({ canRefreshCredential: true })} onDelete={rs.fn()} />);
  // Queried by accessible name, not testid: the visible label is the accessible name, so this also
  // catches a missing or broken `dashboard.providers.actions.refresh_credential` message key.
  expect(screen.getByRole('menuitem', { name: /refresh credential/i })).not.toBeNull();
});

test('a credential refresh targets the provider the menu belongs to', () => {
  render(
    <ProviderMoreMenu provider={providerStub({ id: 'carpool', canRefreshCredential: true })} onDelete={rs.fn()} />,
  );
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByTestId('provider-refresh-credential'));

  expect(mocks.mutate).toHaveBeenCalledWith('carpool');
});
