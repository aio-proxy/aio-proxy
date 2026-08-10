import { m } from '@aio-proxy/i18n';
import type { DashboardPluginSummary } from '@aio-proxy/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@aio-proxy/ui/components/alert-dialog';
import { forwardRef, useImperativeHandle, useState } from 'react';

import { usePluginUninstallMutation } from '../hooks/use-plugin-mutations';
import { PluginRequestError } from '../services/plugins-service';

export interface PluginUninstallDialogRef {
  readonly open: (plugin: Pick<DashboardPluginSummary, 'packageName'>) => void;
}

export const PluginUninstallDialog = forwardRef<PluginUninstallDialogRef>((_, ref) => {
  const [packageName, setPackageName] = useState<string | null>(null);
  const [dependentProviderIds, setDependentProviderIds] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState(false);
  const mutation = usePluginUninstallMutation();

  useImperativeHandle(ref, () => ({
    open: (plugin) => {
      setPackageName(plugin.packageName);
      setDependentProviderIds([]);
      setFailed(false);
    },
  }));

  const close = () => {
    setPackageName(null);
    setDependentProviderIds([]);
    setFailed(false);
  };

  const uninstall = () => {
    if (packageName === null) return;
    mutation.mutate(packageName, {
      onSuccess: close,
      onError: (error) => {
        if (error instanceof PluginRequestError && error.code === 'dependent_providers') {
          setDependentProviderIds(error.providerIds);
          setFailed(false);
          return;
        }
        setFailed(true);
      },
    });
  };

  return (
    <AlertDialog
      open={packageName !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {packageName === null ? null : (
        <AlertDialogContent data-testid="plugin-uninstall-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{m['dashboard.plugins.uninstall_title']()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m['dashboard.plugins.uninstall_description']({ packageName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dependentProviderIds.length === 0 ? null : (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{m['dashboard.plugins.uninstall_dependencies']()}</p>
              <ul className="list-disc pl-5 font-mono">
                {dependentProviderIds.map((providerId) => (
                  <li key={providerId}>{providerId}</li>
                ))}
              </ul>
            </div>
          )}
          {failed ? (
            <p role="alert" className="text-sm text-destructive">
              {m['dashboard.plugins.uninstall_failed']()}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{m['dashboard.plugins.cancel']()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={uninstall} disabled={mutation.isPending}>
              {m['dashboard.plugins.uninstall_confirm']()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
});
