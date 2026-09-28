import type { DashboardProviderSummary } from '@aio-proxy/types';
import type React from 'react';

import { useProviderCatalogContext } from '@/hooks/use-provider-catalog';
import { providerDisplayName, providerKindLabel, providerOAuthService } from '@/lib/provider-display-name';

export interface ProviderLabelView {
  readonly providerId: string;
  readonly provider: DashboardProviderSummary | undefined;
  readonly status: 'loading' | 'ready' | 'missing' | 'error';
  readonly name: string;
  readonly accountLabel: string | undefined;
  readonly kind: DashboardProviderSummary['kind'] | undefined;
  readonly kindLabel: string | undefined;
  readonly oauthService: string | undefined;
  readonly pluginIcon: string | undefined;
}

interface ProviderLabelProps {
  readonly providerId: string;
  readonly children: (view: ProviderLabelView) => React.ReactNode;
}

export const ProviderLabel: React.FC<ProviderLabelProps> = ({ providerId, children }) => {
  const catalog = useProviderCatalogContext();
  const provider = catalog?.providers?.find((item) => item.id === providerId);
  const plugin =
    provider?.plugin === undefined ? undefined : catalog?.plugins?.find((item) => item.packageName === provider.plugin);
  const status =
    provider === undefined ? (catalog?.status === 'ready' ? 'missing' : (catalog?.status ?? 'missing')) : 'ready';
  const view: ProviderLabelView = {
    providerId,
    provider,
    status,
    name: provider === undefined ? providerId : providerDisplayName(provider),
    accountLabel: provider?.accountLabel,
    kind: provider?.kind,
    kindLabel: providerKindLabel(provider),
    oauthService: providerOAuthService(provider, catalog?.plugins),
    pluginIcon: plugin?.icon,
  };
  return children(view);
};
