import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField } from '@aio-proxy/types';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import type { AnyFieldApi } from '@tanstack/react-form';

import type { PluginOptionsForm } from '../hooks/use-plugin-options-form';

interface PluginSecretOptionsFieldProps {
  readonly description: string | undefined;
  readonly field: Extract<DashboardOAuthFormField, { type: 'secret' }>;
  readonly form: PluginOptionsForm;
  readonly label: string;
  readonly secretField: AnyFieldApi;
}

export const PluginSecretOptionsField: React.FC<PluginSecretOptionsFieldProps> = ({
  description,
  field,
  form,
  label,
  secretField,
}) => {
  const id = `plugin-option-${field.key}`;
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  const configuredId = field.configured ? `${id}-configured` : undefined;
  const describedBy = [descriptionId, configuredId].filter((value) => value !== undefined).join(' ') || undefined;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        aria-describedby={describedBy}
        value={secretField.state.value[field.key] ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          secretField.handleChange({ ...secretField.state.value, [field.key]: value });
          if (value !== '') {
            form.setFieldValue('clearSecretKeys', (keys) => keys.filter((key) => key !== field.key));
          }
        }}
      />
      {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      {field.configured ? (
        <>
          <FieldDescription id={configuredId}>{m['dashboard.plugins.secret_configured']()}</FieldDescription>
          <form.Field name="clearSecretKeys">
            {(clearField: AnyFieldApi) => (
              <FieldLabel>
                <Checkbox
                  checked={clearField.state.value.includes(field.key)}
                  onCheckedChange={(checked) => {
                    clearField.handleChange(
                      checked
                        ? [...clearField.state.value, field.key]
                        : clearField.state.value.filter((key: string) => key !== field.key),
                    );
                    if (checked) secretField.handleChange({ ...secretField.state.value, [field.key]: '' });
                  }}
                />
                {m['dashboard.plugins.clear_secret']({ field: label })}
              </FieldLabel>
            )}
          </form.Field>
        </>
      ) : null}
    </Field>
  );
};
