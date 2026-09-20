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

const finalHttpStatusFilter = (value: string): TraceFilterPatch | undefined =>
  /^[1-5]\d{2}$/u.test(value) ? { finalHttpStatus: Number(value) } : undefined;

// 这两个键在 attempt span 上也有，但那里说的是「这一跳」，而列表页只能按整条调用链的最终
// 结果筛选。在一条失败的 attempt 上提供筛选，会跳到一个把用户来处那条链排除掉的结果集
// （200 的链里有一条 429 的 attempt）。`aio_proxy.provider.id` 是 attempt 专属、没有整链
// 含义，所以不映射到任何筛选。
//
// 能提供它们的不只有 root：任务 8 之后 root 上一个 gen_ai.* 都没有了，`gen_ai.response.model`
// 只在那条推理 span 上，而它说的正是「这条链最终用的模型」。少了它，新数据里没有任何 span
// 能点出「按最终模型筛选」—— 选推理 span 没有动作，选 root 连这一行都不存在。
const tracewideFilterBuilders: FilterBuilders = {
  [traceAttribute.responseModel]: (value) => ({ finalModelId: value }),
  [traceAttribute.httpStatusCode]: finalHttpStatusFilter,
  // 老 root span 的状态码挂在废弃的 key 上，少了这条就点不出「按最终状态码过滤」。
  [traceAttribute.legacyHttpStatusCode]: finalHttpStatusFilter,
};

const toFilter = (key: string, value: string, tracewide: boolean): TraceFilterPatch | undefined => {
  if (value === '') return undefined;
  const build = filterBuilders[key] ?? (tracewide ? tracewideFilterBuilders[key] : undefined);
  return build?.(value);
};

export const toSpanAttributeRows = (
  attributes: Readonly<Record<string, unknown>>,
  query: string,
  /** 这个 span 的值说的是整条调用链，而不是某一跳：root 和那条推理 span。 */
  tracewide: boolean,
): readonly SpanAttributeRow[] => {
  const needle = query.trim().toLowerCase();
  return Object.entries(attributes)
    .map(([key, rawValue]) => {
      const value = formatValue(rawValue);
      return { key, value, filter: toFilter(key, value, tracewide) };
    })
    .filter(
      (row) => needle === '' || row.key.toLowerCase().includes(needle) || row.value.toLowerCase().includes(needle),
    )
    .sort((left, right) => left.key.localeCompare(right.key));
};
