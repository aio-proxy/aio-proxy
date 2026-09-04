import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { updateSettingsMutationFn } from '../../services/settings-service';

export const useSettingsMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateSettingsMutationFn,
    onSuccess: async (result, input) => {
      queryClient.setQueryData(queryKeys.settings, result.settings);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      if (Object.hasOwn(input, 'proxy')) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      }
      // Setting or clearing the password flips dashboard authentication on or off, so the
      // cached session status (and the logout control it drives) is stale until refetched.
      if (Object.hasOwn(input, 'password')) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.auth });
      }
    },
    onError: async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.settings });
    },
  });
};
