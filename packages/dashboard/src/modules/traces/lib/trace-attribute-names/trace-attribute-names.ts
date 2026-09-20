// OTel names copied verbatim from `spanName` in
// `packages/server/src/request-tracing/semantic/semantic.ts`. The dashboard cannot import it:
// `@aio-proxy/server` only exports its root entry.
export const traceSpanName = {
  attempt: 'aio_proxy.provider.attempt',
} as const;

// OTel attribute keys copied verbatim from `attributeName` in the same module.
export const traceAttribute = {
  attemptIndex: 'aio_proxy.attempt.index',
  requestId: 'aio_proxy.request.id',
  inboundProtocol: 'aio_proxy.protocol.inbound',
  sessionSource: 'aio_proxy.session.source',
  sessionId: 'aio_proxy.session.id',
  providerId: 'aio_proxy.provider.id',
  finalProviderId: 'aio_proxy.route.final_provider_id',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  attemptModelId: 'aio_proxy.attempt.model_id',
  attemptTtftMs: 'aio_proxy.attempt.ttft_ms',
  // 请求级 TTFT，root span 今天仍然用这个 key —— 不只是 attempt 的兜底。
  ttftMs: 'aio_proxy.response.ttft_ms',
  genAiTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  transportObservation: 'aio_proxy.response.transport_observation',
  upstreamHeadersMs: 'aio_proxy.response.upstream_headers_ms',
  httpStatusCode: 'http.response.status_code',
  // `http.status_code` 2023 年就废弃了，但库里现存的 span 全是它写的，不迁移数据。
  // 每个读状态码的地方都必须带上这条兜底，否则历史 trace 的 4xx/5xx 静默消失。
  legacyHttpStatusCode: 'http.status_code',
} as const;
