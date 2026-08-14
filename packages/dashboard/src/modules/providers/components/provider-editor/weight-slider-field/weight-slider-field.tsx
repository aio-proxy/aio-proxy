import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Slider } from '@aio-proxy/ui/components/slider';

const WEIGHT_MIN = 0;
const WEIGHT_MAX = 100;
const WEIGHT_STEP = 5;
const LABEL_ID = 'provider-weight-label';

interface WeightSliderFieldProps {
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
  readonly disabled: boolean;
}

/**
 * Higher weights are attempted first. Absent stays absent: an untouched weight must never be written
 * as `0`, so the numeric readout is omitted rather than defaulted, and a stored value outside the
 * range or off the step is displayed verbatim until the user actually drags.
 */
export const WeightSliderField: React.FC<WeightSliderFieldProps> = ({ value, onChange, disabled }) => (
  <Field data-testid="provider-editor-field-weight">
    <FieldLabel id={LABEL_ID}>{m['dashboard.providers.form.label_weight']()}</FieldLabel>
    <div className="flex items-center gap-3">
      <Slider
        aria-labelledby={LABEL_ID}
        className="grow"
        disabled={disabled}
        min={WEIGHT_MIN}
        max={WEIGHT_MAX}
        step={WEIGHT_STEP}
        // An ARRAY, not a scalar: the wrapper derives its thumb count from a `_values` that falls
        // back to `[min, max]` for a non-array, which silently renders two thumbs at 0 and 100.
        value={[value ?? 0]}
        // Base UI hands back `number | readonly number[]` for the same reason; narrow it here or the
        // caller stores an array in a `number | undefined` field.
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
      />
      {value === undefined ? null : (
        <span data-testid="weight-slider-value" className="w-10 text-right text-sm tabular-nums">
          {value}
        </span>
      )}
    </div>
    {value !== undefined && (value < WEIGHT_MIN || value > WEIGHT_MAX) ? (
      <FieldDescription data-testid="weight-slider-out-of-range">
        {m['dashboard.providers.editor.weight_out_of_range']({ weight: value })}
      </FieldDescription>
    ) : null}
  </Field>
);
