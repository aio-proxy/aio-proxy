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
      {/* `underline-offset` decoration rather than a button: the whole card is already one link, so
          a real control here would nest interactives. Hover and focus still reach it. */}
      <TooltipTrigger
        render={<span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2" />}
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
