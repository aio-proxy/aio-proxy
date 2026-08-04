import { useQuery } from '@tanstack/react-query';

import { type OverviewQueryInput, overviewQueryOptions } from '../services/overview-service';

export const useOverviewQuery = (input: OverviewQueryInput) => useQuery(overviewQueryOptions(input));
