import { m } from '@aio-proxy/i18n';
import { MODEL_METADATA_KNOWN_KEYS } from '@aio-proxy/types';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Textarea } from '@aio-proxy/ui/components/textarea';

import { ModelMetadataCapabilitySelect } from './model-metadata-capability-select';
import { ModelMetadataExtendField } from './model-metadata-extend-field';
import { ModelMetadataGroup } from './model-metadata-group';
import { ModelMetadataNumberField } from './model-metadata-number-field';

interface ModelMetadataVisualTabProps {
  readonly value: Readonly<Record<string, unknown>>;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}

/**
 * The fields of `ModelMetadataSchema` this tab exposes. Labels are the config key paths themselves
 * rather than i18n prose: they are identifiers the user sees verbatim in the JSON tab, so their
 * spelling is intentionally shared by every locale. The localized prose lives in the group headings.
 */
const LIMIT_FIELDS = ['context', 'input', 'output'] as const;
const CAPABILITY_FIELDS = ['reasoning', 'temperature', 'toolCall', 'attachment', 'structuredOutput'] as const;
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;

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

const numberValue = (value: unknown) => (typeof value === 'number' ? value : undefined);
const stringValue = (value: unknown) => (typeof value === 'string' ? value : '');
const booleanValue = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

export const ModelMetadataVisualTab: React.FC<ModelMetadataVisualTabProps> = ({ value, onChange }) => {
  const unknownCount = Object.keys(value).filter((key) => !MODEL_METADATA_KNOWN_KEYS.has(key)).length;
  const inherit = m['dashboard.providers.editor.metadata_inherit_placeholder']();

  return (
    <div className="space-y-6">
      <ModelMetadataGroup
        titleId="metadata-extend-title"
        title={m['dashboard.providers.editor.metadata_group_extend']()}
        hint={m['dashboard.providers.editor.metadata_group_extend_hint']()}
        separated={false}
      >
        <ModelMetadataExtendField
          value={stringValue(value['extend'])}
          onValueChange={(next) => onChange(withKey(value, 'extend', next))}
        />
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-display-title"
        title={m['dashboard.providers.editor.metadata_group_display']()}
        hint={m['dashboard.providers.editor.metadata_group_display_hint']()}
        separated={false}
      >
        <Field>
          <FieldLabel htmlFor="metadata-name">name</FieldLabel>
          <Input
            id="metadata-name"
            value={stringValue(value['name'])}
            onChange={(event) =>
              onChange(withKey(value, 'name', event.target.value === '' ? undefined : event.target.value))
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="metadata-description">description</FieldLabel>
          <Textarea
            id="metadata-description"
            rows={3}
            value={stringValue(value['description'])}
            onChange={(event) =>
              onChange(withKey(value, 'description', event.target.value === '' ? undefined : event.target.value))
            }
          />
        </Field>
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-limit-title"
        title={m['dashboard.providers.editor.metadata_group_limits']()}
        hint={m['dashboard.providers.editor.metadata_group_limits_hint']()}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {LIMIT_FIELDS.map((key) => (
            <ModelMetadataNumberField
              key={key}
              id={`metadata-limit-${key}`}
              label={`limit.${key}`}
              min={1}
              step={1}
              placeholder={inherit}
              value={numberValue(objectAt(value, 'limit')[key])}
              onValueChange={(next) => onChange(withNested(value, 'limit', key, next))}
            />
          ))}
        </div>
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-capability-title"
        title={m['dashboard.providers.editor.metadata_group_capabilities']()}
        hint={m['dashboard.providers.editor.metadata_group_capabilities_hint']()}
      >
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          {CAPABILITY_FIELDS.map((key) => (
            <ModelMetadataCapabilitySelect
              key={key}
              capability={key}
              value={booleanValue(objectAt(value, 'capabilities')[key])}
              onValueChange={(next) => onChange(withNested(value, 'capabilities', key, next))}
            />
          ))}
        </div>
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-cost-title"
        title={m['dashboard.providers.editor.metadata_group_costs']()}
        hint={m['dashboard.providers.editor.metadata_group_costs_hint']()}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {COST_FIELDS.map((key) => (
            <ModelMetadataNumberField
              key={key}
              id={`metadata-cost-${key}`}
              label={`cost.${key}`}
              min={0}
              step="any"
              placeholder={inherit}
              value={numberValue(objectAt(value, 'cost')[key])}
              onValueChange={(next) => onChange(withNested(value, 'cost', key, next))}
            />
          ))}
        </div>
      </ModelMetadataGroup>

      {unknownCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          {m['dashboard.providers.editor.metadata_unknown_fields']({ count: unknownCount })}
        </p>
      ) : null}
    </div>
  );
};
