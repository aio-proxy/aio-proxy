import { m } from '@aio-proxy/i18n';
import { MODEL_METADATA_KNOWN_KEYS } from '@aio-proxy/types';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@aio-proxy/ui/components/combobox';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { modelsDevSlugsQueryOptions } from '../../services/models-dev-service';

interface ModelMetadataVisualTabProps {
  readonly value: Readonly<Record<string, unknown>>;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}

/**
 * The subset of `ModelMetadataSchema` this tab exposes. Labels are the config key paths themselves
 * rather than i18n prose: they are identifiers the user sees verbatim in the JSON tab, so their
 * spelling is intentionally shared by every locale.
 */
const NUMBER_FIELDS = [
  ['limit', 'context'],
  ['limit', 'output'],
  ['cost', 'input'],
  ['cost', 'output'],
] as const;

const SWITCH_FIELDS = [
  ['capabilities', 'attachment'],
  ['capabilities', 'reasoning'],
] as const;

const objectAt = (value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> => {
  const nested = value[key];
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Readonly<Record<string, unknown>>)
    : {};
};

/** Setting a key to `undefined` clears it, which is how a merge drops a field the user emptied. */
const withKey = (source: Readonly<Record<string, unknown>>, key: string, next: unknown) => {
  const merged = { ...source };
  if (next === undefined) delete merged[key];
  else merged[key] = next;
  return merged;
};

const withNested = (source: Readonly<Record<string, unknown>>, group: string, key: string, next: unknown) => {
  const group_ = withKey(objectAt(source, group), key, next);
  return withKey(source, group, Object.keys(group_).length === 0 ? undefined : group_);
};

const numberText = (value: unknown) => (typeof value === 'number' ? String(value) : '');

export const ModelMetadataVisualTab: React.FC<ModelMetadataVisualTabProps> = ({ value, onChange }) => {
  const extend = typeof value['extend'] === 'string' ? value['extend'] : '';
  const [slugQuery, setSlugQuery] = useState(extend);
  const slugs = useQuery(modelsDevSlugsQueryOptions());
  const query = slugQuery.trim().toLowerCase();
  // The catalog is thousands of entries; the popup only needs enough to pick from.
  const options = (slugs.data?.slugs ?? [])
    .filter((slug) => query === '' || slug.toLowerCase().includes(query))
    .slice(0, 100);
  const unknownCount = Object.keys(value).filter((key) => !MODEL_METADATA_KNOWN_KEYS.has(key)).length;

  return (
    <div className="space-y-5">
      <Field>
        <FieldLabel htmlFor="metadata-extend">{m['dashboard.providers.editor.metadata_extend_label']()}</FieldLabel>
        <Combobox
          items={options}
          value={extend === '' ? null : extend}
          inputValue={slugQuery}
          onValueChange={(next: string | null) => {
            setSlugQuery(next ?? '');
            onChange(withKey(value, 'extend', next === null || next === '' ? undefined : next));
          }}
          onInputValueChange={setSlugQuery}
        >
          <ComboboxInput id="metadata-extend" className="w-full font-mono text-xs" showClear={extend !== ''} />
          <ComboboxContent>
            <ComboboxEmpty>{m['dashboard.providers.editor.metadata_extend_empty']()}</ComboboxEmpty>
            <ComboboxList>
              {options.map((slug) => (
                <ComboboxItem key={slug} value={slug} className="font-mono text-xs">
                  {slug}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        {NUMBER_FIELDS.map(([group, key]) => (
          <Field key={`${group}.${key}`}>
            <FieldLabel htmlFor={`metadata-${group}-${key}`}>{`${group}.${key}`}</FieldLabel>
            <Input
              id={`metadata-${group}-${key}`}
              type="number"
              min={group === 'limit' ? 1 : 0}
              step={group === 'limit' ? 1 : 'any'}
              value={numberText(objectAt(value, group)[key])}
              onChange={(event) => {
                const next = event.target.value === '' ? undefined : Number(event.target.value);
                if (next !== undefined && !Number.isFinite(next)) return;
                onChange(withNested(value, group, key, next));
              }}
            />
          </Field>
        ))}
      </div>

      <div className="space-y-3">
        {SWITCH_FIELDS.map(([group, key]) => (
          <div key={`${group}.${key}`} className="flex items-center justify-between gap-3">
            <Label htmlFor={`metadata-${group}-${key}`}>{`${group}.${key}`}</Label>
            <Switch
              id={`metadata-${group}-${key}`}
              checked={objectAt(value, group)[key] === true}
              // Off drops the key rather than writing `false`: a two-state switch cannot express the
              // schema's third state, and "absent means inherit" matches the rest of this form.
              onCheckedChange={(checked) => onChange(withNested(value, group, key, checked ? true : undefined))}
            />
          </div>
        ))}
      </div>

      {unknownCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          {m['dashboard.providers.editor.metadata_unknown_fields']({ count: unknownCount })}
        </p>
      ) : null}
    </div>
  );
};
