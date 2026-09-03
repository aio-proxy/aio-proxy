import { m } from '@aio-proxy/i18n';
import type { ProviderProtocol } from '@aio-proxy/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import type React from 'react';

import { ProtocolLabel } from '@/components/protocol-label';

interface ProviderProtocolLabelsProps {
  readonly protocols: readonly ProviderProtocol[];
}

/**
 * One protocol reads as its own name; several collapse to a single word with the list on hover.
 * The card's detail line must stay one line at any card width, and "OpenAI Compatible, Anthropic,
 * Gemini Interactions" cannot — truncating it would cut a protocol name mid-word instead.
 */
export const ProviderProtocolLabels: React.FC<ProviderProtocolLabelsProps> = ({ protocols }) => {
  const [first] = protocols;
  if (first === undefined) return null;
  if (protocols.length === 1) return <ProtocolLabel protocol={first} />;

  return (
    <Tooltip>
      {/* `relative z-10` is what makes the tooltip reachable at all: the card's identity link
          stretches a positioned `::after` over the whole card, and a static inline span paints
          underneath it, so every hover would land on the link instead. Raising it costs the word's
          own share of the card click target, which is the right trade for a hover-only affordance.
          Decoration rather than a button, since the whole card is already one link. */}
      <TooltipTrigger
        render={
          <span tabIndex={0} className="relative z-10 cursor-help underline decoration-dotted underline-offset-2" />
        }
        data-testid="provider-protocols-multi"
      >
        {m['dashboard.providers.card.protocols_multi']()}
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col gap-1">
          {protocols.map((protocol) => (
            <ProtocolLabel key={protocol} protocol={protocol} />
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
};
