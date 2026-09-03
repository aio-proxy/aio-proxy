import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription, FieldError } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import type { AnyFieldApi } from '@tanstack/react-form';
import { type FC, useEffect, useRef, useState } from 'react';

import { JsonEditor, type JsonEditorValidation, type JsonValue } from '@/components/json-editor';

import type { UseProviderOptionsSchemaResult } from '../hooks/use-provider-options-schema';

export const isProviderOptionsObject = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> | undefined => {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const providerOptionsAreValid = (
  rootValid: boolean,
  validation: JsonEditorValidation,
  phase: UseProviderOptionsSchemaResult['phase'],
  schema: UseProviderOptionsSchemaResult['schema'],
  schemaResolution: UseProviderOptionsSchemaResult['schemaResolution'],
  value?: JsonValue,
) =>
  rootValid &&
  !(value === undefined && Array.isArray(schema?.['required']) && schema['required'].length > 0) &&
  validation.valid &&
  Object.is(validation.schema, schema) &&
  (phase === 'ready' || phase === 'schema_unavailable' || phase === 'install_error') &&
  (schemaResolution === 'unavailable' || (schemaResolution === 'ready' && schema !== undefined));

export const canRequestProviderInstall = (phase: UseProviderOptionsSchemaResult['phase']) =>
  phase === 'install_required' || phase === 'install_deferred' || phase === 'install_error';

type Props = {
  readonly field: AnyFieldApi;
  readonly schemaState: UseProviderOptionsSchemaResult;
  readonly installRegistry?: string;
  readonly installRegistryValid: boolean;
  readonly onValidityChange: (valid: boolean) => void;
};

const initialValidation: JsonEditorValidation = {
  valid: true,
  syntaxValid: true,
  pending: false,
  markers: [],
  schema: undefined,
};

export const ProviderOptionsEditor: FC<Props> = ({
  field,
  schemaState,
  installRegistry,
  installRegistryValid,
  onValidityChange,
}) => {
  const [editorValue, setEditorValue] = useState<JsonValue | undefined>(field.state.value);
  const [validation, setValidation] = useState(initialValidation);
  const rootValid = isProviderOptionsObject(editorValue);
  const requiredRootMissing =
    editorValue === undefined &&
    Array.isArray(schemaState.schema?.['required']) &&
    schemaState.schema['required'].length > 0;
  const valid = providerOptionsAreValid(
    rootValid,
    validation,
    schemaState.phase,
    schemaState.schema,
    schemaState.schemaResolution,
    editorValue,
  );
  const lastValidity = useRef(valid);

  useEffect(() => {
    if (lastValidity.current === valid) return;
    lastValidity.current = valid;
    onValidityChange(valid);
  }, [onValidityChange, valid]);

  const packageName = schemaState.packageName ?? '';

  let helper: string | null = null;
  if (schemaState.phase === 'checking') {
    helper = m['dashboard.providers.form.options_checking_package']({ packageName });
  } else if (schemaState.phase === 'installing') {
    helper = m['dashboard.providers.form.options_installing_trusted_package']({ packageName });
  } else if (schemaState.phase === 'install_deferred') {
    helper = m['dashboard.providers.form.options_install_package']();
  } else if (schemaState.phase === 'schema_unavailable') {
    helper = m['dashboard.providers.form.options_schema_unavailable']();
  } else if (schemaState.phase === 'install_error') {
    helper = m['dashboard.providers.form.options_install_failure']();
  } else if (schemaState.warnings.length > 0) {
    helper = m['dashboard.providers.form.options_schema_warning_summary']({ count: schemaState.warnings.length });
  }

  const hasSchemaError = validation.markers.some(({ severity }) => severity === 'error');
  let error: string | null = null;
  if (!validation.syntaxValid) error = m['dashboard.providers.form.options_json_error']({});
  else if (!rootValid) error = m['dashboard.providers.form.options_object_error']();
  else if (hasSchemaError || requiredRootMissing) error = m['dashboard.providers.form.options_schema_error']();
  else if (schemaState.phase === 'status_error' || schemaState.schemaResolution === 'error') {
    error = m['dashboard.providers.form.options_schema_load_error']();
  }
  const errorId = `${field.name}-error`;
  return (
    <Field data-invalid={!valid}>
      <Label htmlFor={field.name}>{m['dashboard.providers.form.label_options']()}</Label>
      <JsonEditor
        id={field.name}
        value={editorValue}
        {...(schemaState.schema === undefined ? {} : { schema: schemaState.schema })}
        externalInvalid={!rootValid || requiredRootMissing || schemaState.schemaResolution === 'error'}
        onValueChange={(value) => {
          setEditorValue(value);
          const nextRootValid = isProviderOptionsObject(value);
          if (nextRootValid) field.handleChange(value);
        }}
        onValidationChange={setValidation}
      />
      {helper !== null && <FieldDescription>{helper}</FieldDescription>}
      {canRequestProviderInstall(schemaState.phase) && (
        <Button
          type="button"
          variant="outline"
          disabled={!installRegistryValid}
          onClick={() => schemaState.requestInstall(installRegistry)}
        >
          {m['dashboard.providers.form.options_install_package']()}
        </Button>
      )}
      {error !== null && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
};
