import { ProviderProtocol } from "@aio-proxy/types";

import { cn } from "@/lib/utils";

import { withLobeIcon } from "../lobe-icon";

interface ProtocolLabelProps {
  readonly protocol: ProviderProtocol | string;
  readonly className?: string;
  readonly showIcon?: boolean;
}

const PROTOCOL_LABELS = {
  [ProviderProtocol.OpenAICompatible]: {
    label: "OpenAI Compatible",
    icon: withLobeIcon("openai"),
  },
  [ProviderProtocol.OpenAIResponse]: {
    label: "OpenAI Response",
    icon: withLobeIcon("codex-color"),
  },
  [ProviderProtocol.Anthropic]: {
    label: "Anthropic",
    icon: withLobeIcon("claude-color"),
  },
  [ProviderProtocol.Gemini]: {
    label: "Gemini",
    icon: withLobeIcon("gemini-color"),
  },
} as const;

const isProviderProtocol = (value: string): value is ProviderProtocol =>
  Object.values(ProviderProtocol).includes(value as ProviderProtocol);

export const ProtocolLabel: React.FC<ProtocolLabelProps> = ({ protocol, className, showIcon = false }) => {
  if (!isProviderProtocol(protocol)) {
    return <span className={className}>{protocol}</span>;
  }

  const { icon: Icon, label } = PROTOCOL_LABELS[protocol];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {showIcon ? <Icon size={16} className="shrink-0" /> : null}
      <span>{label}</span>
    </span>
  );
};
