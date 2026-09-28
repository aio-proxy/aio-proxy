import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import type React from 'react';

import { ProviderLabel } from '@/components/provider-label';

import { useModelReference } from '../hooks/use-model-reference';
import {
  PRICE_LABEL,
  PRICE_MAIN_KEYS,
  PRICE_MORE_KEYS,
  PRICE_UNIT,
  type MetadataRecord,
  formatPrice,
  numberAt,
  tiersAt,
} from '../lib/model-metadata-fields';
import type { RoutingMetadataFormValues } from '../lib/routing-metadata-draft';
import { ModelMetadataTiers } from './model-metadata-visual-tab/model-metadata-tiers';
import { RoutingProfileValue } from './routing-profile-value';
import { RoutingProviderIdentity } from './routing-provider-identity';
import { RoutingProviderOverrideTags } from './routing-provider-override-tags';

interface RoutingModelPriceCardProps {
  readonly modelId: string;
  readonly metadata: MetadataRecord | undefined;
  readonly overrides: RoutingMetadataFormValues['overrides'];
  readonly providers: readonly DashboardRoutingProvider[];
  readonly writable: boolean;
  readonly onEdit: (section: 'price' | 'providers') => void;
}

/** Effective prices, plus which Providers are priced or limited on their own. */
export const RoutingModelPriceCard: React.FC<RoutingModelPriceCardProps> = ({
  modelId,
  metadata,
  overrides,
  providers,
  writable,
  onEdit,
}) => {
  const { inherited } = useModelReference(modelId, metadata);
  const reference = inherited as MetadataRecord | undefined;
  const price = (source: MetadataRecord | undefined, key: string) => {
    const value = numberAt(source, 'cost', key);
    return value === undefined ? undefined : formatPrice(value);
  };
  const extras = PRICE_MORE_KEYS.flatMap((key) => {
    const value = price(metadata, key) ?? price(reference, key);
    return value === undefined ? [] : [`${PRICE_LABEL[key]()} ${value} / ${PRICE_UNIT[key]()}`];
  });
  const tiers = tiersAt(metadata) ?? tiersAt(reference) ?? [];
  const overridden = providers.filter(
    (provider) => overrides[provider.id]?.cost.value !== undefined || overrides[provider.id]?.limit.value !== undefined,
  );

  return (
    <Card size="sm" data-testid="routing-model-price-card">
      <CardHeader>
        <CardTitle>{m['dashboard.routing.profile.price_title']()}</CardTitle>
        <CardAction>
          <Button type="button" size="sm" variant="outline" onClick={() => onEdit('price')}>
            {writable ? m['dashboard.routing.profile.edit']() : m['dashboard.routing.profile.view']()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{m['dashboard.routing.profile.unit_million_tokens']()}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {PRICE_MAIN_KEYS.map((key) => (
            <RoutingProfileValue
              key={key}
              label={PRICE_LABEL[key]()}
              own={price(metadata, key)}
              inherited={price(reference, key)}
            />
          ))}
        </dl>
        {extras.length === 0 ? null : <p className="text-xs text-muted-foreground">{extras.join(' · ')}</p>}
        {tiers.length === 0 ? null : (
          <ModelMetadataTiers idPrefix="price-card" tiers={tiers} editable={false} onChange={() => undefined} />
        )}
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{m['dashboard.routing.editor.provider_overrides']()}</p>
            <Button type="button" size="xs" variant="ghost" onClick={() => onEdit('providers')}>
              {writable ? m['dashboard.routing.profile.edit']() : m['dashboard.routing.profile.view']()}
            </Button>
          </div>
          {overridden.length === 0 ? (
            <p className="text-xs text-muted-foreground">{m['dashboard.routing.profile.provider_none']()}</p>
          ) : (
            <ul className="space-y-1.5">
              {overridden.map((provider) => (
                <li key={provider.id} className="flex min-w-0 items-center gap-2 text-sm">
                  <ProviderLabel providerId={provider.id}>
                    {(view) => <RoutingProviderIdentity view={view} compact />}
                  </ProviderLabel>
                  <RoutingProviderOverrideTags
                    cost={overrides[provider.id]?.cost.value !== undefined}
                    limit={overrides[provider.id]?.limit.value !== undefined}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
