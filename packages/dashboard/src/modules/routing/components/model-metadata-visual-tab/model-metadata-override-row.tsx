import { m } from '@aio-proxy/i18n';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@aio-proxy/ui/components/input-group';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';
import type React from 'react';

interface ModelMetadataOverrideRowProps {
  readonly id: string;
  readonly label: string;
  /** Shown at the end of the value, as the overriding input shows it. */
  readonly unit?: string;
  readonly overridden: boolean;
  /** The reference model's value as display text; `undefined` when it has none. */
  readonly inherited: string | undefined;
  readonly onOverriddenChange: (overridden: boolean) => void;
  /** Holds the switch while the reference value an override would start from is still loading. */
  readonly disabled?: boolean;
  /** The editor shown once the field is overridden; it must carry `id` so the label targets it. */
  readonly children: React.ReactNode;
}

/**
 * One field that either follows the reference model or overrides it. The switch makes that choice
 * explicit: an empty input can no longer be mistaken for "inherit", and the inherited value stays
 * readable while the field is not overridden.
 */
export const ModelMetadataOverrideRow: React.FC<ModelMetadataOverrideRowProps> = ({
  id,
  label,
  unit,
  overridden,
  inherited,
  onOverriddenChange,
  disabled = false,
  children,
}) => (
  <div className="grid grid-cols-[6rem_auto_minmax(0,1fr)] items-center gap-2.5" data-testid={`override-row-${id}`}>
    <Label htmlFor={id} className="font-normal text-muted-foreground">
      {label}
    </Label>
    <Switch
      size="sm"
      checked={overridden}
      disabled={disabled}
      onCheckedChange={onOverriddenChange}
      aria-label={m['dashboard.routing.profile.override_field']({ field: label })}
    />
    {overridden ? (
      children
    ) : (
      // The same field the override edits, disabled: switching it on changes what the value means,
      // not where it sits.
      <InputGroup data-disabled="true">
        <InputGroupInput
          id={id}
          disabled
          className="truncate"
          value={inherited ?? ''}
          placeholder={m['dashboard.routing.profile.not_set']()}
        />
        {unit === undefined ? null : (
          <InputGroupAddon align="inline-end">
            <InputGroupText className="text-xs font-normal">{unit}</InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
    )}
  </div>
);
