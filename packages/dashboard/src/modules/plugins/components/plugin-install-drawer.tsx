import { m } from '@aio-proxy/i18n';
import { PluginPackageNameSchema } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@aio-proxy/ui/components/drawer';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import { useForm } from '@tanstack/react-form';
import { forwardRef, useImperativeHandle, useState } from 'react';
import { z } from 'zod';

import { usePluginInstallMutation } from '../hooks/use-plugin-mutations';
import { PluginRequestError } from '../services/plugins-service';
import { PluginInstallInputField } from './plugin-install-input-field';
import { PluginInstallSubmitButton } from './plugin-install-submit-button';
import { PluginTrustField } from './plugin-trust-field';

const PluginInstallRequestFormSchema = z.object({
  packageName: PluginPackageNameSchema,
  registry: z.union([z.literal(''), z.url()]),
});
const PluginInstallFormSchema = PluginInstallRequestFormSchema.extend({ trustConfirmed: z.boolean() });

type PluginInstallRequest = {
  readonly packageName: string;
  readonly registry?: string;
};

const isSameInstallRequest = (left: PluginInstallRequest, right: PluginInstallRequest) =>
  left.packageName === right.packageName && left.registry === right.registry;

export interface PluginInstallDrawerRef {
  readonly open: () => void;
}

const installErrorMessage = (error: Error | null): string | undefined => {
  if (error === null) return undefined;
  if (error instanceof PluginRequestError && error.code === 'confirmation_required') {
    return m['dashboard.plugins.install_confirmation_required']();
  }
  return m['dashboard.plugins.install_failed']();
};

const usePluginInstallWorkflow = () => {
  const [open, setOpen] = useState(false);
  const [challengedRequest, setChallengedRequest] = useState<PluginInstallRequest | null>(null);
  const mutation = usePluginInstallMutation();
  const form = useForm({
    defaultValues: { packageName: '', registry: '', trustConfirmed: false },
    validators: { onChange: PluginInstallFormSchema },
    onSubmit: ({ value }) => {
      const parsed = PluginInstallRequestFormSchema.safeParse(value);
      if (!parsed.success) return;
      const request: PluginInstallRequest = {
        packageName: parsed.data.packageName,
        ...(parsed.data.registry === '' ? {} : { registry: parsed.data.registry }),
      };
      const confirmed =
        challengedRequest !== null && isSameInstallRequest(challengedRequest, request) && value.trustConfirmed;
      if (challengedRequest !== null && !confirmed) return;
      mutation.mutate(confirmed ? { ...request, confirmed: true } : request, {
        onError: (error) => {
          if (error instanceof PluginRequestError && error.code === 'confirmation_required') {
            setChallengedRequest(request);
            form.setFieldValue('trustConfirmed', false);
          }
        },
        onSuccess: closeDrawer,
      });
    },
  });

  function clearChallenge() {
    setChallengedRequest(null);
    form.setFieldValue('trustConfirmed', false);
    mutation.reset();
  }

  function closeDrawer() {
    form.reset();
    mutation.reset();
    setChallengedRequest(null);
    setOpen(false);
  }

  return {
    challengedRequest,
    clearChallenge,
    closeDrawer,
    error: installErrorMessage(mutation.error),
    form,
    isPending: mutation.isPending,
    open,
    openDrawer: () => setOpen(true),
  };
};

export const PluginInstallDrawer = forwardRef<PluginInstallDrawerRef>((_, ref) => {
  const workflow = usePluginInstallWorkflow();
  const isMobile = useIsMobile();
  useImperativeHandle(ref, () => ({ open: workflow.openDrawer }), [workflow.openDrawer]);

  return (
    <Drawer
      open={workflow.open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) workflow.openDrawer();
        else workflow.closeDrawer();
      }}
      swipeDirection={isMobile ? 'down' : 'right'}
    >
      <DrawerContent className="p-0 sm:w-full sm:max-w-lg" data-testid="plugin-install-drawer">
        <DrawerHeader>
          <DrawerTitle>{m['dashboard.plugins.install_title']()}</DrawerTitle>
          <DrawerDescription>{m['dashboard.plugins.install_description']()}</DrawerDescription>
        </DrawerHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void workflow.form.handleSubmit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            <workflow.form.Field name="packageName">
              {(field) => (
                <PluginInstallInputField
                  id="plugin-package-name"
                  label={m['dashboard.plugins.package_name']()}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(value) => {
                    field.handleChange(value);
                    workflow.clearChallenge();
                  }}
                />
              )}
            </workflow.form.Field>
            <workflow.form.Field name="registry">
              {(field) => (
                <PluginInstallInputField
                  id="plugin-registry"
                  label={m['dashboard.plugins.registry']()}
                  type="url"
                  value={field.state.value}
                  placeholder={m['dashboard.plugins.registry_placeholder']()}
                  onBlur={field.handleBlur}
                  onChange={(value) => {
                    field.handleChange(value);
                    workflow.clearChallenge();
                  }}
                />
              )}
            </workflow.form.Field>
            {workflow.challengedRequest === null ? null : (
              <workflow.form.Field name="trustConfirmed">
                {(field) => (
                  <PluginTrustField checked={field.state.value} onChange={(checked) => field.handleChange(checked)} />
                )}
              </workflow.form.Field>
            )}
            {workflow.error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {workflow.error}
              </p>
            )}
          </div>
          <DrawerFooter className="flex-row justify-end border-t pt-4">
            <Button type="button" variant="outline" onClick={workflow.closeDrawer}>
              {m['dashboard.plugins.cancel']()}
            </Button>
            <workflow.form.Subscribe
              selector={(state) => [
                PluginInstallRequestFormSchema.safeParse(state.values).success,
                state.values.trustConfirmed,
                state.isSubmitting,
              ]}
            >
              {([isValid, trustConfirmed, isSubmitting]) => (
                <PluginInstallSubmitButton
                  confirmationRequired={workflow.challengedRequest !== null}
                  isPending={workflow.isPending}
                  isSubmitting={Boolean(isSubmitting)}
                  isValid={Boolean(isValid)}
                  trustConfirmed={Boolean(trustConfirmed)}
                />
              )}
            </workflow.form.Subscribe>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
});
