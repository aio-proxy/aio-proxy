import { usageLocalDate } from '@aio-proxy/core/db';
import { DesktopLiveV1Schema } from '@aio-proxy/types';
import { Hono } from 'hono';

import type { ServerState } from '../../server-state';
import { requireDesktopToken } from '../desktop-summary';

const TODAY_USAGE_CACHE_MS = 5_000;

export const createDesktopLiveRoute = (
  state: Pick<ServerState, 'desktopToken' | 'liveMetrics' | 'traceStore'>,
  options?: { now?: () => Date },
) => {
  const now = options?.now ?? (() => new Date());
  let previousTime: number | undefined;
  let cached:
    | {
        date: string;
        time: number;
        usage: ReturnType<ServerState['traceStore']['todayUsage']>;
      }
    | undefined;

  return new Hono().get(
    '/',
    requireDesktopToken(() => state.desktopToken),
    (context) => {
      const current = now();
      const time = current.getTime();
      const date = usageLocalDate(current);
      if (
        cached === undefined ||
        cached.date !== date ||
        time - cached.time >= TODAY_USAGE_CACHE_MS ||
        (previousTime !== undefined && time < previousTime)
      ) {
        cached = { date, time, usage: state.traceStore.todayUsage(current) };
      }
      previousTime = time;
      const live = state.liveMetrics.snapshot();
      return context.json(
        DesktopLiveV1Schema.parse({
          version: 1,
          todayTokens: String(cached.usage.inputTokens + cached.usage.outputTokens),
          todayCostNanoUsd: String(cached.usage.estimatedCostNanoUsd),
          inFlight: live.inFlight,
          outputTokensPerSecond: Math.round(live.outputTokensPerSecond * 10) / 10,
        }),
      );
    },
  );
};
