import { useQuery } from '@tanstack/react-query';

import type { TraceSearch } from '../lib/trace-search';
import { traceSummaryQueryOptions } from '../services/traces-service';

export const useTraceSummaryQuery = (search: TraceSearch, autoRefresh: boolean) =>
  useQuery(traceSummaryQueryOptions(search, autoRefresh));
