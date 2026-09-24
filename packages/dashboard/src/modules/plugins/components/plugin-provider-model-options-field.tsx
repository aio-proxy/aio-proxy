import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField, DashboardProviderSummary } from '@aio-proxy/types';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
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
  const models = providers.find((provider) => provider.id === combined[field.providerKey])?.clientModels ?? [];
  const known = models.length > 0;
  const invalid = known ? !models.includes(value) : value.trim().length === 0;
  const descriptionId = field.description === undefined ? undefined : `${id}-description`;
  const errorId = invalid ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  const setModel = (next: string | null) => {
    if (next === null) return;
    publicField.handleChange({ ...publicField.state.value, [field.key]: next });
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{resolveDashboardText(field.label)}</FieldLabel>
      {known ? (
        <Select items={models.map((model) => ({ value: model, label: model }))} value={value} onValueChange={setModel}>
          <SelectTrigger id={id} aria-invalid={invalid} aria-describedby={describedBy}>
            <SelectValue placeholder={m['dashboard.plugins.model_placeholder']()} />
          </SelectTrigger>
          <SelectContent>
            {value !== '' && !models.includes(value) ? (
              <SelectItem value={value} disabled>
                {value}
              </SelectItem>
            ) : null}
            {models.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => setModel(event.target.value)}
        />
      )}
      {field.description === undefined ? null : (
        <FieldDescription id={descriptionId}>{resolveDashboardText(field.description)}</FieldDescription>
      )}
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {known ? m['dashboard.plugins.model_invalid']() : m['dashboard.plugins.model_required']()}
        </p>
      ) : null}
    </Field>
  );
};
