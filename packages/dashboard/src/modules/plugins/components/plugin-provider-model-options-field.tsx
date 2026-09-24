import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField, DashboardProviderSummary } from '@aio-proxy/types';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import type { AnyFieldApi } from '@tanstack/react-form';

import { resolveDashboardText } from '@/lib/localized-text';

interface PluginProviderModelOptionsFieldProps {
  readonly field: Extract<DashboardOAuthFormField, { type: 'provider-model' }>;
  readonly providers: readonly DashboardProviderSummary[];
  readonly combined: Readonly<Record<string, unknown>>;
  readonly publicField: AnyFieldApi;
}

export const PluginProviderModelOptionsField: React.FC<PluginProviderModelOptionsFieldProps> = ({
  field,
  providers,
  combined,
  publicField,
}) => {
  const id = `plugin-option-${field.key}`;
  const current = publicField.state.value[field.key];
  const value = typeof current === 'string' ? current : '';
  const invalid = value.trim().length === 0;
  const models = providers.find((provider) => provider.id === combined[field.providerKey])?.clientModels ?? [];
  const descriptionId = field.description === undefined ? undefined : `${id}-description`;
  const errorId = invalid ? `${id}-error` : undefined;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{resolveDashboardText(field.label)}</FieldLabel>
      <Input
        id={id}
        value={value}
        list={`${id}-models`}
        aria-invalid={invalid}
        aria-describedby={[descriptionId, errorId].filter(Boolean).join(' ') || undefined}
        onChange={(event) => publicField.handleChange({ ...publicField.state.value, [field.key]: event.target.value })}
      />
      <datalist id={`${id}-models`}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {field.description === undefined ? null : (
        <FieldDescription id={descriptionId}>{resolveDashboardText(field.description)}</FieldDescription>
      )}
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {m['dashboard.plugins.model_required']()}
        </p>
      ) : null}
    </Field>
  );
};
