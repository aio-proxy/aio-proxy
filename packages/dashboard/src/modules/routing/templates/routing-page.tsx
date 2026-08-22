import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { RoutingEditorSheet } from '../components/routing-editor-sheet';
import { RoutingTable } from '../components/routing-table';
import { useRoutingQuery } from '../hooks/use-routing-query';

export const RoutingPage: React.FC = () => {
  const query = useRoutingQuery();
  const [selected, setSelected] = useState<DashboardRoutingModel | null>(null);
  const models = query.data?.models ?? [];
  const writable = query.data?.writable ?? false;

  const content = (() => {
    if (query.isLoading) {
      return (
        <div className="space-y-2" aria-label={m['dashboard.routing.title']()}>
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      );
    }
    if (query.isError) {
      return (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {m['dashboard.routing.load_failed']()}
          </p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            {m['dashboard.routing.retry']()}
          </Button>
        </div>
      );
    }
    if (models.length === 0) {
      return (
        <Empty>
          <p>{m['dashboard.routing.empty']()}</p>
          <Button render={<Link to="/providers" />}>{m['dashboard.routing.empty_action']()}</Button>
        </Empty>
      );
    }
    return <RoutingTable models={models} onEdit={setSelected} />;
  })();

  return (
    <PageContainer
      title={m['dashboard.routing.title']()}
      subtitle={m['dashboard.routing.subtitle']()}
      breadcrumbs={[{ label: m['dashboard.menus.configuration']() }, { label: m['dashboard.routing.title']() }]}
    >
      {query.data?.writable === false ? (
        <p role="status" className="mb-3 rounded-lg border bg-muted p-3 text-sm">
          {m['dashboard.routing.read_only']()}
        </p>
      ) : null}
      <Card>
        <CardContent>{content}</CardContent>
      </Card>
      <RoutingEditorSheet
        key={selected?.modelId ?? 'closed'}
        model={selected}
        writable={writable}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onReload={() => {
          void query.refetch().then((result) => {
            const nextModels = result.data?.models ?? [];
            setSelected((current) => {
              if (current === null) return null;
              return nextModels.find((model) => model.modelId === current.modelId) ?? current;
            });
          });
        }}
      />
    </PageContainer>
  );
};
