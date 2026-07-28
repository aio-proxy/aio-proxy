import { type DashboardProviderSummary, ProviderKind } from '@aio-proxy/types';

export const providerStub = (overrides: Partial<DashboardProviderSummary> = {}): DashboardProviderSummary => ({
  id: 'provider-id',
  kind: ProviderKind.OAuth,
  enabled: true,
  passthrough: false,
  last_status: 'unknown',
  last_latency: null,
  clientModels: [],
  state: { status: 'ready' },
  ...overrides,
});
