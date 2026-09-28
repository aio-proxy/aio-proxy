import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import type React from 'react';
import { useState } from 'react';

import type { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import type { MetadataRecord } from '../../lib/model-metadata-fields';
import { RoutingProviderOverrideCard } from './routing-provider-override-card';

interface RoutingProviderOverridesProps {
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
  readonly providers: readonly DashboardRoutingProvider[];
  readonly modelCost: MetadataRecord;
  readonly modelLimit: MetadataRecord;
  readonly writable: boolean;
}

const EMPTY_DRAFT = { cost: { touched: false, value: undefined }, limit: { touched: false, value: undefined } };

/** Per-Provider price and limit overrides, one collapsible card per Provider serving the model. */
export const RoutingProviderOverrides: React.FC<RoutingProviderOverridesProps> = ({
  metadataForm,
  providers,
  modelCost,
  modelLimit,
  writable,
}) => {
  // Cards open where an override already exists, so what differs is visible without hunting for it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        providers
          .filter((provider) => provider.override?.cost !== undefined || provider.override?.limit !== undefined)
          .map((provider) => provider.id),
      ),
  );

  return (
    <section className="space-y-3" aria-labelledby="provider-overrides-title" data-testid="routing-overrides-section">
      <div>
        <h3 id="provider-overrides-title" tabIndex={-1} className="scroll-mt-4 text-sm font-medium outline-none">
          {m['dashboard.routing.editor.provider_overrides']()}
        </h3>
        <p className="text-xs text-muted-foreground">{m['dashboard.routing.profile.provider_hint']()}</p>
      </div>
      <metadataForm.Field name="overrides">
        {(field) => (
          <div className="space-y-2">
            {providers.map((provider) => (
              <RoutingProviderOverrideCard
                key={provider.id}
                providerId={provider.id}
                draft={field.state.value[provider.id] ?? EMPTY_DRAFT}
                modelCost={modelCost}
                modelLimit={modelLimit}
                expanded={expanded.has(provider.id)}
                writable={writable}
                onExpandedChange={(open) =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (open) next.add(provider.id);
                    else next.delete(provider.id);
                    return next;
                  })
                }
                onChange={(next) => field.handleChange({ ...field.state.value, [provider.id]: next })}
              />
            ))}
          </div>
        )}
      </metadataForm.Field>
    </section>
  );
};
