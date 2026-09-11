import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { useSidebar } from '@aio-proxy/ui/components/sidebar';
import { ArrowUpCircle } from 'lucide-react';

import { useApplyRelease } from '@/modules/settings/hooks/use-apply-release';
import { useReleaseQuery } from '@/modules/settings/hooks/use-release-query';

export const SidebarUpdateCard: React.FC = () => {
  const { isMobile, setOpen, setOpenMobile, state } = useSidebar();
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
          onClick={() => {
            setOpen(true);
            if (isMobile) setOpenMobile(true);
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
      {/* Failure, restart, and unavailable are reported by toast — a card this narrow turns a
          full sentence into five ragged lines. */}
      <Button className="mt-2 w-full" disabled={inProgress || restartRequired} onClick={apply}>
        {inProgress ? m['dashboard.settings.version_updating']() : m['dashboard.settings.version_update']()}
      </Button>
    </div>
  );
};
