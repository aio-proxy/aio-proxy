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
import { useRoutingMetadataForm } from '../hooks/use-routing-metadata-form';
import { useRoutingMutation } from '../hooks/use-routing-mutation';
import {
  mergeRoutingMutationDrafts,
  reconcileRoutingMetadataValues,
  routingOverrideDraftsValid,
} from '../lib/routing-metadata-draft';
import { explicitRoutingOverrides } from '../lib/routing-summary';
import { isStaleRoutingError } from '../services/routing-service';
import { ModelMetadataEditor } from './model-metadata-editor';
import { RoutingBoard } from './routing-board';
import { RoutingProviderOverrideFields } from './routing-provider-override-fields';

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
  // Invalid metadata JSON stays local to the editor; saving over it would silently persist the
  // last valid value and discard the visible draft, so Save is gated until the draft is repaired.
  const [metadataValid, setMetadataValid] = useState(true);
  const reloadGeneration = useRef(0);
  // Metadata and per-provider cost/limit live in their own form: the board rows must stay
  // priority/weight-only so a drag or share change can never carry — or delete — drawer data.
  const metadataForm = useRoutingMetadataForm(model);
  const form = useRoutingForm(model, (value) => {
    if (model === null) return;
    mutation.mutate(
      {
        modelId: model.modelId,
        revision: model.revision,
        baselineProviderIds: model.baselineProviderIds,
        ...mergeRoutingMutationDrafts(
          explicitRoutingOverrides(routingDraftRecord(value.providers)),
          metadataForm.state.values,
        ),
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
      metadataForm.reset(reconcileRoutingMetadataValues(metadataForm.state.values, next));
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
              // Keyboard submit bypasses the disabled Save button, so the gate lives here too.
              if (!metadataValid || !routingOverrideDraftsValid(metadataForm.state.values.overrides)) return;
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
              <section className="mt-6 space-y-2" data-testid="routing-metadata-section">
                <h3 className="text-sm font-medium">{m['dashboard.routing.editor.metadata']()}</h3>
                <p className="text-xs text-muted-foreground">{m['dashboard.routing.editor.metadata_description']()}</p>
                <metadataForm.Field name="metadata">
                  {(field) => (
                    <ModelMetadataEditor
                      model={model.modelId}
                      value={field.state.value.value}
                      onChange={(next) => field.handleChange({ touched: true, value: next })}
                      onValidityChange={setMetadataValid}
                    />
                  )}
                </metadataForm.Field>
              </section>
              <section className="mt-6 space-y-2" data-testid="routing-overrides-section">
                <h3 className="text-sm font-medium">{m['dashboard.routing.editor.provider_overrides']()}</h3>
                <metadataForm.Field name="overrides">
                  {(field) => (
                    <div className="space-y-3">
                      {model.providers.map((provider) => (
                        <RoutingProviderOverrideFields
                          key={provider.id}
                          providerId={provider.id}
                          value={
                            field.state.value[provider.id] ?? {
                              cost: { touched: false, value: undefined },
                              limit: { touched: false, value: undefined },
                            }
                          }
                          onChange={(next) => field.handleChange({ ...field.state.value, [provider.id]: next })}
                        />
                      ))}
                    </div>
                  )}
                </metadataForm.Field>
              </section>
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
                  <metadataForm.Subscribe selector={(state) => routingOverrideDraftsValid(state.values.overrides)}>
                    {(overridesValid) => (
                      <Button
                        type="submit"
                        data-testid="routing-save"
                        disabled={
                          !writable ||
                          !canSubmit ||
                          isSubmitting ||
                          mutation.isPending ||
                          !metadataValid ||
                          !overridesValid
                        }
                      >
                        {m['dashboard.routing.editor.save']()}
                      </Button>
                    )}
                  </metadataForm.Subscribe>
                )}
              </form.Subscribe>
            </DrawerFooter>
          </form>
        )}
      </DrawerContent>
    </Drawer>
  );
};
