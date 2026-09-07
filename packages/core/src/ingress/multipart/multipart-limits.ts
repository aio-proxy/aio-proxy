// Side-effect-free leaf so protocol constant modules can read the process-wide
// ceiling without pulling `multipart/index` — and with it the spool's `node:fs`
// handles and FinalizationRegistry — into their module graph. Deep imports of
// this file from outside `multipart/` are intentional for that reason.

// Process-wide ceiling on a spooled multipart envelope, mirroring the server's
// max request body size. It bounds disk use before any protocol-specific limit
// applies, so it is not a per-protocol compatibility knob; callers that know a
// tighter cap should pass it to `spoolMultipartBody` instead of relying on this.
export const MULTIPART_ENCODED_LIMIT = 851_048_559;
