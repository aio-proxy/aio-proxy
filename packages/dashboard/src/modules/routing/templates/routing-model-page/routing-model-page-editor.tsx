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
import { Button } from '@aio-proxy/ui/components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import type React from 'react';

import { RoutingModelCostTab } from '../../components/routing-model-cost-tab';
import { RoutingModelMetadataTab } from '../../components/routing-model-metadata-tab';
import { RoutingModelTopologyTab } from '../../components/routing-model-topology-tab';
import { RoutingModelTrafficTab } from '../../components/routing-model-traffic-tab';
import { useRoutingModelEditor } from '../../hooks/use-routing-model-editor';
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

  return (
    <>
      <Tabs defaultValue="topology" className="min-w-0 gap-4">
        <TabsList>
          <TabsTrigger value="topology">
            {m['dashboard.routing.detail.tab_topology']()}
            {editor.dirtyTabs.includes('topology') ? (
              <span className="text-destructive"> {m['dashboard.routing.detail.dirty_marker']()}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="metadata">
            {m['dashboard.routing.detail.tab_metadata']()}
            {editor.dirtyTabs.includes('metadata') ? (
              <span className="text-destructive"> {m['dashboard.routing.detail.dirty_marker']()}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="cost">
            {m['dashboard.routing.detail.tab_cost']()}
            {editor.dirtyTabs.includes('cost') ? (
              <span className="text-destructive"> {m['dashboard.routing.detail.dirty_marker']()}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="traffic">{m['dashboard.routing.detail.tab_traffic']()}</TabsTrigger>
        </TabsList>
        <TabsContent value="topology">
          <RoutingModelTopologyTab form={editor.form} model={model} writable={writable} actual={actual} />
        </TabsContent>
        <TabsContent value="metadata">
          <RoutingModelMetadataTab
            metadataForm={editor.metadataForm}
            modelId={model.modelId}
            catalog={model.catalog}
            setMetadataValid={editor.setMetadataValid}
          />
        </TabsContent>
        <TabsContent value="cost">
          <RoutingModelCostTab metadataForm={editor.metadataForm} providers={model.providers} writable={writable} />
        </TabsContent>
        <TabsContent value="traffic">
          <RoutingModelTrafficTab modelId={model.modelId} range={range} />
        </TabsContent>
      </Tabs>
      <div className="mt-6 flex flex-wrap justify-end gap-2 border-t pt-4">
        {writable ? null : (
          <p role="status" className="mr-auto w-full text-sm text-muted-foreground">
            {m['dashboard.routing.read_only']()}
          </p>
        )}
        {editor.stale ? (
          <p role="alert" className="mr-auto w-full text-sm text-destructive">
            {m['dashboard.routing.editor.stale']()}
          </p>
        ) : editor.saveFailed ? (
          <p role="alert" className="mr-auto w-full text-sm text-destructive">
            {m['dashboard.routing.editor.save_failed']()}
          </p>
        ) : null}
        <Button type="button" variant="outline" onClick={() => editor.discard()}>
          {m['dashboard.routing.editor.cancel']()}
        </Button>
        {editor.stale ? (
          <Button type="button" variant="outline" onClick={() => editor.reload()}>
            {m['dashboard.routing.editor.reload']()}
          </Button>
        ) : null}
        <Button type="button" disabled={!editor.canSave} onClick={() => editor.save()}>
          {m['dashboard.routing.editor.save']()}
        </Button>
      </div>
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
