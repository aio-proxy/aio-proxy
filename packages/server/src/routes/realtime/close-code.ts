export const INTERNAL_CLOSE_CODE = 1011;
export const SHUTDOWN_CLOSE_CODE = 1001;
/** A deliberate, non-error end of the call: a 2xx hangup. */
export const NORMAL_CLOSE_CODE = 1000;
export const MAX_CLOSE_REASON_BYTES = 123;

/** Measured on Bun 1.4.2: `ServerWebSocket.close()` accepts everything, but the
 *  client `WebSocket.close()` throws `InvalidAccessError` outside these ranges.
 *  Normalizing to the narrower set in both directions keeps one code path.
 *  A fractional code is rejected for a different reason: the client accepts it and
 *  rounds it, so the peer would see a code the origin never sent (`1002.9` -> `1003`,
 *  and even out-of-range `999.5` -> `1000`). */
function acceptedByClient(code: number): boolean {
  if (!Number.isInteger(code)) return false;
  if (code >= 1000 && code <= 1003) return true;
  if (code >= 1007 && code <= 1014) return true;
  return code >= 3000 && code <= 4999;
}

export function normalizeCloseCode(code: number | undefined): number {
  return code !== undefined && acceptedByClient(code) ? code : INTERNAL_CLOSE_CODE;
}

/** Measured on Bun 1.4.2: only the client `WebSocket.close()` throws `SyntaxError`
 *  over 123 UTF-8 bytes (`Received 124 bytes.` at exactly 124). The server side neither
 *  throws nor truncates cleanly — it cuts at byte 123 and, when that cut lands
 *  mid-sequence, discards the whole frame and sends `1007` "Server sent invalid UTF8"
 *  in its place.
 *
 *  Walking code points therefore buys two different things in the two directions:
 *
 *  - downstream -> upstream (the proxy calls the *client* socket's `close()`): the
 *    guarantee holds. Without truncation the call throws and no close frame is sent
 *    at all; with it the origin's code and a boundary-safe prefix of its reason cross
 *    intact (measured: 123 ASCII bytes cross whole, 124 throws).
 *  - upstream -> downstream (the proxy calls Bun's *server* socket `close()`): this
 *    only bounds what the proxy itself emits. It cannot recover a code the origin
 *    already lost, because the origin's own server-side truncation happens before the
 *    bytes reach the proxy. Measured end-to-end: an origin `close(4002, 50 emoji =
 *    200 B)` arrives at the proxy already rewritten to `1007` "Server sent invalid
 *    UTF8", so `realtime.sideband_closed` logs `closeCode: 1007, origin: "upstream"`
 *    and the origin's `4002` is unrecoverable at this layer. `close(4003, 200 ASCII)`
 *    arrives as `4003` with 123 bytes, and `close(4001, 30 emoji = 120 B)` arrives whole. */
export function truncateCloseReason(reason: string | undefined): string | undefined {
  if (reason === undefined || reason.length === 0) return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let bytes = 0;
  let result = '';
  for (const codePoint of reason) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > MAX_CLOSE_REASON_BYTES) break;
    bytes += size;
    result += codePoint;
  }
  return result.length === 0 ? undefined : result;
}

/** A code that had to be normalized carries no meaningful reason, so the reason is
 *  dropped rather than paired with a code the origin never sent. */
export function normalizedClose(
  code: number | undefined,
  reason: string | undefined,
): { readonly code: number; readonly reason?: string } {
  const normalized = normalizeCloseCode(code);
  if (normalized !== code) return { code: normalized };
  const truncated = truncateCloseReason(reason);
  return truncated === undefined ? { code: normalized } : { code: normalized, reason: truncated };
}
