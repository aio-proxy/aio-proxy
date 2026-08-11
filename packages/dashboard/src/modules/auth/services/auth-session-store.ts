import { queryClient } from '@/lib/query-client';
import { queryKeys } from '@/lib/query-keys';

import { clearDashboardAuthToken } from './dashboard-auth-token';

export type DashboardAuthSession = {
  readonly status: 'authenticated' | 'disabled' | 'unauthenticated' | 'unavailable';
  readonly reason?: 'expired';
};

export const isNotDashboardAuthQuery = (query: { readonly queryKey: readonly unknown[] }): boolean =>
  query.queryKey[0] !== queryKeys.auth[0];

export function setDashboardAuthSession(session: DashboardAuthSession): void {
  queryClient.setQueryData(queryKeys.auth, session);
}

export function markDashboardSessionExpired(): void {
  const current = queryClient.getQueryData<DashboardAuthSession>(queryKeys.auth);
  if (current?.status !== 'authenticated' && current?.status !== 'disabled') return;
  clearDashboardAuthToken();
  queryClient.removeQueries({ predicate: isNotDashboardAuthQuery });
  setDashboardAuthSession(
    current.status === 'authenticated'
      ? { status: 'unauthenticated', reason: 'expired' }
      : { status: 'unauthenticated' },
  );
}

export function markDashboardUnavailable(): void {
  const current = queryClient.getQueryData<DashboardAuthSession>(queryKeys.auth);
  if (current?.status !== 'authenticated' && current?.status !== 'disabled') return;
  clearDashboardAuthToken();
  queryClient.removeQueries({ predicate: isNotDashboardAuthQuery });
  setDashboardAuthSession({ status: 'unavailable' });
}
