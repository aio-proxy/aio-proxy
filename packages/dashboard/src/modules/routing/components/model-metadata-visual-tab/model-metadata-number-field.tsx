import { Input } from '@aio-proxy/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@aio-proxy/ui/components/input-group';
import { Label } from '@aio-proxy/ui/components/label';
import { useState } from 'react';

interface ModelMetadataNumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly step: number | 'any';
  /** Shown while empty, so a blank field reads as "inherit" rather than as zero. */
  readonly placeholder: string;
  readonly value: number | undefined;
  /** Keeps the label for assistive tech but hides it, for grids where a column header names the field. */
  readonly labelHidden?: boolean;
  /** `sm` is the dense form used inside a tier's price grid. */
  readonly size?: 'default' | 'sm';
  /** Shown at the end of the input, e.g. "USD / 1M tokens". */
  readonly unit?: string;
  readonly onValueChange: (next: number | undefined) => void;
}

/**
 * A number input whose DOM text is owned locally, not derived from the parsed draft.
 *
 * Deriving `value` from the draft on every render makes fractional entry impossible: typing `0.075`
 * passes through `0.0`, which `Number()` collapses to `0`, and the controlled string `'0'` is then
 * written back over the user's `'0.0'`. Holding the in-progress text here and pushing only the
 * parsed number outward keeps the field editable while the draft stays numeric.
 */
export const ModelMetadataNumberField: React.FC<ModelMetadataNumberFieldProps> = ({
  id,
  label,
  min,
  step,
  placeholder,
  value,
  labelHidden = false,
  size = 'default',
  unit,
  onValueChange,
}) => {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const [lastValue, setLastValue] = useState(value);

  // Re-sync from outside (JSON tab edited, drawer reopened) but never from our own echo: if the
  // incoming number is what the current text already parses to, the text is the better display.
  if (value !== lastValue) {
    setLastValue(value);
    if (value !== (text === '' ? undefined : Number(text))) setText(value === undefined ? '' : String(value));
  }

  const inputProps = {
    id,
    type: 'number',
    min,
    step,
    placeholder,
    value: text,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      const parsed = next === '' ? undefined : Number(next);
      // Refused, not displayed: a value the draft cannot hold (`1e999` -> Infinity) would otherwise
      // sit in the field as text no saved record contains.
      if (parsed !== undefined && !Number.isFinite(parsed)) return;
      setText(next);
      onValueChange(parsed);
    },
  } as const;

  return (
    <div className={labelHidden ? undefined : size === 'sm' ? 'space-y-1' : 'space-y-1.5'}>
      <Label
        htmlFor={id}
        className={labelHidden ? 'sr-only' : size === 'sm' ? 'text-xs font-normal text-muted-foreground' : undefined}
      >
        {label}
      </Label>
      {unit === undefined ? (
        <Input className={size === 'sm' ? 'h-7 font-mono text-xs' : 'font-mono'} {...inputProps} />
      ) : (
        <InputGroup>
          <InputGroupInput className="font-mono" {...inputProps} />
          <InputGroupAddon align="inline-end">
            <InputGroupText className="text-xs font-normal">{unit}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      )}
    </div>
  );
};
