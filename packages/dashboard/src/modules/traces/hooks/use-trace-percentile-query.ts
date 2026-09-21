import { useQuery } from '@tanstack/react-query';

import { tracePercentileQueryOptions } from '../services/traces-service';

/**
 * `enabled` 只在调用链已经结束时打开。还在跑的时候分位端点只会给 null，
 * 而第一次成功之后 `isSuccess` 不再变，那份空结果会一直占着缓存。
 */
export const useTracePercentileQuery = (traceId: string, enabled: boolean) =>
  useQuery({ ...tracePercentileQueryOptions(traceId), enabled });
