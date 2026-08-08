import { useQuery } from '@tanstack/react-query';

import type { TraceSearch } from '../lib/trace-search';
import { tracesQueryOptions } from '../services/traces-service';

export const useTracesQuery = (search: TraceSearch, autoRefresh: boolean) =>
  useQuery(tracesQueryOptions(search, autoRefresh));
