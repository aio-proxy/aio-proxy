import { m } from '@aio-proxy/i18n';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { isEqual } from 'es-toolkit/predicate';
import { useEffect, useId, useRef, useState } from 'react';

import { parseCompositeDraft } from './request-transform-composite-draft';
import {
  type InvalidStaticValueType,
  RequestTransformStaticValueInput,
  type StaticValueType,
} from './request-transform-static-value-input';

export interface RequestTransformStaticValueEditorProps {
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

const valueType = (value: JsonValue): StaticValueType => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
};

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

export const RequestTransformStaticValueEditor: React.FC<RequestTransformStaticValueEditorProps> = ({
  value,
  onChange,
  onValidityChange,
}) => {
  const [typeId, valueId, errorId] = [useId(), useId(), useId()];
  const expectedValue = useRef(value);
  const [draftError, setDraftError] = useState<InvalidStaticValueType | null>(null);
  const form = useForm({ defaultValues: { type: valueType(value), draft: valueDraft(value) } });
  useEffect(() => {
    if (isEqual(value, expectedValue.current)) return;
    expectedValue.current = value;
    form.reset({ type: valueType(value), draft: valueDraft(value) });
    setDraftError(null);
    onValidityChange(true);
  }, [form, onValidityChange, value]);
  const emit = (nextValue: JsonValue) => {
    expectedValue.current = nextValue;
    onValidityChange(true);
    onChange(nextValue);
  };
  const commitDraft = (type: Exclude<StaticValueType, 'null'>, draft: string) => {
    if (type === 'text') {
      setDraftError(null);
      emit(draft);
      return;
    }
    if (type === 'boolean') {
      setDraftError(null);
      emit(draft === 'true');
      return;
    }
    const parsed = type === 'number' ? Number(draft) : parseCompositeDraft(type, draft);
    const valid = type === 'number' ? draft.trim() !== '' && Number.isFinite(parsed) : parsed !== undefined;
    setDraftError(valid ? null : type);
    if (!valid) {
      onValidityChange(false);
      return;
    }
    emit(parsed as JsonValue);
  };
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <form.Field name="type">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={typeId} className="sr-only">
              {m['dashboard.providers.transforms.value.type']()}
            </Label>
            <Select
              value={field.state.value}
              onValueChange={(nextType) => {
                if (nextType === null) return;
                if (!['text', 'number', 'boolean', 'null', 'object', 'array'].includes(nextType)) return;
                const typed = nextType as StaticValueType;
                const nextValue = defaultValue(typed);
                field.handleChange(typed);
                form.setFieldValue('draft', valueDraft(nextValue));
                setDraftError(null);
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
                return (
                  <RequestTransformStaticValueInput
                    type={type}
                    draft={field.state.value}
                    valueId={valueId}
                    errorId={errorId}
                    error={draftError}
                    onChange={(draft) => {
                      field.handleChange(draft);
                      commitDraft(type, draft);
                    }}
                  />
                );
              }}
            </form.Field>
          );
        }}
      </form.Subscribe>
    </div>
  );
};
