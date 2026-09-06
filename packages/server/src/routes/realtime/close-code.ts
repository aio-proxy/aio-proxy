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
 *  over 123 UTF-8 bytes. The server side silently truncates instead, and when the cut
 *  lands mid-sequence Bun discards the whole frame and sends `1007` "Server sent
 *  invalid UTF8" in its place. Walking code points is therefore required in both
 *  directions to keep the origin's code intact. */
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
