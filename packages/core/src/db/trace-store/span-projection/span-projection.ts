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
  providerId: 'aio_proxy.provider.id',
  providerKind: 'aio_proxy.provider.kind',
  providerWeight: 'aio_proxy.provider.weight',
  transport: 'aio_proxy.transport',
  sourceProtocol: 'aio_proxy.protocol.source',
  targetProtocol: 'aio_proxy.protocol.target',
  selectionReason: 'aio_proxy.route.selection_reason',
  routingContractVersion: 'aio_proxy.route.contract_version',
  effectivePriority: 'aio_proxy.route.effective_priority',
  effectiveWeight: 'aio_proxy.route.effective_weight',
  prioritySource: 'aio_proxy.route.priority_source',
  weightSource: 'aio_proxy.route.weight_source',
  selectionSource: 'aio_proxy.route.selection_source',
  prepareMode: 'aio_proxy.prepare.mode',
  egressMode: 'aio_proxy.egress.mode',
  errorCode: 'aio_proxy.error.code',
  terminationReason: 'aio_proxy.termination.reason',
  genAiRequestModel: 'gen_ai.request.model',
  genAiResponseModel: 'gen_ai.response.model',
  genAiUsageInputTokens: 'gen_ai.usage.input_tokens',
  genAiUsageOutputTokens: 'gen_ai.usage.output_tokens',
  genAiUsageTotalTokens: 'gen_ai.usage.total_tokens',
  genAiUsageCacheReadTokens: 'gen_ai.usage.cache_read_tokens',
  genAiUsageCacheWriteTokens: 'gen_ai.usage.cache_write_tokens',
  genAiUsageReasoningTokens: 'gen_ai.usage.reasoning_tokens',
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
  routingContractVersion?: number;
  effectivePriority?: number;
  effectiveWeight?: number;
  prioritySource?: string;
  weightSource?: string;
  selectionSource?: string;
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
 * `isRoot` controls whether `gen_ai.request.model` maps to `requestedModelId`
 * (root) or `modelId` (attempt).
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
      case ATTR.routingContractVersion:
        setNum('routingContractVersion', value);
        break;
      case ATTR.effectivePriority:
        setNum('effectivePriority', value);
        break;
      case ATTR.effectiveWeight:
        setNum('effectiveWeight', value);
        break;
      case ATTR.prioritySource:
        setStr('prioritySource', value);
        break;
      case ATTR.weightSource:
        setStr('weightSource', value);
        break;
      case ATTR.selectionSource:
        setStr('selectionSource', value);
        break;
      case ATTR.errorCode:
        setStr('errorCode', value);
        break;
      case ATTR.terminationReason:
        setStr('terminationReason', value);
        break;
      case ATTR.genAiRequestModel:
        if (isRoot) {
          setStr('requestedModelId', value);
        } else {
          setStr('modelId', value);
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
  set(ATTR.routingContractVersion, columns.routingContractVersion);
  set(ATTR.effectivePriority, columns.effectivePriority);
  set(ATTR.effectiveWeight, columns.effectiveWeight);
  set(ATTR.prioritySource, columns.prioritySource);
  set(ATTR.weightSource, columns.weightSource);
  set(ATTR.selectionSource, columns.selectionSource);
  set(ATTR.errorCode, columns.errorCode);
  set(ATTR.terminationReason, columns.terminationReason);
  set(ATTR.genAiRequestModel, isRoot ? columns.requestedModelId : columns.modelId);
  set(ATTR.genAiResponseModel, columns.finalModelId);
  set(ATTR.genAiUsageInputTokens, columns.inputTokens);
  set(ATTR.genAiUsageOutputTokens, columns.outputTokens);
  set(ATTR.genAiUsageTotalTokens, columns.totalTokens);
  set(ATTR.genAiUsageCacheReadTokens, columns.cacheReadTokens);
  set(ATTR.genAiUsageCacheWriteTokens, columns.cacheWriteTokens);
  set(ATTR.genAiUsageReasoningTokens, columns.reasoningTokens);
  set(ATTR.errorType, columns.errorType);

  return merged;
}
