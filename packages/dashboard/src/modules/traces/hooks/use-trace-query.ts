import { useQuery } from '@tanstack/react-query';

import { traceQueryOptions } from '../services/traces-service';

export const useTraceQuery = (traceId: string) => useQuery(traceQueryOptions(traceId));
