import { m } from '@aio-proxy/i18n';
import {
  type DashboardOAuthFormField,
  DashboardPluginOptionsMutationSchema,
  type DashboardPluginSummary,
} from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@aio-proxy/ui/components/drawer';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import type { AnyFieldApi } from '@tanstack/react-form';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

import { usePluginOptionsMutation } from '../hooks/use-plugin-mutations';
import { pluginOptionsFormValues, usePluginOptionsForm } from '../hooks/use-plugin-options-form';
import { usePluginEditViewQuery } from '../hooks/use-plugins-query';
import { PluginRequestError } from '../services/plugins-service';
import { PluginOptionsField } from './plugin-options-field';

export interface PluginOptionsDrawerRef {
  readonly open: (plugin: Pick<DashboardPluginSummary, 'packageName'>) => void;
}

const optionsErrorMessage = (error: Error | null): string | undefined => {
  if (error === null) return undefined;
  if (error instanceof PluginRequestError && error.code === 'stale_revision') {
    return m['dashboard.plugins.options_stale']();
  }
  return m['dashboard.plugins.options_save_failed']();
};

const optionDefaults = (fields: readonly DashboardOAuthFormField[]): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    fields.flatMap((field) =>
      'defaultValue' in field && field.defaultValue !== undefined ? [[field.key, field.defaultValue]] : [],
    ),
  );

export const PluginOptionsDrawer = forwardRef<PluginOptionsDrawerRef>((_, ref) => {
  const [packageName, setPackageName] = useState<string | null>(null);
  const editViewQuery = usePluginEditViewQuery(packageName);
  const mutation = usePluginOptionsMutation();
  const isMobile = useIsMobile();
  const form = usePluginOptionsForm((value) => {
    if (editViewQuery.data === undefined) return;
    const parsed = DashboardPluginOptionsMutationSchema.safeParse({
      packageName: editViewQuery.data.packageName,
      revision: editViewQuery.data.revision,
      publicValues: value.publicValues,
      secretValues: Object.fromEntries(Object.entries(value.secretValues).filter(([, secret]) => secret !== '')),
      clearSecretKeys: value.clearSecretKeys,
    });
    if (!parsed.success) return;
    mutation.mutate(parsed.data, { onSuccess: closeDrawer });
  });

  function closeDrawer() {
    form.reset(pluginOptionsFormValues(editViewQuery.data));
    mutation.reset();
    setPackageName(null);
  }

  useImperativeHandle(ref, () => ({ open: (plugin) => setPackageName(plugin.packageName) }), []);

  useEffect(() => {
    if (editViewQuery.data !== undefined) form.reset(pluginOptionsFormValues(editViewQuery.data));
  }, [editViewQuery.data, form, packageName]);

  const error = optionsErrorMessage(mutation.error);

  return (
    <Drawer
      open={packageName !== null}
      onOpenChange={(open) => {
        if (!open) closeDrawer();
      }}
      swipeDirection={isMobile ? 'down' : 'right'}
    >
      <DrawerContent className="p-0 sm:w-full sm:max-w-lg" data-testid="plugin-options-drawer">
        <DrawerHeader>
          <DrawerTitle>{m['dashboard.plugins.options_title']({ packageName: packageName ?? '' })}</DrawerTitle>
          <DrawerDescription>{m['dashboard.plugins.options_description']()}</DrawerDescription>
        </DrawerHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {editViewQuery.isLoading && (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}
            {!editViewQuery.isLoading && (editViewQuery.isError || editViewQuery.data === undefined) && (
              <p role="alert" className="text-sm text-destructive">
                {m['dashboard.plugins.options_load_failed']()}
              </p>
            )}
            {!editViewQuery.isLoading && !editViewQuery.isError && editViewQuery.data !== undefined && (
              <form.Field name="publicValues">
                {(publicField: AnyFieldApi) => (
                  <form.Field name="secretValues">
                    {(secretField: AnyFieldApi) => (
                      <form.Field name="jsonValues">
                        {(jsonField: AnyFieldApi) => {
                          const combined = {
                            ...optionDefaults(editViewQuery.data.form),
                            ...publicField.state.value,
                            ...secretField.state.value,
                          };
                          return (
                            <div className="space-y-4">
                              {editViewQuery.data.form.map((field) => (
                                <PluginOptionsField
                                  key={field.key}
                                  field={field}
                                  combined={combined}
                                  publicField={publicField}
                                  secretField={secretField}
                                  jsonField={jsonField}
                                  form={form}
                                />
                              ))}
                            </div>
                          );
                        }}
                      </form.Field>
                    )}
                  </form.Field>
                )}
              </form.Field>
            )}
            {error === undefined ? null : (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DrawerFooter className="flex-row justify-end border-t pt-4">
            <Button type="button" variant="outline" onClick={closeDrawer}>
              {m['dashboard.plugins.cancel']()}
            </Button>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  type="submit"
                  disabled={editViewQuery.data === undefined || !canSubmit || isSubmitting || mutation.isPending}
                >
                  {m['dashboard.plugins.options_save']()}
                </Button>
              )}
            </form.Subscribe>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
});
