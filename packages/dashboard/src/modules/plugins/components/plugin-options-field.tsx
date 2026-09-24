import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField, DashboardProviderSummary } from '@aio-proxy/types';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import type { AnyFieldApi } from '@tanstack/react-form';

import { formFieldVisible } from '@/lib/form-field-visible';
import { isValidJson, optionValue } from '@/lib/json-form-value';
import { resolveDashboardText } from '@/lib/localized-text';

import type { PluginOptionsForm } from '../hooks/use-plugin-options-form';
import { PluginProviderModelOptionsField } from './plugin-provider-model-options-field';
import { PluginProviderOptionsField } from './plugin-provider-options-field';
import { PluginSecretOptionsField } from './plugin-secret-options-field';

interface PluginOptionsFieldProps {
  readonly fields: readonly DashboardOAuthFormField[];
  readonly providers: readonly DashboardProviderSummary[];
  readonly combined: Record<string, unknown>;
  readonly field: DashboardOAuthFormField;
  readonly form: PluginOptionsForm;
  readonly jsonField: AnyFieldApi;
  readonly publicField: AnyFieldApi;
  readonly secretField: AnyFieldApi;
}

const setPublicOptionValue = (publicField: AnyFieldApi, key: string, value: unknown) => {
  const next = { ...publicField.state.value };
  if (value === undefined) delete next[key];
  else next[key] = value;
  publicField.handleChange(next);
};

export const PluginOptionsField: React.FC<PluginOptionsFieldProps> = ({
  combined,
  fields,
  providers,
  field,
  form,
  jsonField,
  publicField,
  secretField,
}) => {
  if (!formFieldVisible(field, combined)) return null;
  const id = `plugin-option-${field.key}`;
  const label = resolveDashboardText(field.label);
  const description = field.description === undefined ? undefined : resolveDashboardText(field.description);
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  const current = publicField.state.value[field.key];
  const setPublic = (value: unknown) => setPublicOptionValue(publicField, field.key, value);

  if (field.type === 'provider') {
    return <PluginProviderOptionsField field={field} fields={fields} providers={providers} publicField={publicField} />;
  }
  if (field.type === 'provider-model') {
    return (
      <PluginProviderModelOptionsField
        field={field}
        providers={providers}
        combined={combined}
        publicField={publicField}
      />
    );
  }

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
    const selected = current === undefined ? field.defaultValue : current;
    const items = field.options.map((option) => ({
      label: resolveDashboardText(option.label),
      value: optionValue(option.value),
    }));
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Select
          items={items}
          value={selected === undefined ? '' : optionValue(selected as string | number | boolean)}
          onValueChange={(value) => setPublic(value === null ? undefined : JSON.parse(value))}
        >
          <SelectTrigger id={id} aria-describedby={descriptionId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
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

  const displayed = current === undefined && field.type === 'text' ? field.defaultValue : current;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-describedby={descriptionId}
        type={field.type === 'number' ? 'number' : 'text'}
        value={typeof displayed === 'string' || typeof displayed === 'number' ? displayed : ''}
        placeholder={field.placeholder === undefined ? undefined : resolveDashboardText(field.placeholder)}
        onChange={(event) => {
          let value: string | number | undefined = event.target.value;
          if (field.type === 'number') value = value === '' ? undefined : Number(value);
          setPublic(value);
        }}
      />
      {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
    </Field>
  );
};
