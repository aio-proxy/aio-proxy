import { m } from '@aio-proxy/i18n';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import { useForm } from '@tanstack/react-form';
import { isEqual } from 'es-toolkit/predicate';
import { useEffect, useId, useRef } from 'react';

export interface RequestTransformStaticValueEditorProps {
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

type StaticValueType = 'text' | 'number' | 'boolean' | 'null' | 'object' | 'array';

const valueType = (value: JsonValue): StaticValueType =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'string'
        ? 'text'
        : typeof value === 'number'
          ? 'number'
          : typeof value === 'boolean'
            ? 'boolean'
            : 'object';

const valueDraft = (value: JsonValue): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value, null, 2);

const defaultValue = (type: StaticValueType): JsonValue => {
  if (type === 'text') return '';
  if (type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return null;
};

const staticTypeLabel = (type: StaticValueType): string => {
  if (type === 'text') return m['dashboard.providers.transforms.value.type_text']();
  if (type === 'number') return m['dashboard.providers.transforms.value.type_number']();
  if (type === 'boolean') return m['dashboard.providers.transforms.value.type_boolean']();
  if (type === 'null') return m['dashboard.providers.transforms.value.type_null']();
  if (type === 'object') return m['dashboard.providers.transforms.value.type_object']();
  return m['dashboard.providers.transforms.value.type_array']();
};

const parseCompositeDraft = (type: 'object' | 'array', draft: string): JsonValue | undefined => {
  try {
    const parsed = JSON.parse(draft) as JsonValue;
    if (type === 'array') return Array.isArray(parsed) ? parsed : undefined;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const RequestTransformStaticValueEditor: React.FC<RequestTransformStaticValueEditorProps> = ({
  value,
  onChange,
  onValidityChange,
}) => {
  const [typeId, valueId] = [useId(), useId()];
  const expectedValue = useRef(value);
  const form = useForm({ defaultValues: { type: valueType(value), draft: valueDraft(value) } });
  useEffect(() => {
    if (isEqual(value, expectedValue.current)) return;
    expectedValue.current = value;
    form.reset({ type: valueType(value), draft: valueDraft(value) });
    onValidityChange(true);
  }, [form, onValidityChange, value]);
  const emit = (nextValue: JsonValue) => {
    expectedValue.current = nextValue;
    onValidityChange(true);
    onChange(nextValue);
  };
  return (
    <div className="space-y-4">
      <form.Field name="type">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={typeId}>{m['dashboard.providers.transforms.value.type']()}</Label>
            <Select
              value={field.state.value}
              onValueChange={(nextType) => {
                if (nextType === null) return;
                if (!['text', 'number', 'boolean', 'null', 'object', 'array'].includes(nextType)) return;
                const typed = nextType as StaticValueType;
                const nextValue = defaultValue(typed);
                field.handleChange(typed);
                form.setFieldValue('draft', valueDraft(nextValue));
                emit(nextValue);
              }}
            >
              <SelectTrigger id={typeId} data-testid="request-transform-static-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['text', 'number', 'boolean', 'null', 'object', 'array'] as const).map((type) => (
                  <SelectItem key={type} value={type}>
                    {staticTypeLabel(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.type}>
        {(type) => {
          if (type === 'null') return null;
          return (
            <form.Field name="draft">
              {(field) => {
                if (type === 'boolean') {
                  return (
                    <Label className="w-fit">
                      <Checkbox
                        checked={field.state.value === 'true'}
                        onCheckedChange={(checked) => {
                          const next = Boolean(checked);
                          field.handleChange(String(next));
                          emit(next);
                        }}
                      />
                      {m['dashboard.providers.transforms.value.boolean_true']()}
                    </Label>
                  );
                }
                if (type === 'object' || type === 'array') {
                  return (
                    <div className="space-y-2">
                      <Label htmlFor={valueId}>{m['dashboard.providers.transforms.value.static_label']()}</Label>
                      <Textarea
                        id={valueId}
                        className="min-h-28 font-mono"
                        value={field.state.value}
                        onChange={(event) => {
                          const draft = event.target.value;
                          field.handleChange(draft);
                          const parsed = parseCompositeDraft(type, draft);
                          onValidityChange(parsed !== undefined);
                          if (parsed !== undefined) emit(parsed);
                        }}
                      />
                    </div>
                  );
                }
                return (
                  <div className="space-y-2">
                    <Label htmlFor={valueId}>{m['dashboard.providers.transforms.value.static_label']()}</Label>
                    <Input
                      id={valueId}
                      type={type === 'number' ? 'number' : 'text'}
                      value={field.state.value}
                      onChange={(event) => {
                        const draft = event.target.value;
                        field.handleChange(draft);
                        if (type === 'text') emit(draft);
                        else {
                          const number = Number(draft);
                          const valid = draft.trim() !== '' && Number.isFinite(number);
                          onValidityChange(valid);
                          if (valid) emit(number);
                        }
                      }}
                    />
                  </div>
                );
              }}
            </form.Field>
          );
        }}
      </form.Subscribe>
    </div>
  );
};
