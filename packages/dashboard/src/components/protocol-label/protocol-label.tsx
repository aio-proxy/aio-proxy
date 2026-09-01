import { ProviderProtocol } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';

import { withLobeIcon } from '../lobe-icon';

interface ProtocolLabelProps {
  readonly protocol: ProviderProtocol | string;
  readonly className?: string;
  readonly showIcon?: boolean;
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
 * Protocol order for pickers. Declaration order above, not `Object.values(ProviderProtocol)`: the enum
 * declares `openai-response` first, while OpenAI Compatible is what most third-party gateways speak and
 * so is what a protocol dropdown should open on. The `Record<ProviderProtocol, …>` annotation is what
 * keeps this list exhaustive — a new protocol fails to compile until it is listed.
 */
export const PROTOCOL_ORDER = Object.keys(PROTOCOL_LABELS) as readonly ProviderProtocol[];

const isProviderProtocol = (value: string): value is ProviderProtocol =>
  Object.values(ProviderProtocol).includes(value as ProviderProtocol);

export const ProtocolLabel: React.FC<ProtocolLabelProps> = ({ protocol, className, showIcon = false }) => {
  if (!isProviderProtocol(protocol)) {
    return <span className={className}>{protocol}</span>;
  }

  const { icon: Icon, label } = PROTOCOL_LABELS[protocol];
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {showIcon ? <Icon size={16} className="shrink-0" /> : null}
      <span>{label}</span>
    </span>
  );
};
