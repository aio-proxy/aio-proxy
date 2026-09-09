import { expect, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

import { SyncSettingsGroup } from './sync-settings-group';

test('shows the explicit local plugin action when no backend is installed', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncSettingsGroup />
    </QueryClientProvider>,
  );
  expect(screen.getByTestId('settings-sync-group')).toBeTruthy();
});
