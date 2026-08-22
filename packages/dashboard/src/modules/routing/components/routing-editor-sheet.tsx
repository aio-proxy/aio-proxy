import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@aio-proxy/ui/components/sheet';
import { useState } from 'react';

import { useRoutingForm } from '../hooks/use-routing-form';
import { useRoutingMutation } from '../hooks/use-routing-mutation';
import {
  buildRoutingTiers,
  effectiveRoutingCandidates,
  explicitRoutingOverrides,
  formatRoutingShare,
} from '../lib/routing-summary';
import { isStaleRoutingError } from '../services/routing-service';
import { RoutingProviderFields } from './routing-provider-fields';

interface RoutingEditorSheetProps {
  readonly model: DashboardRoutingModel | null;
  readonly writable: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReload: () => void;
}

export const RoutingEditorSheet: React.FC<RoutingEditorSheetProps> = ({ model, writable, onOpenChange, onReload }) => {
  const mutation = useRoutingMutation();
  const [stale, setStale] = useState(false);
  const form = useRoutingForm(model, (value) => {
    if (model === null) return;
    mutation.mutate(
      {
        modelId: model.modelId,
        revision: model.revision,
        baselineProviderIds: model.baselineProviderIds,
        providers: explicitRoutingOverrides(value.providers),
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
    setStale(false);
    mutation.reset();
    onOpenChange(false);
  };

  return (
    <Sheet
      open={model !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent className="w-full data-[side=right]:sm:max-w-3xl" data-testid="routing-editor-sheet">
        <SheetHeader>
          <SheetTitle>{m['dashboard.routing.editor.title']({ modelId: model?.modelId ?? '' })}</SheetTitle>
          <SheetDescription>{m['dashboard.routing.editor.description']()}</SheetDescription>
        </SheetHeader>
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
              <p role="status" className="mx-6 rounded-lg border bg-muted p-3 text-sm">
                {m['dashboard.routing.read_only']()}
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-auto px-6">
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
                <div>
                  {model.providers.map((provider) => (
                    <RoutingProviderFields key={provider.id} form={form} provider={provider} writable={writable} />
                  ))}
                </div>
                <aside className="lg:sticky lg:top-0">
                  <h2 className="font-heading text-base font-medium">{m['dashboard.routing.editor.preview']()}</h2>
                  <form.Subscribe selector={(state) => state.values.providers}>
                    {(providers) => {
                      const tiers = buildRoutingTiers(effectiveRoutingCandidates(model.providers, providers));
                      if (tiers.length === 0) {
                        return (
                          <p className="mt-3 text-sm text-muted-foreground" data-testid="routing-preview">
                            {m['dashboard.routing.editor.preview_empty']()}
                          </p>
                        );
                      }
                      return (
                        <ol className="mt-3 space-y-3" data-testid="routing-preview">
                          {tiers.map((tier) => (
                            <li key={tier.priority} className="rounded-lg border p-3">
                              <div className="font-mono text-sm">P{tier.priority}</div>
                              <ul className="mt-2 space-y-1 text-sm">
                                {tier.providers.map((entry) => (
                                  <li key={entry.providerId}>
                                    <span className="font-mono">{entry.providerId}</span>{' '}
                                    {formatRoutingShare(entry.share)}
                                  </li>
                                ))}
                              </ul>
                            </li>
                          ))}
                        </ol>
                      );
                    }}
                  </form.Subscribe>
                </aside>
              </div>
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
            <SheetFooter className="flex-row justify-end border-t">
              <Button type="button" variant="outline" onClick={close}>
                {m['dashboard.routing.editor.cancel']()}
              </Button>
              {stale ? (
                <Button type="button" variant="outline" onClick={onReload}>
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
            </SheetFooter>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
};
