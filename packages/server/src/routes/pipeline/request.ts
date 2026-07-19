import { REQUEST_BODY_LIMITS } from "@aio-proxy/core";

export function hasInvalidOrOversizedContentLength(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  return (
    contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > REQUEST_BODY_LIMITS.encoded)
  );
}

export async function cancelRetainedRequestBody(request: Request, reason: unknown): Promise<void> {
  try {
    await request.body?.cancel(reason);
  } catch {}
}
