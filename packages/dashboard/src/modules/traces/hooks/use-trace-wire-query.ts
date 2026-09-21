import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { traceWireQueryOptions } from '../services/traces-service';

/**
 * `enabled` 由当前 tab 决定：只有切到请求/响应才去读日志文件。
 * 抓包要扫一整天的日志，绝大多数人停在详情 tab 上就走了，预加载纯属白扫。
 * `settled` 来自详情的 `endedAt`：还在跑就跟着刷。刚结算再失效一次，
 * 抓包轮询可能比详情慢一拍；若 hop 上还有未终态的 body，query 自己继续扫。
 */
export const useTraceWireQuery = (traceId: string, enabled: boolean, settled: boolean) => {
  const queryClient = useQueryClient();
  const query = useQuery({ ...traceWireQueryOptions(traceId, settled), enabled });
  const wasSettled = useRef(settled);
  useEffect(() => {
    if (!wasSettled.current && settled) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.traceWire(traceId) });
    }
    wasSettled.current = settled;
  }, [settled, queryClient, traceId]);
  return query;
};
