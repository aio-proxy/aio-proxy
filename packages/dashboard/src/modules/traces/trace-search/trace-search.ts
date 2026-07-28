import type { DashboardTracePageSize, OtelSpanStatusCode, TraceTerminationReason } from '@aio-proxy/types';
import { endOfDay, startOfDay } from 'date-fns';

export type TraceSearch = {
  readonly page: number;
  readonly pageSize: DashboardTracePageSize;
  readonly startedAfter: string;
  readonly startedBefore: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly sessionSource?: string;
  readonly sessionId?: string;
  readonly otelStatusCode?: OtelSpanStatusCode;
  readonly terminationReason?: TraceTerminationReason;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
};

export type TraceFilterPatch = { [Key in keyof Omit<TraceSearch, 'page'>]?: TraceSearch[Key] | undefined };
type RawTraceSearch = Record<string, unknown> & Partial<Record<keyof TraceSearch, unknown>>;

const pageSizes = new Set([10, 20, 50, 100]);
const otelStatusCodes = new Set(['UNSET', 'OK', 'ERROR']);
const terminationReasons = new Set(['failure', 'cancelled', 'interrupted']);

export const createDefaultTraceSearch = (now = new Date()): TraceSearch => ({
  page: 1,
  pageSize: 50,
  startedAfter: startOfDay(now).toISOString(),
  startedBefore: endOfDay(now).toISOString(),
});

export const parseTraceSearch = (raw: RawTraceSearch, now = new Date()): TraceSearch => {
  const defaults = createDefaultTraceSearch(now);
  const startedAfter = isoString(raw.startedAfter);
  const startedBefore = isoString(raw.startedBefore);
  const page = integer(raw.page);
  const pageSize = integer(raw.pageSize);
  const finalHttpStatus = integer(raw.finalHttpStatus);
  const otelStatusCode = string(raw.otelStatusCode);
  const terminationReason = string(raw.terminationReason);
  if (
    (raw.startedAfter !== undefined && startedAfter === undefined) ||
    (raw.startedBefore !== undefined && startedBefore === undefined) ||
    (raw.page !== undefined && (page === undefined || page < 1)) ||
    (raw.pageSize !== undefined && (pageSize === undefined || !pageSizes.has(pageSize))) ||
    (raw.finalHttpStatus !== undefined &&
      (finalHttpStatus === undefined || finalHttpStatus < 100 || finalHttpStatus > 599)) ||
    (raw.otelStatusCode !== undefined && (otelStatusCode === undefined || !otelStatusCodes.has(otelStatusCode))) ||
    (raw.terminationReason !== undefined &&
      (terminationReason === undefined || !terminationReasons.has(terminationReason)))
  ) {
    return defaults;
  }

  return {
    page: page ?? defaults.page,
    pageSize: (pageSize ?? defaults.pageSize) as DashboardTracePageSize,
    startedAfter: startedAfter ?? defaults.startedAfter,
    startedBefore: startedBefore ?? defaults.startedBefore,
    ...optionalString('traceId', raw.traceId),
    ...optionalString('requestId', raw.requestId),
    ...optionalString('sessionSource', raw.sessionSource),
    ...optionalString('sessionId', raw.sessionId),
    ...(otelStatusCode === undefined ? {} : { otelStatusCode: otelStatusCode as OtelSpanStatusCode }),
    ...(terminationReason === undefined ? {} : { terminationReason: terminationReason as TraceTerminationReason }),
    ...optionalString('inboundProtocol', raw.inboundProtocol),
    ...optionalString('requestedModelId', raw.requestedModelId),
    ...optionalString('finalProviderId', raw.finalProviderId),
    ...optionalString('finalModelId', raw.finalModelId),
    ...(finalHttpStatus === undefined ? {} : { finalHttpStatus }),
  };
};

export const withTraceFilters = (search: TraceSearch, patch: TraceFilterPatch): TraceSearch => {
  const next = { ...search, ...patch, page: 1 } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
  return next as TraceSearch;
};

export const isWithinTraceRetention = (value: string, now = new Date()) => {
  const time = Date.parse(value);
  return !Number.isNaN(time) && time >= now.getTime() - 45 * 24 * 60 * 60 * 1_000;
};

const integer = (value: unknown) => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : undefined;
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
};

const string = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

const isoString = (value: unknown) => {
  const parsed = string(value);
  return parsed !== undefined && !Number.isNaN(Date.parse(parsed)) ? new Date(parsed).toISOString() : undefined;
};

const optionalString = <Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> => {
  const parsed = string(value);
  return parsed === undefined ? {} : ({ [key]: parsed } as Partial<Record<Key, string>>);
};
