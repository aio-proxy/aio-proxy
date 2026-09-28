import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import type { UsageOverviewRange } from '@aio-proxy/types';
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
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import type React from 'react';
import { useState } from 'react';

import { RoutingModelDrawer, type RoutingModelDrawerSection } from '../../components/routing-model-drawer';
import { RoutingModelInfoCard } from '../../components/routing-model-info-card';
import { RoutingModelPriceCard } from '../../components/routing-model-price-card';
import { RoutingModelSaveBar } from '../../components/routing-model-save-bar';
import { RoutingModelTopologyTab } from '../../components/routing-model-topology-tab';
import { RoutingModelTrafficTab } from '../../components/routing-model-traffic-tab';
import { useRoutingModelEditor } from '../../hooks/use-routing-model-editor';
import type { MetadataRecord } from '../../lib/model-metadata-fields';
import type { RoutingTierShare } from '../../lib/routing-traffic';

interface RoutingModelPageEditorProps {
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly range: UsageOverviewRange;
  readonly actual: readonly RoutingTierShare[] | undefined;
  readonly onReload: () => void | Promise<DashboardRoutingModel | null | undefined>;
}

export const RoutingModelPageEditor: React.FC<RoutingModelPageEditorProps> = ({
  model,
  writable,
  range,
  actual,
  onReload,
}) => {
  const editor = useRoutingModelEditor({ model, writable, onReload });
  const [drawer, setDrawer] = useState<RoutingModelDrawerSection | null>(null);
  // The save body and the defaults the forms snap back to are both captured when Save is pressed,
  // so an edit made while the request is in flight would be neither sent nor kept. The controls stop
  // accepting input until it settles. The read-only notice stays keyed on the real `writable`,
  // because an in-flight save is not the same thing as a config the dashboard cannot write.
  const editable = writable && !editor.saving;

  return (
    <>
      {writable ? null : (
        <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
          {m['dashboard.routing.read_only']()}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{m['dashboard.routing.detail.section_route']()}</CardTitle>
            </CardHeader>
            <CardContent>
              <RoutingModelTopologyTab form={editor.form} model={model} writable={editable} actual={actual} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{m['dashboard.routing.detail.tab_traffic']()}</CardTitle>
            </CardHeader>
            <CardContent>
              <RoutingModelTrafficTab modelId={model.modelId} range={range} />
            </CardContent>
          </Card>
        </div>
        <editor.metadataForm.Subscribe selector={(state) => state.values}>
          {(values) => (
            <aside className="flex min-w-0 flex-col gap-4">
              <RoutingModelInfoCard
                modelId={model.modelId}
                metadata={values.metadata.value as MetadataRecord | undefined}
                writable={editable}
                onEdit={() => setDrawer('info')}
              />
              <RoutingModelPriceCard
                modelId={model.modelId}
                metadata={values.metadata.value as MetadataRecord | undefined}
                overrides={values.overrides}
                providers={model.providers}
                writable={editable}
                onEdit={setDrawer}
              />
            </aside>
          )}
        </editor.metadataForm.Subscribe>
      </div>
      <RoutingModelDrawer
        open={drawer !== null}
        section={drawer ?? 'info'}
        onOpenChange={(open) => {
          if (!open) setDrawer(null);
        }}
        metadataForm={editor.metadataForm}
        model={model}
        writable={editable}
        setMetadataValid={editor.setMetadataValid}
      />
      <RoutingModelSaveBar
        dirty={editor.dirtyTabs}
        stale={editor.stale}
        saveFailed={editor.saveFailed}
        saving={editor.saving}
        canSave={editor.canSave}
        onDiscard={() => editor.discard()}
        onReload={() => editor.reload()}
        onSave={() => editor.save()}
      />
      {editor.blocker.status === 'blocked' ? (
        <AlertDialog open onOpenChange={(open) => !open && editor.blocker.reset?.()}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m['dashboard.routing.detail.unsaved_title']()}</AlertDialogTitle>
              <AlertDialogDescription>{m['dashboard.routing.detail.unsaved_body']()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => editor.blocker.reset?.()}>
                {m['dashboard.routing.detail.unsaved_stay']()}
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => editor.blocker.proceed?.()}>
                {m['dashboard.routing.detail.unsaved_leave']()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
};
