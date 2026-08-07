import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import {
  installPluginMutationFn,
  uninstallPluginMutationFn,
  updatePluginOptionsMutationFn,
} from '../../services/plugins-service';

const invalidateControlPlane = async (queryClient: ReturnType<typeof useQueryClient>) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins }),
    queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
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
      queryClient.setQueryData(queryKeys.pluginEditView(result.plugin.packageName), result.plugin);
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
