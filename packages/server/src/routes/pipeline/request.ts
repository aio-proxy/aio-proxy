import { RequestBodyTooLargeError, type RequestBodyLimitDiagnostic, type RequestBodyLimits } from '@aio-proxy/core';
import { trace, type Attributes } from '@opentelemetry/api';

import { safeDiagnosticFields } from '../../request-logging/capture-policy';
import { attributeName, type RequestTraceSession } from '../../request-tracing';

export class InvalidContentLengthError extends SyntaxError {
  constructor() {
    super('Invalid Content-Length');
  }
}

export function inspectRequestContentLength(
  request: Request,
  limits: RequestBodyLimits,
):
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too_large'; readonly diagnostic: RequestBodyLimitDiagnostic }
  | undefined {
  const value = request.headers.get('content-length');
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) return { kind: 'invalid' };
  const bytes = Number(value);
  if (bytes <= limits.encoded) return undefined;
  return {
    kind: 'too_large',
    diagnostic: {
      stage: 'encoded',
      limitBytes: limits.encoded,
      measurement: 'declared',
      ...(Number.isFinite(bytes) ? { bytes } : {}),
    },
  };
}

// Only local fixed enums and finite sizes leave rejection handling, including in sensitive scopes.
export function requestBodyRejectionFields(request: Request, error: unknown) {
  const diagnostic = error instanceof RequestBodyTooLargeError ? error.diagnostic : undefined;
  const invalid = error instanceof InvalidContentLengthError;
  if (diagnostic === undefined && !invalid) return {};
  const encodings = (request.headers.get('content-encoding') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '' && value !== 'identity');
  const encoding = encodings.length === 0 ? 'identity' : encodings.length === 1 ? encodings[0] : 'unsupported';
  const bodyContentEncoding =
    encoding === undefined || encoding === '' || encoding === 'identity'
      ? 'identity'
      : ['gzip', 'x-gzip', 'zstd', 'deflate', 'br'].includes(encoding)
        ? encoding
        : 'unsupported';
  return safeDiagnosticFields({
    ...(diagnostic === undefined
      ? {}
      : {
          bodyLimitStage: diagnostic.stage,
          bodyLimitBytes: diagnostic.limitBytes,
          bodyMeasurement: diagnostic.measurement,
          ...(diagnostic.bytes === undefined ? {} : { bodyBytes: diagnostic.bytes }),
        }),
    ...(invalid ? { bodyRejectReason: 'invalid_content_length' } : {}),
    bodyContentEncoding,
  });
}

export function recordRequestBodyRejection(session: RequestTraceSession, request: Request, error: unknown): void {
  const fields = requestBodyRejectionFields(request, error);
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      attributes[attributeName[key as keyof typeof fields]] = value;
    }
  }
  trace.getSpan(session.rootContext)?.setAttributes(attributes);
}

export async function cancelRetainedRequestBody(request: Request, reason: unknown): Promise<void> {
  try {
    await request.body?.cancel(reason);
  } catch {}
}
