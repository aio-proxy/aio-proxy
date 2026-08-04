import { useMutation, useQueryClient } from '@tanstack/react-query';

import { providersQueryKey } from '@/modules/providers/services/providers-service';

import { settingsQueryKey, updateSettingsMutationFn } from '../../services/settings-service';

export const useSettingsMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateSettingsMutationFn,
    onSuccess: async (result, input) => {
      queryClient.setQueryData(settingsQueryKey, result.settings);
      await queryClient.invalidateQueries({ queryKey: settingsQueryKey });
      if (Object.hasOwn(input, 'proxy')) {
        await queryClient.invalidateQueries({ queryKey: providersQueryKey });
      }
    },
    onError: async () => {
      await queryClient.refetchQueries({ queryKey: settingsQueryKey });
    },
  });
};
