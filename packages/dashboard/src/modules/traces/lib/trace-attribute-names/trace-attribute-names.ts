// OTel attribute keys copied verbatim from `attributeName` in
// `packages/server/src/request-tracing/semantic.ts`. The dashboard cannot import it:
// `@aio-proxy/server` only exports its root entry.
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
  ttftMs: 'aio_proxy.response.ttft_ms',
  upstreamHeadersMs: 'aio_proxy.response.upstream_headers_ms',
  httpStatusCode: 'http.status_code',
} as const;
