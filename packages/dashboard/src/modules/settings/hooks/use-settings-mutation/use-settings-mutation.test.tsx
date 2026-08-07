import type { DashboardSettingsView } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { useSettingsMutation } from '.';

const mocks = rs.hoisted(() => ({ update: rs.fn() }));

rs.mock('../../services/settings-service', () => ({
  updateSettingsMutationFn: mocks.update,
}));

const settings: DashboardSettingsView = {
  hasPassword: false,
  host: '127.0.0.1',
  logging: { enabled: true, level: 'info', retentionDays: 14 },
  port: 9317,
  proxy: null,
  retryAfterCapMs: 30_000,
};

test('invalidates Settings and Providers after a proxy update', async () => {
  const updatedSettings = { ...settings, proxy: '****' as const };
  mocks.update.mockResolvedValue({ ok: true, restartRequired: false, settings: updatedSettings });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(['settings'], settings);
  const invalidate = rs.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => useSettingsMutation(), { wrapper });

  act(() => result.current.mutate({ proxy: null }));

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(queryClient.getQueryData(['settings'])).toEqual(updatedSettings);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['providers'] });
});

test('does not invalidate Providers for a non-proxy update', async () => {
  mocks.update.mockResolvedValue({ ok: true, restartRequired: false, settings });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = rs.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => useSettingsMutation(), { wrapper });

  act(() => result.current.mutate({ retryAfterCapMs: 10_000 }));

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] });
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['providers'] });
});

test('refetches authoritative Settings after a rejected update', async () => {
  mocks.update.mockRejectedValue(new Error('rejected'));
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const refetch = rs.spyOn(queryClient, 'refetchQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => useSettingsMutation(), { wrapper });

  act(() => result.current.mutate({ port: 9400 }));

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(refetch).toHaveBeenCalledWith({ queryKey: ['settings'] });
});
