import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Slider } from '@aio-proxy/ui/components/slider';
import { clamp } from 'es-toolkit/math';

const WEIGHT_MIN = 0;
const WEIGHT_MAX = 100;
const WEIGHT_STEP = 5;
const LABEL_ID = 'provider-weight-label';
const INPUT_ID = 'provider-weight-input';

interface WeightSliderFieldProps {
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
}

/**
 * Higher weights are attempted first. This control never derives a weight from absence: `onChange`
 * reports `undefined` for an empty input, so an existing provider whose config omits the key keeps
 * omitting it, and a stored value outside the range or off the step is kept verbatim until the user
 * actually drags. A new provider is the other case — `routes/providers/new.tsx` seeds an explicit `0`,
 * a value handed to the field rather than one invented here.
 *
 * What an absent weight *displays* is `0`, matching the slider thumb and the runtime, which reads an
 * absent weight as `0` when ordering candidates (`routes/pipeline/attempt/attempt.ts`). A blank box
 * beside a thumb parked at zero read as two controls disagreeing about the same field.
 *
 * The slider is the plan's and the prototype's control, but it can only express `0-100` on a step of
 * `5`. The number input beside it is bound to the same form field and carries no bounds, so any
 * weight config accepts can be typed and kept.
 */
export const WeightSliderField: React.FC<WeightSliderFieldProps> = ({ value, onChange }) => (
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
        min={WEIGHT_MIN}
        max={WEIGHT_MAX}
        step={WEIGHT_STEP}
        // An ARRAY, not a scalar: the wrapper derives its thumb count from a `_values` that falls
        // back to `[min, max]` for a non-array, which silently renders two thumbs at 0 and 100.
        // Clamped for *rendering only* — the number input accepts weights off this track by design, and
        // an unclamped 250 parks the thumb past the end of it. The stored value stays untouched: the
        // out-of-range note below and the input above both read the true `value`.
        value={[clamp(value ?? 0, WEIGHT_MIN, WEIGHT_MAX)]}
        // Base UI hands back `number | readonly number[]` for the same reason; narrow it here or the
        // caller stores an array in a `number | undefined` field.
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
      />
      <Input
        className="w-20 shrink-0 text-right tabular-nums"
        data-testid="weight-number-input"
        id={INPUT_ID}
        // Deliberately no min/max/step: this input IS the escape hatch from the slider's grid, so a
        // stored 250 or 7 has to survive being typed. `step="any"` keeps a fractional weight valid.
        step="any"
        type="number"
        // `?? 0`, not `?? ''`: an absent weight IS zero to the router, and the slider already shows it
        // as such. Clearing the box still reports `undefined` below, so no `weight: 0` key is invented
        // in the config file — only the digit the field was already behaving as becomes visible.
        value={value ?? 0}
        onChange={(event) => {
          const raw = event.target.value.trim();
          const next = Number(raw);
          // Empty is absent, not `0` — `Number('')` is `0`, the one value this field must never
          // invent. The `Number.isNaN` arm is unreachable for `type="number"`, which reports `''` for
          // anything it cannot parse (a half-typed `-` or `1e` arrives as empty and is caught by the
          // arm before it). Kept deliberately as defence if this input's type ever changes.
          onChange(raw === '' || Number.isNaN(next) ? undefined : next);
        }}
      />
    </div>
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
