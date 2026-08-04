import type {
  DashboardPluginEditView,
  DashboardPluginOptionsMutationInput,
  DashboardPluginSummary,
} from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';
import type { InferRequestType } from 'hono/client';

import { createDashboardClient } from '@/lib/dashboard-client';

const pluginsClient = createDashboardClient().dashboard.api.plugins;

type PluginInstallInput = InferRequestType<typeof pluginsClient.install.$post>['json'];
type PluginErrorResponse = {
  readonly error: { readonly code: string; readonly providerIds?: readonly string[] };
  readonly ok: false;
};

export class PluginRequestError extends Error {
  override name = 'PluginRequestError';

  constructor(
    readonly code: string,
    readonly status: number,
    readonly providerIds: readonly string[] = [],
  ) {
    super(code);
  }
}

const throwPluginRequestError = async (response: {
  readonly json: () => Promise<unknown>;
  readonly status: number;
}): Promise<never> => {
  const result = (await response.json()) as PluginErrorResponse;
  throw new PluginRequestError(result.error.code, response.status, result.error.providerIds);
};

export const pluginsQueryKey = ['plugins'] as const;
export const pluginEditViewQueryKey = (packageName: string) => ['plugins', packageName, 'edit-view'] as const;

export const pluginsQueryOptions = () =>
  queryOptions({
    queryKey: pluginsQueryKey,
    queryFn: async (): Promise<{ plugins: readonly DashboardPluginSummary[] }> => {
      const response = await pluginsClient.$get();
      if (!response.ok) return throwPluginRequestError(response);
      return (await (response as unknown as Response).json()) as {
        plugins: readonly DashboardPluginSummary[];
      };
    },
  });

export const pluginEditViewQueryOptions = (packageName: string) =>
  queryOptions({
    queryKey: pluginEditViewQueryKey(packageName),
    queryFn: async (): Promise<DashboardPluginEditView> => {
      const response = await pluginsClient['edit-view'].$get({ query: { packageName } });
      if (!response.ok) return throwPluginRequestError(response);
      return (await (response as unknown as Response).json()) as DashboardPluginEditView;
    },
  });

export const installPluginMutationFn = async (
  input: PluginInstallInput,
): Promise<{ ok: true; packageName: string }> => {
  const response = await pluginsClient.install.$post({ json: input });
  if (!response.ok) return throwPluginRequestError(response);
  return response.json();
};

export const updatePluginOptionsMutationFn = async (
  input: DashboardPluginOptionsMutationInput,
): Promise<{ ok: true; plugin: DashboardPluginEditView }> => {
  const response = await pluginsClient.options.$put({ json: input });
  if (!response.ok) return throwPluginRequestError(response);
  return (await (response as unknown as Response).json()) as { ok: true; plugin: DashboardPluginEditView };
};

export const uninstallPluginMutationFn = async (packageName: string): Promise<{ ok: true; packageName: string }> => {
  const response = await pluginsClient.uninstall.$delete({ json: { packageName } });
  if (!response.ok) return throwPluginRequestError(response);
  return response.json();
};
