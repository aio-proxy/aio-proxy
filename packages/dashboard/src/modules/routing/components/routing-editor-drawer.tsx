import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@aio-proxy/ui/components/drawer';
import { useRef, useState } from 'react';

import { reconcileRoutingFormRows, routingDraftRecord, useRoutingForm } from '../hooks/use-routing-form';
import { useRoutingMutation } from '../hooks/use-routing-mutation';
import { explicitRoutingOverrides } from '../lib/routing-summary';
import { isStaleRoutingError } from '../services/routing-service';
import { RoutingBoard } from './routing-board';

interface RoutingEditorDrawerProps {
  readonly model: DashboardRoutingModel | null;
  readonly writable: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReload: () => void | Promise<DashboardRoutingModel | null | undefined>;
}

export const RoutingEditorDrawer: React.FC<RoutingEditorDrawerProps> = ({
  model,
  writable,
  onOpenChange,
  onReload,
}) => {
  const mutation = useRoutingMutation();
  const [stale, setStale] = useState(false);
  const reloadGeneration = useRef(0);
  const form = useRoutingForm(model, (value) => {
    if (model === null) return;
    mutation.mutate(
      {
        modelId: model.modelId,
        revision: model.revision,
        baselineProviderIds: model.baselineProviderIds,
        providers: explicitRoutingOverrides(routingDraftRecord(value.providers)),
      },
      {
        onSuccess: () => {
          mutation.reset();
          setStale(false);
          onOpenChange(false);
        },
        onError: (error) => {
          if (isStaleRoutingError(error)) setStale(true);
        },
      },
    );
  });

  const close = () => {
    reloadGeneration.current += 1;
    setStale(false);
    mutation.reset();
    onOpenChange(false);
  };

  const reloadEditor = () => {
    const generation = ++reloadGeneration.current;
    const initiatedId = model?.modelId;
    void Promise.resolve(onReload()).then((next) => {
      if (generation !== reloadGeneration.current) return;
      if (next == null || next.modelId !== initiatedId) return;
      form.setFieldValue('providers', reconcileRoutingFormRows(form.getFieldValue('providers') ?? [], next));
    });
  };

  return (
    <Drawer
      open={model !== null}
      swipeDirection="right"
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DrawerContent
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:36rem]"
        data-testid="routing-editor-drawer"
      >
        <DrawerHeader>
          <DrawerTitle>{m['dashboard.routing.editor.title']({ modelId: model?.modelId ?? '' })}</DrawerTitle>
          <DrawerDescription>{m['dashboard.routing.editor.description']()}</DrawerDescription>
        </DrawerHeader>
        {model === null ? null : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            {writable ? null : (
              <p role="status" className="mx-4 rounded-lg border bg-muted p-3 text-sm">
                {m['dashboard.routing.read_only']()}
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              <RoutingBoard form={form} model={model} writable={writable} />
              {stale ? (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {m['dashboard.routing.editor.stale']()}
                </p>
              ) : mutation.error == null ? null : (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {m['dashboard.routing.editor.save_failed']()}
                </p>
              )}
            </div>
            <DrawerFooter className="flex-row justify-end">
              <Button type="button" variant="outline" onClick={close}>
                {m['dashboard.routing.editor.cancel']()}
              </Button>
              {stale ? (
                <Button type="button" variant="outline" onClick={reloadEditor}>
                  {m['dashboard.routing.editor.reload']()}
                </Button>
              ) : null}
              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
                {([canSubmit, isSubmitting]) => (
                  <Button
                    type="submit"
                    data-testid="routing-save"
                    disabled={!writable || !canSubmit || isSubmitting || mutation.isPending}
                  >
                    {m['dashboard.routing.editor.save']()}
                  </Button>
                )}
              </form.Subscribe>
            </DrawerFooter>
          </form>
        )}
      </DrawerContent>
    </Drawer>
  );
};
