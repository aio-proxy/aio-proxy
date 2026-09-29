import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import type React from 'react';

import type { RoutingDirtyTab } from '../lib/routing-metadata-draft';

interface RoutingModelSaveBarProps {
  readonly dirty: readonly RoutingDirtyTab[];
  readonly stale: boolean;
  readonly saveFailed: boolean;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly onDiscard: () => void;
  readonly onReload: () => void;
  readonly onSave: () => void;
}

const PART_LABEL: Readonly<Record<RoutingDirtyTab, () => string>> = {
  topology: m['dashboard.routing.detail.dirty_route'],
  metadata: m['dashboard.routing.detail.dirty_metadata'],
  cost: m['dashboard.routing.detail.dirty_overrides'],
};

/**
 * The page's single save point. Routing, model info and per-Provider overrides share one draft and
 * one PUT, so one bar names every part with unsaved work and saves them together.
 */
export const RoutingModelSaveBar: React.FC<RoutingModelSaveBarProps> = ({
  dirty,
  stale,
  saveFailed,
  saving,
  canSave,
  onDiscard,
  onReload,
  onSave,
}) => {
  if (dirty.length === 0 && !stale && !saveFailed) return null;
  const parts = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(
    dirty.map((part) => PART_LABEL[part]()),
  );

  return (
    // Same frame as the Provider editor's footer, so the two pages' save points look alike.
    <div
      role="region"
      aria-label={m['dashboard.routing.detail.save_bar']()}
      data-testid="routing-save-bar"
      className="sticky bottom-2 z-20 mt-auto rounded-4xl border bg-background/90 shadow-sm/5 backdrop-blur-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {stale ? (
          <p role="alert" className="min-w-0 text-sm text-destructive">
            {m['dashboard.routing.editor.stale']()}
          </p>
        ) : saveFailed ? (
          <p role="alert" className="min-w-0 text-sm text-destructive">
            {m['dashboard.routing.editor.save_failed']()}
          </p>
        ) : (
          <p className="min-w-0 text-sm text-muted-foreground">{m['dashboard.routing.detail.unsaved']({ parts })}</p>
        )}
        <div className="flex gap-2">
          {/* Cancel cannot call off a request already in flight, so it stays out of reach until the
              save settles rather than reporting the write as abandoned while it commits. */}
          <Button type="button" variant="ghost" disabled={saving} onClick={onDiscard}>
            {m['dashboard.routing.editor.cancel']()}
          </Button>
          {stale ? (
            <Button type="button" variant="outline" disabled={saving} onClick={onReload}>
              {m['dashboard.routing.editor.reload']()}
            </Button>
          ) : null}
          <Button type="button" disabled={!canSave} onClick={onSave}>
            {m['dashboard.routing.editor.save']()}
          </Button>
        </div>
      </div>
    </div>
  );
};
