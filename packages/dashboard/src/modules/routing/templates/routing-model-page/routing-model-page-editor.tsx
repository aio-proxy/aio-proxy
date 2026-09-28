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
import { Card, CardContent, CardFooter } from '@aio-proxy/ui/components/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import type React from 'react';
import { useState } from 'react';

import { RoutingModelCostTab } from '../../components/routing-model-cost-tab';
import { RoutingModelMetadataTab } from '../../components/routing-model-metadata-tab';
import { RoutingModelTopologyTab, type RoutingTrafficState } from '../../components/routing-model-topology-tab';
import { RoutingModelTrafficTab } from '../../components/routing-model-traffic-tab';
import { useRoutingModelEditor } from '../../hooks/use-routing-model-editor';
import type { RoutingTierShare } from '../../lib/routing-traffic';

interface RoutingModelPageEditorProps {
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly range: UsageOverviewRange;
  readonly actual: readonly RoutingTierShare[] | undefined;
  readonly trafficState: RoutingTrafficState;
  readonly onReload: () => void | Promise<DashboardRoutingModel | null | undefined>;
}

export const RoutingModelPageEditor: React.FC<RoutingModelPageEditorProps> = ({
  model,
  writable,
  range,
  actual,
  trafficState,
  onReload,
}) => {
  const editor = useRoutingModelEditor({ model, writable, onReload });
  const [activeTab, setActiveTab] = useState<'topology' | 'metadata' | 'cost' | 'traffic'>('topology');
  // The save body and the defaults the forms snap back to are both captured when Save is pressed,
  // so an edit made while the request is in flight would be neither sent nor kept. The controls stop
  // accepting input until it settles. The read-only notice below stays keyed on the real `writable`,
  // because an in-flight save is not the same thing as a config the dashboard cannot write.
  const editable = writable && !editor.saving;

  return (
    <>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as typeof activeTab)}
        className="min-w-0 gap-4"
      >
        <TabsList>
          <TabsTrigger value="topology">
            {m['dashboard.routing.detail.tab_topology']()}
            {editor.dirtyTabs.includes('topology') ? (
              <span
                role="img"
                aria-label={m['dashboard.routing.detail.dirty_marker']()}
                className="inline-block size-2 shrink-0 rounded-full bg-destructive"
              />
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="metadata">
            {m['dashboard.routing.detail.tab_metadata']()}
            {editor.dirtyTabs.includes('metadata') ? (
              <span
                role="img"
                aria-label={m['dashboard.routing.detail.dirty_marker']()}
                className="inline-block size-2 shrink-0 rounded-full bg-destructive"
              />
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="cost">
            {m['dashboard.routing.detail.tab_cost']()}
            {editor.dirtyTabs.includes('cost') ? (
              <span
                role="img"
                aria-label={m['dashboard.routing.detail.dirty_marker']()}
                className="inline-block size-2 shrink-0 rounded-full bg-destructive"
              />
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="traffic">{m['dashboard.routing.detail.tab_traffic']()}</TabsTrigger>
        </TabsList>
        <Card>
          <CardContent>
            <TabsContent value="topology">
              <RoutingModelTopologyTab
                form={editor.form}
                model={model}
                writable={editable}
                actual={actual}
                trafficState={trafficState}
              />
            </TabsContent>
            <TabsContent value="metadata">
              <RoutingModelMetadataTab
                metadataForm={editor.metadataForm}
                modelId={model.modelId}
                catalog={model.catalog}
                writable={editable}
                setMetadataValid={editor.setMetadataValid}
              />
            </TabsContent>
            <TabsContent value="cost">
              <RoutingModelCostTab metadataForm={editor.metadataForm} providers={model.providers} writable={editable} />
            </TabsContent>
            <TabsContent value="traffic">
              <RoutingModelTrafficTab
                modelId={model.modelId}
                range={range}
                onViewTopology={() => setActiveTab('topology')}
              />
            </TabsContent>
          </CardContent>
          {activeTab === 'traffic' ? null : (
            <CardFooter className="flex-wrap justify-end gap-2">
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
              {/* Cancel cannot call off a request already in flight, so it stays out of reach until the
            save settles rather than reporting the write as abandoned while it commits. */}
              <Button type="button" variant="outline" disabled={editor.saving} onClick={() => editor.discard()}>
                {m['dashboard.routing.editor.cancel']()}
              </Button>
              {editor.stale ? (
                <Button type="button" variant="outline" disabled={editor.saving} onClick={() => editor.reload()}>
                  {m['dashboard.routing.editor.reload']()}
                </Button>
              ) : null}
              <Button type="button" disabled={!editor.canSave} onClick={() => editor.save()}>
                {m['dashboard.routing.editor.save']()}
              </Button>
            </CardFooter>
          )}
        </Card>
      </Tabs>
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
