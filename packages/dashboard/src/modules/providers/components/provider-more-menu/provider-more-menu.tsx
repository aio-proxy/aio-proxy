import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@aio-proxy/ui/components/dropdown-menu';
import { Link } from '@tanstack/react-router';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type React from 'react';

interface ProviderMoreMenuProps {
  readonly provider: DashboardProviderSummary;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderMoreMenu: React.FC<ProviderMoreMenuProps> = ({ provider, onDelete }) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={m['dashboard.providers.actions.open_menu']({ id: provider.id })}
        />
      }
    >
      <MoreHorizontal />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem render={<Link to="/providers/$id/edit" params={{ id: provider.id }} />}>
        <Pencil />
        {m['dashboard.providers.actions.edit']()}
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onClick={() => onDelete(provider)}>
        <Trash2 />
        {m['dashboard.providers.actions.delete']()}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
