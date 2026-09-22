import type { DashboardTraceSpan } from '@aio-proxy/types';

// OTel names copied verbatim from `spanName` in
// `packages/server/src/request-tracing/semantic/semantic.ts`. The dashboard cannot import it:
// `@aio-proxy/server` only exports its root entry.
export const traceSpanName = {
  // 逻辑操作层，一次请求一条，覆盖路由解析与全部失败转移。
  inference: 'aio_proxy.inference',
  // token-count 路径的尝试仍是这个固定名。**生成路径的不是** —— 见 isAttemptSpan。
  attempt: 'aio_proxy.provider.attempt',
  candidateSkipped: 'aio_proxy.token_count.candidate_skipped',
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
  inferenceTtftMs: 'aio_proxy.inference.ttft_ms',
  // 历史请求级 TTFT；新 trace 写在逻辑 inference span。
  ttftMs: 'aio_proxy.response.ttft_ms',
  genAiTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  transportObservation: 'aio_proxy.upstream.transport_observation',
  legacyTransportObservation: 'aio_proxy.response.transport_observation',
  upstreamHeadersMs: 'aio_proxy.upstream.headers_ms',
  legacyUpstreamHeadersMs: 'aio_proxy.response.upstream_headers_ms',
  httpStatusCode: 'http.response.status_code',
  // `http.status_code` 2023 年就废弃了，但库里现存的 span 全是它写的，不迁移数据。
  // 每个读状态码的地方都必须带上这条兜底，否则历史 trace 的 4xx/5xx 静默消失。
  legacyHttpStatusCode: 'http.status_code',
} as const;

// 生成路径的 provider 尝试 span 名是运行时拼的 `{operation} {model}`（`chat gpt-5` 等），
// 所以**不能按名字认**。`aio_proxy.attempt.index` 可以：它只存在于代表一次 provider 尝试的
// span 上，生成路径与 token-count 路径都写。
//
// 唯一的例外是 token-count 的「跳过的候选」span —— 它也带 index，但它是被略过的候选而不是
// 一次尝试，靠名字排掉。
export const isAttemptSpan = (span: DashboardTraceSpan): boolean =>
  span.attributes[traceAttribute.attemptIndex] !== undefined && span.name !== traceSpanName.candidateSkipped;
