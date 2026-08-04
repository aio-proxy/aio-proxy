import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField } from '@aio-proxy/types';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import type { AnyFieldApi } from '@tanstack/react-form';

import { resolveDashboardText } from '@/modules/providers/localized-text';

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
  const current = publicField.state.value[field.key];
  const setPublic = (value: unknown) => {
    const next = { ...publicField.state.value };
    if (value === undefined) delete next[field.key];
    else next[field.key] = value;
    publicField.handleChange(next);
  };

  if (field.type === 'secret') {
    return <PluginSecretOptionsField field={field} form={form} label={label} secretField={secretField} />;
  }

  if (field.type === 'boolean') {
    return (
      <Field orientation="horizontal">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Switch
          id={id}
          checked={Boolean(current ?? field.defaultValue)}
          onCheckedChange={(checked) => setPublic(Boolean(checked))}
        />
      </Field>
    );
  }

  if (field.type === 'select') {
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <Select
          value={current === undefined ? '' : optionValue(current as string | number | boolean)}
          onValueChange={(value) => setPublic(value === null ? undefined : JSON.parse(value))}
        >
          <SelectTrigger>
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
      </Field>
    );
  }

  if (field.type === 'json') {
    const value = jsonField.state.value[field.key] ?? (current === undefined ? '' : JSON.stringify(current, null, 2));
    const invalid = !isValidJson(value);
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Textarea
          id={id}
          aria-invalid={invalid}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            jsonField.handleChange({ ...jsonField.state.value, [field.key]: next });
            if (isValidJson(next)) setPublic(next === '' ? undefined : JSON.parse(next));
          }}
        />
        {invalid ? <p className="text-sm text-destructive">{m['dashboard.plugins.invalid_json']()}</p> : null}
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
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
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
};
