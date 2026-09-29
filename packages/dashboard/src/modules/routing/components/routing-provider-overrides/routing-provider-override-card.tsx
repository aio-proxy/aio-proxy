import { m } from '@aio-proxy/i18n';
import type { ModelCostInput, ModelLimitInput } from '@aio-proxy/types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@aio-proxy/ui/components/collapsible';
import { Switch } from '@aio-proxy/ui/components/switch';
import type React from 'react';

import { ProviderLabel } from '@/components/provider-label';

import { LIMIT_KEYS, LIMIT_LABEL, type MetadataRecord, withKey } from '../../lib/model-metadata-fields';
import type { RoutingProviderOverrideDraft } from '../../lib/routing-metadata-draft';
import { RoutingProviderIdentity } from '../routing-provider-identity';
import { RoutingProviderOverrideTags } from '../routing-provider-override-tags';
import { RoutingProviderCostForm } from './routing-provider-cost-form';
import { RoutingProviderPlainField } from './routing-provider-plain-field';

interface RoutingProviderOverrideCardProps {
  readonly providerId: string;
  readonly draft: RoutingProviderOverrideDraft;
  /** The model's resolved cost and limit, copied in when an override is turned on. */
  readonly modelCost: MetadataRecord;
  readonly modelLimit: MetadataRecord;
  readonly expanded: boolean;
  readonly writable: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onChange: (next: RoutingProviderOverrideDraft) => void;
}

const nonEmpty = (value: MetadataRecord): MetadataRecord | undefined =>
  Object.keys(value).length === 0 ? undefined : value;

export const RoutingProviderOverrideCard: React.FC<RoutingProviderOverrideCardProps> = ({
  providerId,
  draft,
  modelCost,
  modelLimit,
  expanded,
  writable,
  onExpandedChange,
  onChange,
}) => {
  const cost = draft.cost.value;
  const limit = draft.limit.value;
  // Both groups replace the model's value wholesale, so turning one on starts from a copy of the
  // model's: the override then only has to change what actually differs for this Provider.
  const setCost = (next: MetadataRecord | undefined) =>
    onChange({ ...draft, cost: { touched: true, value: next as ModelCostInput | undefined } });
  const setLimit = (next: MetadataRecord | undefined) =>
    onChange({ ...draft, limit: { touched: true, value: next as ModelLimitInput | undefined } });

  const switchRow = (
    label: string,
    on: boolean,
    description: string,
    onCheckedChange: (checked: boolean) => void,
  ): React.ReactNode => (
    <div className="flex items-start gap-2.5">
      <Switch size="sm" className="mt-0.5" checked={on} aria-label={label} onCheckedChange={onCheckedChange} />
      <div className="text-sm">
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );

  return (
    <Collapsible
      open={expanded}
      onOpenChange={onExpandedChange}
      className="overflow-hidden rounded-xl border"
      data-testid={`provider-override-${providerId}`}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
        <ProviderLabel providerId={providerId}>{(view) => <RoutingProviderIdentity view={view} />}</ProviderLabel>
        <RoutingProviderOverrideTags cost={cost !== undefined} limit={limit !== undefined} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <fieldset disabled={!writable} className="space-y-3 border-t p-2.5">
          {switchRow(
            m['dashboard.routing.profile.provider_cost'](),
            cost !== undefined,
            cost === undefined
              ? m['dashboard.routing.profile.provider_cost_off']()
              : m['dashboard.routing.profile.provider_cost_on'](),
            (on) => setCost(on ? (nonEmpty(modelCost) ?? {}) : undefined),
          )}
          {cost === undefined ? null : (
            <RoutingProviderCostForm providerId={providerId} cost={cost as MetadataRecord} onChange={setCost} />
          )}
          {switchRow(
            m['dashboard.routing.profile.provider_limit'](),
            limit !== undefined,
            limit === undefined
              ? m['dashboard.routing.profile.provider_limit_off']()
              : m['dashboard.routing.profile.provider_limit_on'](),
            (on) => setLimit(on ? (nonEmpty(modelLimit) ?? {}) : undefined),
          )}
          {limit === undefined ? null : (
            <div className="space-y-2">
              {LIMIT_KEYS.map((key) => {
                const own = (limit as MetadataRecord)[key];
                return (
                  <RoutingProviderPlainField
                    key={key}
                    id={`provider-${providerId}-limit-${key}`}
                    label={LIMIT_LABEL[key]()}
                    min={1}
                    step={1}
                    placeholder={m['dashboard.routing.profile.no_limit']()}
                    value={typeof own === 'number' ? own : undefined}
                    onValueChange={(next) => setLimit(withKey(limit as MetadataRecord, key, next))}
                  />
                );
              })}
            </div>
          )}
        </fieldset>
      </CollapsibleContent>
    </Collapsible>
  );
};
