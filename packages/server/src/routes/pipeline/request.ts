import type { RequestBodyLimits } from '@aio-proxy/core';

export function hasInvalidOrOversizedContentLength(request: Request, limits: RequestBodyLimits): boolean {
  const contentLength = request.headers.get('content-length');
  return contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limits.encoded);
}

export async function cancelRetainedRequestBody(request: Request, reason: unknown): Promise<void> {
  try {
    await request.body?.cancel(reason);
  } catch {}
}
