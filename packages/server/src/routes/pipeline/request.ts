const MAX_BODY_BYTES = 8 * 1_024 * 1_024;

export function hasInvalidOrOversizedContentLength(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  return contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES);
}
