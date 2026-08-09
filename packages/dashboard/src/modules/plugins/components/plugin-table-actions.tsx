import { m } from '@aio-proxy/i18n';
import type { DashboardPluginSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { createContext, useContext } from 'react';

import type { PluginOptionsDrawerRef } from './plugin-options-drawer';
import type { PluginUninstallDialogRef } from './plugin-uninstall-dialog';

interface PluginTableActionsContextValue {
  readonly optionsRef: React.RefObject<PluginOptionsDrawerRef | null>;
  readonly uninstallRef: React.RefObject<PluginUninstallDialogRef | null>;
}

interface PluginTableActionsProps {
  readonly plugin: DashboardPluginSummary;
}

export const PluginTableActionsContext = createContext<PluginTableActionsContextValue | null>(null);

export const PluginTableActions: React.FC<PluginTableActionsProps> = ({ plugin }) => {
  const actions = useContext(PluginTableActionsContext);
  if (actions === null) return null;

  return (
    <div className="flex justify-end gap-2">
      {plugin.hasOptions ? (
        <Button type="button" size="sm" variant="outline" onClick={() => actions.optionsRef.current?.open(plugin)}>
          {m['dashboard.plugins.options_action']()}
        </Button>
      ) : null}
      {plugin.builtin ? null : (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={() => actions.uninstallRef.current?.open(plugin)}
        >
          {m['dashboard.plugins.uninstall_action']()}
        </Button>
      )}
    </div>
  );
};
