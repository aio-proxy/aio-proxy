import { m } from '@aio-proxy/i18n';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';

import { PageContainer } from '@/components/page-container';

import { SettingsForm } from '../../components/settings-form';
import { SettingsPreferencesGroup } from '../../components/settings-preferences-group';
import { useSettingsQuery } from '../../hooks/use-settings-query';

export const SettingsPage: React.FC = () => {
  const settingsQuery = useSettingsQuery();
  const content = (() => {
    if (settingsQuery.isLoading) {
      return (
        <div className="space-y-6" aria-label={m['dashboard.settings.title']()}>
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      );
    }
    if (settingsQuery.isError || settingsQuery.data === undefined) {
      return (
        <p role="alert" className="text-sm text-destructive">
          {m['dashboard.settings.load_failed']()}
        </p>
      );
    }
    return <SettingsForm settings={settingsQuery.data} />;
  })();

  return (
    <PageContainer
      title={m['dashboard.settings.title']()}
      subtitle={m['dashboard.settings.description']()}
      breadcrumbs={[{ label: m['dashboard.menus.configuration']() }, { label: m['dashboard.settings.title']() }]}
    >
      <div className="mx-auto w-full max-w-3xl space-y-6">
        {content}
        <SettingsPreferencesGroup />
      </div>
    </PageContainer>
  );
};
