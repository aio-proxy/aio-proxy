import { m } from '@aio-proxy/i18n';
import type { ModelMetadata } from '@aio-proxy/types';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import { useQuery } from '@tanstack/react-query';
import { isPlainObject } from 'es-toolkit/predicate';

import { modelsDevLookupQueryOptions } from '../../services/models-dev-service';
import { ModelMetadataCapabilitySelect } from './model-metadata-capability-select';
import { ModelMetadataExtendField } from './model-metadata-extend-field';
import { ModelMetadataGroup } from './model-metadata-group';
import { ModelMetadataNumberField } from './model-metadata-number-field';

interface ModelMetadataVisualTabProps {
  /** Public slug of the model being edited; used to suggest an `extend` fallback. */
  readonly model: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}

/** The fields of `ModelMetadataSchema` this tab exposes. Config key paths appear only in the JSON tab. */
const LIMIT_FIELDS = ['context', 'input', 'output'] as const;
const CAPABILITY_FIELDS = ['reasoning', 'temperature', 'toolCall', 'attachment', 'structuredOutput'] as const;
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;

const LIMIT_LABEL: Readonly<Record<(typeof LIMIT_FIELDS)[number], () => string>> = {
  context: m['dashboard.routing.editor.metadata_limit_label_context'],
  input: m['dashboard.routing.editor.metadata_limit_label_input'],
  output: m['dashboard.routing.editor.metadata_limit_label_output'],
};

const CAPABILITY_LABEL: Readonly<Record<(typeof CAPABILITY_FIELDS)[number], () => string>> = {
  reasoning: m['dashboard.routing.editor.metadata_capability_label_reasoning'],
  temperature: m['dashboard.routing.editor.metadata_capability_label_temperature'],
  toolCall: m['dashboard.routing.editor.metadata_capability_label_tool_call'],
  attachment: m['dashboard.routing.editor.metadata_capability_label_attachment'],
  structuredOutput: m['dashboard.routing.editor.metadata_capability_label_structured_output'],
};

const COST_LABEL: Readonly<Record<(typeof COST_FIELDS)[number], () => string>> = {
  input: m['dashboard.routing.editor.metadata_cost_label_input'],
  output: m['dashboard.routing.editor.metadata_cost_label_output'],
  cacheRead: m['dashboard.routing.editor.metadata_cost_label_cache_read'],
  cacheWrite: m['dashboard.routing.editor.metadata_cost_label_cache_write'],
  reasoning: m['dashboard.routing.editor.metadata_cost_label_reasoning'],
};

const objectAt = (value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> => {
  const nested = value[key];
  return isPlainObject(nested) ? nested : {};
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

const inheritedNumberPlaceholder = (inherited: number | undefined, fallback: string) =>
  inherited === undefined ? fallback : String(inherited);

export const ModelMetadataVisualTab: React.FC<ModelMetadataVisualTabProps> = ({ model, value, onChange }) => {
  const inherit = m['dashboard.routing.editor.metadata_inherit_placeholder']();
  const extend = stringValue(value['extend']);
  const lookup = useQuery(modelsDevLookupQueryOptions(extend === '' ? model : extend));
  const resolvedSlug = lookup.data?.slug;
  const suggestion =
    extend === '' && typeof resolvedSlug === 'string' && resolvedSlug !== model ? resolvedSlug : undefined;
  const inherited: ModelMetadata | undefined =
    extend === '' || lookup.data?.metadata == null ? undefined : lookup.data.metadata;

  return (
    <div className="space-y-6">
      <ModelMetadataGroup
        titleId="metadata-extend-title"
        title={m['dashboard.routing.editor.metadata_group_extend']()}
        hint={m['dashboard.routing.editor.metadata_group_extend_hint']()}
        separated={false}
      >
        <ModelMetadataExtendField
          value={extend}
          suggestion={suggestion}
          onValueChange={(next) => onChange(withKey(value, 'extend', next))}
        />
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-display-title"
        title={m['dashboard.routing.editor.metadata_group_display']()}
        hint={m['dashboard.routing.editor.metadata_group_display_hint']()}
        separated={false}
      >
        <div className="space-y-1.5">
          <Label htmlFor="metadata-name">{m['dashboard.routing.editor.metadata_field_label_name']()}</Label>
          <Input
            id="metadata-name"
            placeholder={inherited?.name ?? m['dashboard.routing.editor.metadata_name_placeholder']()}
            value={stringValue(value['name'])}
            onChange={(event) =>
              onChange(withKey(value, 'name', event.target.value === '' ? undefined : event.target.value))
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="metadata-description">
            {m['dashboard.routing.editor.metadata_field_label_description']()}
          </Label>
          <Textarea
            id="metadata-description"
            rows={3}
            placeholder={inherited?.description}
            value={stringValue(value['description'])}
            onChange={(event) =>
              onChange(withKey(value, 'description', event.target.value === '' ? undefined : event.target.value))
            }
          />
        </div>
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-limit-title"
        title={m['dashboard.routing.editor.metadata_group_limits']()}
        hint={m['dashboard.routing.editor.metadata_group_limits_hint']()}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {LIMIT_FIELDS.map((key) => (
            <ModelMetadataNumberField
              key={key}
              id={`metadata-limit-${key}`}
              label={LIMIT_LABEL[key]()}
              min={1}
              step={1}
              placeholder={inheritedNumberPlaceholder(inherited?.limit?.[key], inherit)}
              value={numberValue(objectAt(value, 'limit')[key])}
              onValueChange={(next) => onChange(withNested(value, 'limit', key, next))}
            />
          ))}
        </div>
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-capability-title"
        title={m['dashboard.routing.editor.metadata_group_capabilities']()}
        hint={m['dashboard.routing.editor.metadata_group_capabilities_hint']()}
      >
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          {CAPABILITY_FIELDS.map((key) => (
            <ModelMetadataCapabilitySelect
              key={key}
              capability={key}
              label={CAPABILITY_LABEL[key]()}
              value={booleanValue(objectAt(value, 'capabilities')[key])}
              inherited={booleanValue(inherited?.capabilities?.[key])}
              onValueChange={(next) => onChange(withNested(value, 'capabilities', key, next))}
            />
          ))}
        </div>
      </ModelMetadataGroup>

      <ModelMetadataGroup
        titleId="metadata-cost-title"
        title={m['dashboard.routing.editor.metadata_group_costs']()}
        hint={m['dashboard.routing.editor.metadata_group_costs_hint']()}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {COST_FIELDS.map((key) => (
            <ModelMetadataNumberField
              key={key}
              id={`metadata-cost-${key}`}
              label={COST_LABEL[key]()}
              min={0}
              step="any"
              placeholder={inheritedNumberPlaceholder(inherited?.cost?.[key], inherit)}
              value={numberValue(objectAt(value, 'cost')[key])}
              onValueChange={(next) => onChange(withNested(value, 'cost', key, next))}
            />
          ))}
        </div>
      </ModelMetadataGroup>
    </div>
  );
};
