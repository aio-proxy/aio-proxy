import { ProviderProtocol } from "@aio-proxy/types";
import Claude from "@lobehub/icons-static-svg/icons/claude-color.svg?react";
import Codex from "@lobehub/icons-static-svg/icons/codex-color.svg?react";
import Gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg?react";
import OpenAI from "@lobehub/icons-static-svg/icons/openai.svg?react";

import { cn } from "@/lib/utils";

interface ProtocolLabelProps {
  protocol: ProviderProtocol | string;
  className?: string;
}

const PROTOCOL_LABELS = {
  [ProviderProtocol.OpenAICompatible]: {
    label: "OpenAI Compatible",
    icon: OpenAI,
  },
  [ProviderProtocol.OpenAIResponse]: {
    label: "OpenAI Response",
    icon: Codex,
  },
  [ProviderProtocol.Anthropic]: {
    label: "Anthropic",
    icon: Claude,
  },
  [ProviderProtocol.Gemini]: {
    label: "Gemini",
    icon: Gemini,
  },
} as const;

const isProviderProtocol = (value: string): value is ProviderProtocol =>
  Object.values(ProviderProtocol).includes(value as ProviderProtocol);

export const ProtocolLabel: React.FC<ProtocolLabelProps> = ({ protocol, className }) => {
  if (!isProviderProtocol(protocol)) {
    return <span className={className}>{protocol}</span>;
  }

  const { icon: Icon, label } = PROTOCOL_LABELS[protocol];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Icon className="size-4 shrink-0" />
      <span>{label}</span>
    </span>
  );
};
