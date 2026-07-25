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
  readonly requestId?: string;
  readonly sessionSource?: string;
  readonly sessionId?: string;
  readonly sessionResolvedBy?: string;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly priceModelId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly providerKind?: string;
  readonly providerWeight?: number;
  readonly modelId?: string;
  readonly transport?: string;
  readonly sourceProtocol?: string;
  readonly targetProtocol?: string;
  readonly selectionReason?: string;
  readonly terminationReason?: string;
  readonly errorType?: string;
  readonly errorCode?: string;
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

  for (const [key, value] of Object.entries(attributes)) {
    switch (key) {
      case ATTR.requestId:
        columns.requestId = asString(value);
        break;
      case ATTR.inboundProtocol:
        columns.inboundProtocol = asString(value);
        break;
      case ATTR.sessionSource:
        columns.sessionSource = asString(value);
        break;
      case ATTR.sessionId:
        columns.sessionId = asString(value);
        break;
      case ATTR.sessionResolvedBy:
        columns.sessionResolvedBy = asString(value);
        break;
      case ATTR.finalProviderId:
        columns.finalProviderId = asString(value);
        break;
      case ATTR.attemptIndex:
        columns.attemptIndex = asNumber(value);
        break;
      case ATTR.providerId:
        columns.providerId = asString(value);
        break;
      case ATTR.providerKind:
        columns.providerKind = asString(value);
        break;
      case ATTR.providerWeight:
        columns.providerWeight = asNumber(value);
        break;
      case ATTR.transport:
        columns.transport = asString(value);
        break;
      case ATTR.sourceProtocol:
        columns.sourceProtocol = asString(value);
        break;
      case ATTR.targetProtocol:
        columns.targetProtocol = asString(value);
        break;
      case ATTR.selectionReason:
        columns.selectionReason = asString(value);
        break;
      case ATTR.errorCode:
        columns.errorCode = asString(value);
        break;
      case ATTR.terminationReason:
        columns.terminationReason = asString(value);
        break;
      case ATTR.genAiRequestModel:
        if (isRoot) {
          columns.requestedModelId = asString(value);
        } else {
          columns.modelId = asString(value);
        }
        break;
      case ATTR.genAiResponseModel:
        columns.finalModelId = asString(value);
        break;
      case ATTR.genAiUsageInputTokens:
        columns.inputTokens = asNumber(value);
        break;
      case ATTR.genAiUsageOutputTokens:
        columns.outputTokens = asNumber(value);
        break;
      case ATTR.genAiUsageTotalTokens:
        columns.totalTokens = asNumber(value);
        break;
      case ATTR.genAiUsageCacheReadTokens:
        columns.cacheReadTokens = asNumber(value);
        break;
      case ATTR.genAiUsageCacheWriteTokens:
        columns.cacheWriteTokens = asNumber(value);
        break;
      case ATTR.genAiUsageReasoningTokens:
        columns.reasoningTokens = asNumber(value);
        break;
      case ATTR.errorType:
        columns.errorType = asString(value);
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
