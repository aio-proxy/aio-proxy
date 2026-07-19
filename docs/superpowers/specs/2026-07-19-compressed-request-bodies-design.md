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

| Stage | Default | Environment override |
| --- | ---: | --- |
| Encoded request bytes | 64 MiB | `AIO_PROXY_MAX_COMPRESSED_REQUEST_BYTES` |
| Decoded request bytes | 128 MiB | `AIO_PROXY_MAX_DECOMPRESSED_REQUEST_BYTES` |

Environment values are positive integer byte counts. A missing value uses the default. An invalid or non-positive value emits one `console.warn` at configuration load and falls back to the default.

The server's `Content-Length` early rejection and the core stream reader must consume the same encoded limit source. The stream reader remains authoritative for missing, misleading, or chunked lengths. Each zlib operation receives the decoded limit through `maxOutputLength`; a size error must not trigger the raw-deflate fallback.

Bun's default 128 MiB server limit remains an outer safety net. No Bun server limit change is needed because the encoded application limit is 64 MiB.

### Raw passthrough and rewrites

Parsing consumes only a clone. When a same-protocol request requires no rewrite, raw dispatch continues forwarding the client's original compressed bytes and entity headers.

When the model or Responses background behavior requires a JSON rewrite, build the outgoing body from decoded JSON and remove both `content-encoding` and `content-length`. The runtime recalculates the length of the new plaintext entity.

### Errors and diagnostics

- Encoded or decoded limit exceeded: existing protocol-shaped HTTP 413 response.
- Unknown coding or more than one effective coding: protocol-shaped HTTP 415 response.
- Invalid compressed data: protocol-shaped HTTP 400 invalid-request response.

Introduce a typed unsupported-content-encoding error so the server pipeline can map it separately from JSON and schema failures. The temporary diagnostic uses `console.warn` and records only the normalized coding value or coding list, never headers wholesale or request body data. Existing request-rejection recording remains responsible for request ID, protocol, path, status, error code, and error type.

## Verification

Keep behavior tests at the shared boundary:

- successful decode for gzip, x-gzip, zstd, zlib-wrapped deflate, raw deflate, Brotli, identity, and no header;
- encoded 64 MiB boundary behavior through a small injected test limit;
- decoded 128 MiB boundary behavior through `maxOutputLength` with a small injected test limit;
- unsupported and multi-coding rejection;
- invalid compressed payload rejection;
- cancellation of retained request branches on failure;
- invalid environment values fall back to defaults.

Add one server pipeline regression for the protocol-shaped 415 response and safe rejection diagnostic. Retain the existing OpenAI Responses tests proving unchanged raw bytes/headers without rewrite and CE/CL removal after rewrite. Do not duplicate the same decompression matrix across every protocol adapter because each calls the shared helper.

Before completion, run the focused core and server tests, then `bun run preflight`.

## Out of scope

- Nested or repeated content-coding chains.
- Decompressing and normalizing requests that can be forwarded without parsing.
- Applying Hono body limits to dashboard, OAuth, plugin, or other non-model routes.
- Replacing temporary console diagnostics with a new logging subsystem.
