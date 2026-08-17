import { m } from '@aio-proxy/i18n';
import { InputGroup, InputGroupAddon } from '@aio-proxy/ui/components/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type { FC } from 'react';

import { ANY_DIMENSION, type AliasRowDraft, type AliasRowForm } from '../../lib/alias-editor';
import { CONDITION_LABEL_CLASS, CONDITION_SELECT_CLASS } from './condition-classes';
import { EffortCombobox } from './effort-combobox';

// Service tiers are config literals the user also types in YAML, so they stay unlocalized like model ids.
const SPEEDS = ['flex', 'standard', 'fast'] as const;

interface ProviderVariantConditionsProps {
  readonly form: AliasRowForm;
  readonly controlId: string;
  readonly invalid: boolean;
  readonly onCommit: (patch: Partial<AliasRowDraft>) => void;
}

/** The three dimensions a request is matched on. `lg:contents` hands the cells to the row's grid so
 * conditions and target align across rows, while below `lg` they keep their own three-up grid. */
export const ProviderVariantConditions: FC<ProviderVariantConditionsProps> = ({
  form,
  controlId,
  invalid,
  onCommit,
}) => (
  <div className="grid gap-2 sm:grid-cols-3 lg:contents">
    <form.Field name="effort">
      {(field) => (
        <EffortCombobox
          id={controlId}
          value={field.state.value}
          invalid={invalid}
          onChange={(effort) => {
            field.handleChange(effort);
            onCommit({ effort });
          }}
        />
      )}
    </form.Field>
    <form.Field name="thinking">
      {(field) => (
        <InputGroup>
          <InputGroupAddon className={CONDITION_LABEL_CLASS}>thinking</InputGroupAddon>
          <Select
            value={field.state.value}
            onValueChange={(thinking) => {
              if (thinking === null) return;
              field.handleChange(thinking);
              onCommit({ thinking });
            }}
          >
            <SelectTrigger
              id={`${controlId}-thinking`}
              data-slot="input-group-control"
              className={CONDITION_SELECT_CLASS}
              aria-label={m['dashboard.providers.form.variant_thinking_label']()}
              aria-invalid={invalid}
            >
              <SelectValue>
                {field.state.value === 'on'
                  ? m['dashboard.providers.form.variant_thinking_on']()
                  : field.state.value === 'off'
                    ? m['dashboard.providers.form.variant_thinking_off']()
                    : m['dashboard.providers.form.variant_thinking_unset']()}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_DIMENSION}>{m['dashboard.providers.form.variant_thinking_unset']()}</SelectItem>
              <SelectItem value="on">{m['dashboard.providers.form.variant_thinking_on']()}</SelectItem>
              <SelectItem value="off">{m['dashboard.providers.form.variant_thinking_off']()}</SelectItem>
            </SelectContent>
          </Select>
        </InputGroup>
      )}
    </form.Field>
    <form.Field name="speed">
      {(field) => (
        <InputGroup>
          <InputGroupAddon className={CONDITION_LABEL_CLASS}>speed</InputGroupAddon>
          <Select
            value={field.state.value}
            onValueChange={(speed) => {
              if (speed === null) return;
              field.handleChange(speed);
              onCommit({ speed });
            }}
          >
            <SelectTrigger
              id={`${controlId}-speed`}
              data-slot="input-group-control"
              className={CONDITION_SELECT_CLASS}
              aria-label={m['dashboard.providers.form.variant_speed_label']()}
              aria-invalid={invalid}
            >
              <SelectValue>
                {field.state.value === ANY_DIMENSION
                  ? m['dashboard.providers.form.variant_speed_unset']()
                  : field.state.value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_DIMENSION}>{m['dashboard.providers.form.variant_speed_unset']()}</SelectItem>
              {SPEEDS.map((speed) => (
                <SelectItem key={speed} value={speed}>
                  {speed}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InputGroup>
      )}
    </form.Field>
  </div>
);
