import { useQuery } from '@tanstack/react-query';

import { traceWireQueryOptions } from '../services/traces-service';

/**
 * `enabled` 由当前 tab 决定：只有切到请求/响应才去读日志文件。
 * 抓包要扫一整天的日志，绝大多数人停在详情 tab 上就走了，预加载纯属白扫。
 * `settled` 来自详情的 `endedAt`：还在跑就跟着刷，结束了才按历史日志缓存。
 */
export const useTraceWireQuery = (traceId: string, enabled: boolean, settled: boolean) =>
  useQuery({ ...traceWireQueryOptions(traceId, settled), enabled });
