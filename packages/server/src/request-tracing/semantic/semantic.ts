import type { DashboardTraceDiagnostics } from '@aio-proxy/types';
import { SpanKind } from '@opentelemetry/api';

export const spanName = {
  request: 'aio_proxy.request',
  parse: 'aio_proxy.request.parse',
  session: 'aio_proxy.session.resolve',
  route: 'aio_proxy.route.resolve',
  attempt: 'aio_proxy.provider.attempt',
  prepare: 'aio_proxy.request.prepare',
  tokenCount: 'aio_proxy.token_count',
  candidateSkipped: 'aio_proxy.token_count.candidate_skipped',
} as const;

type SpanDeclaration = {
  /** 固定 span 名；动态名的 span 不给这个字段，只给 nameShape。 */
  readonly name?: string;
  readonly nameShape?: string;
  readonly kind: SpanKind;
  /** 允许的父 span（registry 的 key）。root 为空。 */
  readonly parent: readonly string[];
  /** 创建点，相对 packages/server/src。colocated 测试按它校验「声明即存在」。 */
  readonly createdBy: string;
};

// 一个 span 的完整声明只有这一处。加 span 先加声明，测试会逼着你把创建点补上；
// 删创建点不删声明，测试同样会红 —— 本次重构起因的七个死常量再也长不出来。
export const spanRegistry = {
  request: {
    name: spanName.request,
    kind: SpanKind.SERVER,
    parent: [],
    createdBy: 'request-tracing/request-trace-recorder/request-trace-recorder.ts',
  },
  parse: { name: spanName.parse, kind: SpanKind.INTERNAL, parent: ['request'], createdBy: 'routes/pipeline/index.ts' },
  session: {
    name: spanName.session,
    kind: SpanKind.INTERNAL,
    parent: ['request'],
    createdBy: 'routes/pipeline/index.ts',
  },
  route: { name: spanName.route, kind: SpanKind.INTERNAL, parent: ['request'], createdBy: 'routes/pipeline/index.ts' },
  inference: {
    nameShape: '{operation} {model}',
    kind: SpanKind.CLIENT,
    parent: ['request'],
    createdBy: 'routes/pipeline/inference-span.ts',
  },
  attempt: {
    name: spanName.attempt,
    kind: SpanKind.INTERNAL,
    // startInferenceSpan 只在 routes/pipeline 里调用，token-count 那条路上没有 GenAI span，
    // 它的 attempt 直接挂 root。
    parent: ['inference', 'request'],
    createdBy: 'routes/pipeline/attempt/emit/emit.ts',
  },
  prepare: {
    name: spanName.prepare,
    kind: SpanKind.INTERNAL,
    parent: ['attempt'],
    createdBy: 'routes/pipeline/attempt/model.ts',
  },
  upstream: {
    nameShape: '{http.request.method}',
    kind: SpanKind.CLIENT,
    parent: ['attempt'],
    createdBy: 'request-logging/wire/wire.ts',
  },
  tokenCount: {
    name: spanName.tokenCount,
    kind: SpanKind.INTERNAL,
    parent: ['request'],
    createdBy: 'routes/token-count/shared.ts',
  },
  candidateSkipped: {
    name: spanName.candidateSkipped,
    kind: SpanKind.INTERNAL,
    parent: ['request'],
    createdBy: 'routes/token-count/shared.ts',
  },
} as const satisfies Record<string, SpanDeclaration>;

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
  capability: 'aio_proxy.capability',
  genAiOperationName: 'gen_ai.operation.name',
  stream: 'aio_proxy.request.stream',
  fast: 'aio_proxy.request.fast',
  ttftMs: 'aio_proxy.response.ttft_ms',
  transportObservation: 'aio_proxy.response.transport_observation',
  upstreamHeadersMs: 'aio_proxy.response.upstream_headers_ms',
  firstUpstreamByteMs: 'aio_proxy.response.first_upstream_byte_ms',
  firstSseEventMs: 'aio_proxy.response.first_sse_event_ms',
  contentGapP95Ms: 'aio_proxy.response.content_gap_p95_ms',
  maxSseFramesPerRead: 'aio_proxy.response.max_sse_frames_per_read',
  contentEncoding: 'aio_proxy.response.content_encoding',
  inboundProtocol: 'aio_proxy.protocol.inbound',
  sessionSource: 'aio_proxy.session.source',
  sessionId: 'aio_proxy.session.id',
  sessionResolvedBy: 'aio_proxy.session.resolved_by',
  finalProviderId: 'aio_proxy.route.final_provider_id',
  routeCandidateCount: 'aio_proxy.route.candidate_count',
  attemptIndex: 'aio_proxy.attempt.index',
  // attempt span 是 aio-proxy 自己的转移机制，不是 GenAI span：它的模型和 TTFT 用自己的
  // 命名空间，否则一条 trace 里 N 个 attempt 都长得像 GENERATION，token 数按 N 倍算。
  attemptModelId: 'aio_proxy.attempt.model_id',
  attemptTtftMs: 'aio_proxy.attempt.ttft_ms',
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
  tokenCountSource: 'aio_proxy.token_count.source',
  skipReason: 'aio_proxy.token_count.skip_reason',
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
  genAiResponseId: 'gen_ai.response.id',
  // double, in seconds. Only the gen_ai.inference.client group references it, so
  // there is no shared constant to import and it is hardcoded like the rest.
  genAiTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  httpRequestMethod: 'http.request.method',
  serverAddress: 'server.address',
  urlPath: 'url.path',
  errorType: 'error.type',
  // `http.status_code` 2023 年就废弃了。旧数据落库时用的是老 key，dashboard 侧留兜底，
  // 不做数据迁移。
  httpStatusCode: 'http.response.status_code',
  diagnosticRequestProtocol: 'aio_proxy.diagnostics.request.protocol',
  diagnosticRequestMethod: 'aio_proxy.diagnostics.request.method',
  diagnosticRequestContentType: 'aio_proxy.diagnostics.request.content_type',
  diagnosticRequestContentLengthBytes: 'aio_proxy.diagnostics.request.content_length_bytes',
  diagnosticRequestUserAgent: 'aio_proxy.diagnostics.request.user_agent',
  diagnosticResponseStatusCode: 'aio_proxy.diagnostics.response.status_code',
  diagnosticResponseContentType: 'aio_proxy.diagnostics.response.content_type',
  diagnosticResponseContentLengthBytes: 'aio_proxy.diagnostics.response.content_length_bytes',
} as const;

export const ALLOWED_ATTRIBUTES = new Set<string>(Object.values(attributeName));

type DiagnosticAttributeValue = string | number;
type DiagnosticAttributes = Record<string, DiagnosticAttributeValue>;

const MAX_DIAGNOSTIC_TEXT_LENGTH = 512;

export function captureTraceDiagnostics(input: {
  readonly inboundRequest?: { readonly protocol: string; readonly value: Request };
  readonly clientResponse?: Response;
}): DashboardTraceDiagnostics {
  const request = input.inboundRequest;
  const response = input.clientResponse;
  return {
    ...(request === undefined
      ? {}
      : {
          request: {
            protocol: request.protocol,
            method: request.value.method,
            ...headerDiagnostics(request.value.headers, true),
          },
        }),
    ...(response === undefined
      ? {}
      : {
          response: {
            statusCode: response.status,
            ...headerDiagnostics(response.headers, false),
          },
        }),
  };
}

function headerDiagnostics(headers: Headers, includeUserAgent: boolean) {
  const contentType = safeHeader(headers, 'content-type');
  const contentLengthBytes = safeContentLength(headers);
  const userAgent = includeUserAgent ? safeHeader(headers, 'user-agent') : undefined;
  return {
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentLengthBytes === undefined ? {} : { contentLengthBytes }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

function safeHeader(headers: Headers, name: 'content-type' | 'user-agent'): string | undefined {
  const value = headers.get(name)?.trim();
  return value !== undefined && value.length > 0 && value.length <= MAX_DIAGNOSTIC_TEXT_LENGTH ? value : undefined;
}

function safeContentLength(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (value === null || !/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function traceDiagnosticsToAttributes(diagnostics: DashboardTraceDiagnostics): DiagnosticAttributes {
  const request = diagnostics.request;
  const response = diagnostics.response;
  return {
    ...(request === undefined
      ? {}
      : {
          [attributeName.diagnosticRequestProtocol]: request.protocol,
          [attributeName.diagnosticRequestMethod]: request.method,
          ...(request.contentType === undefined
            ? {}
            : { [attributeName.diagnosticRequestContentType]: request.contentType }),
          ...(request.contentLengthBytes === undefined
            ? {}
            : { [attributeName.diagnosticRequestContentLengthBytes]: request.contentLengthBytes }),
          ...(request.userAgent === undefined ? {} : { [attributeName.diagnosticRequestUserAgent]: request.userAgent }),
        }),
    ...(response === undefined
      ? {}
      : {
          [attributeName.diagnosticResponseStatusCode]: response.statusCode,
          ...(response.contentType === undefined
            ? {}
            : { [attributeName.diagnosticResponseContentType]: response.contentType }),
          ...(response.contentLengthBytes === undefined
            ? {}
            : { [attributeName.diagnosticResponseContentLengthBytes]: response.contentLengthBytes }),
        }),
  };
}

export function traceDiagnosticsFromAttributes(
  attributes: Readonly<Record<string, unknown>>,
): DashboardTraceDiagnostics | undefined {
  const requestProtocol = stringAttribute(attributes, attributeName.diagnosticRequestProtocol);
  const requestMethod = stringAttribute(attributes, attributeName.diagnosticRequestMethod);
  const responseStatus = numberAttribute(attributes, attributeName.diagnosticResponseStatusCode);
  const diagnostics: DashboardTraceDiagnostics = {
    ...(requestProtocol === undefined || requestMethod === undefined
      ? {}
      : {
          request: {
            protocol: requestProtocol,
            method: requestMethod,
            ...optionalStringAttribute(attributes, attributeName.diagnosticRequestContentType, 'contentType'),
            ...optionalNumberAttribute(
              attributes,
              attributeName.diagnosticRequestContentLengthBytes,
              'contentLengthBytes',
            ),
            ...optionalStringAttribute(attributes, attributeName.diagnosticRequestUserAgent, 'userAgent'),
          },
        }),
    ...(responseStatus === undefined
      ? {}
      : {
          response: {
            statusCode: responseStatus,
            ...optionalStringAttribute(attributes, attributeName.diagnosticResponseContentType, 'contentType'),
            ...optionalNumberAttribute(
              attributes,
              attributeName.diagnosticResponseContentLengthBytes,
              'contentLengthBytes',
            ),
          },
        }),
  };
  return diagnostics.request === undefined && diagnostics.response === undefined ? undefined : diagnostics;
}

function stringAttribute(attributes: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = attributes[name];
  return typeof value === 'string' ? value : undefined;
}

function numberAttribute(attributes: Readonly<Record<string, unknown>>, name: string): number | undefined {
  const value = attributes[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalStringAttribute(
  attributes: Readonly<Record<string, unknown>>,
  name: string,
  field: 'contentType' | 'userAgent',
): Partial<Record<'contentType' | 'userAgent', string>> {
  const value = stringAttribute(attributes, name);
  return value === undefined ? {} : { [field]: value };
}

function optionalNumberAttribute(
  attributes: Readonly<Record<string, unknown>>,
  name: string,
  field: 'contentLengthBytes',
): Partial<Record<'contentLengthBytes', number>> {
  const value = numberAttribute(attributes, name);
  return value === undefined ? {} : { [field]: value };
}
