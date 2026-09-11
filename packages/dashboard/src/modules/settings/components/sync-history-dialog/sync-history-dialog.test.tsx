import type { SyncHistoryItem } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SyncHistoryDialog } from './sync-history-dialog';

const history: readonly SyncHistoryItem[] = [
  { operationId: 'operation-b', objectId: 'object-work', writtenAt: 2_000, current: false },
  { operationId: 'operation-a', objectId: 'object-work', writtenAt: 1_000, current: true },
];

rs.mock('../../services/sync-service', () => ({
  syncHistoryQueryOptions: () => ({ queryKey: ['sync', 'history', 'object-work'], queryFn: async () => history }),
}));

test('provides filtering, sorting, pagination, and column visibility controls', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncHistoryDialog objectId="object-work" open onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText(/Filter history|筛选历史/u)).toBeTruthy());
  await waitFor(() => expect(screen.getByText('operation-a')).toBeTruthy());
  expect(screen.getByRole('button', { name: /Columns|列/u })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Previous|上一页/u })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Next|下一页/u })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Operation|操作/u }));
  expect(screen.getByText('operation-a')).toBeTruthy();
});
