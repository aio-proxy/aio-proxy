export const spanName = {
  request: 'aio_proxy.request',
  parse: 'aio_proxy.request.parse',
  session: 'aio_proxy.session.resolve',
  route: 'aio_proxy.route.resolve',
  attempt: 'aio_proxy.provider.attempt',
  prepare: 'aio_proxy.request.prepare',
  inference: 'gen_ai.client.inference',
  tokenCount: 'aio_proxy.token_count',
  egress: 'aio_proxy.response.egress',
  usage: 'aio_proxy.usage.resolve',
} as const;

export const eventName = {
  firstUpstreamResponse: 'aio_proxy.response.first_upstream',
  firstClientResponse: 'aio_proxy.response.first_client',
} as const;

// Stable GenAI/HTTP/error attribute names are hardcoded to match the core
// span-projection ATTR map exactly (packages/core/.../span-projection.ts).
// OTel's incubating constants are marked deprecated and its cache/reasoning
// suffixes differ from our projection, so we do not import them here.
export const attributeName = {
  requestId: 'aio_proxy.request.id',
  operation: 'aio_proxy.operation',
  stream: 'aio_proxy.request.stream',
  ttftMs: 'aio_proxy.response.ttft_ms',
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
  httpStatusCode: 'http.status_code',
} as const;

export const ALLOWED_ATTRIBUTES = new Set<string>(Object.values(attributeName));
