import type { DashboardPluginEditView, DashboardProviderSummary } from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';
import { z } from 'zod';

import { formFieldVisible } from '@/lib/form-field-visible';

export interface PluginOptionsFormValues {
  readonly clearSecretKeys: readonly string[];
  readonly jsonValues: Readonly<Record<string, string>>;
  readonly publicValues: DashboardPluginEditView['publicValues'];
  readonly secretValues: Readonly<Record<string, string>>;
}

type PluginOptionsFormShape = Omit<PluginOptionsFormValues, 'publicValues'> & {
  readonly publicValues: Record<string, unknown>;
};

export type PluginOptionsForm = ReactFormExtendedApi<
  PluginOptionsFormShape,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

const JsonDraftsSchema = z.record(
  z.string(),
  z.string().refine((value) => {
    if (value === '') return true;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }),
);

export const pluginOptionsFormValues = (editView?: DashboardPluginEditView): PluginOptionsFormValues => ({
  clearSecretKeys: [],
  jsonValues: Object.fromEntries(
    (editView?.form ?? []).flatMap((field) => {
      if (field.type !== 'json') return [];
      const value = editView?.publicValues[field.key] ?? field.defaultValue;
      return value === undefined ? [] : [[field.key, JSON.stringify(value, null, 2)] as const];
    }),
  ),
  publicValues: { ...editView?.publicValues },
  secretValues: {},
});

export const usePluginOptionsForm = (onSubmit: (value: PluginOptionsFormValues) => void): PluginOptionsForm =>
  useForm({
    defaultValues: pluginOptionsFormValues(),
    validators: {
      onChange: ({ value }) => (JsonDraftsSchema.safeParse(value.jsonValues).success ? undefined : 'INVALID_JSON'),
    },
    onSubmit: ({ value }) => onSubmit(value as PluginOptionsFormValues),
  }) as unknown as PluginOptionsForm;

export const selectablePluginProvider = (
  provider: DashboardProviderSummary,
  protocols: readonly string[] | undefined,
): boolean =>
  provider.enabled &&
  provider.state.status === 'ready' &&
  (protocols === undefined ||
    provider.kind === 'ai-sdk' ||
    provider.protocols.some((protocol) => protocols.includes(protocol)));

export const pluginProviderOptionsValid = (
  fields: DashboardPluginEditView['form'],
  values: Readonly<Record<string, unknown>>,
  providers: readonly DashboardProviderSummary[],
): boolean => {
  const combined = {
    ...Object.fromEntries(
      fields.flatMap((field) => ('defaultValue' in field ? [[field.key, field.defaultValue]] : [])),
    ),
    ...values,
  };
  return fields.every((field) => {
    if (!formFieldVisible(field, combined)) return true;
    if (field.type === 'provider')
      return providers.some(
        (provider) => provider.id === combined[field.key] && selectablePluginProvider(provider, field.protocols),
      );
    if (field.type === 'provider-model') {
      const model = combined[field.key];
      if (typeof model !== 'string' || model.trim().length === 0) return false;
      const provider = providers.find((candidate) => candidate.id === combined[field.providerKey]);
      const models = provider?.clientModels ?? [];
      return models.length === 0 || models.includes(model);
    }
    return true;
  });
};
