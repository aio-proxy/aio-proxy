import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Plus, Trash2 } from 'lucide-react';
import type React from 'react';

import {
  PRICE_LABEL,
  TIER_PRICE_KEYS,
  type PriceTier,
  formatPrice,
  formatTokens,
  tierSize,
  withKey,
  withTierSize,
} from '../../lib/model-metadata-fields';
import { ModelMetadataNumberField } from './model-metadata-number-field';

interface ModelMetadataTiersProps {
  readonly idPrefix: string;
  readonly tiers: readonly PriceTier[];
  /** Read-only tiers are the inherited ones, shown for reference while the field is not overridden. */
  readonly editable: boolean;
  readonly onChange: (next: readonly PriceTier[]) => void;
}

/** Long-context tier prices: past `size` tokens of context, these prices replace the base ones. */
export const ModelMetadataTiers: React.FC<ModelMetadataTiersProps> = ({ idPrefix, tiers, editable, onChange }) => {
  if (!editable) {
    return tiers.length === 0 ? (
      <p className="text-xs text-muted-foreground">{m['dashboard.routing.profile.tiers_none']()}</p>
    ) : (
      <ul className="space-y-1 text-xs text-muted-foreground">
        {tiers.map((tier, index) => (
          <li key={index}>
            {m['dashboard.routing.profile.tier_summary']({
              size: formatTokens(tierSize(tier) ?? 0),
              prices: TIER_PRICE_KEYS.flatMap((key) =>
                typeof tier[key] === 'number' ? [`${PRICE_LABEL[key]()} ${formatPrice(tier[key])}`] : [],
              ).join(' · '),
            })}
          </li>
        ))}
      </ul>
    );
  }

  const replace = (index: number, next: PriceTier) => onChange(tiers.map((tier, at) => (at === index ? next : tier)));

  return (
    <div className="space-y-2">
      {tiers.map((tier, index) => (
        <div key={index} className="space-y-2 rounded-lg border p-2.5" data-testid={`${idPrefix}-tier-${index}`}>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{m['dashboard.routing.profile.tier_from']()}</span>
            <div className="w-28">
              <ModelMetadataNumberField
                id={`${idPrefix}-tier-${index}-size`}
                label={m['dashboard.routing.profile.tier_size']()}
                labelHidden
                size="sm"
                min={0}
                step={1}
                placeholder="200000"
                value={tierSize(tier)}
                onValueChange={(size) => replace(index, withTierSize(tier, size))}
              />
            </div>
            <span>{m['dashboard.routing.profile.tier_then']()}</span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="ml-auto"
              aria-label={m['dashboard.routing.profile.tier_remove']()}
              onClick={() => onChange(tiers.filter((_, at) => at !== index))}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TIER_PRICE_KEYS.map((key) => (
              <ModelMetadataNumberField
                key={key}
                id={`${idPrefix}-tier-${index}-${key}`}
                label={PRICE_LABEL[key]()}
                size="sm"
                min={0}
                step="any"
                placeholder={m['dashboard.routing.profile.not_charged']()}
                value={typeof tier[key] === 'number' ? tier[key] : undefined}
                onValueChange={(next) => replace(index, withKey(tier, key, next) as PriceTier)}
              />
            ))}
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="link"
        className="h-auto px-0"
        onClick={() => onChange([...tiers, withTierSize({}, undefined)])}
      >
        <Plus data-icon="inline-start" />
        {m['dashboard.routing.profile.tier_add']()}
      </Button>
    </div>
  );
};
