import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { cn } from '@aio-proxy/ui/lib/utils';
import { BracesIcon, Trash2Icon } from 'lucide-react';

interface ModelRowItemProps {
  readonly id: string;
  readonly enabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onEditMetadata: () => void;
}

export const ModelRowItem: React.FC<ModelRowItemProps> = ({ id, enabled, onToggle, onRemove, onEditMetadata }) => {
  const checkboxId = `model-row-checkbox-${id}`;

  return (
    <div
      className={cn(
        'rounded-2xl border px-3 py-2.5 transition-colors',
        enabled ? 'border-border bg-card' : 'border-transparent bg-muted/40',
      )}
      data-testid={`model-row-${id}`}
    >
      <div className="flex items-center gap-3">
        <Checkbox
          id={checkboxId}
          checked={enabled}
          aria-label={m['dashboard.providers.form.enable_model']({ model: id })}
          onCheckedChange={onToggle}
        />
        <label
          htmlFor={checkboxId}
          className={cn('min-w-0 flex-1 truncate font-mono text-sm', enabled ? '' : 'text-muted-foreground')}
        >
          {id}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="model-row-metadata"
          disabled={!enabled}
          aria-label={m['dashboard.providers.form.edit_metadata']({ model: id })}
          onClick={onEditMetadata}
        >
          <BracesIcon data-icon="inline-start" />
          {m['dashboard.providers.form.metadata']()}
        </Button>
        {/* `disabled` reads the same `enabled` the parent's `remove()` guard early-returns on: only a
            whitelisted id can leave the list, and a catalog-only row's delete would otherwise be an
            enabled control with an inert handler. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="model-row-remove"
          disabled={!enabled}
          aria-label={m['dashboard.providers.form.remove_model']({ model: id })}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
};
