import { useQuery } from '@tanstack/react-query';

import {
  type OverviewActivityQueryInput,
  type OverviewQueryInput,
  overviewActivityQueryOptions,
  overviewDiagnosticsQueryOptions,
  overviewQueryOptions,
} from '../services/overview-service';

export const useOverviewQuery = (input: OverviewQueryInput) => useQuery(overviewQueryOptions(input));
export const useOverviewDiagnosticsQuery = () => useQuery(overviewDiagnosticsQueryOptions());
export const useOverviewActivityQuery = (input: OverviewActivityQueryInput) =>
  useQuery(overviewActivityQueryOptions(input));
