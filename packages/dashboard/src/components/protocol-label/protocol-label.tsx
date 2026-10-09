import { ProviderProtocol } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { Scale } from 'lucide-react';

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
    label: 'OpenAI Chat Completions',
    icon: withLobeIcon('openai'),
  },
  [ProviderProtocol.OpenAIResponse]: {
    label: 'OpenAI Responses',
    icon: withLobeIcon('codex-color'),
  },
  [ProviderProtocol.Anthropic]: {
    label: 'Anthropic Messages',
    icon: withLobeIcon('claude-color'),
  },
  [ProviderProtocol.Gemini]: {
    label: 'Gemini generateContent',
    icon: withLobeIcon('gemini-color'),
  },
  [ProviderProtocol.GeminiInteractions]: {
    label: 'Gemini Interactions',
    icon: withLobeIcon('gemini-color'),
  },
  [ProviderProtocol.OpenAIImage]: {
    label: 'OpenAI Images',
    icon: withLobeIcon('openai'),
  },
  [ProviderProtocol.OpenAIAudio]: {
    label: 'OpenAI Audio',
    icon: withLobeIcon('openai'),
  },
  [ProviderProtocol.OpenAIVideo]: {
    label: 'OpenAI Videos',
    icon: withLobeIcon('openai'),
  },
  [ProviderProtocol.OpenAIDecisions]: { label: 'OpenAI Decisions', icon: withLobeIcon('openai') },
  [ProviderProtocol.TypeSafeSystemOne]: {
    label: 'TypeSafe System One',
    // Not a lobehub slug: `@lobehub/icons-static-*` publishes no TypeSafe asset,
    // and `withLobeIcon` renders an <img> whatever the slug, so a missing one is
    // an empty box in both themes rather than a visible failure. A lucide glyph
    // is the honest fallback until an asset exists; scales read as evaluation
    // beside the vendor logos above.
    icon: Scale,
  },
};

/**
 * Protocol order for pickers. Every protocol is offered: each one is a configurable endpoint and
 * carries its own traffic, so leaving one out makes it unconfigurable from the dashboard and hides
 * it from the traces protocol filter.
 * Chat Completions leads because it is what most third-party gateways speak. The media protocols
 * follow the chat ones, and TypeSafe System One is last since it serves evaluation only.
 */
export const PROTOCOL_ORDER: readonly ProviderProtocol[] = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
  ProviderProtocol.GeminiInteractions,
  ProviderProtocol.OpenAIImage,
  ProviderProtocol.OpenAIAudio,
  ProviderProtocol.OpenAIVideo,
  ProviderProtocol.OpenAIDecisions,
  ProviderProtocol.TypeSafeSystemOne,
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
