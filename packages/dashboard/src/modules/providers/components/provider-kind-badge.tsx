import { m } from "@aio-proxy/i18n";
import type { ProviderKind } from "@aio-proxy/types";
import { Badge } from "@/components/ui/badge";

type Props = { kind: ProviderKind };

export const ProviderKindBadge: React.FC<Props> = ({ kind }) => {
  const variant = kind === "api" ? "default" : kind === "ai-sdk" ? "secondary" : "outline";

  const label =
    kind === "api"
      ? m["dashboard.providers.kind_label.api"]()
      : kind === "ai-sdk"
        ? m["dashboard.providers.kind_label.ai-sdk"]()
        : m["dashboard.providers.kind_label.oauth"]();

  return (
    <Badge variant={variant} data-testid="provider-kind-badge">
      {label}
    </Badge>
  );
};
