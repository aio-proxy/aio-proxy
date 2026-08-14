import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';

interface ModelRowItemProps {
  readonly id: string;
  readonly enabled: boolean;
  /** Rendered only when a discovered catalog exists; without one the row *is* the whitelist. */
  readonly selectable: boolean;
  /** Whitelisted but absent from the discovered catalog. */
  readonly stale: boolean;
  /** Only rows the user authored (or stale ones) can be removed; a candidate row would reappear. */
  readonly removable: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onEditMetadata: () => void;
}

export const ModelRowItem: React.FC<ModelRowItemProps> = ({
  id,
  enabled,
  selectable,
  stale,
  removable,
  onToggle,
  onRemove,
  onEditMetadata,
}) => (
  <div className="flex items-center gap-2 rounded-lg border p-2" data-testid={`model-row-${id}`}>
    {selectable ? <Checkbox checked={enabled} aria-label={id} onCheckedChange={onToggle} /> : null}
    <div className="min-w-0 flex-1">
      <span className="block truncate">{id}</span>
      {stale ? (
        <span className="block text-xs text-muted-foreground" data-testid="model-row-stale">
          {m['dashboard.providers.editor.models_stale_whitelist']({ model: id })}
        </span>
      ) : null}
    </div>
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
