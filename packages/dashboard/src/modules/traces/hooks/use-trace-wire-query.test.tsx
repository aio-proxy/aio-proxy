import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { useTraceWireQuery } from './use-trace-wire-query';

const mocks = rs.hoisted(() => ({ getTraceWire: rs.fn() }));

rs.mock('../services/traces-service', () => ({
  traceWireQueryOptions: (traceId: string, settled: boolean) => ({
    queryKey: queryKeys.traceWire(traceId),
    queryFn: mocks.getTraceWire,
    staleTime: settled ? Number.POSITIVE_INFINITY : 0,
    refetchInterval: false,
  }),
}));

const wire = { available: true, hops: [] };
const traceId = 'a'.repeat(32);

const renderWire = (settled: boolean) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = rs.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    invalidateQueries,
    ...renderHook(({ settled: next }: { readonly settled: boolean }) => useTraceWireQuery(traceId, true, next), {
      wrapper,
      initialProps: { settled },
    }),
  };
};

test('invalidates the wire cache once when a live trace settles', async () => {
  mocks.getTraceWire.mockReset().mockResolvedValue(wire);
  const { invalidateQueries, rerender } = renderWire(false);

  await waitFor(() => expect(mocks.getTraceWire).toHaveBeenCalledTimes(1));
  expect(invalidateQueries).not.toHaveBeenCalled();

  rerender({ settled: true });
  await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.traceWire(traceId) }));
});

test('does not invalidate again when the page opens on an already settled trace', async () => {
  mocks.getTraceWire.mockReset().mockResolvedValue(wire);
  const { invalidateQueries } = renderWire(true);

  await waitFor(() => expect(mocks.getTraceWire).toHaveBeenCalledTimes(1));
  expect(invalidateQueries).not.toHaveBeenCalled();
});
