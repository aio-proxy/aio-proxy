import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Slider } from '@aio-proxy/ui/components/slider';

const WEIGHT_MIN = 0;
const WEIGHT_MAX = 100;
const WEIGHT_STEP = 5;
const LABEL_ID = 'provider-weight-label';
const INPUT_ID = 'provider-weight-input';

interface WeightSliderFieldProps {
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
  readonly disabled: boolean;
}

/**
 * Higher weights are attempted first. Absent stays absent: an untouched weight must never be written
 * as `0`, so the input is left empty rather than defaulted, and a stored value outside the range or
 * off the step is displayed verbatim until the user actually drags.
 *
 * The slider is the plan's and the prototype's control, but it can only express `0-100` on a step of
 * `5`. The number input beside it is bound to the same form field and carries no bounds, so any
 * weight config accepts can be typed, kept, and cleared back to absent.
 */
export const WeightSliderField: React.FC<WeightSliderFieldProps> = ({ value, onChange, disabled }) => (
  <Field data-testid="provider-editor-field-weight">
    {/* `htmlFor` names the number input; the slider takes the same label by `aria-labelledby` and is
        told apart by its role. */}
    <FieldLabel htmlFor={INPUT_ID} id={LABEL_ID}>
      {m['dashboard.providers.form.label_weight']()}
    </FieldLabel>
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
      <Input
        className="w-20 shrink-0 text-right tabular-nums"
        data-testid="weight-number-input"
        disabled={disabled}
        id={INPUT_ID}
        // Deliberately no min/max/step: this input IS the escape hatch from the slider's grid, so a
        // stored 250 or 7 has to survive being typed. `step="any"` keeps a fractional weight valid.
        step="any"
        type="number"
        value={value ?? ''}
        onChange={(event) => {
          const raw = event.target.value.trim();
          const next = Number(raw);
          // Empty is absent, not `0` — `Number('')` is `0`, the one value this field must never
          // invent. A half-typed `-` or `1e` is NaN and also reads as absent until it parses.
          onChange(raw === '' || Number.isNaN(next) ? undefined : next);
        }}
      />
    </div>
    {/* The affinity half of the prototype's sentence already ships as `preview_affinity_note` under
        the attempt-order list on this same screen, so this states the direction only. */}
    <FieldDescription data-testid="weight-slider-description">
      {m['dashboard.providers.editor.weight_description']()}
    </FieldDescription>
    {value !== undefined && (value < WEIGHT_MIN || value > WEIGHT_MAX) ? (
      <FieldDescription data-testid="weight-slider-out-of-range">
        {m['dashboard.providers.editor.weight_out_of_range']({ weight: value })}
      </FieldDescription>
    ) : null}
  </Field>
);
