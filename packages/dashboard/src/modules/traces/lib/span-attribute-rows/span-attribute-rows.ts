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

// Only the attributes the list page can actually query, keyed by the `traceSearchSchema` field they
// filter on. Everything else gets no filter action rather than a link that silently matches nothing.
const filterBuilders: Readonly<Record<string, (value: string) => TraceFilterPatch | undefined>> = {
  [traceAttribute.providerId]: (value) => ({ finalProviderId: value }),
  [traceAttribute.finalProviderId]: (value) => ({ finalProviderId: value }),
  [traceAttribute.requestModel]: (value) => ({ requestedModelId: value }),
  [traceAttribute.responseModel]: (value) => ({ finalModelId: value }),
  [traceAttribute.httpStatusCode]: (value) =>
    /^[1-5]\d{2}$/u.test(value) ? { finalHttpStatus: Number(value) } : undefined,
  [traceAttribute.inboundProtocol]: (value) => ({ inboundProtocol: value }),
  [traceAttribute.sessionSource]: (value) => ({ sessionSource: value }),
  [traceAttribute.sessionId]: (value) => ({ sessionId: value }),
  [traceAttribute.requestId]: (value) => ({ requestId: value }),
};

const toFilter = (key: string, value: string): TraceFilterPatch | undefined =>
  value === '' ? undefined : filterBuilders[key]?.(value);

export const toSpanAttributeRows = (
  attributes: Readonly<Record<string, unknown>>,
  query: string,
): readonly SpanAttributeRow[] => {
  const needle = query.trim().toLowerCase();
  return Object.entries(attributes)
    .map(([key, rawValue]) => {
      const value = formatValue(rawValue);
      return { key, value, filter: toFilter(key, value) };
    })
    .filter(
      (row) => needle === '' || row.key.toLowerCase().includes(needle) || row.value.toLowerCase().includes(needle),
    )
    .sort((left, right) => left.key.localeCompare(right.key));
};
