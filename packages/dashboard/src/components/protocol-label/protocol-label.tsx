import { ProviderProtocol } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';

import { withLobeIcon } from '../lobe-icon';

interface ProtocolLabelProps {
  readonly protocol: ProviderProtocol | string;
  readonly className?: string;
  readonly showIcon?: boolean;
  readonly iconSize?: number;
}

const PROTOCOL_LABELS: Record<
  ProviderProtocol,
  { readonly label: string; readonly icon: React.FC<{ size?: number; className?: string }> }
> = {
  [ProviderProtocol.OpenAICompatible]: {
    label: 'OpenAI Compatible',
    icon: withLobeIcon('openai'),
  },
  [ProviderProtocol.OpenAIResponse]: {
    label: 'OpenAI Response',
    icon: withLobeIcon('codex-color'),
  },
  [ProviderProtocol.Anthropic]: {
    label: 'Anthropic',
    icon: withLobeIcon('claude-color'),
  },
  [ProviderProtocol.Gemini]: {
    label: 'Gemini',
    icon: withLobeIcon('gemini-color'),
  },
  [ProviderProtocol.GeminiInteractions]: {
    label: 'Gemini Interactions',
    icon: withLobeIcon('gemini-color'),
  },
  [ProviderProtocol.OpenAIImage]: {
    label: 'OpenAI Image',
    icon: withLobeIcon('openai'),
  },
};

/**
 * Protocol order for pickers. Rendering coverage and picker coverage are different questions:
 * `PROTOCOL_LABELS` must be exhaustive so a card never renders a blank icon, while the pickers offer
 * only the protocols a user may configure or filter by. `openai-image` renders but is not offered.
 * OpenAI Compatible leads because it is what most third-party gateways speak.
 */
export const PROTOCOL_ORDER: readonly ProviderProtocol[] = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
  ProviderProtocol.GeminiInteractions,
];

const isProviderProtocol = (value: string): value is ProviderProtocol =>
  Object.values(ProviderProtocol).includes(value as ProviderProtocol);

export const ProtocolLabel: React.FC<ProtocolLabelProps> = ({
  protocol,
  className,
  showIcon = false,
  iconSize = 16,
}) => {
  if (!isProviderProtocol(protocol)) {
    return <span className={className}>{protocol}</span>;
  }

  const { icon: Icon, label } = PROTOCOL_LABELS[protocol];
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {showIcon ? <Icon size={iconSize} className="shrink-0" /> : null}
      <span>{label}</span>
    </span>
  );
};
