import { m } from '@aio-proxy/i18n';
import { ROUTING_VALUE_MAX } from '@aio-proxy/types';
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@aio-proxy/ui/components/number-field';
import type React from 'react';
import { useState } from 'react';

interface WeightFieldProps {
  readonly weight: number;
  /** The lowest weight this field accepts; `0` where zero means "parked", `1` where it cannot. */
  readonly min: number;
  readonly disabled?: boolean;
  readonly 'aria-label': string;
  readonly 'data-testid'?: string;
  readonly onWeightChange: (weight: number) => void;
}

/**
 * A Provider weight as `− N +`. The draft is owned here and committed on blur, Enter or a stepper
 * press, so a half-typed number never reshuffles its tier's shares mid-keystroke.
 */
export const WeightField: React.FC<WeightFieldProps> = ({
  weight,
  min,
  disabled = false,
  'aria-label': ariaLabel,
  'data-testid': testId,
  onWeightChange,
}) => {
  const [draft, setDraft] = useState<number | null>(weight);
  const [lastWeight, setLastWeight] = useState(weight);
  if (weight !== lastWeight) {
    setLastWeight(weight);
    setDraft(weight);
  }
  const commit = (next: number | null) => {
    // An emptied field has no weight to apply; it falls back to the one in effect.
    if (next === null) setDraft(weight);
    else if (next !== weight) onWeightChange(next);
  };

  return (
    <NumberField
      min={min}
      max={ROUTING_VALUE_MAX}
      step={1}
      format={{ maximumFractionDigits: 0, useGrouping: false }}
      disabled={disabled}
      value={draft}
      onValueChange={setDraft}
      onValueCommitted={commit}
    >
      <NumberFieldGroup className="h-7">
        <NumberFieldDecrement className="px-1.5" aria-label={m['common.decrease']()} />
        <NumberFieldInput
          aria-label={ariaLabel}
          data-testid={testId}
          className="px-0 text-center font-mono"
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft);
          }}
        />
        <NumberFieldIncrement className="px-1.5" aria-label={m['common.increase']()} />
      </NumberFieldGroup>
    </NumberField>
  );
};
