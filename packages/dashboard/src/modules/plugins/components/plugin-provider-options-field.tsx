import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField, DashboardProviderSummary } from '@aio-proxy/types';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type { AnyFieldApi } from '@tanstack/react-form';

import { resolveDashboardText } from '@/lib/localized-text';

import { selectablePluginProvider } from '../hooks/use-plugin-options-form';

interface PluginProviderOptionsFieldProps {
  readonly field: Extract<DashboardOAuthFormField, { type: 'provider' }>;
  readonly fields: readonly DashboardOAuthFormField[];
  readonly providers: readonly DashboardProviderSummary[];
  readonly publicField: AnyFieldApi;
}

export const PluginProviderOptionsField: React.FC<PluginProviderOptionsFieldProps> = ({
  field,
  fields,
  providers,
  publicField,
}) => {
  const id = `plugin-option-${field.key}`;
  const current = publicField.state.value[field.key];
  const selected = typeof current === 'string' ? current : '';
  const selectable = providers.filter(selectablePluginProvider);
  const invalid = !selectable.some((provider) => provider.id === selected);
  const items = selectable.map((provider) => ({
    value: provider.id,
    label: `${provider.name ?? provider.id} (${provider.id})`,
  }));
  if (invalid && selected !== '') {
    const saved = providers.find((provider) => provider.id === selected);
    items.push({ value: selected, label: saved === undefined ? selected : `${saved.name ?? saved.id} (${saved.id})` });
  }
  const descriptionId = field.description === undefined ? undefined : `${id}-description`;
  const errorId = invalid ? `${id}-error` : undefined;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{resolveDashboardText(field.label)}</FieldLabel>
      <Select
        items={items}
        value={selected}
        onValueChange={(value) => {
          // Removing the stale saved item can emit null; this selector has no clear action.
          if (value === null || value === selected) return;
          const next = { ...publicField.state.value, [field.key]: value };
          const models = providers.find((provider) => provider.id === value)?.clientModels ?? [];
          for (const dependent of fields) {
            if (
              dependent.type === 'provider-model' &&
              dependent.providerKey === field.key &&
              !models.includes(next[dependent.key])
            ) {
              delete next[dependent.key];
            }
          }
          publicField.handleChange(next);
        }}
      >
        <SelectTrigger
          id={id}
          aria-invalid={invalid}
          aria-describedby={[descriptionId, errorId].filter(Boolean).join(' ') || undefined}
        >
          <SelectValue placeholder={m['dashboard.plugins.provider_placeholder']()} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} disabled={invalid && item.value === selected}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {field.description === undefined ? null : (
        <FieldDescription id={descriptionId}>{resolveDashboardText(field.description)}</FieldDescription>
      )}
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {m['dashboard.plugins.provider_invalid']()}
        </p>
      ) : null}
    </Field>
  );
};
