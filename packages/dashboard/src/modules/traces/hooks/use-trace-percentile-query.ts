import { useQuery } from '@tanstack/react-query';

import { tracePercentileQueryOptions } from '../services/traces-service';

/**
 * `enabled` 挂在调用链本身查到了没有上：traceId 不存在时这个端点也是 404，
 * 没必要陪着详情请求再打一次注定失败的聚合。
 */
export const useTracePercentileQuery = (traceId: string, enabled: boolean) =>
  useQuery({ ...tracePercentileQueryOptions(traceId), enabled });
