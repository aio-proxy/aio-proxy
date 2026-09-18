import { traceAttribute } from '../trace-attribute-names';
import type { TraceFilterPatch } from '../trace-search';

export interface SpanAttributeRow {
  readonly key: string;
  readonly value: string;
  readonly filter: TraceFilterPatch | undefined;
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).join(', ');
  return JSON.stringify(value) ?? String(value);
};

type FilterBuilders = Readonly<Record<string, (value: string) => TraceFilterPatch | undefined>>;

// Only the attributes the list page can actually query, keyed by the `traceSearchSchema` field they
// filter on. Everything else gets no filter action rather than a link that silently matches nothing.
// These keys are written by the root span alone, so their value already describes the whole trace.
const filterBuilders: FilterBuilders = {
  [traceAttribute.finalProviderId]: (value) => ({ finalProviderId: value }),
  [traceAttribute.requestModel]: (value) => ({ requestedModelId: value }),
  [traceAttribute.inboundProtocol]: (value) => ({ inboundProtocol: value }),
  [traceAttribute.sessionSource]: (value) => ({ sessionSource: value }),
  [traceAttribute.sessionId]: (value) => ({ sessionId: value }),
  [traceAttribute.requestId]: (value) => ({ requestId: value }),
};

// Attempt spans write these two as well, but there they mean "this hop", while the list page can
// only filter on the trace's final result. Offering the filter on a failed attempt would jump to a
// result set that excludes the very trace the user came from (429 attempt inside a 200 trace).
// `aio_proxy.provider.id` is attempt-only and has no whole-trace meaning at all, so it maps nowhere.
const rootOnlyFilterBuilders: FilterBuilders = {
  [traceAttribute.responseModel]: (value) => ({ finalModelId: value }),
  [traceAttribute.httpStatusCode]: (value) =>
    /^[1-5]\d{2}$/u.test(value) ? { finalHttpStatus: Number(value) } : undefined,
};

const toFilter = (key: string, value: string, isRoot: boolean): TraceFilterPatch | undefined => {
  if (value === '') return undefined;
  const build = filterBuilders[key] ?? (isRoot ? rootOnlyFilterBuilders[key] : undefined);
  return build?.(value);
};

export const toSpanAttributeRows = (
  attributes: Readonly<Record<string, unknown>>,
  query: string,
  isRoot: boolean,
): readonly SpanAttributeRow[] => {
  const needle = query.trim().toLowerCase();
  return Object.entries(attributes)
    .map(([key, rawValue]) => {
      const value = formatValue(rawValue);
      return { key, value, filter: toFilter(key, value, isRoot) };
    })
    .filter(
      (row) => needle === '' || row.key.toLowerCase().includes(needle) || row.value.toLowerCase().includes(needle),
    )
    .sort((left, right) => left.key.localeCompare(right.key));
};
