import { useQuery } from '@tanstack/react-query';

import {
  type OverviewQueryInput,
  callerRankingQueryOptions,
  overviewActivityQueryOptions,
  overviewDiagnosticsQueryOptions,
  overviewQueryOptions,
} from '../services/overview-service';

export const useOverviewQuery = (input: OverviewQueryInput) => useQuery(overviewQueryOptions(input));
export const useOverviewDiagnosticsQuery = (input: OverviewQueryInput) =>
  useQuery(overviewDiagnosticsQueryOptions(input));
export const useOverviewActivityQuery = (callerId?: string) => useQuery(overviewActivityQueryOptions(callerId));

export const useCallerRankingQuery = (input: OverviewQueryInput) => useQuery(callerRankingQueryOptions(input));
