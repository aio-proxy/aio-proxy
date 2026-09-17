import { useQuery } from '@tanstack/react-query';

import { tracePercentileQueryOptions } from '../services/traces-service';

export const useTracePercentileQuery = (traceId: string) => useQuery(tracePercentileQueryOptions(traceId));
