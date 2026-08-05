import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useRef } from 'react';

import { PageContainer } from '@/components/page-container';

import { PluginInstallDrawer, type PluginInstallDrawerRef } from '../../components/plugin-install-drawer';
import { PluginsTable } from '../../components/plugins-table';
import { usePluginsQuery } from '../../hooks/use-plugins-query';

export const PluginsPage: React.FC = () => {
  const installDrawerRef = useRef<PluginInstallDrawerRef>(null);
  const pluginsQuery = usePluginsQuery();

  return (
    <PageContainer
      title={m['dashboard.plugins.title']()}
      breadcrumbs={[{ label: m['dashboard.menus.configuration']() }, { label: m['dashboard.plugins.title']() }]}
      extra={
        <Button type="button" onClick={() => installDrawerRef.current?.open()}>
          {m['dashboard.plugins.add']()}
        </Button>
      }
    >
      <Card>
        <CardContent>
          {pluginsQuery.isLoading ? (
            <div className="space-y-2" aria-label={m['dashboard.plugins.title']()}>
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : pluginsQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {m['dashboard.plugins.load_failed']()}
            </p>
          ) : (
            <PluginsTable plugins={pluginsQuery.data?.plugins ?? []} />
          )}
        </CardContent>
      </Card>
      <PluginInstallDrawer ref={installDrawerRef} />
    </PageContainer>
  );
};
