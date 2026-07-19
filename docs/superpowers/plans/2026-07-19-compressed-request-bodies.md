# Compressed Request Bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode common single-layer HTTP request content codings for every model protocol while preserving raw passthrough and returning stable protocol-shaped failures.

**Architecture:** Keep decoding in the shared core `readJsonRequest()` clone path. Export fixed 64 MiB encoded and 128 MiB decoded limits, normalize native zlib failures into domain errors, and let the server pipeline map only the domain errors that need dedicated 413/415 lifecycle handling.

**Tech Stack:** Bun 1.3.14, TypeScript, Hono, Web Standard `Request`, async `node:zlib`, Bun test.

## Global Constraints

- Work only in `/Volumes/ExternalSSD/workspace/aio-proxy/.worktrees/openai-responses-gzip-body` on `codex/openai-responses-gzip-body`.
- Add no dependency and no Hono body-limit/decompression middleware.
- Fixed limits are 64 MiB encoded and 128 MiB decoded; no environment override or admission control.
- Support one effective coding: `gzip`, `x-gzip`, `zstd`, zlib/raw `deflate`, or `br`; ignore `identity`.
- Preserve original compressed bytes and entity headers for same-protocol raw passthrough without rewrite.
- Rewritten JSON must remove `content-encoding` and `content-length`.
- Unknown or multiple codings return 415; corrupt compressed data returns 400; either size limit returns 413.
- Never include request bodies or complete request headers in diagnostics.
- Keep implementation and test files below 300 lines and run `bun run preflight` before completion.

---

### Task 1: Complete the shared bounded decoder

**Files:**
- Modify: `packages/core/src/protocol/request.ts`
- Modify: `packages/core/src/protocol/request.test.ts`
- Retain regression coverage: `packages/core/src/protocol/openai-responses.test.ts`
- Retain regression coverage: `packages/core/src/protocol/openai-responses-basic.test.ts`

**Interfaces:**
- Produces: `REQUEST_BODY_LIMITS: { readonly encoded: number; readonly decoded: number }`
- Produces: `RequestBodyTooLargeError`, `UnsupportedContentEncodingError`, `InvalidCompressedRequestBodyError`
- Produces: `readJsonRequest(raw: Request, limits?: RequestBodyLimits): Promise<unknown>`
- Consumes later: server Content-Length checks import `REQUEST_BODY_LIMITS.encoded`; protocol mappers recognize the two new domain errors.

- [ ] **Step 1: Add failing decoder behavior tests**

Add `node:zlib` sync encoders and table-driven cases to `request.test.ts`:

```ts
import { expect, spyOn, test } from "bun:test";
import { brotliCompressSync, deflateRawSync, deflateSync } from "node:zlib";
import {
  InvalidCompressedRequestBodyError,
  REQUEST_BODY_LIMITS,
  RequestBodyTooLargeError,
  UnsupportedContentEncodingError,
  readJsonRequest,
  rewriteJsonRequestModel,
} from "./request";

const jsonBytes = new TextEncoder().encode(JSON.stringify({ ok: true }));

test.each([
  ["gzip", Bun.gzipSync(jsonBytes)],
  ["x-gzip", Bun.gzipSync(jsonBytes)],
  ["zstd", Bun.zstdCompressSync(jsonBytes)],
  ["deflate", deflateSync(jsonBytes)],
  ["deflate", deflateRawSync(jsonBytes)],
  ["br", brotliCompressSync(jsonBytes)],
] as const)("readJsonRequest decodes %s request bodies", async (encoding, body) => {
  const request = encodedRequest(encoding, body);
  expect(await readJsonRequest(request)).toEqual({ ok: true });
});

test.each(["identity", "IDENTITY"])("readJsonRequest ignores %s", async (encoding) => {
  expect(await readJsonRequest(encodedRequest(encoding, jsonBytes))).toEqual({ ok: true });
});

test.each(["compress", "gzip, br"])("readJsonRequest rejects unsupported coding %s", async (encoding) => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(readJsonRequest(encodedRequest(encoding, jsonBytes))).rejects.toBeInstanceOf(
      UnsupportedContentEncodingError,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test.each(["gzip", "zstd", "deflate", "br"])("normalizes corrupt %s bodies", async (encoding) => {
  await expect(readJsonRequest(encodedRequest(encoding, new Uint8Array([1, 2, 3, 4])))).rejects.toBeInstanceOf(
    InvalidCompressedRequestBodyError,
  );
});

function encodedRequest(encoding: string, body: Uint8Array): Request {
  return new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-encoding": encoding, "content-type": "application/json" },
    body,
  });
}
```

Change existing small-limit calls to the two-stage shape, for example:

```ts
await expect(readJsonRequest(request, { encoded: body.byteLength, decoded: 32 })).rejects.toBeInstanceOf(
  RequestBodyTooLargeError,
);
```

Add a deflate regression whose decoded output exceeds `decoded: 32` and assert `RequestBodyTooLargeError`, proving the error does not become raw fallback or invalid-body.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk bun test packages/core/src/protocol/request.test.ts
```

Expected: FAIL because the constants/errors/options and br/deflate/x-gzip branches do not exist.

- [ ] **Step 3: Implement the decoder with exact native-error rules**

In `request.ts`, use async zlib functions and fixed limits:

```ts
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, inflateRaw, zstdDecompress } from "node:zlib";

export const REQUEST_BODY_LIMITS = Object.freeze({
  encoded: 64 * 1_024 * 1_024,
  decoded: 128 * 1_024 * 1_024,
});

export type RequestBodyLimits = Readonly<{ encoded: number; decoded: number }>;

export class RequestBodyTooLargeError extends Error {}
export class InvalidCompressedRequestBodyError extends Error {}
export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super("Unsupported request Content-Encoding");
  }
}
```

Parse the header into non-empty, non-`identity` lowercase tokens. If more than one remains or the one token is unknown, warn with only that normalized value and throw `UnsupportedContentEncodingError`.

Promisify all five decoders. `decodeRequestBytes()` must pass `{ maxOutputLength: limits.decoded }` to every call. Its catch logic must be:

```ts
if (errorCode(error) === "ERR_BUFFER_TOO_LARGE") {
  throw new RequestBodyTooLargeError("Request body too large");
}
if (isCompressedDataError(error)) {
  throw new InvalidCompressedRequestBodyError("Invalid compressed request body");
}
throw error;
```

The deflate helper must call `inflateRaw` only after the first `inflate` throws exactly `Z_DATA_ERROR`. `Z_BUF_ERROR`, `ERR_BUFFER_TOO_LARGE`, and `ERR_OUT_OF_RANGE` must bypass fallback. Keep request-branch cancellation in the existing outer catch.

- [ ] **Step 4: Run core protocol tests and verify GREEN**

Run:

```bash
rtk bun test packages/core/src/protocol/request.test.ts packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts
```

Expected: all tests pass, including original compressed raw bytes/header preservation and rewritten CE/CL removal.

- [ ] **Step 5: Commit the decoder task only**

```bash
rtk git commit --only packages/core/src/protocol/request.ts packages/core/src/protocol/request.test.ts packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts -m "fix(core): decode compressed request bodies" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Add protocol-shaped request-coding errors

**Files:**
- Modify: `packages/core/src/protocol/adapter.ts`
- Modify: `packages/core/src/protocol/errors.ts`
- Create: `packages/core/src/protocol/errors.test.ts`

**Interfaces:**
- Consumes: `InvalidCompressedRequestBodyError` from Task 1.
- Produces: `ProtocolErrorMapper.unsupportedContentEncoding(): Response`.
- Produces: four protocol-specific 415 envelopes; server pipeline calls this operation in Task 3.

- [ ] **Step 1: Write the failing four-protocol mapper test**

Create `errors.test.ts` with a table that calls `unsupportedContentEncoding()` on all production mappers and expects:

```ts
const expected = [
  [openAICompletionsErrors, { error: { code: "unsupported_content_encoding", message: "Unsupported Content-Encoding", type: "invalid_request_error" } }],
  [openAIResponsesErrors, { error: { code: "unsupported_content_encoding", message: "Unsupported Content-Encoding", type: "invalid_request_error" } }],
  [anthropicMessagesErrors, { type: "error", error: { type: "invalid_request_error", message: "Unsupported Content-Encoding" } }],
  [geminiGenerateContentErrors, { error: { code: 415, message: "Unsupported Content-Encoding", status: "INVALID_ARGUMENT" } }],
] as const;

for (const [mapper, body] of expected) {
  const response = mapper.unsupportedContentEncoding();
  expect(response.status).toBe(415);
  expect(await response.json()).toEqual(body);
  expect(JSON.stringify(body)).not.toContain("secret-marker");
}
```

Also call every mapper's `requestError(new InvalidCompressedRequestBodyError())` and assert a protocol-shaped HTTP 400 response.

- [ ] **Step 2: Run the mapper test and verify RED**

Run:

```bash
rtk bun test packages/core/src/protocol/errors.test.ts
```

Expected: FAIL because `unsupportedContentEncoding` is absent and corrupt-body errors are not recognized.

- [ ] **Step 3: Implement the minimal mapper surface**

Add to `ProtocolErrorMapper`:

```ts
unsupportedContentEncoding: () => Response;
```

Add `InvalidCompressedRequestBodyError` to each mapper's existing 400 request predicate. Add fixed 415 builders without accepting the original header value. Extend `geminiError()` to allow code `415` with status `"INVALID_ARGUMENT"`. Do not reuse `unsupported`, which remains the provider-transform 501 operation.

- [ ] **Step 4: Run mapper and core tests and verify GREEN**

Run:

```bash
rtk bun test packages/core/src/protocol/errors.test.ts packages/core/src/protocol/request.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the mapper task only**

```bash
rtk git add packages/core/src/protocol/adapter.ts packages/core/src/protocol/errors.ts packages/core/src/protocol/errors.test.ts
rtk git commit -m "fix(core): map request coding errors" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Wire shared limits and 415 lifecycle through server handlers

**Files:**
- Modify: `packages/server/src/routes/pipeline/request.ts`
- Modify: `packages/server/src/routes/pipeline/index.ts`
- Modify: `packages/server/src/routes/pipeline/test-support.ts`
- Modify: `packages/server/src/routes/pipeline/rejection-lifecycle.test.ts`
- Modify: `packages/server/src/routes/token-count.ts`
- Modify: `packages/server/src/routes/token-count.body.test.ts`
- Modify: `packages/server/src/routes/openai-responses-observability.test.ts`
- Modify: `packages/server/src/routes/anthropic-messages-count-tokens.test.ts`

**Interfaces:**
- Consumes: `REQUEST_BODY_LIMITS.encoded`, `UnsupportedContentEncodingError`, and `ProtocolErrorMapper.unsupportedContentEncoding()`.
- Produces: stable rejection `errorCode: "unsupported_content_encoding"` in the main pipeline and 415 behavior in token-count handlers.

- [ ] **Step 1: Add failing pipeline and token-count tests**

In `rejection-lifecycle.test.ts`, send valid JSON with `content-encoding: compress` through `openAICompletionsAdapter`. Suppress the expected `console.warn`, then assert:

```ts
expect(response.status).toBe(415);
expect(route.recording.finals).toEqual([
  { outcome: "failure", finalStatusCode: 415, errorCode: "unsupported_content_encoding" },
]);
expect(route.logs).toEqual([
  {
    event: "request.rejected",
    requestId: "request-1",
    inboundProtocol: ProviderProtocol.OpenAICompatible,
    path: "/v1/chat/completions",
    statusCode: 415,
    errorCode: "unsupported_content_encoding",
    errorType: "UnsupportedContentEncodingError",
  },
]);
```

In `token-count.body.test.ts`, add an Anthropic count request with the same unsupported coding and assert the Anthropic 415 envelope. This protects the separate `handleTokenCount()` parse path.

- [ ] **Step 2: Run focused server tests and verify RED**

Run:

```bash
rtk bun test packages/server/src/routes/pipeline/rejection-lifecycle.test.ts packages/server/src/routes/token-count.body.test.ts
```

Expected: FAIL because unsupported coding is not mapped by either handler.

- [ ] **Step 3: Implement server mapping and central limit reuse**

Import `REQUEST_BODY_LIMITS` into `pipeline/request.ts` and compare Content-Length against `.encoded`. Export the same value from `pipeline/test-support.ts` instead of duplicating a literal.

In both `handleProtocolRequest()` and `handleTokenCount()`, add an `UnsupportedContentEncodingError` branch after the too-large branch:

```ts
if (error instanceof UnsupportedContentEncodingError) {
  return rejectRequest({
    source,
    session,
    rawRequest,
    inboundProtocol: adapter.protocol,
    response: adapter.errors.unsupportedContentEncoding(),
    errorCode: "unsupported_content_encoding",
    error,
  });
}
```

For token count, return `adapter.errors.unsupportedContentEncoding()` directly because its early parse path does not yet own a request session.

Replace hardcoded 8 MiB test Content-Length values with `REQUEST_BODY_LIMITS.encoded + 1` in the listed observability and token-count tests.

- [ ] **Step 4: Run all affected server tests and verify GREEN**

Run:

```bash
rtk bun test packages/server/src/routes/pipeline/rejection-lifecycle.test.ts packages/server/src/routes/pipeline/boundaries.test.ts packages/server/src/routes/token-count.body.test.ts packages/server/src/routes/anthropic-messages-count-tokens.test.ts packages/server/src/routes/openai-responses-observability.test.ts
```

Expected: all tests pass with 64 MiB early rejection and stable 415 lifecycle data.

- [ ] **Step 5: Commit the server integration task**

```bash
rtk git add packages/server/src/routes/pipeline/request.ts packages/server/src/routes/pipeline/index.ts packages/server/src/routes/pipeline/test-support.ts packages/server/src/routes/pipeline/rejection-lifecycle.test.ts packages/server/src/routes/token-count.ts packages/server/src/routes/token-count.body.test.ts packages/server/src/routes/openai-responses-observability.test.ts packages/server/src/routes/anthropic-messages-count-tokens.test.ts
rtk git commit -m "fix(server): reject unsupported request codings" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Verify the complete branch

**Files:**
- Verify only; do not add cleanup or unrelated refactors.

**Interfaces:**
- Consumes: all behavior produced by Tasks 1–3.
- Produces: evidence that the branch is ready to push and review.

- [ ] **Step 1: Run changed-file formatting and type checks**

Run:

```bash
rtk bun run check
```

Expected: exit 0 with no new diagnostics in changed files.

- [ ] **Step 2: Run the full repository preflight**

Run:

```bash
rtk bun run preflight
```

Expected: exit 0; all unit tests pass.

- [ ] **Step 3: Replay the captured Codex zstd request**

Compress `/Users/baran/.codex/attachments/012218db-ba16-44e3-909d-326391ded145/pasted-text.txt` with Bun zstd, construct a `Request` with `Content-Encoding: zstd`, and call `openAIResponsesAdapter.parse()`. Assert model `gpt-5.6-sol` and 318 input items.

Expected: parse succeeds without `SyntaxError` and without changing the original encoded bytes.

- [ ] **Step 4: Inspect final diff and commit state**

Run:

```bash
rtk git diff --check
rtk git status --short --branch
rtk git log --oneline --decorate -6
```

Expected: no uncommitted implementation changes, no whitespace errors, and only scoped documentation/decoder/mapper/server commits ahead of the PR branch.
