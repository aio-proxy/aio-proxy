import { m } from '@aio-proxy/i18n';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@aio-proxy/ui/components/combobox';
import { InputGroupAddon } from '@aio-proxy/ui/components/input-group';
import type { FC } from 'react';

import { CONDITION_LABEL_CLASS } from './condition-classes';

// The efforts the supported upstreams name today. The field stays free text on top of them because a
// provider can invent its own level, and the server folds spellings with `canonicalEffort` anyway.
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface EffortComboboxProps {
  readonly id: string;
  /** Already resolved for display: the row's alias name, or the fallback noun when it has none. */
  readonly alias: string;
  readonly value: string;
  readonly invalid: boolean;
  readonly onChange: (effort: string) => void;
}

export const EffortCombobox: FC<EffortComboboxProps> = ({ id, alias, value, invalid, onChange }) => {
  const custom = value.trim();
  const hasCustom = custom !== '' && !EFFORTS.some((effort) => effort === custom);
  // Appending the typed value keeps it selectable: without it the list contradicts the input, which
  // reads as "this value is not allowed" for a field that accepts anything.
  const efforts: readonly string[] = hasCustom ? [...EFFORTS, custom] : EFFORTS;

  return (
    <Combobox
      value={value === '' ? null : value}
      inputValue={value}
      items={efforts}
      autoHighlight
      onInputValueChange={onChange}
      onValueChange={(effort) => {
        if (typeof effort === 'string') onChange(effort);
      }}
    >
      <ComboboxInput
        id={id}
        aria-label={m['dashboard.providers.form.variant_effort_label']({ alias })}
        aria-invalid={invalid}
        placeholder={m['dashboard.providers.form.variant_effort_unset']()}
        className="w-full [&_input]:font-mono [&_input]:text-xs"
        showClear={value !== ''}
        clearLabel={m['common.clear']()}
      >
        <InputGroupAddon className={CONDITION_LABEL_CLASS}>effort</InputGroupAddon>
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxList>
          {efforts.map((effort) => (
            <ComboboxItem key={effort} value={effort} className="font-mono text-xs">
              {hasCustom && effort === custom
                ? m['dashboard.providers.form.variant_effort_custom']({ effort })
                : effort}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};
