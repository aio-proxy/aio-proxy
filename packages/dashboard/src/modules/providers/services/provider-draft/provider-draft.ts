import type {
  DashboardProviderDraftCatalogRequest,
  DashboardProviderDraftCatalogResponse,
  DashboardProviderDraftTestRequest,
  DashboardProviderDraftTestResponse,
} from '@aio-proxy/types';

import { dashboardClient } from '@/lib/dashboard-client';

export const fetchProviderDraftCatalog = async (
  input: DashboardProviderDraftCatalogRequest,
): Promise<DashboardProviderDraftCatalogResponse> => {
  const response = await dashboardClient.dashboard.api.providers.draft.catalog.$query({ json: input });
  return response.json();
};

export const testProviderDraftModel = async (
  input: DashboardProviderDraftTestRequest,
): Promise<DashboardProviderDraftTestResponse> => {
  const response = await dashboardClient.dashboard.api.providers.draft.test.$post({ json: input });
  return response.json();
};
