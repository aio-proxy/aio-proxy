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
import { MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type React from 'react';

import { useProviderCredentialRefresh } from '../../hooks/use-provider-credential-refresh';

interface ProviderMoreMenuProps {
  readonly provider: DashboardProviderSummary;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderMoreMenu: React.FC<ProviderMoreMenuProps> = ({ provider, onDelete }) => {
  // Instantiated per card: the mutation takes the Provider ID at `mutate`, so one shared instance
  // would report `isPending` for every row while a single Provider refreshes.
  const credentialRefresh = useProviderCredentialRefresh();

  return (
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
        {/* Hidden rather than disabled: a plugin without the capability will never gain it at
            runtime, so a permanently greyed row is dead weight. Same treatment as `hasQuota`. */}
        {provider.canRefreshCredential ? (
          <DropdownMenuItem
            data-testid="provider-refresh-credential"
            disabled={credentialRefresh.isPending}
            onClick={() => credentialRefresh.mutate(provider.id)}
          >
            <RefreshCw />
            {m['dashboard.providers.actions.refresh_credential']()}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(provider)}>
          <Trash2 />
          {m['dashboard.providers.actions.delete']()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
