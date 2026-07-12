import type { DashboardRequestLogsPageSize, RequestOutcome } from "@aio-proxy/types";

export type LogsSearch = {
  readonly page: number;
  readonly pageSize: DashboardRequestLogsPageSize;
  readonly startedAfter: string;
  readonly completedBefore: string;
  readonly requestId?: string;
  readonly outcome?: RequestOutcome;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
};

type LogsFilterPatch = { [Key in keyof Omit<LogsSearch, "page">]?: LogsSearch[Key] | undefined };
type RawLogsSearch = Record<string, unknown> & Partial<Record<keyof LogsSearch, unknown>>;

const pageSizes = new Set([10, 20, 50, 100]);
const outcomes = new Set(["success", "failure", "cancelled"]);

export function createDefaultLogsSearch(now = new Date()): LogsSearch {
  return {
    page: 1,
    pageSize: 50,
    startedAfter: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    completedBefore: now.toISOString(),
  };
}

export function parseLogsSearch(raw: RawLogsSearch, now = new Date()): LogsSearch {
  const defaults = createDefaultLogsSearch(now);
  const startedAfter = isoString(raw.startedAfter);
  const completedBefore = isoString(raw.completedBefore);
  if (
    (raw.startedAfter !== undefined && startedAfter === undefined) ||
    (raw.completedBefore !== undefined && completedBefore === undefined)
  ) {
    return defaults;
  }

  const page = integer(raw.page);
  const pageSize = integer(raw.pageSize);
  const finalStatusCode = integer(raw.finalStatusCode);
  const outcome = string(raw.outcome);
  if (
    (raw.page !== undefined && (page === undefined || page < 1)) ||
    (raw.pageSize !== undefined && (pageSize === undefined || !pageSizes.has(pageSize))) ||
    (raw.finalStatusCode !== undefined &&
      (finalStatusCode === undefined || finalStatusCode < 100 || finalStatusCode > 599)) ||
    (raw.outcome !== undefined && (outcome === undefined || !outcomes.has(outcome)))
  ) {
    return defaults;
  }

  return {
    page: page ?? defaults.page,
    pageSize: (pageSize ?? defaults.pageSize) as DashboardRequestLogsPageSize,
    startedAfter: startedAfter ?? defaults.startedAfter,
    completedBefore: completedBefore ?? defaults.completedBefore,
    ...optionalString("requestId", raw.requestId),
    ...(outcome === undefined ? {} : { outcome: outcome as RequestOutcome }),
    ...optionalString("inboundProtocol", raw.inboundProtocol),
    ...optionalString("requestedModelId", raw.requestedModelId),
    ...optionalString("finalProviderId", raw.finalProviderId),
    ...optionalString("finalModelId", raw.finalModelId),
    ...(finalStatusCode === undefined ? {} : { finalStatusCode }),
  };
}

export function withLogsFilters(search: LogsSearch, patch: LogsFilterPatch): LogsSearch {
  const next = { ...search, ...patch, page: 1 } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
  return next as LogsSearch;
}

const integer = (value: unknown) => {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : undefined;
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
};

const string = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

const isoString = (value: unknown) => {
  const parsed = string(value);
  return parsed !== undefined && !Number.isNaN(Date.parse(parsed)) ? new Date(parsed).toISOString() : undefined;
};

const optionalString = <Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> => {
  const parsed = string(value);
  return parsed === undefined ? {} : ({ [key]: parsed } as Partial<Record<Key, string>>);
};
