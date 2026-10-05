export class InvalidContentLengthError extends SyntaxError {
  constructor() {
    super('Invalid Content-Length');
  }
}

export type RequestBodyLimitDiagnostic = {
  readonly stage: 'encoded' | 'decoded';
  readonly limitBytes: number;
  readonly measurement: 'declared' | 'observed_lower_bound' | 'unknown';
  readonly bytes?: number;
};

export class RequestBodyTooLargeError extends Error {
  constructor(
    message?: string,
    readonly diagnostic?: RequestBodyLimitDiagnostic,
  ) {
    super(message);
  }
}
export class RequestBodyIdleTimeoutError extends Error {
  constructor() {
    super('Request body timed out');
    this.name = 'RequestBodyIdleTimeoutError';
  }
}

export class InvalidCompressedRequestBodyError extends Error {}
export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super('Unsupported request Content-Encoding');
  }
}

export function mapDecodeError(error: unknown, decodedLimit: number): unknown {
  if (error instanceof RequestBodyTooLargeError || error instanceof RequestBodyIdleTimeoutError) return error;
  if (errorCode(error) === 'ERR_BUFFER_TOO_LARGE')
    return new RequestBodyTooLargeError('Request body too large', {
      stage: 'decoded',
      limitBytes: decodedLimit,
      measurement: 'unknown',
    });
  if (isCompressedDataError(error)) return new InvalidCompressedRequestBodyError('Invalid compressed request body');
  return error;
}

export function isCompressedDataError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'Z_DATA_ERROR' ||
    code === 'Z_BUF_ERROR' ||
    code?.startsWith('ERR_BROTLI_DECODER_') === true ||
    code?.startsWith('ZSTD_error_') === true
  );
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
