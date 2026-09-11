import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField, ProviderSyncView, SyncPreview, SyncPreviewInput } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Switch } from '@aio-proxy/ui/components/switch';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import { useForm } from '@tanstack/react-form';
import type { AnyFieldApi } from '@tanstack/react-form';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { resolveDashboardText } from '@/lib/localized-text';
import { SyncPreviewDialog } from '@/modules/settings/components/sync-preview-dialog';

import { usePreviewSync, useSyncBackends, useSyncStatus, useDisconnectSync, useRetrySync } from '../../hooks/use-sync';
import { SyncHistoryDialog } from '../sync-history-dialog';

const initialOptions = (fields: readonly DashboardOAuthFormField[]): Record<string, unknown> =>
  Object.fromEntries(
    fields.flatMap((field) =>
      'defaultValue' in field && field.defaultValue !== undefined ? [[field.key, field.defaultValue]] : [],
    ),
  );
const syncOptionsSchema = z.record(z.string(), z.json());
const EMPTY_PROVIDERS: readonly ProviderSyncView[] = [];

export const providerPurgePreviewInput = (providerId: string): Extract<SyncPreviewInput, { kind: 'purge' }> => ({
  kind: 'purge',
  scope: 'provider',
  objectId: providerId,
});

const statusCopy = (state: string): string => {
  const key = `dashboard.sync.status_${state}` as keyof typeof m;
  const message = m[key];
  return typeof message === 'function' ? (message as () => string)() : state;
};

interface SyncReactFormApi {
  readonly Field: React.FC<{ name: string; children(field: AnyFieldApi): ReactNode }>;
}

const renderSyncBackendField = (field: DashboardOAuthFormField, form: SyncReactFormApi) => {
  const id = `sync-option-${field.key}`;
  const label = resolveDashboardText(field.label);
  const description = field.description === undefined ? undefined : resolveDashboardText(field.description);
  return (
    <form.Field name="options">
      {(optionsField) => {
        const values = (optionsField.state.value ?? {}) as Record<string, unknown>;
        const value = values[field.key];
        const setValue = (next: unknown) =>
          optionsField.handleChange({ ...values, ...(next === undefined ? {} : { [field.key]: next }) });
        if (field.type === 'secret') {
          return (
            <Field>
              <FieldLabel>{label}</FieldLabel>
              <FieldDescription>{m['dashboard.sync.required_plugin_data']()}</FieldDescription>
            </Field>
          );
        }
        if (field.type === 'boolean') {
          return (
            <Field orientation="horizontal">
              <div className="flex-1">
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
              </div>
              <Switch id={id} checked={Boolean(value ?? field.defaultValue)} onCheckedChange={setValue} />
            </Field>
          );
        }
        if (field.type === 'select') {
          return (
            <Field>
              <FieldLabel htmlFor={id}>{label}</FieldLabel>
              <Select
                value={value === undefined ? '' : String(value)}
                onValueChange={(next) => setValue(next ?? undefined)}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={String(option.value)} value={String(option.value)}>
                      {resolveDashboardText(option.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
            </Field>
          );
        }
        if (field.type === 'json') {
          return (
            <Field>
              <FieldLabel htmlFor={id}>{label}</FieldLabel>
              <Textarea
                id={id}
                value={value === undefined ? '' : JSON.stringify(value)}
                onChange={(event) => {
                  try {
                    setValue(event.target.value === '' ? undefined : JSON.parse(event.target.value));
                  } catch {
                    setValue(event.target.value);
                  }
                }}
              />
              {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
            </Field>
          );
        }
        return (
          <Field>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <Input
              id={id}
              type={field.type === 'number' ? 'number' : 'text'}
              value={typeof value === 'string' || typeof value === 'number' ? value : ''}
              placeholder={field.placeholder === undefined ? undefined : resolveDashboardText(field.placeholder)}
              onChange={(event) =>
                setValue(
                  field.type === 'number'
                    ? event.target.value === ''
                      ? undefined
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
            />
            {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
          </Field>
        );
      }}
    </form.Field>
  );
};

export const SyncSettingsGroup: React.FC = () => {
  const status = useSyncStatus();
  const backends = useSyncBackends();
  const previewMutation = usePreviewSync();
  const disconnectMutation = useDisconnectSync();
  const retryMutation = useRetrySync();
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [lastPreviewInput, setLastPreviewInput] = useState<SyncPreviewInput>();
  const [historyObjectId, setHistoryObjectId] = useState<string | null>(null);
  const backend = backends.data?.backends[0];
  const form = useForm({ defaultValues: { options: initialOptions(backend?.form ?? []), providerId: '' } });
  const providers = status.data?.providers ?? EMPTY_PROVIDERS;

  useEffect(() => {
    if (backend !== undefined) form.setFieldValue('options', initialOptions(backend.form));
  }, [backend, form]);

  useEffect(() => {
    const selected = form.getFieldValue('providerId');
    if (providers.some((provider) => provider.providerId === selected)) return;
    form.setFieldValue('providerId', providers[0]?.providerId ?? '');
  }, [form, providers]);

  const connect = () => {
    if (backend === undefined) return;
    const options = syncOptionsSchema.safeParse(form.getFieldValue('options'));
    if (!options.success) return;
    const input: SyncPreviewInput = {
      kind: 'connect',
      plugin: backend.plugin,
      capability: backend.capability,
      options: options.data,
    };
    setLastPreviewInput(input);
    previewMutation.mutate(input, { onSuccess: setPreview });
  };

  const previewProviderPurge = () => {
    if (selectedProviderId === '') return;
    const input = providerPurgePreviewInput(selectedProviderId);
    setLastPreviewInput(input);
    previewMutation.mutate(input, { onSuccess: setPreview });
  };

  const statusLabel = status.data === undefined ? undefined : statusCopy(status.data.state);
  const selectedProviderId = form.state.values.providerId;
  const selectedProvider = providers.find((provider) => provider.providerId === selectedProviderId);
  const providerObjectId = selectedProvider?.objectId ?? null;
  const previewError = previewMutation.isError
    ? lastPreviewInput?.kind === 'connect'
      ? m['dashboard.sync.connect_failed']()
      : m['dashboard.sync.preview_failed']()
    : undefined;

  return (
    <>
      <Card data-testid="settings-sync-group">
        <CardHeader>
          <CardTitle>{m['dashboard.sync.title']()}</CardTitle>
          <CardDescription>{m['dashboard.sync.description']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.isLoading || backends.isLoading ? (
            <Skeleton className="h-20 w-full" aria-label={m['dashboard.sync.loading']()} />
          ) : null}
          {status.isError || backends.isError ? <p role="alert">{m['dashboard.sync.load_failed']()}</p> : null}
          {statusLabel !== undefined ? (
            <p role="status">{m['dashboard.sync.status']({ status: statusLabel })}</p>
          ) : null}
          {backends.data?.backends.length === 0 ? (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm">{m['dashboard.sync.backend_missing']()}</p>
              <code className="block text-xs text-muted-foreground">@aio-proxy/plugin-cloudkit</code>
              <Button render={<a href="/plugins" />} variant="outline" size="sm">
                {m['dashboard.sync.install_plugin']()}
              </Button>
            </div>
          ) : null}
          {backend !== undefined ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                connect();
              }}
            >
              <p className="text-sm font-medium">
                {m['dashboard.sync.backend_label']()}: {resolveDashboardText(backend.displayName)}
              </p>
              {providers.length === 0 ? null : (
                <form.Field name="providerId">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor="sync-provider-select">{m['dashboard.sync.provider_select']()}</FieldLabel>
                      <Select value={field.state.value} onValueChange={(value) => field.handleChange(value ?? '')}>
                        <SelectTrigger id="sync-provider-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {providers.map((provider) => (
                            <SelectItem key={provider.providerId} value={provider.providerId}>
                              {provider.providerId}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </form.Field>
              )}
              {backend.form.map((field) => (
                <div key={field.key}>{renderSyncBackendField(field, form as unknown as SyncReactFormApi)}</div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={previewMutation.isPending}>
                  {m['dashboard.sync.connect']()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disconnectMutation.isPending}
                  onClick={() => disconnectMutation.mutate()}
                >
                  {m['dashboard.sync.disconnect']()}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={retryMutation.isPending}
                  onClick={() => retryMutation.mutate()}
                >
                  {m['dashboard.sync.retry']()}
                </Button>
                {providerObjectId === null ? null : (
                  <Button type="button" variant="link" onClick={() => setHistoryObjectId(providerObjectId)}>
                    {m['dashboard.sync.history']()}
                  </Button>
                )}
                {selectedProviderId === '' ? null : (
                  <Button type="button" variant="destructive" onClick={previewProviderPurge}>
                    {m['dashboard.sync.purge_provider']()}
                  </Button>
                )}
              </div>
            </form>
          ) : null}
          {previewError === undefined ? null : <p role="alert">{previewError}</p>}
          {disconnectMutation.isError ? <p role="alert">{m['dashboard.sync.disconnect_failed']()}</p> : null}
          {retryMutation.isError ? <p role="alert">{m['dashboard.sync.retry_failed']()}</p> : null}
        </CardContent>
      </Card>
      <SyncPreviewDialog
        open={preview !== null}
        preview={preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        onApplied={() => setPreview(null)}
        onRetry={async () => {
          if (lastPreviewInput === undefined) throw new Error('SYNC_PREVIEW_INPUT_MISSING');
          const next = await previewMutation.mutateAsync(lastPreviewInput);
          setPreview(next);
          return next;
        }}
        onPreviewOverrides={
          preview?.kind === 'purge'
            ? undefined
            : async (paths) => {
                const objectId = preview?.rows[0]?.objectId;
                if (objectId === undefined) throw new Error('SYNC_PREVIEW_OBJECT_MISSING');
                const input: SyncPreviewInput = { kind: 'overrides', objectId, paths: paths.map((path) => [...path]) };
                setLastPreviewInput(input);
                const next = await previewMutation.mutateAsync(input);
                setPreview(next);
                return next;
              }
        }
      />
      <SyncHistoryDialog
        objectId={historyObjectId}
        open={historyObjectId !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryObjectId(null);
        }}
      />
    </>
  );
};
