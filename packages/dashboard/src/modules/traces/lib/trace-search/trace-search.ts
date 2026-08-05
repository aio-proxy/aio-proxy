import type { DashboardTracePageSize } from '@aio-proxy/types';
import { endOfDay, startOfDay } from 'date-fns';
import { z } from 'zod';

const pageSize = z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]);
const optionalString = z.string().trim().min(1).optional().catch(undefined);
const traceId = z
  .string()
  .regex(/^[0-9a-f]{32}$/u)
  .optional()
  .catch(undefined);

export const traceSearchSchema = z.object({
  pageSize: z.coerce.number().pipe(pageSize).catch(50),
  pageToken: optionalString,
  startedAfter: z.iso.datetime({ offset: true }).optional().catch(undefined),
  startedBefore: z.iso.datetime({ offset: true }).optional().catch(undefined),
  traceId,
  requestId: optionalString,
  sessionSource: optionalString,
  sessionId: optionalString,
  otelStatusCode: z.enum(['UNSET', 'OK', 'ERROR']).optional().catch(undefined),
  terminationReason: z.enum(['failure', 'cancelled', 'interrupted']).optional().catch(undefined),
  inboundProtocol: optionalString,
  requestedModelId: optionalString,
  finalProviderId: optionalString,
  finalModelId: optionalString,
  finalHttpStatus: z.coerce.number().int().min(100).max(599).optional().catch(undefined),
});

export type TraceUrlSearch = z.infer<typeof traceSearchSchema>;
export type TraceSearch = Omit<TraceUrlSearch, 'startedAfter' | 'startedBefore'> & {
  readonly startedAfter: string;
  readonly startedBefore: string;
};

export type TraceFilterPatch = { [Key in keyof Omit<TraceSearch, 'pageToken'>]?: TraceSearch[Key] | undefined };

export const createDefaultTraceSearch = (now = new Date()): TraceSearch => ({
  pageSize: 50,
  startedAfter: startOfDay(now).toISOString(),
  startedBefore: endOfDay(now).toISOString(),
});

export const resolveTraceSearch = (search: TraceUrlSearch, now = new Date()): TraceSearch => {
  const defaults = createDefaultTraceSearch(now);
  return {
    ...search,
    pageSize: search.pageSize as DashboardTracePageSize,
    startedAfter: search.startedAfter ?? defaults.startedAfter,
    startedBefore: search.startedBefore ?? defaults.startedBefore,
  };
};

export const toTraceUrlSearch = (search: TraceSearch): TraceUrlSearch => search;

export const withTraceFilters = (search: TraceSearch, patch: TraceFilterPatch): TraceSearch => {
  const next = { ...search, ...patch } as Record<string, unknown>;
  delete next['pageToken'];
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
  return next as TraceSearch;
};
