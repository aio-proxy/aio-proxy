import { useQuery } from '@tanstack/react-query';

import { releaseQueryOptions } from '../../services/release-service';

export const useReleaseQuery = () => useQuery(releaseQueryOptions());
