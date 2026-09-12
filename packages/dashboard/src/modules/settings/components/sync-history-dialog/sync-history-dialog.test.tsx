import type { SyncHistoryItem } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SyncHistoryDialog } from './sync-history-dialog';

const history: readonly SyncHistoryItem[] = [
  { operationId: 'operation-b', objectId: 'object-work', writtenAt: 2_000, current: false },
  { operationId: 'operation-a', objectId: 'object-work', writtenAt: 1_000, current: true },
];

rs.mock('@/modules/settings/services/sync-service', () => ({
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

test('hiding a column takes effect on the table immediately', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncHistoryDialog objectId="object-work" open onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(screen.getByText('operation-a')).toBeTruthy());
  expect(screen.getAllByRole('columnheader')).toHaveLength(3);

  fireEvent.click(screen.getByRole('button', { name: /Columns|列/u }));
  // Base UI routes a checkbox click through a hidden input that happy-dom bounces back off the
  // wrapping label, so clicking the label is the one gesture that nets a single toggle.
  fireEvent.click(screen.getByText(/Show operation|显示操作/u));

  // The table reads visibility out of form state. Reading it through the non-reactive `form.state`
  // getter left the column on screen until some unrelated parent state happened to change.
  await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(2));
});

test('drops the previous target filter so the next object does not read as empty', async () => {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncHistoryDialog objectId="object-work" open onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText('operation-a')).toBeTruthy());

  const filter = screen.getByLabelText(/Filter history|筛选历史/u);
  fireEvent.change(filter, { target: { value: 'matches-nothing' } });
  await waitFor(() => expect(screen.queryByText('operation-a')).toBeNull());

  // The dialog stays mounted between targets, so without a reset the new object's revisions stay
  // hidden behind the previous object's filter and the dialog reports it as having no history.
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <SyncHistoryDialog objectId="object-other" open onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText('operation-a')).toBeTruthy());
  expect((screen.getByLabelText(/Filter history|筛选历史/u) as HTMLInputElement).value).toBe('');
});
