import { m } from '@aio-proxy/i18n';
import { SyncPreviewSchema, type SyncApplyInput, type SyncPreview, type SyncPreviewRow } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@aio-proxy/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { omit } from 'es-toolkit/object';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { useApplySync } from '@/hooks/use-sync';
import { SyncRequestError } from '@/lib/sync-request-error';

import { SyncPreviewOverrideField } from './sync-preview-override-field';
import { SyncPreviewRenameField } from './sync-preview-rename-field';

const SECRET_KEY = /(?:secret|token|password|credential|api[-_]?key|private[-_]?key|authorization)/iu;
const EMPTY_ROWS: readonly SyncPreviewRow[] = [];
const EMPTY_PATHS: readonly string[][] = [];
// Matches `newProviderId` in the sync contract and `id` in the Provider contract: any nonempty
// string. A narrower client alphabet would reject IDs the Provider editor itself accepts.
const providerIdSchema = z.string().trim().min(1);
const decisionSchema = z.object({
  objectId: z.string().min(1),
  choice: z.enum(['local', 'cloud', 'restore']),
  newProviderId: providerIdSchema.optional(),
});
const previewFormSchema = z.object({
  decisions: z.record(z.string(), decisionSchema),
  overrides: z.record(z.string(), z.array(z.array(z.string().min(1)))),
  renames: z.record(z.string(), z.string()),
});

const redactPreviewValue = (value: unknown): unknown => {
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
  readonly overrides: Record<string, readonly string[][]>;
  readonly renames: Record<string, string>;
}

export interface SyncPreviewDialogProps {
  readonly preview: SyncPreview | null;
  onOpenChange(open: boolean): void;
  onRetry?(): Promise<SyncPreview>;
  /** An override belongs to one entity, so the row the paths were pinned on names the target. */
  onPreviewOverrides?(objectId: string, paths: readonly string[][]): Promise<SyncPreview>;
}

// A connect row the server marked `optional` joins nothing, so omitting its decision is how the
// user declines to carry it onto the new backend. The Select needs a value for that, and it must
// not collide with a real choice.
const EXCLUDE = 'exclude';

const initialValues = (preview: SyncPreview | null): PreviewFormValues => ({
  decisions: Object.fromEntries(
    (preview?.rows ?? [])
      .filter((row) => row.optional !== true)
      .map((row) => [row.objectId, { objectId: row.objectId, choice: row.choices[0] ?? 'local' }]),
  ),
  overrides: {},
  renames: {},
});

const choiceLabel = (choice: SyncPreviewRow['choices'][number] | typeof EXCLUDE): string => {
  if (choice === EXCLUDE) return m['dashboard.sync.preview_choice_exclude']();
  if (choice === 'cloud') return m['dashboard.sync.preview_choice_cloud']();
  if (choice === 'restore') return m['dashboard.sync.preview_choice_restore']();
  return m['dashboard.sync.preview_choice_local']();
};

// An excluded connect row is not being carried anywhere, so it has no identity to collide with and
// demanding a new Provider ID for it would leave Apply blocked with no way to satisfy it.
const missingRenames = (values: PreviewFormValues, rows: readonly SyncPreviewRow[]): readonly string[] =>
  rows
    .filter(
      (row) =>
        row.requiresProviderId === true &&
        values.decisions[row.objectId] !== undefined &&
        !providerIdSchema.safeParse(values.renames[row.objectId]).success,
    )
    .map((row) => row.objectId);

const isValidReplacementPreview = (value: unknown, kind: SyncPreview['kind']): value is SyncPreview =>
  SyncPreviewSchema.safeParse(value).success && (value as SyncPreview).kind === kind;

// An override preview replaces the whole dialog, so only one row can have a failure in flight.
interface OverrideError {
  readonly objectId: string;
  readonly kind: 'invalid' | 'refresh';
}

export const SyncPreviewDialog: React.FC<SyncPreviewDialogProps> = ({
  preview,
  onOpenChange,
  onRetry,
  onPreviewOverrides,
}) => {
  const open = preview !== null;
  const applyMutation = useApplySync();
  const [needsFreshPreview, setNeedsFreshPreview] = useState(false);
  const [overrideError, setOverrideError] = useState<OverrideError | undefined>();
  const [retryError, setRetryError] = useState(false);
  const [isRefreshingOverrides, setIsRefreshingOverrides] = useState(false);
  const overridesRef = useRef<Record<string, readonly string[][]>>({});
  // Bumped by every override preview request and by every draft reset, so a request that was
  // superseded while in flight can tell that its result no longer describes the pinned paths.
  const previewGenerationRef = useRef(0);
  // The operation the dialog was opened for. Pinning an override previews that override on its
  // own, so this is what has to come back once the override is applied.
  const openedKindRef = useRef<SyncPreview['kind'] | undefined>(undefined);
  const [, rerenderOverrides] = useState(0);
  const rows = preview?.rows ?? EMPTY_ROWS;

  // Every setter and ref below is render-stable, so the effect can depend on this directly.
  const clearOverrideDraft = useCallback(() => {
    overridesRef.current = {};
    previewGenerationRef.current += 1;
    setNeedsFreshPreview(false);
    setOverrideError(undefined);
    setIsRefreshingOverrides(false);
  }, []);

  const form = useForm({
    defaultValues: initialValues(preview),
    validators: {
      onChange: previewFormSchema,
      // Reported against `renames` so each collision row can render its own message from the
      // field rather than from a second copy of the rule held next to the dialog.
      onSubmit: ({ value }) => {
        const missing = missingRenames(value, rows);
        return missing.length === 0 ? undefined : { fields: { renames: missing } };
      },
    },
    onSubmit: ({ value }) => submit(value),
  });

  useEffect(() => {
    if (!open || preview === null) {
      openedKindRef.current = undefined;
      // The parent keeps this component mounted across closes, so the draft has to be cleared
      // from the prop change rather than from an event: the dialog also closes without one.
      // oxlint-disable-next-line react/set-state-in-effect
      clearOverrideDraft();
      form.reset(initialValues(preview));
      return;
    }
    if (openedKindRef.current === undefined) openedKindRef.current = preview.kind;
    const existingOverrides = overridesRef.current;
    form.reset({
      ...initialValues(preview),
      overrides: existingOverrides,
    });
  }, [clearOverrideDraft, form, open, preview]);

  const stale = applyMutation.error instanceof SyncRequestError && applyMutation.error.code === 'preview-stale';
  const pending = applyMutation.isPending || isRefreshingOverrides;
  // A first connect has no binding yet, so its preview legitimately carries zero rows and
  // an empty decision set is a valid apply. Only the decision-bearing kinds need a row.
  const submitDisabled =
    pending || needsFreshPreview || preview === null || (rows.length === 0 && preview.kind !== 'connect');

  const options = new Set(rows.flatMap((row) => row.choices));

  const requestOverridesPreview = async (objectId: string, paths: readonly string[][]) => {
    const generation = (previewGenerationRef.current += 1);
    setNeedsFreshPreview(true);
    setOverrideError(undefined);
    if (onPreviewOverrides === undefined) {
      setOverrideError({ objectId, kind: 'refresh' });
      return;
    }
    setIsRefreshingOverrides(true);
    const replacement = await Promise.resolve()
      .then(() => onPreviewOverrides(objectId, paths))
      .catch(() => undefined);
    // A superseded request previewed paths the user has since changed or abandoned. Accepting it
    // would mark the current pins as reviewed and let Apply persist the older path set.
    if (previewGenerationRef.current !== generation) return;
    if (replacement !== undefined && isValidReplacementPreview(replacement, 'overrides')) {
      setNeedsFreshPreview(false);
    } else {
      setOverrideError({ objectId, kind: 'refresh' });
    }
    setIsRefreshingOverrides(false);
  };

  const setOverridePaths = (objectId: string, paths: readonly string[][]) => {
    overridesRef.current = { ...overridesRef.current, [objectId]: paths };
    rerenderOverrides((version) => version + 1);
  };

  // Reached only after the form's own validators pass, so the rename requirement is already met.
  function submit(values: PreviewFormValues) {
    if (preview === null || submitDisabled) return;
    const decisions = Object.values(values.decisions).map((decision) => {
      const rename = values.renames[decision.objectId]?.trim();
      return { ...decision, ...(rename === undefined || rename === '' ? {} : { newProviderId: rename }) };
    });
    applyMutation.mutate(
      { previewId: preview.previewId, decisions },
      {
        onSuccess: () => {
          // An override applied from inside another operation persists only its own paths. Bring
          // that operation back for its own explicit apply rather than reporting it done: its
          // decisions were never sent, and it now has to be previewed against the new overrides.
          if (preview.kind === 'overrides' && openedKindRef.current !== 'overrides' && onRetry !== undefined) {
            clearOverrideDraft();
            applyMutation.reset();
            void Promise.resolve()
              .then(() => onRetry())
              .catch(() => setRetryError(true));
            return;
          }
          onOpenChange(false);
        },
      },
    );
  }

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
                const replacement =
                  onRetry === undefined
                    ? undefined
                    : await Promise.resolve()
                        .then(() => onRetry())
                        .catch(() => undefined);
                if (replacement !== undefined && isValidReplacementPreview(replacement, preview?.kind ?? 'join')) {
                  applyMutation.reset();
                  setNeedsFreshPreview(false);
                } else {
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
                      const current =
                        field.state.value[row.objectId]?.choice ??
                        (row.optional === true ? EXCLUDE : (row.choices[0] ?? 'local'));
                      return (
                        <Select
                          value={current}
                          onValueChange={(value) => {
                            if (value === null) return;
                            if (value === EXCLUDE) {
                              if (row.optional !== true) return;
                              field.handleChange(omit(field.state.value, [row.objectId]));
                              return;
                            }
                            if (!options.has(value as SyncPreviewRow['choices'][number])) return;
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
                            {row.optional === true ? (
                              <SelectItem value={EXCLUDE}>{choiceLabel(EXCLUDE)}</SelectItem>
                            ) : null}
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
                {/* Only an identity collision — two objects claiming one Provider ID — needs a
                    rename. A plain local/cloud conflict on a single object is resolvable under its
                    existing ID, and the server rejects nothing there. */}
                {row.requiresProviderId === true ? (
                  <form.Field name="renames">
                    {(field) => (
                      <SyncPreviewRenameField
                        value={field.state.value[row.objectId] ?? ''}
                        missing={field.state.meta.errors.flat().includes(row.objectId)}
                        onValueChange={(newProviderId) =>
                          field.handleChange({ ...field.state.value, [row.objectId]: newProviderId })
                        }
                      />
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
                {preview.kind === 'purge' ? null : (
                  <form.Field name="overrides">
                    {(field) => (
                      <div className="mt-3">
                        <SyncPreviewOverrideField
                          paths={overridesRef.current[row.objectId] ?? EMPTY_PATHS}
                          pending={pending}
                          error={overrideError?.objectId === row.objectId ? overrideError.kind : undefined}
                          needsFreshPreview={needsFreshPreview}
                          canPreview={onPreviewOverrides !== undefined}
                          onInvalidPath={() => setOverrideError({ objectId: row.objectId, kind: 'invalid' })}
                          onPathsChange={(next) => {
                            setOverridePaths(row.objectId, next);
                            field.handleChange({ ...field.state.value, [row.objectId]: next });
                            void requestOverridesPreview(row.objectId, next);
                          }}
                        />
                      </div>
                    )}
                  </form.Field>
                )}
              </div>
            ))}
            {preview.retainedSharedPlugins.length > 0 ? (
              <p className="rounded-lg border p-3 text-sm">{m['dashboard.sync.shared_plugin_retained']()}</p>
            ) : null}
            {rows.some((row) => row.dependencies.length > 0 || row.secretChange !== 'none') ? (
              <p className="rounded-lg border p-3 text-sm">{m['dashboard.sync.required_plugin_data']()}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{m['dashboard.sync.preview_no_secrets']()}</p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {m['dashboard.sync.preview_cancel']()}
          </Button>
          <Button type="button" onClick={() => void form.handleSubmit()} disabled={submitDisabled}>
            {pending ? m['dashboard.sync.pending']() : m['dashboard.sync.preview_apply']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
