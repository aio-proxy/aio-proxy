import { attributeName } from '../../request-tracing/semantic';

const reasons = new Set([
  'internal_error',
  'invalid_request',
  'request_too_large',
  'unsupported_content_encoding',
  'unsupported_feature',
  'model_not_found',
  'not_implemented',
  'previous_response_conflict',
  'rate_limited',
  'provider_error',
  'bad_gateway',
  'upstream_error',
  'invalid_response',
  'transport_failed',
  'target_unavailable',
  'recursive_target',
  'unsupported',
  'response_too_large',
]);
const identifiers = new Set([
  'providerId',
  'modelId',
  'targetProviderId',
  'targetModelId',
  attributeName.providerId,
  attributeName.finalProviderId,
  attributeName.genAiRequestModel,
  attributeName.attemptModelId,
]);
const localFields = new Set([
  'event',
  'requestId',
  'inboundProtocol',
  'protocol',
  'providerKind',
  'direction',
  'outcome',
  'failureKind',
  'transport',
  'sourceProtocol',
  'targetProtocol',
  'strategy',
  'correlationId',
  attributeName.requestId,
  attributeName.guardianParentRequestId,
  attributeName.inboundProtocol,
  attributeName.sourceProtocol,
  attributeName.targetProtocol,
  attributeName.providerKind,
  attributeName.transport,
  attributeName.operation,
  attributeName.capability,
  attributeName.genAiOperationName,
  attributeName.terminationReason,
  attributeName.selectionReason,
  attributeName.prioritySource,
  attributeName.weightSource,
  attributeName.selectionSource,
  attributeName.transportObservation,
  attributeName.prepareMode,
  attributeName.egressMode,
  attributeName.httpRequestMethod,
  attributeName.sessionSource,
  attributeName.sessionResolvedBy,
]);

export function safeDiagnosticFields<T extends object>(fields: T, capturePayload = false): T {
  if (capturePayload) return fields;
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => {
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value === 'boolean') return true;
      if (typeof value !== 'string') return false;
      if (key === 'errorCode' || key === attributeName.errorCode) return reasons.has(value);
      if (identifiers.has(key)) return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(value);
      return localFields.has(key) && value.length <= 256;
    }),
  ) as T;
}

// Remember sensitivity at span creation: completion may run after the request scope exits.
const sensitiveSpans = new WeakSet<object>();
export function markSensitiveSpan(span: object, sensitive: boolean): void {
  if (sensitive) sensitiveSpans.add(span);
}
export function isSensitiveSpan(span: object): boolean {
  return sensitiveSpans.has(span);
}
