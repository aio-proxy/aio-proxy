import { m } from "@aio-proxy/i18n";
import type { DashboardProviderSummary } from "@aio-proxy/types";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Props = {
  provider: DashboardProviderSummary;
  onDelete?: () => void;
  onProbe?: () => void;
};

const inferredInvalidCodes = new Set(["PROVIDER_CONFIG_INVALID", "LEGACY_OAUTH_CONFIG_UNSUPPORTED"]);

function canEdit(provider: DashboardProviderSummary): boolean {
  if (provider.kind !== "api" && provider.kind !== "ai-sdk") return false;
  return provider.state.diagnostic === undefined || !inferredInvalidCodes.has(provider.state.diagnostic.code);
}

export const ProviderActionsMenu: React.FC<Props> = ({ provider, onDelete, onProbe }) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="provider-actions-trigger"
        aria-label={m["dashboard.providers.actions.open_menu"]({ id: provider.id })}
        className="flex h-8 w-8 items-center justify-center p-0"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canEdit(provider) && (
          <DropdownMenuItem
            data-testid="provider-action-edit"
            render={<Link preload="intent" to="/providers/$id/edit" params={{ id: provider.id }} />}
          >
            {m["dashboard.providers.actions.edit"]()}
          </DropdownMenuItem>
        )}
        {onProbe !== undefined && (
          <DropdownMenuItem data-testid="provider-action-probe" onClick={onProbe}>
            {m["dashboard.providers.actions.probe_now"]()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem data-testid="provider-action-delete" onClick={onDelete} className="text-destructive">
          {m["dashboard.providers.actions.delete"]()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
