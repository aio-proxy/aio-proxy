import { m } from '@aio-proxy/i18n';
import { InputGroup, InputGroupAddon } from '@aio-proxy/ui/components/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type { FC } from 'react';

import { ANY_DIMENSION, type AliasRowDraft } from '../../lib/alias-editor';
import { CONDITION_LABEL_CLASS, CONDITION_SELECT_CLASS } from './condition-classes';
import { EffortCombobox } from './effort-combobox';

// Service tiers are config literals the user also types in YAML, so they stay unlocalized like model ids.
const SPEEDS = ['flex', 'standard', 'fast'] as const;

interface ProviderVariantConditionsProps {
  readonly draft: AliasRowDraft;
  readonly aliasName: string;
  readonly controlId: string;
  readonly invalid: boolean;
  readonly onCommit: (patch: Partial<AliasRowDraft>) => void;
}

/** The three dimensions a request is matched on. `lg:contents` hands the cells to the row's grid so
 * conditions and target align across rows, while below `lg` they keep their own three-up grid. */
export const ProviderVariantConditions: FC<ProviderVariantConditionsProps> = ({
  draft,
  aliasName,
  controlId,
  invalid,
  onCommit,
}) => {
  // Every row of every alias would otherwise announce the same three labels, so a screen reader hears
  // "thinking" with no way to tell which alias — or which row — it belongs to.
  const alias = aliasName.trim() === '' ? m['dashboard.providers.form.variant_condition_alias_fallback']() : aliasName;

  return (
    <div className="grid gap-2 sm:grid-cols-3 lg:contents">
      <EffortCombobox
        id={controlId}
        aliasName={alias}
        value={draft.effort}
        invalid={invalid}
        onChange={(effort) => onCommit({ effort })}
      />
      <InputGroup>
        <InputGroupAddon className={CONDITION_LABEL_CLASS}>thinking</InputGroupAddon>
        <Select
          value={draft.thinking}
          onValueChange={(thinking) => {
            if (thinking === null) return;
            onCommit({ thinking });
          }}
        >
          <SelectTrigger
            id={`${controlId}-thinking`}
            data-slot="input-group-control"
            className={CONDITION_SELECT_CLASS}
            aria-label={m['dashboard.providers.form.variant_thinking_label']({ alias })}
            aria-invalid={invalid}
          >
            <SelectValue>
              {draft.thinking === 'on'
                ? m['dashboard.providers.form.variant_thinking_on']()
                : draft.thinking === 'off'
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
      <InputGroup>
        <InputGroupAddon className={CONDITION_LABEL_CLASS}>speed</InputGroupAddon>
        <Select
          value={draft.speed}
          onValueChange={(speed) => {
            if (speed === null) return;
            onCommit({ speed });
          }}
        >
          <SelectTrigger
            id={`${controlId}-speed`}
            data-slot="input-group-control"
            className={CONDITION_SELECT_CLASS}
            aria-label={m['dashboard.providers.form.variant_speed_label']({ alias })}
            aria-invalid={invalid}
          >
            <SelectValue>
              {draft.speed === ANY_DIMENSION ? m['dashboard.providers.form.variant_speed_unset']() : draft.speed}
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
    </div>
  );
};
