import { useQuery } from '@tanstack/react-query';

import { releaseQueryOptions } from './release-service';

export const useReleaseQuery = () => useQuery(releaseQueryOptions());
