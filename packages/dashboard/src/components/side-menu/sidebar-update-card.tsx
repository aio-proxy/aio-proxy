import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { useSidebar } from '@aio-proxy/ui/components/sidebar';
import { ArrowUpCircle } from 'lucide-react';

import { useApplyRelease } from '@/lib/release/use-apply-release';
import { useReleaseQuery } from '@/lib/release/use-release-query';

export const SidebarUpdateCard: React.FC = () => {
  const { state } = useSidebar();
  const release = useReleaseQuery();
  const outdated = release.data?.outdated === true;
  const status = release.data?.update.status ?? 'idle';
  const latest = release.data?.latest;
  const { apply, failed, inProgress, restartRequired, unavailable } = useApplyRelease({ outdated });
  const visible = outdated || inProgress || restartRequired || failed || unavailable || status === 'failed';

  if (!visible) return null;

  if (state === 'collapsed') {
    return (
      <div className="flex justify-center">
        <Button
          aria-label={m['dashboard.update.available']()}
          className="relative size-8"
          disabled={inProgress || restartRequired}
          onClick={() => {
            if (!restartRequired) apply();
          }}
          size="icon"
          variant="ghost"
        >
          <ArrowUpCircle />
          <span aria-hidden className="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary" />
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background p-3 text-sm">
      <p className="font-medium">{m['dashboard.update.available']()}</p>
      {latest === undefined ? null : <p className="mt-1 text-muted-foreground">{latest}</p>}
      {restartRequired ? (
        <p className="mt-2 text-muted-foreground">{m['dashboard.settings.version_restart_required']()}</p>
      ) : (
        <Button className="mt-2 w-full" disabled={inProgress} onClick={() => apply()}>
          {inProgress ? m['dashboard.settings.version_updating']() : m['dashboard.settings.version_update']()}
        </Button>
      )}
      {unavailable ? (
        <p className="mt-2 text-muted-foreground">{m['dashboard.settings.version_update_unavailable']()}</p>
      ) : failed ? (
        <p className="mt-2 text-destructive" role="alert">
          {m['dashboard.settings.version_update_failed']()}
        </p>
      ) : null}
    </div>
  );
};
