import type { SpanAttributesJson } from '../../schema/trace-span';

/**
 * Controlled attribute names that are projected into typed columns.
 * Hardcoded (no OTel SDK import in Task 2) to match the recorder's
 * `attributeName` map and the GenAI semantic-convention constants.
 */
const ATTR = {
  requestId: 'aio_proxy.request.id',
  operation: 'aio_proxy.operation',
  inboundProtocol: 'aio_proxy.protocol.inbound',
  sessionSource: 'aio_proxy.session.source',
  sessionId: 'aio_proxy.session.id',
  sessionResolvedBy: 'aio_proxy.session.resolved_by',
  finalProviderId: 'aio_proxy.route.final_provider_id',
  attemptIndex: 'aio_proxy.attempt.index',
  attemptModelId: 'aio_proxy.attempt.model_id',
  providerId: 'aio_proxy.provider.id',
  providerKind: 'aio_proxy.provider.kind',
  providerWeight: 'aio_proxy.provider.weight',
  transport: 'aio_proxy.transport',
  sourceProtocol: 'aio_proxy.protocol.source',
  targetProtocol: 'aio_proxy.protocol.target',
  selectionReason: 'aio_proxy.route.selection_reason',
  prepareMode: 'aio_proxy.prepare.mode',
  egressMode: 'aio_proxy.egress.mode',
  errorCode: 'aio_proxy.error.code',
  terminationReason: 'aio_proxy.termination.reason',
  genAiRequestModel: 'gen_ai.request.model',
  genAiResponseModel: 'gen_ai.response.model',
  genAiUsageInputTokens: 'gen_ai.usage.input_tokens',
  genAiUsageOutputTokens: 'gen_ai.usage.output_tokens',
  genAiUsageTotalTokens: 'gen_ai.usage.total_tokens',
  genAiUsageCacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
  genAiUsageCacheWriteTokens: 'gen_ai.usage.cache_write.input_tokens',
  genAiUsageReasoningTokens: 'gen_ai.usage.reasoning.output_tokens',
  errorType: 'error.type',
} as const;

/** Columns that receive projected values. `operation`/`prepareMode`/`egressMode` stay in JSON. */
export type ProjectedColumns = {
  requestId?: string;
  sessionSource?: string;
  sessionId?: string;
  sessionResolvedBy?: string;
  inboundProtocol?: string;
  requestedModelId?: string;
  finalProviderId?: string;
  finalModelId?: string;
  priceModelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  estimatedCostUsd?: number;
  attemptIndex?: number;
  providerId?: string;
  providerKind?: string;
  providerWeight?: number;
  modelId?: string;
  transport?: string;
  sourceProtocol?: string;
  targetProtocol?: string;
  selectionReason?: string;
  terminationReason?: string;
  errorType?: string;
  errorCode?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Split a span's full attribute object into typed-column values and the
 * remaining long-tail attributes that stay in `attributes_json`.
 *
 * `isRoot` controls whether `gen_ai.request.model` maps to `requestedModelId`;
 * on any other span it stays in `remaining` so the GenAI span keeps the key as
 * its own attribute. The `modelId` column now belongs to the attempt span's
 * candidate model (`aio_proxy.attempt.model_id`); rows written before that also
 * kept their non-root `gen_ai.request.model` there.
 */
export function projectAttributes(
  attributes: SpanAttributesJson,
  isRoot: boolean,
): { readonly columns: ProjectedColumns; readonly remaining: SpanAttributesJson } {
  const columns: ProjectedColumns = {};
  const remaining: SpanAttributesJson = {};
  const setStr = (key: keyof ProjectedColumns, value: unknown): void => {
    const str = asString(value);
    if (str !== undefined) (columns as Record<string, unknown>)[key] = str;
  };
  const setNum = (key: keyof ProjectedColumns, value: unknown): void => {
    const num = asNumber(value);
    if (num !== undefined) (columns as Record<string, unknown>)[key] = num;
  };

  for (const [key, value] of Object.entries(attributes)) {
    switch (key) {
      case ATTR.requestId:
        setStr('requestId', value);
        break;
      case ATTR.inboundProtocol:
        setStr('inboundProtocol', value);
        break;
      case ATTR.sessionSource:
        setStr('sessionSource', value);
        break;
      case ATTR.sessionId:
        setStr('sessionId', value);
        break;
      case ATTR.sessionResolvedBy:
        setStr('sessionResolvedBy', value);
        break;
      case ATTR.finalProviderId:
        setStr('finalProviderId', value);
        break;
      case ATTR.attemptIndex:
        setNum('attemptIndex', value);
        break;
      case ATTR.attemptModelId:
        setStr('modelId', value);
        break;
      case ATTR.providerId:
        setStr('providerId', value);
        break;
      case ATTR.providerKind:
        setStr('providerKind', value);
        break;
      case ATTR.providerWeight:
        setNum('providerWeight', value);
        break;
      case ATTR.transport:
        setStr('transport', value);
        break;
      case ATTR.sourceProtocol:
        setStr('sourceProtocol', value);
        break;
      case ATTR.targetProtocol:
        setStr('targetProtocol', value);
        break;
      case ATTR.selectionReason:
        setStr('selectionReason', value);
        break;
      case ATTR.errorCode:
        setStr('errorCode', value);
        break;
      case ATTR.terminationReason:
        setStr('terminationReason', value);
        break;
      case ATTR.genAiRequestModel:
        // 只有 root 需要它入列（喂 requestedModelId，旧数据兼容）。GenAI span 上
        // 这个 key 就是它自己的属性，原样留在 JSON 里。
        if (isRoot) {
          setStr('requestedModelId', value);
        } else {
          remaining[key] = value;
        }
        break;
      case ATTR.genAiResponseModel:
        setStr('finalModelId', value);
        break;
      case ATTR.genAiUsageInputTokens:
        setNum('inputTokens', value);
        break;
      case ATTR.genAiUsageOutputTokens:
        setNum('outputTokens', value);
        break;
      case ATTR.genAiUsageTotalTokens:
        setNum('totalTokens', value);
        break;
      case ATTR.genAiUsageCacheReadTokens:
        setNum('cacheReadTokens', value);
        break;
      case ATTR.genAiUsageCacheWriteTokens:
        setNum('cacheWriteTokens', value);
        break;
      case ATTR.genAiUsageReasoningTokens:
        setNum('reasoningTokens', value);
        break;
      case ATTR.errorType:
        setStr('errorType', value);
        break;
      default:
        remaining[key] = value;
        break;
    }
  }

  return { columns, remaining };
}

/**
 * Merge typed-column values back into the original attribute object under the
 * same OTel/aio_proxy names. Used on read so callers see the complete span.
 */
export function mergeAttributes(
  columns: ProjectedColumns,
  stored: SpanAttributesJson,
  isRoot: boolean,
): SpanAttributesJson {
  const merged: SpanAttributesJson = { ...stored };

  const set = (name: string, value: unknown) => {
    if (value !== undefined && value !== null) {
      merged[name] = value;
    }
  };

  set(ATTR.requestId, columns.requestId);
  set(ATTR.inboundProtocol, columns.inboundProtocol);
  set(ATTR.sessionSource, columns.sessionSource);
  set(ATTR.sessionId, columns.sessionId);
  set(ATTR.sessionResolvedBy, columns.sessionResolvedBy);
  set(ATTR.finalProviderId, columns.finalProviderId);
  set(ATTR.attemptIndex, columns.attemptIndex);
  set(ATTR.providerId, columns.providerId);
  set(ATTR.providerKind, columns.providerKind);
  set(ATTR.providerWeight, columns.providerWeight);
  set(ATTR.transport, columns.transport);
  set(ATTR.sourceProtocol, columns.sourceProtocol);
  set(ATTR.targetProtocol, columns.targetProtocol);
  set(ATTR.selectionReason, columns.selectionReason);
  set(ATTR.errorCode, columns.errorCode);
  set(ATTR.terminationReason, columns.terminationReason);
  // root 的 usage / model 列来自 summary，不是它自己的属性。挂回去会让 root 变成
  // 第二个「带 gen_ai.* 的 span」，Langfuse 那边一条 trace 就出现两个 GENERATION。
  if (!isRoot) {
    // attempt span 的候选模型。写路径是活的（attempt/emit/emit.ts 与 token-count/shared.ts
    // 发 aio_proxy.attempt.model_id，上面抽进 model_id 列）。同一列还装着老数据：任务 8
    // 之前非 root 的 gen_ai.request.model 也投在这里，那些行读回时会挂成新 key —— 都是
    // 「这一跳用的模型」，语义一致，不迁移数据。
    set(ATTR.attemptModelId, columns.modelId);
    // GenAI span（inference-span.ts）发 gen_ai.response.model，被抽进 final_model_id 列。
    // 老库里的 attempt 行也有：改名前 attempt span 发的就是这个 key。
    set(ATTR.genAiResponseModel, columns.finalModelId);
    // GENERATION span（`{operation} {model}`，routes/pipeline/inference-span.ts）的 token
    // usage 只能从这六列还原：它是非 root（CLIENT，挂在 root 下），settle 时发全部六个
    // gen_ai.usage.*，而上面的 projectAttributes 抽这六个 key 时没有 isRoot 判断（和
    // genAiRequestModel 不同），属性全被抽进列、attributes_json 里一个都不留。删掉这六行，
    // 每个 generation span 的 usage 读回来就是空的，仪表盘上的 token 静默消失。由
    // span-projection.test.ts 的 'a non-root GENERATION span still reports all six token
    // counts after a write/read cycle' 钉住 —— 那条测试走完整的写入/读回，六行少一行就红。
    set(ATTR.genAiUsageInputTokens, columns.inputTokens);
    set(ATTR.genAiUsageOutputTokens, columns.outputTokens);
    set(ATTR.genAiUsageTotalTokens, columns.totalTokens);
    set(ATTR.genAiUsageCacheReadTokens, columns.cacheReadTokens);
    set(ATTR.genAiUsageCacheWriteTokens, columns.cacheWriteTokens);
    set(ATTR.genAiUsageReasoningTokens, columns.reasoningTokens);
  }
  set(ATTR.errorType, columns.errorType);

  return merged;
}
