import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { cn } from '@aio-proxy/ui/lib/utils';
import { BracesIcon, Trash2Icon } from 'lucide-react';

interface ModelRowItemProps {
  readonly id: string;
  readonly enabled: boolean;
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
  context,
  onToggle,
  onRemove,
  onEditMetadata,
}) => {
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
        <span
          className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline"
          data-testid="model-row-context"
        >
          {formatContext(context)}
        </span>
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
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="model-row-remove"
          aria-label={m['dashboard.providers.form.remove_model']({ model: id })}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
};
