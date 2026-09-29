import { m } from '@aio-proxy/i18n';
import type React from 'react';

import {
  PRICE_LABEL,
  PRICE_MAIN_KEYS,
  PRICE_MORE_KEYS,
  PRICE_UNIT,
  type MetadataRecord,
  type PriceKey,
  tiersAt,
  withKey,
} from '../../lib/model-metadata-fields';
import { ModelMetadataMorePrices } from '../model-metadata-visual-tab/model-metadata-more-prices';
import { ModelMetadataTiers } from '../model-metadata-visual-tab/model-metadata-tiers';
import { RoutingProviderPlainField } from './routing-provider-plain-field';

interface RoutingProviderCostFormProps {
  readonly providerId: string;
  readonly cost: MetadataRecord;
  readonly onChange: (next: MetadataRecord) => void;
}

/** A Provider's own price list. It replaces the model's wholesale, so an empty field is simply not charged. */
export const RoutingProviderCostForm: React.FC<RoutingProviderCostFormProps> = ({ providerId, cost, onChange }) => {
  const field = (key: PriceKey) => (
    <RoutingProviderPlainField
      key={key}
      id={`provider-${providerId}-cost-${key}`}
      label={PRICE_LABEL[key]()}
      unit={PRICE_UNIT[key]()}
      min={0}
      step="any"
      placeholder={m['dashboard.routing.profile.not_charged']()}
      value={typeof cost[key] === 'number' ? cost[key] : undefined}
      onValueChange={(next) => onChange(withKey(cost, key, next))}
    />
  );

  return (
    <div className="space-y-2">
      {PRICE_MAIN_KEYS.map(field)}
      <ModelMetadataMorePrices defaultOpen={PRICE_MORE_KEYS.some((key) => typeof cost[key] === 'number')}>
        {PRICE_MORE_KEYS.map(field)}
      </ModelMetadataMorePrices>
      <p className="pt-1 text-xs text-muted-foreground">{m['dashboard.routing.profile.tiers']()}</p>
      <ModelMetadataTiers
        idPrefix={`provider-${providerId}-cost`}
        tiers={tiersAt({ cost }) ?? []}
        editable
        onChange={(next) => onChange(withKey(cost, 'tiers', next.length === 0 ? undefined : next))}
      />
    </div>
  );
};
