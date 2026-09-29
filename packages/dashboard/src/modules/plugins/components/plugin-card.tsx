import { m } from '@aio-proxy/i18n';
import type { DashboardPluginSummary } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardFooter } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { PluginIcon } from '@/components/plugin-icon';
import { resolveDashboardText } from '@/lib/localized-text';

interface PluginCardProps {
  readonly plugin: DashboardPluginSummary;
  readonly onOptions: (plugin: DashboardPluginSummary) => void;
  readonly onUninstall: (plugin: DashboardPluginSummary) => void;
}

const statusOf = (plugin: DashboardPluginSummary) =>
  plugin.state.status === 'failed' ? 'failed' : plugin.enabled ? 'ready' : 'disabled';

const STATUS_DOT = { failed: 'bg-destructive', ready: 'bg-primary', disabled: 'bg-muted-foreground/50' } as const;

export const PluginCard: React.FC<PluginCardProps> = ({ plugin, onOptions, onUninstall }) => {
  const status = statusOf(plugin);
  const displayName = plugin.displayName === undefined ? undefined : resolveDashboardText(plugin.displayName);
  const label = {
    failed: m['dashboard.plugins.status_failed'](),
    ready: m['dashboard.plugins.status_ready'](),
    disabled: m['dashboard.plugins.disabled'](),
  }[status];

  return (
    <Card
      data-testid={`plugin-card-${plugin.packageName}`}
      className={cn('h-full justify-between', status === 'failed' && 'ring-destructive/30')}
    >
      <CardContent className="flex min-w-0 flex-col gap-3">
        <div className={cn('flex min-w-0 items-start gap-3', status === 'disabled' && 'opacity-60')}>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted font-heading font-semibold">
            {plugin.icon === undefined ? (
              (displayName ?? plugin.packageName).replace(/^@/u, '').charAt(0).toUpperCase()
            ) : (
              <PluginIcon icon={plugin.icon} size={22} />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-heading font-medium">{displayName ?? plugin.packageName}</h3>
              {plugin.version === undefined ? null : (
                <span className="font-mono text-xs text-muted-foreground">v{plugin.version}</span>
              )}
              {plugin.builtin ? <Badge variant="outline">{m['dashboard.plugins.builtin']()}</Badge> : null}
            </div>
            {displayName === undefined ? null : (
              <p className="truncate font-mono text-xs text-muted-foreground">{plugin.packageName}</p>
            )}
          </div>
        </div>
        {plugin.state.status === 'failed' ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            {plugin.state.diagnostic.summary}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="items-center gap-2">
        <span className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_DOT[status])} />
          {label}
        </span>
        <div className="ml-auto flex gap-1">
          {plugin.hasOptions ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onOptions(plugin)}>
              {m['dashboard.plugins.options_action']()}
            </Button>
          ) : null}
          {plugin.builtin ? null : (
            <Button type="button" size="sm" variant="ghost" onClick={() => onUninstall(plugin)}>
              {m['dashboard.plugins.uninstall_action']()}
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
};
