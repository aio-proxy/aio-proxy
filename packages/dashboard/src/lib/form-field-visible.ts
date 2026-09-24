import type { DashboardOAuthFormField } from '@aio-proxy/types';

export const formFieldVisible = (field: DashboardOAuthFormField, values: Readonly<Record<string, unknown>>): boolean =>
  field.when === undefined ||
  ('equals' in field.when
    ? values[field.when.key] === field.when.equals
    : values[field.when.key] !== field.when.notEquals);
