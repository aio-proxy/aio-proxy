import { AsyncLocalStorage } from 'node:async_hooks';

import { DEFAULT_REQUEST_BODY_MAX_BYTES } from '@aio-proxy/types';

export type RequestBodyLimits = Readonly<{ encoded: number; decoded: number }>;

export const REQUEST_BODY_LIMITS: RequestBodyLimits = Object.freeze({
  encoded: DEFAULT_REQUEST_BODY_MAX_BYTES,
  decoded: DEFAULT_REQUEST_BODY_MAX_BYTES,
});

const requestBodyLimits = new AsyncLocalStorage<RequestBodyLimits>();

export function currentRequestBodyLimits(): RequestBodyLimits {
  return requestBodyLimits.getStore() ?? REQUEST_BODY_LIMITS;
}

export function withRequestBodyLimits<T>(limits: RequestBodyLimits, operation: () => T): T {
  return requestBodyLimits.run(Object.freeze({ ...limits }), operation);
}
