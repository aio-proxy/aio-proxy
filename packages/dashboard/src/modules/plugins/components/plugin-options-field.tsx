import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField } from '@aio-proxy/types';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import type { AnyFieldApi } from '@tanstack/react-form';

import { resolveDashboardText } from '@/lib/localized-text';

import type { PluginOptionsForm } from '../hooks/use-plugin-options-form';
import { PluginSecretOptionsField } from './plugin-secret-options-field';

interface PluginOptionsFieldProps {
  readonly combined: Record<string, unknown>;
  readonly field: DashboardOAuthFormField;
  readonly form: PluginOptionsForm;
  readonly jsonField: AnyFieldApi;
  readonly publicField: AnyFieldApi;
  readonly secretField: AnyFieldApi;
}

const optionValue = (value: string | number | boolean) => JSON.stringify(value);
const isValidJson = (value: string) => {
  if (value === '') return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

const setPublicOptionValue = (publicField: AnyFieldApi, key: string, value: unknown) => {
  const next = { ...publicField.state.value };
  if (value === undefined) delete next[key];
  else next[key] = value;
  publicField.handleChange(next);
};

export const PluginOptionsField: React.FC<PluginOptionsFieldProps> = ({
  combined,
  field,
  form,
  jsonField,
  publicField,
  secretField,
}) => {
  if (field.when !== undefined && combined[field.when.key] !== field.when.equals) return null;
  const id = `plugin-option-${field.key}`;
  const label = resolveDashboardText(field.label);
  const description = field.description === undefined ? undefined : resolveDashboardText(field.description);
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  const current = publicField.state.value[field.key];
  const setPublic = (value: unknown) => setPublicOptionValue(publicField, field.key, value);

  if (field.type === 'secret') {
    return (
      <PluginSecretOptionsField
        description={description}
        field={field}
        form={form}
        label={label}
        secretField={secretField}
      />
    );
  }

  if (field.type === 'boolean') {
    return (
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
        </FieldContent>
        <Switch
          id={id}
          aria-describedby={descriptionId}
          checked={Boolean(current ?? field.defaultValue)}
          onCheckedChange={(checked) => setPublic(Boolean(checked))}
        />
      </Field>
    );
  }

  if (field.type === 'select') {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Select
          value={current === undefined ? '' : optionValue(current as string | number | boolean)}
          onValueChange={(value) => setPublic(value === null ? undefined : JSON.parse(value))}
        >
          <SelectTrigger id={id} aria-describedby={descriptionId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={optionValue(option.value)} value={optionValue(option.value)}>
                {resolveDashboardText(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      </Field>
    );
  }

  if (field.type === 'json') {
    const value = jsonField.state.value[field.key] ?? (current === undefined ? '' : JSON.stringify(current, null, 2));
    const invalid = !isValidJson(value);
    const invalidId = invalid ? `${id}-error` : undefined;
    const describedBy = [descriptionId, invalidId].filter((value) => value !== undefined).join(' ') || undefined;
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            jsonField.handleChange({ ...jsonField.state.value, [field.key]: next });
            if (isValidJson(next)) setPublic(next === '' ? undefined : JSON.parse(next));
          }}
        />
        {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
        {invalid ? (
          <p id={invalidId} role="alert" className="text-sm text-destructive">
            {m['dashboard.plugins.invalid_json']()}
          </p>
        ) : null}
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-describedby={descriptionId}
        type={field.type === 'number' ? 'number' : 'text'}
        value={typeof current === 'string' || typeof current === 'number' ? current : ''}
        placeholder={field.placeholder === undefined ? undefined : resolveDashboardText(field.placeholder)}
        onChange={(event) =>
          setPublic(
            field.type === 'number'
              ? event.target.value === ''
                ? undefined
                : Number(event.target.value)
              : event.target.value,
          )
        }
      />
      {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
    </Field>
  );
};
