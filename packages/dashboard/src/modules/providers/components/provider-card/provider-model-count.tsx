import { m } from '@aio-proxy/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import type React from 'react';

import { sortModelIds } from '../../lib/model-sort';

interface ProviderModelCountProps {
  readonly models: readonly string[];
}

/**
 * The count is the summary; the list itself is one hover away. Carried over from the Provider table
 * this card replaced, where the models column worked the same way.
 */
export const ProviderModelCount: React.FC<ProviderModelCountProps> = ({ models }) => {
  const label = m['dashboard.providers.card.models_count']({ count: models.length });
  if (models.length === 0) return <span>{label}</span>;

  return (
    <Tooltip>
      {/* `relative z-10` for the same reason the footer controls carry it: the identity link
          stretches a positioned `::after` over the whole card, and a static span paints under it,
          so the hover would never reach this trigger. */}
      <TooltipTrigger
        render={<span className="relative z-10 cursor-help underline decoration-dotted underline-offset-2" />}
        data-testid="provider-card-models-count"
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>
        {/* Sorted for reading, not routed in this order: `clientModels` keeps its configured order,
            which is the client-facing listing contract it shares with `/v1/models`. */}
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {sortModelIds(models).map((model) => (
            <li key={model}>{model}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
};
