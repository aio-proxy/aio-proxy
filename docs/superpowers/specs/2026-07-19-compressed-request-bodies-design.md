# Compressed Request Bodies Design

## Context

Codex sends OpenAI Responses requests with `Content-Encoding: zstd`. Bun and Hono expose the encoded request bytes; neither decodes inbound content codings before `JSON.parse`. The same failure can affect every model protocol because all adapters must parse the request body before provider selection.

The current branch already decodes gzip and zstd in the shared `readJsonRequest()` path, bounds encoded and decoded data at 8 MiB, preserves the original entity for raw passthrough, and removes stale entity headers when rewriting JSON. The remaining work is to complete the supported coding set, replace the arbitrary shared threshold with independent limits, and give unsupported codings an explicit response.

Reference findings are recorded in [compressed-request-body-reference.md](../../research/compressed-request-body-reference.md).

## Decisions

### Shared core decoder

Request decoding remains in `packages/core/src/protocol/request.ts`. Every protocol adapter continues to parse a clone through `readJsonRequest()`, so OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Gemini receive the same behavior.

Do not add a Hono `bodyLimit` or decompression middleware. `bodyLimit` cannot constrain decompressed output and buffers chunked bodies before the core parser reads them again. A decompression middleware would also need to carry both the original and decoded requests to preserve byte-level raw passthrough. Keeping both concerns in the existing core helper is smaller and keeps adapters usable outside Hono.

### Supported content codings

Use asynchronous `node:zlib` APIs without adding a dependency. Accept one effective content coding:

- no header or `identity`: parse the original bytes;
- `gzip` and `x-gzip`: gunzip;
- `zstd`: zstd decompress;
- `deflate`: try zlib-wrapped inflate, then raw inflate only when the first attempt reports invalid compressed data;
- `br`: Brotli decompress.

Header tokens are trimmed and compared case-insensitively. Ignore `identity` tokens. More than one remaining coding is unsupported; the proxy will not implement nested coding chains.

### Independent limits

Bound both stages:

| Stage                 | Fixed limit |
| --------------------- | ----------: |
| Encoded request bytes |      64 MiB |
| Decoded request bytes |     128 MiB |

These are fixed product limits. This change does not add environment overrides or request-decoding concurrency control.

The server's `Content-Length` early rejection and the core stream reader must import the same encoded constant. The stream reader remains authoritative for missing, misleading, or chunked lengths. Each zlib operation receives the decoded constant through `maxOutputLength`; a size error must not trigger the raw-deflate fallback.

Bun's default 128 MiB server limit remains an outer safety net. No Bun server limit change is needed because the encoded application limit is 64 MiB. Bodies between 64 and 128 MiB that reach the application receive the protocol-shaped 413. A declared body above Bun's outer limit can be rejected before the handler with Bun's generic 413; that response is explicitly outside the protocol-shaped application guarantee.

A Bun 1.3.14 probe of the retained raw request, clone, decoded buffer, string, and parsed object measured about 555 MiB RSS for a highly compressible 128 MiB single-string JSON body. The 64/128 MiB limits are an explicit product capacity choice; operators must account for the resulting per-request memory ceiling. Admission control and a process-wide memory budget remain out of scope.

### Raw passthrough and rewrites

Parsing consumes only a clone. When a same-protocol request requires no rewrite, raw dispatch continues forwarding the client's original compressed bytes and entity headers.

When the model or Responses background behavior requires a JSON rewrite, build the outgoing body from decoded JSON and remove both `content-encoding` and `content-length`. The runtime recalculates the length of the new plaintext entity.

### Errors and diagnostics

- Encoded or decoded limit exceeded: preserve or create `RequestBodyTooLargeError`, producing the existing protocol-shaped HTTP 413 response.
- Unknown coding or more than one effective coding: create `UnsupportedContentEncodingError`, producing a protocol-shaped HTTP 415 response.
- Invalid compressed data: normalize native algorithm errors into `InvalidCompressedRequestBodyError`, producing a protocol-shaped HTTP 400 invalid-request response.

Do not expose native zlib messages. Map `ERR_BUFFER_TOO_LARGE` directly to `RequestBodyTooLargeError`. Treat `ERR_OUT_OF_RANGE` as an internal programming/configuration failure rather than a client 400. Normalize known corrupt/truncated-data codes (`Z_DATA_ERROR`, `Z_BUF_ERROR`, `ERR_BROTLI_DECODER_*`, and `ZSTD_error_*`) to `InvalidCompressedRequestBodyError`; allow unrelated runtime failures to propagate as internal errors.

For deflate, retry with `inflateRaw` only when the first `inflate` attempt has `code === "Z_DATA_ERROR"`. Do not retry after `Z_BUF_ERROR`, `ERR_BUFFER_TOO_LARGE`, `ERR_OUT_OF_RANGE`, or any other error. If the raw retry also reports a known corrupt/truncated-data code, return the safe domain error.

Add a dedicated `unsupportedContentEncoding` operation to `ProtocolErrorMapper`; do not reuse the provider-transform `unsupported` operation, which means HTTP 501. Each production mapper must return HTTP 415 in its own protocol envelope. `InvalidCompressedRequestBodyError` remains part of each mapper's normal 400 request-error recognition. The pipeline gives the three domain failures stable rejection codes (`request_too_large`, `unsupported_content_encoding`, and `invalid_request`) and preserves the domain error class as the diagnostic error type.

The temporary unsupported-coding diagnostic uses `console.warn` and records only the normalized coding value or coding list, never headers wholesale or request body data. Existing request-rejection recording remains responsible for request ID, protocol, path, status, error code, and error type.

## Verification

Keep behavior tests at the shared boundary:

- successful decode for gzip, x-gzip, zstd, zlib-wrapped deflate, raw deflate, Brotli, identity, and no header;
- encoded 64 MiB boundary behavior through a small injected test limit;
- decoded 128 MiB boundary behavior through `maxOutputLength` with a small injected test limit;
- unsupported and multi-coding rejection;
- invalid compressed payload rejection;
- a decoded-output limit error does not trigger raw-deflate fallback;
- cancellation of retained request branches on failure;

Add one server pipeline regression for 415 dispatch, recording, and safe rejection diagnostics. Add a small table-driven mapper test that verifies OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini each return HTTP 415 with the expected protocol body shape and stable code/type, without reflecting the original header or body. Retain the existing OpenAI Responses tests proving unchanged raw bytes/headers without rewrite and CE/CL removal after rewrite. Do not duplicate the decompression matrix across every protocol adapter because each calls the shared helper.

Before completion, run the focused core and server tests, then `bun run preflight`.

## Out of scope

- Nested or repeated content-coding chains.
- Decompressing and normalizing requests that can be forwarded without parsing.
- Applying Hono body limits to dashboard, OAuth, plugin, or other non-model routes.
- Runtime-configurable request-body limits or request-decoding admission control.
- Replacing temporary console diagnostics with a new logging subsystem.
