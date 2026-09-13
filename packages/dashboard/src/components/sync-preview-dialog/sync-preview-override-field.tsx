import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Input } from '@aio-proxy/ui/components/input';
import { X } from 'lucide-react';
import { useState } from 'react';

import { formatOverridePath, parseOverridePath } from './override-path';

export interface SyncPreviewOverrideFieldProps {
  readonly paths: readonly string[][];
  readonly pending: boolean;
  readonly error: 'invalid' | 'refresh' | undefined;
  readonly needsFreshPreview: boolean;
  readonly canPreview: boolean;
  /** Also called with the unchanged paths to retry a preview the backend refused. */
  onPathsChange(paths: readonly string[][]): void;
  onInvalidPath(): void;
}

/**
 * Pins local option paths so a synchronized body never overwrites them. Each edit needs its own
 * preview before the dialog will apply anything, because overriding is its own sync operation.
 */
export const SyncPreviewOverrideField: React.FC<SyncPreviewOverrideFieldProps> = ({
  paths,
  pending,
  error,
  needsFreshPreview,
  canPreview,
  onPathsChange,
  onInvalidPath,
}) => {
  const [draft, setDraft] = useState('');
  const addPath = () => {
    const parsed = parseOverridePath(draft);
    if (parsed === undefined) {
      onInvalidPath();
      return;
    }
    setDraft('');
    onPathsChange([...paths, [...parsed]]);
  };

  return (
    <div className="rounded-lg border p-3">
      <p className="font-medium">{m['dashboard.sync.override_title']()}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {paths.map((path) => {
          const label = formatOverridePath(path);
          return (
            <Button
              key={label}
              type="button"
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => onPathsChange(paths.filter((current) => formatOverridePath(current) !== label))}
              aria-label={`${m['dashboard.sync.override_remove']()} ${label}`}
            >
              {label}
              <X aria-hidden="true" />
            </Button>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          aria-label={m['dashboard.sync.override_path']()}
          value={draft}
          placeholder={m['dashboard.sync.override_path']()}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="button" variant="outline" disabled={pending || draft.trim() === ''} onClick={addPath}>
          {m['dashboard.sync.override_add']()}
        </Button>
      </div>
      {error === undefined ? null : (
        <div className="mt-2 space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {error === 'invalid'
              ? m['dashboard.sync.override_invalid']()
              : m['dashboard.sync.override_preview_failed']()}
          </p>
          {error === 'refresh' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || !canPreview}
              onClick={() => onPathsChange(paths)}
            >
              {m['dashboard.sync.override_preview_retry']()}
            </Button>
          ) : null}
        </div>
      )}
      {needsFreshPreview ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {m['dashboard.sync.override_preview_required']()}
        </p>
      ) : null}
    </div>
  );
};
