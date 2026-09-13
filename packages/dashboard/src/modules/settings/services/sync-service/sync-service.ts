import type {
  SyncApplyInput,
  SyncBackendView,
  SyncDetachInput,
  SyncHistoryItem,
  SyncPreview,
  SyncPreviewInput,
  SyncRangeInput,
  SyncStatus,
} from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { createDashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';
import { SyncRequestError } from '@/lib/sync-request-error';

const dashboardClient = createDashboardClient();
const syncClient = dashboardClient.dashboard.api.sync;

const readSyncResponse = async <T>(response: unknown): Promise<T> => {
  const typedResponse = response as {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
  };
  const result = await typedResponse.json();
  if (!typedResponse.ok || (typeof result === 'object' && result !== null && 'ok' in result && result.ok === false)) {
    const code =
      typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'object'
        ? String((result.error as { readonly code?: unknown }).code ?? 'SYNC_REQUEST_FAILED')
        : 'SYNC_REQUEST_FAILED';
    throw new SyncRequestError(code, typedResponse.status);
  }
  return result as T;
};

export const syncQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.sync,
    queryFn: async (): Promise<SyncStatus> => readSyncResponse<SyncStatus>(await syncClient.$get()),
    // Scheduled reconciliation changes the connection state, the imported Providers and their
    // pending reasons with no mutation from this Dashboard, and the client disables refetch on
    // focus, so a parked Settings page would keep showing the snapshot it loaded with. Half the
    // engine's 60s poll bounds that staleness; the endpoint answers from in-memory server state.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

export const syncBackendsQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.sync, 'backends'],
    queryFn: async (): Promise<{ readonly backends: readonly SyncBackendView[] }> =>
      readSyncResponse<{ readonly backends: readonly SyncBackendView[] }>(await syncClient.backends.$get()),
  });

export const previewSync = async (input: SyncPreviewInput): Promise<SyncPreview> =>
  readSyncResponse<SyncPreview>(await syncClient.preview.$post({ json: input }));

export const applySync = async (input: SyncApplyInput): Promise<SyncStatus> =>
  readSyncResponse<SyncStatus>(await syncClient.apply.$post({ json: input }));

export const setSyncRange = async (input: SyncRangeInput): Promise<SyncStatus> =>
  readSyncResponse<SyncStatus>(await syncClient.range.$put({ json: input }));

export const detachSync = async (input: SyncDetachInput): Promise<SyncStatus> =>
  readSyncResponse<SyncStatus>(await syncClient.detach.$post({ json: input }));

const historySync = async (objectId: string): Promise<readonly SyncHistoryItem[]> => {
  const response = await syncClient.history[':objectId'].$get({ param: { objectId } });
  const result = await readSyncResponse<{ readonly items: readonly SyncHistoryItem[] }>(response);
  return result.items;
};

export const syncHistoryQueryOptions = (objectId: string) =>
  queryOptions({
    queryKey: [...queryKeys.sync, 'history', objectId],
    queryFn: () => historySync(objectId),
    enabled: objectId.length > 0,
  });

export const retrySync = async (): Promise<SyncStatus> => readSyncResponse<SyncStatus>(await syncClient.retry.$post());

export const disconnectSync = async (): Promise<SyncStatus> =>
  readSyncResponse<SyncStatus>(await syncClient.disconnect.$post());
