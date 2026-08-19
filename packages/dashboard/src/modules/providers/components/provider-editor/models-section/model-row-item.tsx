import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { cn } from '@aio-proxy/ui/lib/utils';

interface ModelRowItemProps {
  readonly id: string;
  readonly enabled: boolean;
  /** Rendered only when a discovered catalog exists; without one the row *is* the whitelist. */
  readonly selectable: boolean;
  /** Whitelisted but absent from the discovered catalog. */
  readonly stale: boolean;
  /** Only rows the user authored (or stale ones) can be removed; a candidate row would reappear. */
  readonly removable: boolean;
  /** The row's own `limit.context` override in tokens. The catalog endpoint returns slugs only. */
  readonly context?: number | undefined;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onEditMetadata: () => void;
}

// An em dash means "not overridden", never zero tokens.
const formatContext = (context: number | undefined) => (context === undefined ? '—' : `${Math.round(context / 1000)}K`);

export const ModelRowItem: React.FC<ModelRowItemProps> = ({
  id,
  enabled,
  selectable,
  stale,
  removable,
  context,
  onToggle,
  onRemove,
  onEditMetadata,
}) => {
  const checkboxId = `model-row-checkbox-${id}`;
  const nameClassName = cn('block truncate font-mono text-sm', enabled ? '' : 'text-muted-foreground');

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition-colors',
        enabled ? 'border-border bg-card' : 'border-transparent bg-muted/40',
      )}
      data-testid={`model-row-${id}`}
    >
      {selectable ? <Checkbox id={checkboxId} checked={enabled} aria-label={id} onCheckedChange={onToggle} /> : null}
      <div className="min-w-0 flex-1">
        {/* A bound label, so clicking the model id toggles it. Without a checkbox there is nothing to bind. */}
        {selectable ? (
          <label htmlFor={checkboxId} className={nameClassName}>
            {id}
          </label>
        ) : (
          <span className={nameClassName}>{id}</span>
        )}
        {stale ? (
          <span className="block text-xs text-muted-foreground" data-testid="model-row-stale">
            {m['dashboard.providers.editor.models_stale_whitelist']({ model: id })}
          </span>
        ) : null}
      </div>
      <span
        className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline"
        data-testid="model-row-context"
      >
        {formatContext(context)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="model-row-metadata"
        aria-label={m['dashboard.providers.form.edit_metadata']({ model: id })}
        onClick={onEditMetadata}
      >
        {m['dashboard.providers.form.metadata']()}
      </Button>
      {removable ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="model-row-remove"
          aria-label={m['dashboard.providers.form.remove_model']({ model: id })}
          onClick={onRemove}
        >
          {m['dashboard.providers.actions.delete']()}
        </Button>
      ) : null}
    </div>
  );
};
