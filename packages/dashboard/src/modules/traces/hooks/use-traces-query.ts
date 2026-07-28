import { useQuery } from '@tanstack/react-query';

import { tracesQueryOptions } from '../services/traces-service';
import type { TraceSearch } from '../trace-search';

export const useTracesQuery = (search: TraceSearch, autoRefresh: boolean) =>
  useQuery(tracesQueryOptions(search, autoRefresh));
