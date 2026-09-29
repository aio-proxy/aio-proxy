import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useRef } from 'react';

import { PageContainer } from '@/components/page-container';

import { PluginInstallDialog, type PluginInstallDialogRef } from '../../components/plugin-install-dialog';
import { PluginsGrid } from '../../components/plugins-grid';
import { usePluginsQuery } from '../../hooks/use-plugins-query';

export const PluginsPage: React.FC = () => {
  const installDialogRef = useRef<PluginInstallDialogRef>(null);
  const pluginsQuery = usePluginsQuery();
  const content = (() => {
    if (pluginsQuery.isLoading) {
      return (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={m['dashboard.plugins.title']()}>
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-32 w-full" />
          ))}
        </div>
      );
    }
    if (pluginsQuery.isError)
      return (
        <p role="alert" className="text-sm text-destructive">
          {m['dashboard.plugins.load_failed']()}
        </p>
      );
    return <PluginsGrid plugins={pluginsQuery.data?.plugins ?? []} />;
  })();

  return (
    <PageContainer
      title={m['dashboard.plugins.title']()}
      breadcrumbs={[{ label: m['dashboard.menus.configuration']() }, { label: m['dashboard.plugins.title']() }]}
      extra={
        <Button type="button" onClick={() => installDialogRef.current?.open()}>
          {m['dashboard.plugins.add']()}
        </Button>
      }
    >
      {content}
      <PluginInstallDialog ref={installDialogRef} />
    </PageContainer>
  );
};
