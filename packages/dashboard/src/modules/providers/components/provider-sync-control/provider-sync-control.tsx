import { m } from '@aio-proxy/i18n';
import type { ProviderSyncView } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Switch } from '@aio-proxy/ui/components/switch';
import { useState } from 'react';

export interface ProviderSyncControlProps {
  readonly state: ProviderSyncView;
  onEnable(): Promise<void>;
  onExclude(): Promise<void>;
  onDetach(): Promise<void>;
}

type ProviderSyncAction = 'enable' | 'exclude' | 'detach';

const actionErrorCopy = (error: unknown, action: ProviderSyncAction): string => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'login-required') return m['dashboard.sync.login_required']();
  if (code === 'preview-stale') return m['dashboard.sync.preview_retry_failed']();
  if (code === 'detach-pending') return m['dashboard.sync.detach_failed']();
  if (action === 'enable') return m['dashboard.sync.enable_failed']();
  if (action === 'exclude') return m['dashboard.sync.exclude_failed']();
  return m['dashboard.sync.detach_failed']();
};

const credentialCopy = (state: ProviderSyncView): string | undefined => {
  if (state.credentialState === 'detach-pending') return m['dashboard.sync.uncertain_login']();
  if (state.credentialState === 'refresh-deferred') return m['dashboard.sync.offline']();
  if (state.credentialState === 'result-uncertain' || state.credentialState === 'login-required') {
    return m['dashboard.sync.uncertain_login']();
  }
  if (state.credentialState === 'unverified') return m['dashboard.sync.credential_pending']();
  if (state.credentialState === 'independent') return m['dashboard.sync.independent_unconfirmed']();
  return undefined;
};

export const ProviderSyncControl: React.FC<ProviderSyncControlProps> = ({ state, onEnable, onExclude, onDetach }) => {
  const [isPending, setIsPending] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const run = async (action: ProviderSyncAction, operation: () => Promise<void>) => {
    setIsPending(true);
    setActionError(undefined);
    try {
      await operation();
      setIsPending(false);
    } catch (error) {
      setActionError(actionErrorCopy(error, action));
      setIsPending(false);
    }
  };
  const copy = credentialCopy(state);

  return (
    <Card size="sm" data-testid="provider-sync-control">
      <CardHeader>
        <CardTitle>{m['dashboard.sync.provider_switch']()}</CardTitle>
        <CardDescription>{m['dashboard.sync.provider_switch_description']()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            {state.included ? m['dashboard.sync.keep_cloud']() : m['dashboard.sync.new_local']()}
          </span>
          <Switch
            checked={state.included}
            disabled={isPending}
            aria-label={m['dashboard.sync.provider_switch']()}
            onCheckedChange={(checked) => void run(checked ? 'enable' : 'exclude', checked ? onEnable : onExclude)}
          />
        </div>
        {copy === undefined ? null : <p className="text-xs text-muted-foreground">{copy}</p>}
        {!state.included && (state.credentialState === 'shared' || state.credentialState === 'detach-pending') ? (
          <p className="text-xs text-muted-foreground">{m['dashboard.sync.cloud_copies_remain']()}</p>
        ) : null}
        {state.credentialState === 'shared' || state.credentialState === 'detach-pending' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => void run('detach', onDetach)}
          >
            {m['dashboard.sync.disconnect']()}
          </Button>
        ) : null}
        {actionError !== undefined ? (
          <p role="alert" className="text-xs text-destructive">
            {actionError}
          </p>
        ) : null}
        {state.credentialState === 'detach-pending' ? (
          <p role="status" className="text-xs text-muted-foreground">
            {m['dashboard.sync.pending']()}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
};
