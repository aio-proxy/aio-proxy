import type { DashboardPluginEditView } from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';
import { z } from 'zod';

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
