import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { usePreviewSync } from './use-sync';

const mocks = rs.hoisted(() => ({ previewSync: rs.fn() }));

rs.mock('../../services/sync-service', () => ({ previewSync: mocks.previewSync }));

test('invalidates sync, provider, and settings queries after a preview succeeds', async () => {
  mocks.previewSync.mockReset().mockResolvedValue({
    previewId: 'preview-1',
    kind: 'join',
    expiresAt: Date.now() + 10_000,
    retainedSharedPlugins: [],
    rows: [],
  });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateQueries = rs.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => usePreviewSync(), { wrapper });

  result.current.mutate({ kind: 'join', providerId: 'work' });

  await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.sync }));
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.providers });
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
});
