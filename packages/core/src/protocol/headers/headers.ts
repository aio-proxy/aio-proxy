// Headers that describe the ORIGINAL body encoding must not survive onto a
// rewritten upstream request: the rewrite re-encodes the body, so a stale
// content-length or content-encoding makes the upstream reject or truncate it.
export function stripHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('content-md5');
  headers.delete('digest');
  headers.delete('content-digest');
  return headers;
}
