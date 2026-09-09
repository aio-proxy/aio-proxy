import { m } from '@aio-proxy/i18n';
import type { SyncApplyInput, SyncPreview, SyncPreviewRow } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@aio-proxy/ui/components/dialog';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { SyncRequestError, useApplySync } from '@/lib/sync';

const SECRET_KEY = /(?:secret|token|password|credential|api[-_]?key|private[-_]?key|authorization)/iu;
const EMPTY_ROWS: readonly SyncPreviewRow[] = [];
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const providerIdSchema = z.string().trim().min(1).regex(PROVIDER_ID_PATTERN);
const overridePathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u);
const decisionSchema = z.object({
  objectId: z.string().min(1),
  choice: z.enum(['local', 'cloud', 'restore']),
  newProviderId: providerIdSchema.optional(),
});
const previewFormSchema = z.object({
  decisions: z.record(z.string(), decisionSchema),
  overrides: z.array(z.array(z.string().min(1))),
  newOverride: z.string(),
});

export const redactPreviewValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactPreviewValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : redactPreviewValue(child),
      ]),
    );
  }
  return value;
};

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined) return m['dashboard.sync.preview_empty_value']();
  const redacted = redactPreviewValue(value);
  return typeof redacted === 'string' ? redacted : JSON.stringify(redacted, null, 2);
};

interface PreviewFormValues {
  readonly decisions: Record<string, SyncApplyInput['decisions'][number]>;
  readonly overrides: readonly string[][];
  readonly newOverride: string;
}

export interface SyncPreviewDialogProps {
  readonly open: boolean;
  readonly preview: SyncPreview | null;
  onOpenChange(open: boolean): void;
  onApplied?(): void;
  onRetry?(): Promise<void>;
  onPreviewOverrides?(paths: readonly string[][]): Promise<void>;
}

const initialValues = (preview: SyncPreview | null): PreviewFormValues => ({
  decisions: Object.fromEntries(
    (preview?.rows ?? []).map((row) => [row.objectId, { objectId: row.objectId, choice: row.choices[0] ?? 'local' }]),
  ),
  overrides: [],
  newOverride: '',
});

const choiceLabel = (choice: SyncPreviewRow['choices'][number]): string => {
  if (choice === 'cloud') return m['dashboard.sync.preview_choice_cloud']();
  if (choice === 'restore') return m['dashboard.sync.preview_choice_restore']();
  return m['dashboard.sync.preview_choice_local']();
};

export const SyncPreviewDialog: React.FC<SyncPreviewDialogProps> = ({
  open,
  preview,
  onOpenChange,
  onApplied,
  onRetry,
  onPreviewOverrides,
}) => {
  const applyMutation = useApplySync();
  const [needsFreshPreview, setNeedsFreshPreview] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<'invalid' | 'refresh' | undefined>();
  const [retryError, setRetryError] = useState(false);
  const [isRefreshingOverrides, setIsRefreshingOverrides] = useState(false);
  const form = useForm({ defaultValues: initialValues(preview), validators: { onChange: previewFormSchema } });

  useEffect(() => {
    const existingOverrides = form.getFieldValue('overrides');
    form.reset({
      ...initialValues(preview),
      overrides: preview === null ? [] : existingOverrides,
    });
  }, [form, preview]);

  const stale = applyMutation.error instanceof SyncRequestError && applyMutation.error.code === 'preview-stale';
  const pending = applyMutation.isPending || isRefreshingOverrides;
  const rows = preview?.rows ?? EMPTY_ROWS;
  const submitDisabled = pending || preview === null || rows.length === 0 || needsFreshPreview;

  const options = new Set(rows.flatMap((row) => row.choices));

  const apply = () => {
    if (preview === null || submitDisabled) return;
    const values = form.state.values;
    const parsed = previewFormSchema.safeParse(values);
    const requiredRename = rows.find(
      (row) =>
        row.kind === 'provider' &&
        row.change === 'conflict' &&
        !providerIdSchema.safeParse(values.decisions[row.objectId]?.newProviderId).success,
    );
    if (!parsed.success || requiredRename !== undefined) {
      setValidationError(requiredRename?.objectId ?? 'form');
      return;
    }
    const decisions = Object.values(parsed.data.decisions).map((decision) => ({
      ...decision,
      ...(decision.newProviderId === undefined ? {} : { newProviderId: decision.newProviderId.trim() }),
    }));
    setValidationError(null);
    applyMutation.mutate(
      { previewId: preview.previewId, decisions },
      {
        onSuccess: () => {
          onApplied?.();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(90vh,52rem)] max-w-4xl overflow-y-auto" closeLabel={m['common.close']()}>
        <DialogHeader>
          <DialogTitle>{m['dashboard.sync.preview_title']()}</DialogTitle>
          <DialogDescription>{m['dashboard.sync.preview_description']()}</DialogDescription>
        </DialogHeader>
        {stale ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p>{m['dashboard.sync.preview_stale_retry']()}</p>
            <Button
              type="button"
              size="sm"
              className="mt-2"
              onClick={async () => {
                setRetryError(false);
                try {
                  await onRetry?.();
                  applyMutation.reset();
                  setNeedsFreshPreview(false);
                } catch {
                  setRetryError(true);
                }
              }}
              disabled={pending}
            >
              {m['dashboard.sync.preview_retry']()}
            </Button>
            {retryError ? <p role="alert">{m['dashboard.sync.preview_retry_failed']()}</p> : null}
          </div>
        ) : null}
        {applyMutation.isError && !stale ? <p role="alert">{m['dashboard.sync.apply_failed']()}</p> : null}
        {preview === null || rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['dashboard.sync.preview_empty']()}</p>
        ) : (
          <div className="space-y-4">
            {rows.map((row) => (
              <div key={row.objectId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{row.logicalKey}</p>
                    <p className="text-xs text-muted-foreground">{row.kind}</p>
                  </div>
                  <form.Field name="decisions">
                    {(field) => {
                      const current = field.state.value[row.objectId]?.choice ?? row.choices[0] ?? 'local';
                      return (
                        <Select
                          value={current}
                          onValueChange={(value) => {
                            if (value === null || !options.has(value as SyncPreviewRow['choices'][number])) return;
                            field.handleChange({
                              ...field.state.value,
                              [row.objectId]: {
                                ...(field.state.value[row.objectId] ?? { objectId: row.objectId }),
                                objectId: row.objectId,
                                choice: value as SyncApplyInput['decisions'][number]['choice'],
                              },
                            });
                          }}
                        >
                          <SelectTrigger aria-label={row.logicalKey} className="w-full sm:w-44">
                            <SelectValue>{choiceLabel(current)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {row.choices.map((choice) => (
                              <SelectItem key={choice} value={choice}>
                                {choiceLabel(choice)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      );
                    }}
                  </form.Field>
                </div>
                {row.change === 'conflict' ? (
                  <form.Field name="decisions">
                    {(field) => (
                      <>
                        <Input
                          className="mt-3"
                          aria-label={m['dashboard.sync.rename_provider']()}
                          placeholder={m['dashboard.sync.rename_provider']()}
                          value={field.state.value[row.objectId]?.newProviderId ?? ''}
                          onChange={(event) =>
                            field.handleChange({
                              ...field.state.value,
                              [row.objectId]: {
                                ...(field.state.value[row.objectId] ?? { objectId: row.objectId, choice: 'local' }),
                                newProviderId: event.target.value || undefined,
                              },
                            })
                          }
                        />
                        {validationError === row.objectId ? (
                          <p role="alert" className="mt-1 text-xs text-destructive">
                            {providerIdSchema.safeParse(field.state.value[row.objectId]?.newProviderId).success
                              ? null
                              : field.state.value[row.objectId]?.newProviderId?.trim() === '' ||
                                  field.state.value[row.objectId]?.newProviderId === undefined
                                ? m['dashboard.sync.rename_provider_required']()
                                : m['dashboard.sync.rename_provider_invalid']()}
                          </p>
                        ) : null}
                      </>
                    )}
                  </form.Field>
                ) : null}
                <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                  <div>
                    <p className="font-medium">{m['dashboard.sync.preview_row_local']()}</p>
                    <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2">{displayValue(row.local)}</pre>
                  </div>
                  <div>
                    <p className="font-medium">{m['dashboard.sync.preview_row_cloud']()}</p>
                    <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2">{displayValue(row.cloud)}</pre>
                  </div>
                </div>
              </div>
            ))}
            {preview.retainedSharedPlugins.length > 0 ? (
              <p className="rounded-lg border p-3 text-sm">{m['dashboard.sync.shared_plugin_retained']()}</p>
            ) : null}
            {rows.some((row) => row.dependencies.length > 0 || row.secretChange !== 'none') ? (
              <p className="rounded-lg border p-3 text-sm">{m['dashboard.sync.required_plugin_data']()}</p>
            ) : null}
            <form.Field name="overrides">
              {(field) => (
                <div className="rounded-lg border p-3">
                  <p className="font-medium">{m['dashboard.sync.override_title']()}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {field.state.value.map((path) => (
                      <Button
                        key={path.join('.')}
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          const next = field.state.value.filter((current) => current.join('.') !== path.join('.'));
                          field.handleChange(next);
                          setNeedsFreshPreview(true);
                          setOverrideError(undefined);
                        }}
                        aria-label={`${m['dashboard.sync.override_remove']()} ${path.join('.')}`}
                      >
                        {path.join('.')}
                        <X aria-hidden="true" />
                      </Button>
                    ))}
                  </div>
                  <form.Field name="newOverride">
                    {(pathField) => (
                      <div className="mt-3 flex gap-2">
                        <Input
                          aria-label={m['dashboard.sync.override_path']()}
                          value={pathField.state.value}
                          placeholder={m['dashboard.sync.override_path']()}
                          onChange={(event) => pathField.handleChange(event.target.value)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending || pathField.state.value.trim() === ''}
                          onClick={async () => {
                            const parsedPath = overridePathSchema.safeParse(pathField.state.value);
                            if (!parsedPath.success) {
                              setOverrideError('invalid');
                              return;
                            }
                            const path = parsedPath.data.split('.');
                            const next = [...field.state.value, path];
                            field.handleChange(next);
                            pathField.handleChange('');
                            setNeedsFreshPreview(true);
                            setOverrideError(undefined);
                            if (onPreviewOverrides === undefined) return;
                            setIsRefreshingOverrides(true);
                            try {
                              await onPreviewOverrides(next);
                              setNeedsFreshPreview(false);
                              setIsRefreshingOverrides(false);
                            } catch {
                              setOverrideError('refresh');
                              setIsRefreshingOverrides(false);
                            }
                          }}
                        >
                          {m['dashboard.sync.override_add']()}
                        </Button>
                      </div>
                    )}
                  </form.Field>
                  {overrideError !== undefined ? (
                    <p role="alert" className="mt-2 text-xs text-destructive">
                      {overrideError === 'invalid'
                        ? m['dashboard.sync.override_invalid']()
                        : m['dashboard.sync.override_preview_failed']()}
                    </p>
                  ) : null}
                  {needsFreshPreview ? (
                    <p role="status" className="mt-2 text-xs text-muted-foreground">
                      {m['dashboard.sync.override_preview_required']()}
                    </p>
                  ) : null}
                </div>
              )}
            </form.Field>
            <p className="text-xs text-muted-foreground">{m['dashboard.sync.preview_no_secrets']()}</p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {m['dashboard.sync.preview_cancel']()}
          </Button>
          <Button type="button" onClick={apply} disabled={submitDisabled}>
            {pending ? m['dashboard.sync.pending']() : m['dashboard.sync.preview_apply']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
