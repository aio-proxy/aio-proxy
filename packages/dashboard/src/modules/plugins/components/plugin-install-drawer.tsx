import { m } from '@aio-proxy/i18n';
import { PluginPackageNameSchema } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@aio-proxy/ui/components/drawer';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import { useForm } from '@tanstack/react-form';
import { forwardRef, useImperativeHandle, useState } from 'react';
import { z } from 'zod';

import { usePluginInstallMutation } from '../hooks/use-plugin-mutations';
import { PluginRequestError } from '../services/plugins-service';

const PluginInstallFormSchema = z.object({
  packageName: PluginPackageNameSchema,
  registry: z.union([z.literal(''), z.url()]),
  trustConfirmed: z.literal(true),
});

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

export const PluginInstallDrawer = forwardRef<PluginInstallDrawerRef>((_, ref) => {
  const [open, setOpen] = useState(false);
  const mutation = usePluginInstallMutation();
  const isMobile = useIsMobile();
  const form = useForm({
    defaultValues: { packageName: '', registry: '', trustConfirmed: false },
    validators: { onChange: PluginInstallFormSchema },
    onSubmit: ({ value }) => {
      const parsed = PluginInstallFormSchema.safeParse(value);
      if (!parsed.success) return;
      mutation.mutate(
        {
          packageName: parsed.data.packageName,
          confirmed: true,
          ...(parsed.data.registry === '' ? {} : { registry: parsed.data.registry }),
        },
        {
          onSuccess: () => {
            setOpen(false);
            form.reset();
          },
        },
      );
    },
  });

  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const error = installErrorMessage(mutation.error);

  return (
    <Drawer open={open} onOpenChange={setOpen} swipeDirection={isMobile ? 'down' : 'right'}>
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
            void form.handleSubmit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            <form.Field name="packageName">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="plugin-package-name">{m['dashboard.plugins.package_name']()}</FieldLabel>
                  <Input
                    id="plugin-package-name"
                    autoComplete="off"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
            <form.Field name="registry">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="plugin-registry">{m['dashboard.plugins.registry']()}</FieldLabel>
                  <Input
                    id="plugin-registry"
                    type="url"
                    value={field.state.value}
                    placeholder={m['dashboard.plugins.registry_placeholder']()}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
            <form.Field name="trustConfirmed">
              {(field) => (
                <Field>
                  <FieldLabel className="items-start">
                    <Checkbox
                      checked={field.state.value}
                      onCheckedChange={(checked) => field.handleChange(checked === true)}
                    />
                    {m['dashboard.plugins.trust_local_code']()}
                  </FieldLabel>
                  <FieldDescription>{m['dashboard.plugins.trust_local_code_description']()}</FieldDescription>
                </Field>
              )}
            </form.Field>
            {error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DrawerFooter className="flex-row justify-end border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {m['dashboard.plugins.cancel']()}
            </Button>
            <form.Subscribe
              selector={(state) => [PluginInstallFormSchema.safeParse(state.values).success, state.isSubmitting]}
            >
              {([isValid, isSubmitting]) => (
                <Button type="submit" disabled={!isValid || isSubmitting || mutation.isPending}>
                  {m['dashboard.plugins.install_action']()}
                </Button>
              )}
            </form.Subscribe>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
});
