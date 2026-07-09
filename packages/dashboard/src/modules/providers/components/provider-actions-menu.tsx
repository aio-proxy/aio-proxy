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

export const ProviderActionsMenu: React.FC<Props> = ({ provider, onDelete, onProbe }) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="provider-actions-trigger" asChild>
        <button type="button" className="flex h-8 w-8 items-center justify-center p-0">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {provider.kind !== "oauth" && (
          <DropdownMenuItem data-testid="provider-action-edit" asChild>
            <Link to="/providers/$id/edit" params={{ id: provider.id }}>
              {m["dashboard.providers.actions.edit"]()}
            </Link>
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
