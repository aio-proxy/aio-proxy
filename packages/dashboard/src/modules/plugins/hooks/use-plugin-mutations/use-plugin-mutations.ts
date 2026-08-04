import { useMutation, useQueryClient } from '@tanstack/react-query';

import { providersQueryKey } from '@/modules/providers/services/providers-service';

import {
  installPluginMutationFn,
  pluginEditViewQueryKey,
  pluginsQueryKey,
  uninstallPluginMutationFn,
  updatePluginOptionsMutationFn,
} from '../../services/plugins-service';

const invalidateControlPlane = async (queryClient: ReturnType<typeof useQueryClient>) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: pluginsQueryKey }),
    queryClient.invalidateQueries({ queryKey: providersQueryKey }),
  ]);
};

export const usePluginInstallMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: installPluginMutationFn,
    onSuccess: () => invalidateControlPlane(queryClient),
  });
};

export const usePluginOptionsMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updatePluginOptionsMutationFn,
    onSuccess: async (result) => {
      queryClient.setQueryData(pluginEditViewQueryKey(result.plugin.packageName), result.plugin);
      await invalidateControlPlane(queryClient);
    },
  });
};

export const usePluginUninstallMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uninstallPluginMutationFn,
    onSuccess: () => invalidateControlPlane(queryClient),
  });
};
