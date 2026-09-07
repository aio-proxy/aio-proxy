import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { checkLatestReleaseMutationFn, releaseQueryOptions } from './release-service';

export const useReleaseRefresh = () => {
  const queryClient = useQueryClient();
  const release = useQuery(releaseQueryOptions());
  useEffect(() => {
    void checkLatestReleaseMutationFn()
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.release }))
      .catch(() => {
        // Keep the last good GET /release payload.
      });
  }, [queryClient]);
  return release;
};
