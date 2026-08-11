# Cursor OAuth Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 `@aio-proxy/plugin-cursor` login-only adapter into a working model provider by hand-writing a `LanguageModelV4` that speaks Connect-RPC over HTTP/2 + protobuf to `AgentService/Run`, discovers models via `GetUsableModels`, answers the built-in (A-class) exec handshake per-case, bridges caller (B-class) tools through stateless history continuation, and carries multi-turn `conversationState` in a bounded per-plugin store.

**Architecture:** Phase 2 adds Cursor-specific transport and runtime modules under `packages/plugins/cursor/src/` behind the existing `OAuthAdapter` seam, with no new host touchpoints beyond what Phase 1 shipped. `src/gen/` holds vendored protobuf-es code; `src/wire/` owns the 5-byte Connect frame codec and the `node:http2` transport; `src/runtime/` owns the exec-policy, conversation-turn builder, server-message-to-`LanguageModelV4StreamPart` mapping, the hand-written model, and the `ProviderV4` (mirroring `packages/plugins/google-antigravity/src/runtime/provider.ts`); `src/store/` holds the bounded `lru-cache` session/blob store; `src/tool-names.ts` is the pure reserved-name escaper. `createRuntime` replaces the Phase 1 throw and returns `{ provider }`; the catalog switches from `static` to `ttl`.

**Tech Stack:** Bun 1.4.0 (`bun test`, `node:http2`, `Buffer`, `crypto.randomUUID`), TypeScript, `@aio-proxy/plugin-sdk` (`LanguageModelV4`/`ProviderV4`/`RuntimeContext`/`ModelCatalog`), `@bufbuild/protobuf` (protobuf-es v2: `create`/`toBinary`/`fromBinary`/`fromJson`/`toJson`), `lru-cache`, `es-toolkit`. No `protobufjs`, no gRPC library, no `rsbuild-plugin-protobufjs`, no `@ai-sdk/*` delegate (Cursor has no `@ai-sdk/cursor`).

## Global Constraints

- Endpoints fixed: run `POST https://api2.cursor.sh` `:path /agent.v1.AgentService/Run` with `content-type: application/connect+proto` (streaming); discovery `:path /agent.v1.AgentService/GetUsableModels` with `content-type: application/proto` (unary). HTTP/1.1 is rejected (464); HTTP/2 is mandatory and requires TLS-ALPN `h2`.
- Run headers (full list): `content-type: application/connect+proto`, `connect-protocol-version: 1`, `te: trailers`, `authorization: Bearer <access>`, `x-ghost-mode: true`, `x-cursor-client-type: cli`, `x-cursor-client-version: <plaintext const>`, `x-request-id: <uuid>`. `x-cursor-client-version` is a plaintext constant (NOT a secret, NOT `source.define`); server gating of the version is unproven. Never send `x-cursor-checksum`.
- Connect frame is 5 bytes `[flags:u8][len:u32be][payload]`; `CONNECT_END_STREAM_FLAG = 0b00000010`. The end-stream frame payload is JSON; a non-empty `.error` maps to a provider envelope error.
- protobuf uses protobuf-es (`@bufbuild/protobuf`) ONLY. `src/gen/agent_pb.ts` is a vendored generated file: mark it generated (300-line limit exempt) and record provenance/license. Never hand-trim a schema subset; never add `protobufjs` or a bundler protobuf plugin.
- Exec (A-class) responses are heterogeneous per protobuf oneof case, NOT a single `rejected`: `read/ls/write/delete/diagnostics` -> that result schema's `rejected` variant; `grep` has NO rejected variant -> `GrepResultSchema` `error`; `shell` -> `ShellResultSchema` `rejected`; `shellStream` -> a `ShellStreamSchema` `exit` event (no rejected on the stream event union used here) then close; `backgroundShellSpawn` -> `rejected`; `writeShellStdin`/`fetch` -> `error: "Not implemented"`; `listMcpResources`/`readMcpResource`/`recordScreen`/`computerUse` -> empty result; `requestContextArgs` -> `requestContextResult` success; unknown `default` -> bare ack (id+execId only). `todo` never reaches exec (it is `interactionUpdate.updateTodosToolCall`); `lsp` maps to `diagnosticsArgs`.
- Suppress synthesized native tool-call blocks: OMP calls `synthesizeCursorExecToolCall` at the top of each exec branch; aio-proxy MUST NOT emit these into `LanguageModelV4` output (they would leak as caller-undeclared tool calls).
- B-class (caller/MCP) tools are stateless history continuation, NOT turn-inline results: emit an AI-SDK tool-call from `mcpArgs`, honestly suspend (close the stream, write NO fake `mcpResult`), preserve the real Cursor `conversationId` (mark `checkpointUsable = false`), and on the next inbound turn carrying tool results send `ResumeAction` while maintaining a `callId <-> toolCallId` map.
- Tool-name escaping is a pure deterministic function (no per-request map table): reserved set = `CURSOR_NATIVE_TOOL_NAMES` (`bash/read/write/delete/ls/grep/lsp/todo`), prefix = `aio_proxy__`; applied to every outbound/inbound path including `conversationState` history; `toolCallId`/`callId` pass through unchanged; case-sensitive exact match; outbound same-name collision is intentionally NOT handled.
- `turnEnded` is NOT a clean end: after it, still wait for a clean HTTP/2 `end`, parse the Connect end-stream error frame, and treat `grpc-status != "0"` (trailers) or "ended before turnEnded" as a failure rejected back to the candidate loop. finishReason: text turn -> `stop`; tool turn -> `tool-calls`.
- Outbound `clientHeartbeat` keepalive: unproven necessity for long Cursor streams; keep a 5s interval and verify at e2e. Inbound idle watchdog is out of scope.
- Multi-turn `conversationState` (+ `blobStore`) is carried by a bounded per-plugin store, NOT by the caller and NOT by affinity. Reuse `lru-cache` (`new LRUCache({ max, ttl, ttlAutopurge: true })`); keys are identity-scoped. Session affinity only reorders candidates; on affinity miss (bound provider unavailable), drop state and reopen a fresh conversation.
- Model discovery classifies and propagates HTTP status via a typed `CursorCatalogError` (retryable = network/timeout/408/429/5xx -> curated fallback from Phase 1's `staticCursorCatalog()`; 401/403/empty -> no fallback). Never collapse all failures to `null`.
- Model `metadata` must NOT set `protocol` (Cursor is not in `ProtocolId = 'openai-compatible' | 'openai-response' | 'anthropic' | 'gemini'`).
- Never place raw access/refresh tokens in logs, config, Provider ID, labels, or diagnostics.
- Every handwritten non-test file stays below 300 lines (generated `src/gen/**` is exempt). Colocate tests in same-name directories (`foo/foo.ts` + `foo/foo.test.ts`) when a module has private collaborators; otherwise sibling `foo.ts` + `foo.test.ts`. Prefer `es-toolkit` and Bun APIs; narrow imports; no new utility dependency the platform already covers.
- Write each behavior test first, run it to observe the expected failure, then add only enough production code to pass. Do not add tests that merely restate constants or static arrays.
- Commit style `feat(cursor):` / `chore(cursor):` with footer `Co-authored-by: Codex <noreply@openai.com>`. Commit per task only when the user asks; otherwise leave staged/working changes for review.
- Final verification: `bun run --filter @aio-proxy/plugin-cursor test:unit`, `bun run --filter @aio-proxy/plugin-cursor build`, then `bun run preflight`.

## Validation Gates (require a real Cursor account; encode assumptions, verify at e2e)

These are open questions from the design review. They do not block writing code, but each listed task notes the assumption it bakes in so an e2e pass can confirm or correct it.

1. B-class: does Cursor send only `toolCallStarted` (client-side execution) or also a turn-inline `mcpArgs` requiring an in-turn `mcpResult`? Decides whether stateless continuation (Tasks 13/16) is sufficient.
2. A-class all-reject: after every built-in exec is rejected, does Cursor still return coherent text and `turnEnded`, or hang / burn tokens? (Task 9 assumes coherent text; coding tasks degrade.)
3. Handshake without `requestContextResult`: truly "no content"? (Task 9 always answers; no counterexample in OMP/opencodex.)
4. Does the server gate `x-cursor-client-version`, and do long streams require the outbound heartbeat? (Task 5 sends the header; Task 16 runs the heartbeat.)
5. `conversationState`/`blobStore` persistence key, TTL, max, eviction, and affinity-miss degrade policy. (Task 7 uses TTL ~1h, max 2048, identity-scoped key; Task 16 drops-and-reopens on affinity miss.)

---

## File Structure

Phase 2 adds these files under `packages/plugins/cursor/` (Phase 1 already shipped `pkce.ts`, `jwt.ts`, `schema.ts`, `oauth.ts`, `oauth/`, `catalog.ts`, `plugin.ts`, `index.ts`):

- `src/gen/agent_pb.ts` (+ `src/gen/README.md`) — Task 2: vendored protobuf-es generated code and provenance; the only 300-line-exempt file.
- `src/wire/frame.ts` (+ `src/wire/frame.test.ts`) — Task 3: Connect 5-byte frame encode, incremental decode, end-stream error parse.
- `src/wire/unary.ts` (+ `src/wire/unary.test.ts`) — Task 4: single-message Connect body decode for the unary discovery response.
- `src/wire/transport.ts` (+ `src/wire/transport.test.ts`) — Task 5: `node:http2` run/discovery transport, run/discovery header builders, `mapH2TransportError`.
- `src/wire/index.ts` — Task 5: wire barrel (frame + transport public surface).
- `src/tool-names.ts` (+ `src/tool-names.test.ts`) — Task 6: `toWireName`/`fromWireName`, reserved set, prefix.
- `src/store/session-store.ts` (+ `src/store/session-store.test.ts`) — Task 7: bounded `lru-cache` session store, identity-scoped key, drop on affinity miss.
- `src/store/blobs.ts` (+ `src/store/blobs.test.ts`) — Task 11: content-addressed blob helpers (`createBlobId`/`blobKey`/`storeCursorBlob`/`readCursorBlob`) over the per-conversation blob `Map`.
- `src/store/index.ts` — Task 7: store barrel (session store + blob helpers).
- `src/catalog/discover.ts` (+ `src/catalog/discover.test.ts`) — Task 8: `GetUsableModels` request/response, `CursorCatalogError`, status classification, retryable curated fallback.
- `src/runtime/exec-policy.ts` (+ `src/runtime/exec-policy.test.ts`) — Task 9: per-case (A-class) exec responder; suppresses synthesized native tool-calls.
- `src/runtime/mcp-tools.ts` (+ `src/runtime/mcp-tools.test.ts`) — Task 10: caller (B-class) `McpToolDefinition` builder with `toWireName` escaping.
- `src/runtime/history/user-message.ts`, `history/history.ts`, `history/index.ts` (+ `user-message.test.ts`, `history.test.ts`) — Task 12: `LanguageModelV4Prompt` -> Cursor system/turn blobs.
- `src/runtime/run-request.ts` (+ `src/runtime/run-request.test.ts`) — Task 13: `AgentRunRequest` builder, `conversationState` reuse, `UserMessageAction`/`ResumeAction` selection.
- `src/runtime/stream/interaction.ts`, `stream/index.ts` (+ `stream/interaction.test.ts`) — Task 14: `interactionUpdate` -> `LanguageModelV4StreamPart` mapping, accumulator, finishReason.
- `src/runtime/client-messages.ts` (+ `src/runtime/client-messages.test.ts`) — Task 15: KV blob + exec + `requestContext` client-message writers (wire bytes for Task 9's pure responses).
- `src/runtime/driver.ts` (+ `src/runtime/driver.test.ts`) — Task 16: stateless turn pump driving the transport, routing server messages, producing the V4 stream.
- `src/runtime/cursor-model.ts` (+ `src/runtime/cursor-model.test.ts`) — Task 16: hand-written `LanguageModelV4` `doStream`/`doGenerate`; owns session identity + store persistence.
- `src/runtime/provider.ts` (+ `src/runtime/provider.test.ts`) — Task 17: `createCursorProviderV4` (mirror antigravity/xai `{ provider }`-only).
- `src/runtime/index.ts` — Task 17: runtime barrel + `createCursorRuntime` factory.

Phase 2 modifies:

- `packages/plugins/cursor/package.json`: add `@ai-sdk/provider`, `@bufbuild/protobuf`, `lru-cache`, `es-toolkit` deps.
- `package.json` (root): add `@bufbuild/protobuf` to `workspaces.catalog`.
- `packages/plugins/cursor/src/catalog.ts` (Task 17): ADD `discoverCursorCatalog` (dynamic `GetUsableModels` via Task 8) and re-export Task 8's retryable `initialCursorCatalogFallback`; keep the Phase 1 `staticCursorCatalog` + `CURSOR_CATALOG_TTL_MS` as the curated source.
- `packages/plugins/cursor/src/plugin.ts` (Task 17): catalog `policy` `{ kind: 'ttl', ttlMs: CURSOR_CATALOG_TTL_MS }`, `discover` -> `discoverCursorCatalog`, `createRuntime` -> `createCursorRuntime(context, dependencies)` (REMOVE the Phase 1 throw); widen `dependencies` to `CursorRuntimeDependencies`.
- `packages/plugins/cursor/src/index.ts` (Task 17): add `export * from './runtime'` / `'./store'` / `'./wire'` alongside the Phase 1 barrels.
- `packages/core/src/plugins/builtins.test.ts` (Task 17): change the Cursor catalog-policy assertion from `{ kind: 'static' }` to `{ kind: 'ttl', ttlMs: expect.any(Number) }` and assert `createRuntime` is a function (no longer throws); keep the Phase 1 localized-copy assertions unchanged.

---

### Task 1: Add protobuf-es and runtime dependencies

**Files:**
- Modify: `package.json` (root) — add `@bufbuild/protobuf` to `workspaces.catalog` (alongside `lru-cache`, `zod`).
- Modify: `packages/plugins/cursor/package.json` — add runtime dependencies.

**Interfaces:**
- Produces: `@aio-proxy/plugin-cursor` resolves `@ai-sdk/provider`, `@bufbuild/protobuf`, `lru-cache`, and `es-toolkit` via `catalog:`.
- Consumes: Phase 1 package shell (Task 6 of Phase 1).

- [x] Add `@bufbuild/protobuf` to the root `workspaces.catalog` (pick the current stable v2, e.g. `"@bufbuild/protobuf": "^2.10.2"`), keeping the object alphabetical:
  ```json
  "@bufbuild/protobuf": "^2.10.2",
  ```
- [x] Set `packages/plugins/cursor/package.json` `dependencies` to (mirror the antigravity plugin, which also ships a hand-written `ProviderV4`):
  ```json
  "dependencies": {
    "@ai-sdk/provider": "catalog:",
    "@aio-proxy/plugin-sdk": "workspace:*",
    "@bufbuild/protobuf": "catalog:",
    "es-toolkit": "catalog:",
    "lru-cache": "catalog:"
  },
  ```
- [x] Run `bun install` at repo root and confirm it succeeds and writes `bun.lock`.
- [x] Run `bun run --filter @aio-proxy/plugin-cursor build` and confirm it still builds (Phase 1 sources unchanged).
- [ ] Commit (only if the user asks).

### Task 2: Vendor the protobuf-es generated agent schema

**Files:**
- Create: `packages/plugins/cursor/src/gen/agent_pb.ts` (vendored generated protobuf-es output; 300-line limit exempt).
- Create: `packages/plugins/cursor/src/gen/README.md` (provenance + license + regeneration steps).
- Create: `packages/plugins/cursor/src/gen/agent_pb.smoke.test.ts` (a real behavior smoke test: the schema round-trips a message).

**Interfaces:**
- Produces (verified schema exports used by later tasks): `AgentClientMessageSchema`, `AgentServerMessageSchema`, `AgentRunRequestSchema`, `ConversationActionSchema`, `UserMessageActionSchema`, `ResumeActionSchema`, `ConversationStateStructureSchema`, `ModelDetailsSchema`, `RequestedModelSchema`, `RequestContextSchema`, `RequestContextResultSchema`, `RequestContextSuccessSchema`, `ExecClientMessageSchema`, `ExecClientControlMessageSchema`, `ExecClientStreamCloseSchema`, `ClientHeartbeatSchema`, `KvClientMessageSchema`, `GetBlobResultSchema`, `SetBlobResultSchema`, `McpToolDefinitionSchema`, `ReadResultSchema`, `ReadRejectedSchema`, `LsResultSchema`, `LsRejectedSchema`, `GrepResultSchema`, `GrepErrorSchema`, `WriteResultSchema`, `WriteRejectedSchema`, `DeleteResultSchema`, `DeleteRejectedSchema`, `ShellResultSchema`, `ShellRejectedSchema`, `ShellStreamSchema`, `ShellStreamExitSchema`, `DiagnosticsResultSchema`, `DiagnosticsRejectedSchema`, `BackgroundShellSpawnResultSchema`, `WriteShellStdinResultSchema`, `WriteShellStdinErrorSchema`, `FetchResultSchema`, `FetchErrorSchema`, `ListMcpResourcesExecResultSchema`, `ReadMcpResourceExecResultSchema`, `RecordScreenResultSchema`, `ComputerUseResultSchema`, `GetUsableModelsRequestSchema`, `GetUsableModelsResponseSchema`. Also the message type aliases (`AgentServerMessage`, `ExecServerMessage`, etc.) protobuf-es emits alongside each schema.
- Consumes: `@bufbuild/protobuf` and `@bufbuild/protobuf/codegenv2` (the generated file imports these).

- [x] Copy the vendored `.proto` into the repo for provenance: create `packages/plugins/cursor/src/gen/agent.proto` from `.reference/oh-my-pi/packages/ai/src/providers/cursor/proto/agent.proto` (verbatim). Record the source commit in the README.
- [x] Generate `agent_pb.ts` with protobuf-es v2 (`protoc-gen-es`, `opt: target=ts`) from that `.proto`. If codegen tooling is unavailable in this environment, vendor the already-generated file verbatim from `.reference/oh-my-pi/packages/catalog/src/discovery/cursor-gen/agent_pb.ts` (~15k lines), which was produced by `protoc-gen-es v2.10.2`. Do NOT hand-trim a subset.
- [x] Add the generated-file marker as the first line so the 300-line rule is waived, matching how the repo marks generated output:
  ```ts
  // @generated by protoc-gen-es v2.10.2 with parameter "target=ts"
  // Source: agent.proto (see ./README.md for provenance)
  ```
- [x] Write `src/gen/README.md`: upstream source path + commit, the exact `protoc-gen-es` version/options, the regeneration command, and the upstream license note. This file documents that `src/gen/**` is generated and exempt from the 300-line limit.
- [x] Write a failing smoke test that the schema actually round-trips (not a constant restatement — it exercises encode/decode):
  ```ts
  import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import { AgentClientMessageSchema, ClientHeartbeatSchema } from './agent_pb';

  test('agent_pb round-trips a heartbeat client message', () => {
    const message = create(AgentClientMessageSchema, {
      message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
    });
    const bytes = toBinary(AgentClientMessageSchema, message);
    const decoded = fromBinary(AgentClientMessageSchema, bytes);
    expect(decoded.message.case).toBe('clientHeartbeat');
  });
  ```
- [x] Run `bun run --filter @aio-proxy/plugin-cursor test:unit` and confirm the smoke test FAILS (module missing / not yet generated).
- [x] Land the generated file, then run the test again and confirm PASS.
- [x] Run `bun run --filter @aio-proxy/plugin-cursor build` to confirm the generated file type-checks in the package build.
- [ ] Commit (only if the user asks).

### Task 3: Connect 5-byte frame codec

**Files:**
- Create: `packages/plugins/cursor/src/wire/frame.ts`
- Create: `packages/plugins/cursor/src/wire/frame.test.ts`

**Interfaces:**
- Produces:
  - `CONNECT_END_STREAM_FLAG = 0b00000010`.
  - `frameConnectMessage(data: Uint8Array, flags?: number): Uint8Array` — 5-byte header + payload.
  - `class ConnectFrameDecoder { push(chunk: Uint8Array): ConnectFrame[] }` where `ConnectFrame = { flags: number; payload: Uint8Array }` — incremental decode across chunk boundaries.
  - `parseConnectEndStream(payload: Uint8Array): { error?: { code: string; message: string } }` — decode the end-stream JSON payload.
- Consumes: nothing (pure `Uint8Array`/`Buffer`).

- [x] Write failing tests for framing, incremental decode across a split boundary, and end-stream error parsing:
  ```ts
  import { expect, test } from 'bun:test';
  import {
    CONNECT_END_STREAM_FLAG,
    ConnectFrameDecoder,
    frameConnectMessage,
    parseConnectEndStream,
  } from './frame';

  test('frameConnectMessage writes flags, big-endian length, then payload', () => {
    const framed = frameConnectMessage(new Uint8Array([1, 2, 3]));
    expect(framed.length).toBe(8);
    expect(framed[0]).toBe(0);
    expect(new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(1)).toBe(3);
    expect([...framed.slice(5)]).toEqual([1, 2, 3]);
  });

  test('ConnectFrameDecoder reassembles a frame split across two chunks', () => {
    const framed = frameConnectMessage(new Uint8Array([9, 8, 7, 6]), CONNECT_END_STREAM_FLAG);
    const decoder = new ConnectFrameDecoder();
    expect(decoder.push(framed.slice(0, 3))).toEqual([]);
    const frames = decoder.push(framed.slice(3));
    expect(frames.length).toBe(1);
    expect(frames[0]?.flags).toBe(CONNECT_END_STREAM_FLAG);
    expect([...frames[0]!.payload]).toEqual([9, 8, 7, 6]);
  });

  test('parseConnectEndStream surfaces an envelope error', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ error: { code: 'resource_exhausted', message: 'quota' } }));
    expect(parseConnectEndStream(payload)).toEqual({ error: { code: 'resource_exhausted', message: 'quota' } });
    expect(parseConnectEndStream(new TextEncoder().encode('{}'))).toEqual({});
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/wire/frame.test.ts` and confirm FAIL.
- [x] Implement `frame.ts`:
  ```ts
  export const CONNECT_END_STREAM_FLAG = 0b00000010;

  export type ConnectFrame = { readonly flags: number; readonly payload: Uint8Array };

  export function frameConnectMessage(data: Uint8Array, flags = 0): Uint8Array {
    const frame = new Uint8Array(5 + data.length);
    frame[0] = flags & 0xff;
    new DataView(frame.buffer).setUint32(1, data.length);
    frame.set(data, 5);
    return frame;
  }

  export class ConnectFrameDecoder {
    #buffer = new Uint8Array(0);

    push(chunk: Uint8Array): ConnectFrame[] {
      this.#buffer = concat(this.#buffer, chunk);
      const frames: ConnectFrame[] = [];
      while (this.#buffer.length >= 5) {
        const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
        const length = view.getUint32(1);
        if (this.#buffer.length < 5 + length) break;
        frames.push({ flags: this.#buffer[0]!, payload: this.#buffer.slice(5, 5 + length) });
        this.#buffer = this.#buffer.slice(5 + length);
      }
      return frames;
    }
  }

  export function parseConnectEndStream(payload: Uint8Array): { error?: { code: string; message: string } } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return { error: { code: 'unknown', message: 'Failed to parse Connect end stream' } };
    }
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (!error) return {};
    return {
      error: {
        code: typeof error.code === 'string' ? error.code : 'unknown',
        message: typeof error.message === 'string' ? error.message : 'Unknown error',
      },
    };
  }

  function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
    const out = new Uint8Array(left.length + right.length);
    out.set(left);
    out.set(right, left.length);
    return out;
  }
  ```
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 4: Unary Connect body decode (discovery framing)

**Files:**
- Create: `packages/plugins/cursor/src/wire/unary.ts`
- Create: `packages/plugins/cursor/src/wire/unary.test.ts`

**Interfaces:**
- Produces: `decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null` — returns the first non-end-stream frame body; rejects the compression flag (`0b0000_0001`); skips end-stream frames (`0b0000_0010`).
- Consumes: nothing (pure bytes). NOTE: discovery framing differs from the run stream — a compressed frame is unsupported and returns `null`.

- [x] Write failing tests covering the body frame, a compressed-frame rejection, and a leading end-stream frame skip:
  ```ts
  import { expect, test } from 'bun:test';
  import { frameConnectMessage, CONNECT_END_STREAM_FLAG } from './frame';
  import { decodeConnectUnaryBody } from './unary';

  test('returns the first non-end-stream frame body', () => {
    const body = new Uint8Array([10, 20, 30]);
    expect([...(decodeConnectUnaryBody(frameConnectMessage(body)) ?? [])]).toEqual([10, 20, 30]);
  });

  test('returns null when the compression flag is set', () => {
    expect(decodeConnectUnaryBody(frameConnectMessage(new Uint8Array([1]), 0b0000_0001))).toBeNull();
  });

  test('skips a leading end-stream frame and returns null when only end-stream is present', () => {
    expect(decodeConnectUnaryBody(frameConnectMessage(new Uint8Array([1, 2]), CONNECT_END_STREAM_FLAG))).toBeNull();
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/wire/unary.test.ts` and confirm FAIL.
- [x] Implement `unary.ts`:
  ```ts
  export function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
    if (payload.length < 5) return null;
    let offset = 0;
    while (offset + 5 <= payload.length) {
      const flags = payload[offset]!;
      const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
      const messageLength = view.getUint32(1, false);
      const frameEnd = offset + 5 + messageLength;
      if (frameEnd > payload.length) return null;
      if ((flags & 0b0000_0001) !== 0) return null; // compression unsupported
      if ((flags & 0b0000_0010) === 0) return payload.subarray(offset + 5, frameEnd);
      offset = frameEnd;
    }
    return null;
  }
  ```
- [x] Run the test again and confirm PASS.
- [ ] Commit (only if the user asks).

### Task 5: HTTP/2 transport, run headers, and ALPN error mapping

**Files:**
- Create: `packages/plugins/cursor/src/wire/transport.ts`
- Create: `packages/plugins/cursor/src/wire/transport.test.ts`
- Create: `packages/plugins/cursor/src/wire/index.ts`

**Interfaces:**
- Produces:
  - `CURSOR_API_URL = 'https://api2.cursor.sh'`, `CURSOR_CLIENT_VERSION` (plaintext const), `CURSOR_RUN_PATH = '/agent.v1.AgentService/Run'`, `CURSOR_GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels'`.
  - `buildRunHeaders(input: { accessToken: string; requestId?: string; baseUrl?: string }): Record<string, string>`.
  - `buildDiscoveryHeaders(input: { accessToken: string }): Record<string, string>`.
  - `mapH2TransportError(error: unknown, baseUrl: string): unknown`.
  - `type CursorH2Stream = { write(frame: Uint8Array): void; end(): void; frames: AsyncIterable<import('./frame').ConnectFrame>; trailers: Promise<Record<string, string>>; }`.
  - `type CursorTransport = { openRun(input: { accessToken: string; baseUrl?: string; signal?: AbortSignal }): Promise<CursorH2Stream>; unary(input: { path: string; headers: Record<string, string>; body: Uint8Array; baseUrl?: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ status: number; body: Uint8Array }>; }`.
  - `createNodeHttp2Transport(dependencies?: { connect?: typeof import('node:http2').connect }): CursorTransport`.
- Consumes: `ConnectFrameDecoder`, `frameConnectMessage` (Task 3); `node:http2`.

- [x] Write failing tests. Inject a fake `connect` so no real socket opens; assert run headers are complete, discovery content-type differs, ALPN errors map, and framed server chunks decode into frames:
  ```ts
  import { expect, test } from 'bun:test';
  import { frameConnectMessage } from './frame';
  import {
    buildDiscoveryHeaders,
    buildRunHeaders,
    createNodeHttp2Transport,
    mapH2TransportError,
  } from './transport';

  test('run headers carry the full Connect identity set', () => {
    const headers = buildRunHeaders({ accessToken: 'tok', requestId: 'req-1' });
    expect(headers['content-type']).toBe('application/connect+proto');
    expect(headers['connect-protocol-version']).toBe('1');
    expect(headers.te).toBe('trailers');
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['x-ghost-mode']).toBe('true');
    expect(headers['x-cursor-client-type']).toBe('cli');
    expect(headers['x-cursor-client-version']).toBeString();
    expect(headers['x-request-id']).toBe('req-1');
  });

  test('discovery uses application/proto, not application/connect+proto', () => {
    expect(buildDiscoveryHeaders({ accessToken: 'tok' })['content-type']).toBe('application/proto');
  });

  test('mapH2TransportError explains an ALPN h2 negotiation failure', () => {
    const mapped = mapH2TransportError(
      Object.assign(new Error('h2 is not supported'), { code: 'ERR_HTTP2_ERROR' }),
      'https://api2.cursor.sh',
    );
    expect(mapped).toBeInstanceOf(Error);
    expect((mapped as Error).message).toMatch(/HTTP\/2/);
    expect((mapped as Error).message).toMatch(/ALPN/);
  });

  test('a non-ALPN error passes through unchanged', () => {
    const original = new Error('boom');
    expect(mapH2TransportError(original, 'https://api2.cursor.sh')).toBe(original);
  });

  test('openRun decodes framed server chunks into Connect frames', async () => {
    const fakeStream = new FakeClientHttp2Stream();
    const transport = createNodeHttp2Transport({
      connect: () => new FakeSession(fakeStream) as never,
    });
    const stream = await transport.openRun({ accessToken: 'tok' });
    const collected: number[][] = [];
    const reader = (async () => {
      for await (const frame of stream.frames) collected.push([...frame.payload]);
    })();
    fakeStream.emit('response', { ':status': 200 });
    fakeStream.emit('data', frameConnectMessage(new Uint8Array([7, 7])));
    fakeStream.emit('end');
    await reader;
    expect(collected).toEqual([[7, 7]]);
  });
  ```
  (Define minimal `FakeSession`/`FakeClientHttp2Stream` `EventEmitter` doubles in the test file: `FakeSession.request()` returns the fake stream; the stream records `write`/`end` and re-emits `response`/`data`/`end`/`trailers`. Keep them local to the test.)
- [x] Run `cd packages/plugins/cursor && bun test src/wire/transport.test.ts` and confirm FAIL.
- [x] Implement `transport.ts` (constants, header builders, `mapH2TransportError` verbatim from OMP semantics, and a thin `node:http2` wrapper turning `data` chunks into frames through `ConnectFrameDecoder`, resolving `trailers` from the h2 `trailers` event). Keep the file below 300 lines; if the fake-driven stream adapter grows, split the stream adapter into `wire/h2-stream.ts` and keep `transport.ts` as the opener:
  ```ts
  import http2 from 'node:http2';

  import { ConnectFrameDecoder, type ConnectFrame } from './frame';

  export const CURSOR_API_URL = 'https://api2.cursor.sh';
  export const CURSOR_CLIENT_VERSION = 'cli-2026.01.09-231024f';
  export const CURSOR_RUN_PATH = '/agent.v1.AgentService/Run';
  export const CURSOR_GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';

  export function buildRunHeaders(input: {
    readonly accessToken: string;
    readonly requestId?: string;
    readonly baseUrl?: string;
  }): Record<string, string> {
    return {
      'content-type': 'application/connect+proto',
      'connect-protocol-version': '1',
      te: 'trailers',
      authorization: `Bearer ${input.accessToken}`,
      'x-ghost-mode': 'true',
      'x-cursor-client-type': 'cli',
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
      'x-request-id': input.requestId ?? crypto.randomUUID(),
    };
  }

  export function buildDiscoveryHeaders(input: { readonly accessToken: string }): Record<string, string> {
    return {
      'content-type': 'application/proto',
      te: 'trailers',
      authorization: `Bearer ${input.accessToken}`,
      'x-ghost-mode': 'true',
      'x-cursor-client-type': 'cli',
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    };
  }

  export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ERR_HTTP2_ERROR' && /h2 is not supported/i.test(message)) {
      return new Error(
        `Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
          'This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate h2 via ALPN — ' +
          'typically an ALPN-stripping TLS-intercepting proxy. Front the provider with a local HTTP/2 bridge ' +
          'and set the Cursor baseUrl to it.',
      );
    }
    return error;
  }

  // ... createNodeHttp2Transport: open a session via (dependencies?.connect ?? http2.connect),
  // request({ ':method': 'POST', ':path', ...headers }), feed 'data' chunks through a
  // ConnectFrameDecoder exposed as an async iterable, resolve trailers from the 'trailers' event,
  // and wrap session/stream 'error' through mapH2TransportError. unary(): collect all body bytes,
  // read ':status' from the 'response' event, enforce timeoutMs, and destroy on abort.
  ```
  Implement `createNodeHttp2Transport` fully (the comment marks where the wrapper body goes; write the real adapter, do not leave the comment as the implementation). Add `wire/index.ts` re-exporting the frame + transport public surface.
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 6: Reserved tool-name escaping (pure, deterministic)

**Files:**
- Create: `packages/plugins/cursor/src/tool-names.ts`
- Create: `packages/plugins/cursor/src/tool-names.test.ts`

**Interfaces:**
- Produces:
  - `CURSOR_NATIVE_TOOL_NAMES: ReadonlySet<string>` = `bash, read, write, delete, ls, grep, lsp, todo`.
  - `AIO_PROXY_TOOL_PREFIX = 'aio_proxy__'`.
  - `toWireName(name: string): string` — prefix a caller tool name only when it collides with the reserved set.
  - `fromWireName(name: string): string` — strip the prefix only when the remainder is a reserved name.
- Consumes: nothing. NOTE (documented tradeoff): a caller tool literally named `aio_proxy__read` is un-escaped back to `read`; outbound same-name collision is intentionally NOT handled.

- [x] Write failing tests for the round-trip, pass-through, and the accepted boundary case:
  ```ts
  import { expect, test } from 'bun:test';
  import { fromWireName, toWireName } from './tool-names';

  test('escapes only reserved caller names and round-trips them', () => {
    expect(toWireName('read')).toBe('aio_proxy__read');
    expect(fromWireName('aio_proxy__read')).toBe('read');
    expect(toWireName('search_docs')).toBe('search_docs');
    expect(fromWireName('search_docs')).toBe('search_docs');
  });

  test('does not strip the prefix when the remainder is not reserved', () => {
    expect(fromWireName('aio_proxy__search')).toBe('aio_proxy__search');
  });

  test('matching is case-sensitive', () => {
    expect(toWireName('Read')).toBe('Read');
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/tool-names.test.ts` and confirm FAIL.
- [x] Implement `tool-names.ts`:
  ```ts
  export const CURSOR_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
    'bash',
    'read',
    'write',
    'delete',
    'ls',
    'grep',
    'lsp',
    'todo',
  ]);

  export const AIO_PROXY_TOOL_PREFIX = 'aio_proxy__';

  export function toWireName(name: string): string {
    return CURSOR_NATIVE_TOOL_NAMES.has(name) ? `${AIO_PROXY_TOOL_PREFIX}${name}` : name;
  }

  export function fromWireName(name: string): string {
    if (!name.startsWith(AIO_PROXY_TOOL_PREFIX)) return name;
    const original = name.slice(AIO_PROXY_TOOL_PREFIX.length);
    return CURSOR_NATIVE_TOOL_NAMES.has(original) ? original : name;
  }
  ```
- [x] Run the test again and confirm PASS.
- [ ] Commit (only if the user asks).

### Task 7: Bounded session + blob store

**Files:**
- Create: `packages/plugins/cursor/src/store/session-store.ts`
- Create: `packages/plugins/cursor/src/store/session-store.test.ts`
- Create: `packages/plugins/cursor/src/store/index.ts`

**Interfaces:**
- Produces:
  - `type CursorSessionState = { conversationId: string; conversationState?: Uint8Array; blobs: ReadonlyMap<string, Uint8Array>; checkpointUsable: boolean; pendingToolCalls: ReadonlyMap<string, string> }` (the `pendingToolCalls` map is `callId -> toolCallId`).
  - `sessionKey(input: { identityScope: string; logicalSessionKey: string }): string`.
  - `class CursorSessionStore { get(key: string): CursorSessionState | undefined; set(key: string, state: CursorSessionState): void; delete(key: string): void }` backed by `lru-cache`.
  - `CURSOR_SESSION_TTL_MS = 60 * 60_000`, `CURSOR_SESSION_MAX_ENTRIES = 2048`.
- Consumes: `lru-cache` (`LRUCache`). NOTE: identity-scoped key prevents cross-tenant bleed; affinity miss is handled by the model caller dropping the key (Task 16), not by the store.

- [x] Write a failing behavior test: entries round-trip, an identity-scoped key isolates tenants, and eviction past `max` drops the oldest (drive eviction deterministically with a tiny `max` via an injected option, not by writing 2048 entries):
  ```ts
  import { expect, test } from 'bun:test';
  import { CursorSessionStore, sessionKey } from './session-store';

  test('round-trips a session and isolates identity scopes', () => {
    const store = new CursorSessionStore();
    const a = sessionKey({ identityScope: 'user-a', logicalSessionKey: 's1' });
    const b = sessionKey({ identityScope: 'user-b', logicalSessionKey: 's1' });
    store.set(a, { conversationId: 'conv-a', blobs: new Map(), checkpointUsable: true, pendingToolCalls: new Map() });
    expect(store.get(a)?.conversationId).toBe('conv-a');
    expect(store.get(b)).toBeUndefined();
  });

  test('evicts the oldest entry past max', () => {
    const store = new CursorSessionStore({ max: 1 });
    store.set('k1', { conversationId: 'c1', blobs: new Map(), checkpointUsable: true, pendingToolCalls: new Map() });
    store.set('k2', { conversationId: 'c2', blobs: new Map(), checkpointUsable: true, pendingToolCalls: new Map() });
    expect(store.get('k1')).toBeUndefined();
    expect(store.get('k2')?.conversationId).toBe('c2');
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/store/session-store.test.ts` and confirm FAIL.
- [x] Implement `session-store.ts` (reuse `lru-cache`; do not hand-write prune/LRU):
  ```ts
  import { LRUCache } from 'lru-cache';

  export const CURSOR_SESSION_TTL_MS = 60 * 60_000;
  export const CURSOR_SESSION_MAX_ENTRIES = 2048;

  export type CursorSessionState = {
    readonly conversationId: string;
    readonly conversationState?: Uint8Array;
    readonly blobs: ReadonlyMap<string, Uint8Array>;
    readonly checkpointUsable: boolean;
    readonly pendingToolCalls: ReadonlyMap<string, string>;
  };

  export function sessionKey(input: { readonly identityScope: string; readonly logicalSessionKey: string }): string {
    return JSON.stringify([input.identityScope, input.logicalSessionKey]);
  }

  export class CursorSessionStore {
    readonly #cache: LRUCache<string, CursorSessionState>;

    constructor(options: { readonly max?: number; readonly ttl?: number } = {}) {
      this.#cache = new LRUCache({
        max: options.max ?? CURSOR_SESSION_MAX_ENTRIES,
        ttl: options.ttl ?? CURSOR_SESSION_TTL_MS,
        ttlAutopurge: true,
      });
    }

    get(key: string): CursorSessionState | undefined {
      return this.#cache.get(key);
    }

    set(key: string, state: CursorSessionState): void {
      this.#cache.set(key, state);
    }

    delete(key: string): void {
      this.#cache.delete(key);
    }
  }
  ```
- [x] Run the test again and confirm PASS.
- [x] Add `store/index.ts` re-exporting `session-store`.
- [ ] Commit (only if the user asks).

### Task 8: Dynamic model discovery with typed error and curated fallback

**Files:**
- Create: `packages/plugins/cursor/src/catalog/discover.ts`
- Create: `packages/plugins/cursor/src/catalog/discover.test.ts`

**Interfaces:**
- Produces:
  - `class CursorCatalogError extends Error { readonly retryable: boolean; readonly status?: number }`.
  - `discoverCursorModels(input: { accessToken: string; transport: CursorTransport; baseUrl?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ModelCatalog>`.
  - `initialCursorCatalogFallback(error: unknown): ModelCatalog | undefined` (Phase 2 version: curated snapshot only for a retryable `CursorCatalogError`).
- Consumes: `CursorTransport` + `CURSOR_GET_USABLE_MODELS_PATH` + `buildDiscoveryHeaders` (Task 5), `decodeConnectUnaryBody` (Task 4), `GetUsableModelsRequestSchema`/`GetUsableModelsResponseSchema` (Task 2), `staticCursorCatalog` (Phase 1 `catalog.ts`), `ModelCatalog`/`ModelDescriptor`. This mirrors `packages/plugins/xai-grok/src/catalog.ts` (`XAIGrokCatalogError` + `initialXAIGrokCatalogFallback`).

- [x] Write failing tests using a fake `CursorTransport.unary`: a 200 with a framed response yields model ids; 401 throws a non-retryable error and `initialCursorCatalogFallback` returns `undefined`; 503 throws retryable and the fallback returns the curated catalog; an empty model list throws non-retryable:
  ```ts
  import { create, toBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import { GetUsableModelsResponseSchema } from '../gen/agent_pb';
  import { frameConnectMessage } from '../wire/frame';
  import { CursorCatalogError, discoverCursorModels, initialCursorCatalogFallback } from './discover';

  const framed = (ids: string[]) =>
    frameConnectMessage(
      toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: ids.map((id) => ({ modelId: id })) })),
    );

  const transportWith = (status: number, body: Uint8Array) => ({
    openRun: () => Promise.reject(new Error('unused')),
    unary: () => Promise.resolve({ status, body }),
  });

  test('returns non-empty language models on success', async () => {
    const catalog = await discoverCursorModels({ accessToken: 't', transport: transportWith(200, framed(['claude-4.5-sonnet'])) as never });
    expect(catalog.language.map((m) => m.id)).toContain('claude-4.5-sonnet');
  });

  test('401 is non-retryable and yields no fallback', async () => {
    const error = await discoverCursorModels({ accessToken: 't', transport: transportWith(401, new Uint8Array()) as never }).catch((e) => e);
    expect(error).toBeInstanceOf(CursorCatalogError);
    expect((error as CursorCatalogError).retryable).toBe(false);
    expect(initialCursorCatalogFallback(error)).toBeUndefined();
  });

  test('503 is retryable and falls back to the curated catalog', async () => {
    const error = await discoverCursorModels({ accessToken: 't', transport: transportWith(503, new Uint8Array()) as never }).catch((e) => e);
    expect((error as CursorCatalogError).retryable).toBe(true);
    expect(initialCursorCatalogFallback(error)?.language.length ?? 0).toBeGreaterThan(0);
  });

  test('an empty model directory is non-retryable', async () => {
    const error = await discoverCursorModels({ accessToken: 't', transport: transportWith(200, framed([])) as never }).catch((e) => e);
    expect((error as CursorCatalogError).retryable).toBe(false);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/catalog/discover.test.ts` and confirm FAIL.
- [x] Implement `discover.ts`:
  ```ts
  import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
  import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

  import { staticCursorCatalog } from '../catalog';
  import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from '../gen/agent_pb';
  import { decodeConnectUnaryBody } from '../wire/unary';
  import { buildDiscoveryHeaders, CURSOR_GET_USABLE_MODELS_PATH, type CursorTransport } from '../wire';

  export class CursorCatalogError extends Error {
    override readonly name = 'CursorCatalogError';
    constructor(message: string, readonly retryable: boolean, readonly status?: number) {
      super(message);
    }
  }

  export async function discoverCursorModels(input: {
    readonly accessToken: string;
    readonly transport: CursorTransport;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<ModelCatalog> {
    const body = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, { customModelIds: [] }));
    let response: { status: number; body: Uint8Array };
    try {
      response = await input.transport.unary({
        path: CURSOR_GET_USABLE_MODELS_PATH,
        headers: buildDiscoveryHeaders({ accessToken: input.accessToken }),
        body,
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        timeoutMs: input.timeoutMs ?? 15_000,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (cause) {
      throw new CursorCatalogError('Cursor model discovery network failure', true, undefined, { cause });
    }
    if (response.status === 401 || response.status === 403) {
      throw new CursorCatalogError('Cursor model discovery rejected', false, response.status);
    }
    if (response.status !== 200) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new CursorCatalogError('Cursor model discovery failed', retryable, response.status);
    }
    const framed = decodeConnectUnaryBody(response.body) ?? response.body;
    let decoded: ReturnType<typeof fromBinary<typeof GetUsableModelsResponseSchema>>;
    try {
      decoded = fromBinary(GetUsableModelsResponseSchema, framed);
    } catch {
      throw new CursorCatalogError('Cursor model discovery returned invalid protobuf', true);
    }
    const language = dedupeById(decoded.models);
    if (language.length === 0) {
      throw new CursorCatalogError('Cursor model discovery returned no models', false, 200);
    }
    return { language, image: [], embedding: [], speech: [], transcription: [], reranking: [] };
  }

  export function initialCursorCatalogFallback(error: unknown): ModelCatalog | undefined {
    return error instanceof CursorCatalogError && error.retryable ? staticCursorCatalog() : undefined;
  }

  function dedupeById(models: readonly { modelId?: string; displayName?: string }[]): ModelDescriptor[] {
    const byId = new Map<string, ModelDescriptor>();
    for (const model of models) {
      const id = typeof model.modelId === 'string' ? model.modelId.trim() : '';
      if (id.length === 0 || byId.has(id)) continue;
      byId.set(id, model.displayName ? { id, displayName: model.displayName } : { id });
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
  ```
  (If protobuf-es rejects the extra `cause` option on `Error`, drop it and keep the classification; the fourth argument is only for diagnostics.) The `GetUsableModelsResponse.models` entries are `ModelDetails` messages whose protobuf fields are `model_id` (field 1) and `display_name` (field 4); protobuf-es generates the camelCase accessors `modelId` and `displayName`, which is what `dedupeById` reads above. Re-confirm against the generated `src/gen/agent_pb.ts` and adjust only if the vendored schema differs.
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 9: Built-in (A-class) exec responder

**Files:**
- Create: `packages/plugins/cursor/src/runtime/exec-policy.ts`
- Create: `packages/plugins/cursor/src/runtime/exec-policy.test.ts`

**Interfaces:**
- Produces:
  - `type ExecClientResponse = { messageCase: string; value?: unknown } | { ack: true }` — the exec reply describing which `ExecClientMessage.message` case to send (or a bare ack).
  - `buildRequestContextResult(tools: McpToolDefinition[]): { messageCase: 'requestContextResult'; value: RequestContextResult }`.
  - `respondToExec(exec: ExecServerMessage): ExecClientResponse` — pure mapping from an exec server message to the protocol-legal reply for a proxy with NO filesystem/shell. Emits NO synthesized tool-call blocks.
- Consumes: exec/result schemas from `../gen/agent_pb` (Task 2). NOTE: this is the "answer per case" fact-driven task; Task 15 (`encodeExecResponse`) serializes the chosen response to wire bytes and Task 16's driver writes the frame. Assumption (Validation Gate 2): after all-reject the model still returns coherent text; coding tasks degrade by design.

- [x] Write failing tests asserting each family maps to the right `messageCase` and oneof variant (drive with `create(ExecServerMessageSchema, ...)` inputs):
  ```ts
  import { create } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import { ExecServerMessageSchema } from '../gen/agent_pb';
  import { respondToExec } from './exec-policy';

  const exec = (messageCase: string, value: Record<string, unknown> = {}) =>
    create(ExecServerMessageSchema, { id: 'x', execId: 'e', message: { case: messageCase, value } } as never);

  test('read is rejected via ReadResult.rejected', () => {
    const response = respondToExec(exec('readArgs', { path: '/x', toolCallId: 't' }));
    expect(response).toMatchObject({ messageCase: 'readResult' });
    expect((response as { value: { result: { case: string } } }).value.result.case).toBe('rejected');
  });

  test('grep has no rejected variant and is answered with GrepResult.error', () => {
    const response = respondToExec(exec('grepArgs', { pattern: 'x', toolCallId: 't' }));
    expect(response).toMatchObject({ messageCase: 'grepResult' });
    expect((response as { value: { result: { case: string } } }).value.result.case).toBe('error');
  });

  test('fetch and writeShellStdin are Not implemented errors', () => {
    expect(respondToExec(exec('fetchArgs', { url: 'https://x' }))).toMatchObject({ messageCase: 'fetchResult' });
    expect(respondToExec(exec('writeShellStdinArgs'))).toMatchObject({ messageCase: 'writeShellStdinResult' });
  });

  test('backgroundShellSpawn is rejected; listMcpResources is an empty result', () => {
    expect((respondToExec(exec('backgroundShellSpawnArgs', { command: 'ls' })) as { value: { result: { case: string } } }).value.result.case).toBe('rejected');
    expect(respondToExec(exec('listMcpResourcesExecArgs'))).toMatchObject({ messageCase: 'listMcpResourcesExecResult' });
  });

  test('an unknown exec case is a bare ack', () => {
    expect(respondToExec(exec('someFutureArgs'))).toEqual({ ack: true });
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/exec-policy.test.ts` and confirm FAIL.
- [x] Implement `exec-policy.ts` (per-case, protocol-legal; NO `synthesizeCursorExecToolCall`). Split builders into `runtime/exec-results.ts` if the file nears 300 lines:
  ```ts
  import { create } from '@bufbuild/protobuf';
  import {
    BackgroundShellSpawnResultSchema,
    ComputerUseResultSchema,
    DeleteRejectedSchema,
    DeleteResultSchema,
    DiagnosticsRejectedSchema,
    DiagnosticsResultSchema,
    type ExecServerMessage,
    FetchErrorSchema,
    FetchResultSchema,
    GrepErrorSchema,
    GrepResultSchema,
    ListMcpResourcesExecResultSchema,
    LsRejectedSchema,
    LsResultSchema,
    type McpToolDefinition,
    ReadMcpResourceExecResultSchema,
    ReadRejectedSchema,
    ReadResultSchema,
    RecordScreenResultSchema,
    RequestContextResultSchema,
    RequestContextSchema,
    RequestContextSuccessSchema,
    ShellRejectedSchema,
    ShellResultSchema,
    ShellStreamExitSchema,
    ShellStreamSchema,
    WriteRejectedSchema,
    WriteResultSchema,
    WriteShellStdinErrorSchema,
    WriteShellStdinResultSchema,
  } from '../gen/agent_pb';

  export type ExecClientResponse = { readonly messageCase: string; readonly value?: unknown } | { readonly ack: true };

  const NOT_IMPLEMENTED = 'Not implemented';
  const NOT_AVAILABLE = 'Tool not available';

  export function buildRequestContextResult(tools: McpToolDefinition[]): { messageCase: 'requestContextResult'; value: unknown } {
    const requestContext = create(RequestContextSchema, {
      rules: [],
      repositoryInfo: [],
      tools,
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [],
      fileContents: {},
      customSubagents: [],
    });
    return {
      messageCase: 'requestContextResult',
      value: create(RequestContextResultSchema, {
        result: { case: 'success', value: create(RequestContextSuccessSchema, { requestContext }) },
      }),
    };
  }

  export function respondToExec(exec: ExecServerMessage): ExecClientResponse {
    const execCase = exec.message.case;
    const args = exec.message.value as { path?: string; url?: string; command?: string; workingDirectory?: string } | undefined;
    switch (execCase) {
      case 'readArgs':
        return { messageCase: 'readResult', value: create(ReadResultSchema, { result: { case: 'rejected', value: create(ReadRejectedSchema, { path: args?.path ?? '', reason: NOT_AVAILABLE }) } }) };
      case 'lsArgs':
        return { messageCase: 'lsResult', value: create(LsResultSchema, { result: { case: 'rejected', value: create(LsRejectedSchema, { path: args?.path ?? '', reason: NOT_AVAILABLE }) } }) };
      case 'grepArgs':
        return { messageCase: 'grepResult', value: create(GrepResultSchema, { result: { case: 'error', value: create(GrepErrorSchema, { error: NOT_AVAILABLE }) } }) };
      case 'writeArgs':
        return { messageCase: 'writeResult', value: create(WriteResultSchema, { result: { case: 'rejected', value: create(WriteRejectedSchema, { path: args?.path ?? '', reason: NOT_AVAILABLE }) } }) };
      case 'deleteArgs':
        return { messageCase: 'deleteResult', value: create(DeleteResultSchema, { result: { case: 'rejected', value: create(DeleteRejectedSchema, { path: args?.path ?? '', reason: NOT_AVAILABLE }) } }) };
      case 'diagnosticsArgs':
        return { messageCase: 'diagnosticsResult', value: create(DiagnosticsResultSchema, { result: { case: 'rejected', value: create(DiagnosticsRejectedSchema, { path: args?.path ?? '', reason: NOT_AVAILABLE }) } }) };
      case 'shellArgs':
        return { messageCase: 'shellResult', value: create(ShellResultSchema, { result: { case: 'rejected', value: create(ShellRejectedSchema, { command: args?.command ?? '', workingDirectory: args?.workingDirectory ?? '', reason: NOT_AVAILABLE, isReadonly: false }) } }) };
      case 'shellStreamArgs':
        return { messageCase: 'shellStream', value: create(ShellStreamSchema, { event: { case: 'exit', value: create(ShellStreamExitSchema, { code: 1 }) } }) };
      case 'backgroundShellSpawnArgs':
        return { messageCase: 'backgroundShellSpawnResult', value: create(BackgroundShellSpawnResultSchema, { result: { case: 'rejected', value: create(ShellRejectedSchema, { command: args?.command ?? '', workingDirectory: args?.workingDirectory ?? '', reason: NOT_IMPLEMENTED, isReadonly: false }) } }) };
      case 'writeShellStdinArgs':
        return { messageCase: 'writeShellStdinResult', value: create(WriteShellStdinResultSchema, { result: { case: 'error', value: create(WriteShellStdinErrorSchema, { error: NOT_IMPLEMENTED }) } }) };
      case 'fetchArgs':
        return { messageCase: 'fetchResult', value: create(FetchResultSchema, { result: { case: 'error', value: create(FetchErrorSchema, { url: args?.url ?? '', error: NOT_IMPLEMENTED }) } }) };
      case 'listMcpResourcesExecArgs':
        return { messageCase: 'listMcpResourcesExecResult', value: create(ListMcpResourcesExecResultSchema, {}) };
      case 'readMcpResourceExecArgs':
        return { messageCase: 'readMcpResourceExecResult', value: create(ReadMcpResourceExecResultSchema, {}) };
      case 'recordScreenArgs':
        return { messageCase: 'recordScreenResult', value: create(RecordScreenResultSchema, {}) };
      case 'computerUseArgs':
        return { messageCase: 'computerUseResult', value: create(ComputerUseResultSchema, {}) };
      default:
        return { ack: true };
    }
  }
  ```
  Verify each `*RejectedSchema`/`*ResultSchema` field name (`path`/`reason`/`command`/`workingDirectory`/`isReadonly`/`code`) against `src/gen/agent_pb.ts`; adjust any that differ. `mcpArgs` is intentionally NOT handled here — it is B-class and handled in Task 10.
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 10: Caller (B-class) MCP tool definitions

**Files:**
- Create: `packages/plugins/cursor/src/runtime/mcp-tools.ts`
- Create: `packages/plugins/cursor/src/runtime/mcp-tools.test.ts`

**Interfaces:**
- Produces: `buildMcpToolDefinitions(tools: readonly LanguageModelV4FunctionTool[] | undefined): McpToolDefinition[]` — maps every caller function tool to a Cursor `McpToolDefinition` with `toWireName` applied to `name` and `toolName`, `providerIdentifier: 'pi-agent'`, and a protobuf `Value`-encoded JSON Schema.
- Consumes: `McpToolDefinitionSchema` (Task 2), `ValueSchema` from `@bufbuild/protobuf/wkt`, `create`/`toBinary`/`fromJson` from `@bufbuild/protobuf`, `toWireName` (Task 6). `LanguageModelV4FunctionTool` is the `type: 'function'` member of `LanguageModelV4CallOptions['tools']`. NOTE (diverges from OMP): OMP DROPS caller tools whose name collides with `CURSOR_NATIVE_TOOL_NAMES`; aio-proxy instead RENAMES them via `toWireName` so a caller tool literally named `read` is advertised as `aio_proxy__read` and still works.

- [x] Write failing tests: a plain tool passes through; a reserved-name tool is escaped; a missing description becomes `''`; the `inputSchema` bytes decode back to the original JSON Schema:
  ```ts
  import { fromBinary, fromJson, toBinary } from '@bufbuild/protobuf';
  import { ValueSchema } from '@bufbuild/protobuf/wkt';
  import { expect, test } from 'bun:test';
  import { buildMcpToolDefinitions } from './mcp-tools';

  const fn = (name: string, inputSchema: Record<string, unknown>, description?: string) => ({
    type: 'function' as const,
    name,
    inputSchema,
    ...(description === undefined ? {} : { description }),
  });

  test('maps a caller tool and preserves its JSON schema through Value bytes', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const [definition] = buildMcpToolDefinitions([fn('search_docs', schema, 'Search the docs')]);
    expect(definition?.name).toBe('search_docs');
    expect(definition?.toolName).toBe('search_docs');
    expect(definition?.providerIdentifier).toBe('pi-agent');
    expect(definition?.description).toBe('Search the docs');
    const decoded = fromBinary(ValueSchema, definition!.inputSchema);
    expect(toBinary(ValueSchema, decoded)).toEqual(toBinary(ValueSchema, fromJson(ValueSchema, schema as never)));
  });

  test('escapes a reserved caller name and defaults a missing description', () => {
    const [definition] = buildMcpToolDefinitions([fn('read', { type: 'object' })]);
    expect(definition?.name).toBe('aio_proxy__read');
    expect(definition?.toolName).toBe('aio_proxy__read');
    expect(definition?.description).toBe('');
  });

  test('returns an empty array for no tools', () => {
    expect(buildMcpToolDefinitions(undefined)).toEqual([]);
    expect(buildMcpToolDefinitions([])).toEqual([]);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/mcp-tools.test.ts` and confirm FAIL.
- [x] Implement `mcp-tools.ts`:
  ```ts
  import { create, fromJson, toBinary } from '@bufbuild/protobuf';
  import { ValueSchema } from '@bufbuild/protobuf/wkt';

  import { McpToolDefinitionSchema, type McpToolDefinition } from '../gen/agent_pb';
  import { toWireName } from '../tool-names';

  export type LanguageModelV4FunctionTool = {
    readonly type: 'function';
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: unknown;
  };

  const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, required: [] } as const;

  export function buildMcpToolDefinitions(
    tools: readonly LanguageModelV4FunctionTool[] | undefined,
  ): McpToolDefinition[] {
    if (!tools || tools.length === 0) return [];
    return tools
      .filter((tool) => tool.type === 'function')
      .map((tool) => {
        const wireName = toWireName(tool.name);
        const schemaValue =
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? (tool.inputSchema as Record<string, unknown>)
            : EMPTY_OBJECT_SCHEMA;
        const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, schemaValue as never));
        return create(McpToolDefinitionSchema, {
          name: wireName,
          description: tool.description ?? '',
          providerIdentifier: 'pi-agent',
          toolName: wireName,
          inputSchema,
        });
      });
  }
  ```
  Confirm `McpToolDefinition`'s field names (`name`/`description`/`providerIdentifier`/`toolName`/`inputSchema`) against `src/gen/agent_pb.ts`; adjust if the generated names differ.
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 11: Content-addressed blob store helpers

**Files:**
- Create: `packages/plugins/cursor/src/store/blobs.ts`
- Create: `packages/plugins/cursor/src/store/blobs.test.ts`

**Interfaces:**
- Produces:
  - `createBlobId(data: Uint8Array): Uint8Array` — `sha256(data)`.
  - `blobKey(blobId: Uint8Array): string` — lowercase hex of the id (the `Map` key).
  - `storeCursorBlob(store: Map<string, Uint8Array>, data: Uint8Array): Uint8Array` — writes and returns the id.
  - `readCursorBlob(store: ReadonlyMap<string, Uint8Array>, blobId: Uint8Array): Uint8Array | undefined`.
- Consumes: `node:crypto` `createHash`, `node:buffer` `Buffer` (Bun-provided). NOTE: the KV server handler (Task 15) and history builder (Task 12) share this store; the hex key matches Cursor's `Buffer.from(blobId).toString('hex')`.

- [x] Write a failing behavior test: identical data produces one stable id, round-trips, and a missing id reads `undefined`:
  ```ts
  import { expect, test } from 'bun:test';
  import { blobKey, createBlobId, readCursorBlob, storeCursorBlob } from './blobs';

  test('stores content-addressed blobs and round-trips them', () => {
    const store = new Map<string, Uint8Array>();
    const data = new TextEncoder().encode('hello');
    const id = storeCursorBlob(store, data);
    expect(storeCursorBlob(store, new TextEncoder().encode('hello'))).toEqual(id);
    expect(store.size).toBe(1);
    expect([...(readCursorBlob(store, id) ?? [])]).toEqual([...data]);
  });

  test('a missing blob reads undefined and keys are hex', () => {
    const store = new Map<string, Uint8Array>();
    const id = createBlobId(new Uint8Array([1, 2, 3]));
    expect(readCursorBlob(store, id)).toBeUndefined();
    expect(blobKey(id)).toMatch(/^[0-9a-f]{64}$/);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/store/blobs.test.ts` and confirm FAIL.
- [x] Implement `blobs.ts`:
  ```ts
  import { Buffer } from 'node:buffer';
  import { createHash } from 'node:crypto';

  export function createBlobId(data: Uint8Array): Uint8Array {
    return new Uint8Array(createHash('sha256').update(data).digest());
  }

  export function blobKey(blobId: Uint8Array): string {
    return Buffer.from(blobId).toString('hex');
  }

  export function storeCursorBlob(store: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
    const blobId = createBlobId(data);
    store.set(blobKey(blobId), data);
    return blobId;
  }

  export function readCursorBlob(store: ReadonlyMap<string, Uint8Array>, blobId: Uint8Array): Uint8Array | undefined {
    return store.get(blobKey(blobId));
  }
  ```
- [x] Run the test again and confirm PASS.
- [x] Add `store/blobs` to `store/index.ts`.
- [ ] Commit (only if the user asks).

### Task 12: Conversation history builder (`LanguageModelV4Prompt` -> Cursor blobs)

**Files:**
- Create: `packages/plugins/cursor/src/runtime/history/user-message.ts`
- Create: `packages/plugins/cursor/src/runtime/history/user-message.test.ts`
- Create: `packages/plugins/cursor/src/runtime/history/history.ts`
- Create: `packages/plugins/cursor/src/runtime/history/history.test.ts`
- Create: `packages/plugins/cursor/src/runtime/history/index.ts`

**Interfaces:**
- Produces (from `user-message.ts`):
  - `createCursorUserMessage(content: readonly LanguageModelV4TextPart[] | readonly (LanguageModelV4TextPart | LanguageModelV4FilePart)[], text: string, messageId?: string): UserMessage`.
  - `extractV4UserText(content): string`, `v4UserHasImages(content): boolean`.
- Produces (from `history.ts`):
  - `findActiveUserMessageIndex(prompt: LanguageModelV4Prompt): number`.
  - `buildCursorSystemPromptJsons(prompt: LanguageModelV4Prompt): string[]`.
  - `buildRootPromptMessagesJson(prompt, systemPromptIds: Uint8Array[], blobStore: Map<string, Uint8Array>, activeUserMessageIndex?): Uint8Array[]`.
  - `buildConversationTurns(prompt, blobStore: Map<string, Uint8Array>, activeUserMessageIndex?): Uint8Array[]`.
- Consumes: `LanguageModelV4Prompt`/`LanguageModelV4Message`/`LanguageModelV4TextPart`/`LanguageModelV4FilePart`/`LanguageModelV4ToolResultPart` (`@ai-sdk/provider`); `UserMessageSchema`, `SelectedContextSchema`, `SelectedImageSchema`, `ConversationStepSchema`, `AssistantMessageSchema`, `AgentConversationTurnStructureSchema`, `ConversationTurnStructureSchema`, `type UserMessage` (Task 2); `storeCursorBlob` (Task 11). NOTE (faithful to OMP): history flattens assistant `tool-call` parts to nothing and `tool-result` parts to `"[Tool Result]\n<text>"` / `"[Tool Error]\n<text>"` assistant text; no structured tool NAME is serialized into history, so tool-name escaping lives only in the outbound tool defs (Task 10) and the inbound stream mapping (Task 14). The active user message is EXCLUDED from history (it rides in the action, Task 13).

- [x] Write failing tests for `user-message.ts` (text join, image → `SelectedImage` with base64 `data` case):
  ```ts
  import { fromBinary, toBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import { UserMessageSchema } from '../../gen/agent_pb';
  import { createCursorUserMessage, extractV4UserText, v4UserHasImages } from './user-message';

  test('joins text parts and detects images', () => {
    const content = [
      { type: 'text' as const, text: 'hello' },
      { type: 'text' as const, text: 'world' },
    ];
    expect(extractV4UserText(content)).toBe('hello\nworld');
    expect(v4UserHasImages(content)).toBe(false);
  });

  test('encodes an inline image into a SelectedImage data blob', () => {
    const pngBytes = new Uint8Array([1, 2, 3, 4]);
    const content = [
      { type: 'text' as const, text: 'look' },
      { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: pngBytes } },
    ];
    expect(v4UserHasImages(content)).toBe(true);
    const message = createCursorUserMessage(content, 'look', 'mid-1');
    const decoded = fromBinary(UserMessageSchema, toBinary(UserMessageSchema, message));
    expect(decoded.text).toBe('look');
    expect(decoded.messageId).toBe('mid-1');
    const image = decoded.selectedContext?.selectedImages?.[0];
    expect(image?.mimeType).toBe('image/png');
    expect(image?.dataOrBlobId.case).toBe('data');
    expect([...(image?.dataOrBlobId.value as Uint8Array)]).toEqual([1, 2, 3, 4]);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/history/user-message.test.ts` and confirm FAIL.
- [x] Implement `user-message.ts`:
  ```ts
  import { Buffer } from 'node:buffer';

  import type { LanguageModelV4FilePart, LanguageModelV4TextPart } from '@ai-sdk/provider';
  import { create } from '@bufbuild/protobuf';

  import { SelectedContextSchema, SelectedImageSchema, type UserMessage, UserMessageSchema } from '../../gen/agent_pb';

  type UserContentPart = LanguageModelV4TextPart | LanguageModelV4FilePart;

  export function extractV4UserText(content: readonly UserContentPart[]): string {
    return content
      .filter((part): part is LanguageModelV4TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }

  export function v4UserHasImages(content: readonly UserContentPart[]): boolean {
    return content.some((part) => part.type === 'file' && isImageMediaType(part.mediaType));
  }

  export function createCursorUserMessage(
    content: readonly UserContentPart[],
    text: string,
    messageId: string = crypto.randomUUID(),
  ): UserMessage {
    const images = extractV4Images(content);
    return create(UserMessageSchema, {
      text,
      messageId,
      ...(images.length > 0 ? { selectedContext: create(SelectedContextSchema, { selectedImages: images }) } : {}),
    });
  }

  function extractV4Images(content: readonly UserContentPart[]) {
    const images: ReturnType<typeof create<typeof SelectedImageSchema>>[] = [];
    for (const part of content) {
      if (part.type !== 'file' || !isImageMediaType(part.mediaType) || part.data.type !== 'data') continue;
      const bytes = part.data.data instanceof Uint8Array ? part.data.data : Uint8Array.from(Buffer.from(part.data.data, 'base64'));
      images.push(
        create(SelectedImageSchema, {
          uuid: crypto.randomUUID(),
          mimeType: part.mediaType,
          dataOrBlobId: { case: 'data', value: bytes },
        }),
      );
    }
    return images;
  }

  function isImageMediaType(mediaType: string): boolean {
    return mediaType === 'image' || mediaType.startsWith('image/');
  }
  ```
  Confirm `SelectedImage.dataOrBlobId` oneof case name (`data`) and `mimeType`/`uuid` field names against `src/gen/agent_pb.ts`.
- [x] Run the test again and confirm PASS.
- [x] Write failing tests for `history.ts` (system default, active-user exclusion, tool-result flattening). Decode blobs through a local `Map`:
  ```ts
  import { fromBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
  import { AgentConversationTurnStructureSchema, ConversationStepSchema, ConversationTurnStructureSchema } from '../../gen/agent_pb';
  import { buildConversationTurns, buildCursorSystemPromptJsons, buildRootPromptMessagesJson, findActiveUserMessageIndex } from './history';

  const decodeJson = (store: Map<string, Uint8Array>, id: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(store.get(Buffer.from(id).toString('hex'))!));

  test('emits a default system prompt when none is present', () => {
    expect(buildCursorSystemPromptJsons([])).toEqual([JSON.stringify({ role: 'system', content: 'You are a helpful assistant.' })]);
  });

  test('root prompt json excludes the active user turn and flattens tool results', () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { type: 'text', value: 'RESULT' } }] },
      { role: 'user', content: [{ type: 'text', text: 'second (active)' }] },
    ];
    const store = new Map<string, Uint8Array>();
    const activeIndex = findActiveUserMessageIndex(prompt);
    const systemIds = buildCursorSystemPromptJsons(prompt).map((json) => storeForTest(store, json));
    const rootIds = buildRootPromptMessagesJson(prompt, systemIds, store, activeIndex);
    const decoded = rootIds.map((id) => decodeJson(store, id));
    expect(decoded).toContainEqual({ role: 'user', content: [{ type: 'text', text: 'first' }] });
    expect(decoded).toContainEqual({ role: 'user', content: [{ type: 'text', text: '[Tool Result]\nRESULT' }] });
    expect(JSON.stringify(decoded)).not.toContain('second (active)');
  });

  test('builds one agent turn from a completed user/assistant pair', () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2 active' }] },
    ];
    const store = new Map<string, Uint8Array>();
    const turns = buildConversationTurns(prompt, store, findActiveUserMessageIndex(prompt));
    expect(turns.length).toBe(1);
    const turn = fromBinary(ConversationTurnStructureSchema, store.get(Buffer.from(turns[0]!).toString('hex'))!);
    expect(turn.turn.case).toBe('agentConversationTurn');
  });
  ```
  (Add a local `storeForTest(store, json)` that hex-stores `TextEncoder().encode(json)` and returns its sha256 id, or import `storeCursorBlob` from `../../store/blobs`.)
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/history/history.test.ts` and confirm FAIL.
- [x] Implement `history.ts` (port `buildCursorSystemPromptJsons`/`buildRootPromptMessagesJson`/`buildConversationTurns` to the V4 prompt; flatten tool results; exclude the active user index). Keep below 300 lines; if it grows, split the turn builder into `history/turns.ts`:
  ```ts
  import type { LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultPart } from '@ai-sdk/provider';
  import { create, toBinary } from '@bufbuild/protobuf';

  import { storeCursorBlob } from '../../store/blobs';
  import {
    AgentConversationTurnStructureSchema,
    AssistantMessageSchema,
    ConversationStepSchema,
    ConversationTurnStructureSchema,
    UserMessageSchema,
  } from '../../gen/agent_pb';
  import { createCursorUserMessage, extractV4UserText, v4UserHasImages } from './user-message';

  export function findActiveUserMessageIndex(prompt: LanguageModelV4Prompt): number {
    for (let index = prompt.length - 1; index >= 0; index -= 1) {
      if (prompt[index]!.role === 'user') return index;
    }
    return -1;
  }

  export function buildCursorSystemPromptJsons(prompt: LanguageModelV4Prompt): string[] {
    const systemPrompts = prompt
      .filter((message): message is Extract<LanguageModelV4Message, { role: 'system' }> => message.role === 'system')
      .map((message) => message.content.trim())
      .filter((content) => content.length > 0);
    if (systemPrompts.length === 0) return [JSON.stringify({ role: 'system', content: 'You are a helpful assistant.' })];
    return systemPrompts.map((content) => JSON.stringify({ role: 'system', content }));
  }

  export function buildRootPromptMessagesJson(
    prompt: LanguageModelV4Prompt,
    systemPromptIds: Uint8Array[],
    blobStore: Map<string, Uint8Array>,
    activeUserMessageIndex = findActiveUserMessageIndex(prompt),
  ): Uint8Array[] {
    const entries: Uint8Array[] = [...systemPromptIds];
    const pushJson = (value: unknown) => entries.push(storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(value))));
    for (let index = 0; index < prompt.length; index += 1) {
      if (index === activeUserMessageIndex) break;
      const message = prompt[index]!;
      if (message.role === 'user') {
        const text = extractV4UserText(message.content);
        if (text.length > 0) pushJson({ role: 'user', content: [{ type: 'text', text }] });
      } else if (message.role === 'assistant') {
        const text = assistantText(message.content);
        if (text.length > 0) pushJson({ role: 'assistant', content: [{ type: 'text', text }] });
      } else if (message.role === 'tool') {
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue;
          const text = toolResultText(part);
          if (text.length > 0) pushJson({ role: 'user', content: [{ type: 'text', text }] });
        }
      }
    }
    return entries;
  }

  export function buildConversationTurns(
    prompt: LanguageModelV4Prompt,
    blobStore: Map<string, Uint8Array>,
    activeUserMessageIndex = findActiveUserMessageIndex(prompt),
  ): Uint8Array[] {
    const turns: Uint8Array[] = [];
    let index = 0;
    while (index < prompt.length) {
      const message = prompt[index]!;
      if (message.role !== 'user') {
        index += 1;
        continue;
      }
      if (index === activeUserMessageIndex) break;
      const text = extractV4UserText(message.content);
      if (text.length === 0 && !v4UserHasImages(message.content)) {
        index += 1;
        continue;
      }
      const userMessageBlobId = storeCursorBlob(
        blobStore,
        toBinary(UserMessageSchema, createCursorUserMessage(message.content, text)),
      );
      const stepBlobIds: Uint8Array[] = [];
      index += 1;
      while (index < prompt.length && prompt[index]!.role !== 'user') {
        const stepMessage = prompt[index]!;
        const stepText = stepMessage.role === 'assistant' ? assistantText(stepMessage.content) : toolMessageText(stepMessage);
        if (stepText.length > 0) {
          stepBlobIds.push(
            storeCursorBlob(
              blobStore,
              toBinary(
                ConversationStepSchema,
                create(ConversationStepSchema, { message: { case: 'assistantMessage', value: create(AssistantMessageSchema, { text: stepText }) } }),
              ),
            ),
          );
        }
        index += 1;
      }
      const turn = create(ConversationTurnStructureSchema, {
        turn: { case: 'agentConversationTurn', value: create(AgentConversationTurnStructureSchema, { userMessage: userMessageBlobId, steps: stepBlobIds }) },
      });
      turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
    }
    return turns;
  }

  function assistantText(content: Extract<LanguageModelV4Message, { role: 'assistant' }>['content']): string {
    return content
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }

  function toolMessageText(message: LanguageModelV4Message): string {
    if (message.role !== 'tool') return '';
    return message.content
      .filter((part): part is LanguageModelV4ToolResultPart => part.type === 'tool-result')
      .map(toolResultText)
      .filter((text) => text.length > 0)
      .join('\n');
  }

  function toolResultText(part: LanguageModelV4ToolResultPart): string {
    const output = part.output;
    const body =
      output.type === 'text' || output.type === 'error-text'
        ? output.value
        : output.type === 'json' || output.type === 'error-json'
          ? JSON.stringify(output.value)
          : output.type === 'content'
            ? output.value.map((entry) => (entry.type === 'text' ? entry.text : `[${entry.type}]`)).join('\n')
            : '';
    const trimmed = body.trim();
    if (trimmed.length === 0) return '';
    const prefix = output.type === 'error-text' || output.type === 'error-json' ? '[Tool Error]' : '[Tool Result]';
    return `${prefix}\n${trimmed}`;
  }
  ```
  Confirm the V4 `content` tool-result output union member names (`text`/`json`/`error-text`/`error-json`/`content`/`execution-denied`) against `@ai-sdk/provider@4.0.3`; the `content` member's entries include `{ type: 'text', text }` and media entries.
- [x] Run the test again and confirm PASS.
- [x] Add `history/index.ts` re-exporting `user-message` + `history`.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 13: `AgentRunRequest` builder

**Files:**
- Create: `packages/plugins/cursor/src/runtime/run-request.ts`
- Create: `packages/plugins/cursor/src/runtime/run-request.test.ts`

**Interfaces:**
- Produces:
  - `type CursorRunState = { conversationId: string; blobStore: Map<string, Uint8Array>; conversationState?: ConversationStateStructure }`.
  - `buildCursorRunRequestBytes(input: { prompt: LanguageModelV4Prompt; wireModelId: string; displayModelId: string; displayName: string; maxMode: boolean; state: CursorRunState }): { requestBytes: Uint8Array; conversationState: ConversationStateStructure }`.
- Consumes: Task 12 history builders; `ConversationActionSchema`, `UserMessageActionSchema`, `ResumeActionSchema`, `ConversationStateStructureSchema`, `ModelDetailsSchema`, `RequestedModelSchema`, `AgentRunRequestSchema`, `AgentClientMessageSchema` (Task 2); `create`/`toBinary`; `Buffer` (`node:buffer`). NOTE: tools are NOT placed in the run request (OMP sends them later via the `requestContext` exec handshake — Task 9/15). A trailing `tool`-role message (caller returned tool results) selects `ResumeAction`; a trailing `user` message selects `UserMessageAction` and is excluded from history.

- [x] Write failing tests: a fresh user turn produces `userMessageAction` and excludes the active user text from history; a resume (trailing tool results, no trailing user) produces `resumeAction`:
  ```ts
  import { fromBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
  import { AgentClientMessageSchema } from '../gen/agent_pb';
  import { buildCursorRunRequestBytes } from './run-request';

  const decodeRun = (bytes: Uint8Array) => {
    const client = fromBinary(AgentClientMessageSchema, bytes);
    if (client.message.case !== 'runRequest') throw new Error('expected runRequest');
    return client.message.value;
  };

  test('a trailing user message selects userMessageAction', () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
    ];
    const { requestBytes } = buildCursorRunRequestBytes({
      prompt, wireModelId: 'claude-4.5-sonnet', displayModelId: 'claude-4.5-sonnet', displayName: 'Claude', maxMode: false,
      state: { conversationId: 'conv-1', blobStore: new Map() },
    });
    const run = decodeRun(requestBytes);
    expect(run.action?.action.case).toBe('userMessageAction');
    expect(run.conversationId).toBe('conv-1');
    expect(run.modelDetails?.modelId).toBe('claude-4.5-sonnet');
  });

  test('a trailing tool result selects resumeAction', () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: { q: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search_docs', output: { type: 'json', value: { ok: true } } }] },
    ];
    const { requestBytes } = buildCursorRunRequestBytes({
      prompt, wireModelId: 'claude-4.5-sonnet', displayModelId: 'claude-4.5-sonnet', displayName: 'Claude', maxMode: true,
      state: { conversationId: 'conv-2', blobStore: new Map() },
    });
    const run = decodeRun(requestBytes);
    expect(run.action?.action.case).toBe('resumeAction');
    expect(run.requestedModel?.maxMode).toBe(true);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/run-request.test.ts` and confirm FAIL.
- [x] Implement `run-request.ts`:
  ```ts
  import { Buffer } from 'node:buffer';

  import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
  import { create, toBinary } from '@bufbuild/protobuf';

  import { storeCursorBlob } from '../store/blobs';
  import {
    AgentClientMessageSchema,
    AgentRunRequestSchema,
    ConversationActionSchema,
    type ConversationStateStructure,
    ConversationStateStructureSchema,
    ModelDetailsSchema,
    RequestedModelSchema,
    ResumeActionSchema,
    UserMessageActionSchema,
  } from '../gen/agent_pb';
  import {
    buildConversationTurns,
    buildCursorSystemPromptJsons,
    buildRootPromptMessagesJson,
    createCursorUserMessage,
    extractV4UserText,
    v4UserHasImages,
  } from './history';

  export type CursorRunState = {
    readonly conversationId: string;
    readonly blobStore: Map<string, Uint8Array>;
    readonly conversationState?: ConversationStateStructure;
  };

  export function buildCursorRunRequestBytes(input: {
    readonly prompt: LanguageModelV4Prompt;
    readonly wireModelId: string;
    readonly displayModelId: string;
    readonly displayName: string;
    readonly maxMode: boolean;
    readonly state: CursorRunState;
  }): { requestBytes: Uint8Array; conversationState: ConversationStateStructure } {
    const { prompt, state } = input;
    const blobStore = state.blobStore;
    const systemPromptIds = buildCursorSystemPromptJsons(prompt).map((json) =>
      storeCursorBlob(blobStore, new TextEncoder().encode(json)),
    );

    const activeIndex = prompt.length - 1;
    const active = prompt[activeIndex];
    const activeUserContent = active?.role === 'user' ? active.content : undefined;
    const activeText = activeUserContent ? extractV4UserText(activeUserContent) : '';
    const isUserAction =
      activeUserContent !== undefined && (activeText.length > 0 || v4UserHasImages(activeUserContent));

    const action = create(ConversationActionSchema, {
      action: isUserAction
        ? { case: 'userMessageAction', value: create(UserMessageActionSchema, { userMessage: createCursorUserMessage(activeUserContent!, activeText) }) }
        : { case: 'resumeAction', value: create(ResumeActionSchema, {}) },
    });

    const historyActiveIndex = isUserAction ? activeIndex : -1;
    const turns = buildConversationTurns(prompt, blobStore, historyActiveIndex);
    const rootPromptMessagesJson = buildRootPromptMessagesJson(prompt, systemPromptIds, blobStore, historyActiveIndex);

    const cachedHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
    const promptHeadMatches =
      cachedHead.length === systemPromptIds.length &&
      systemPromptIds.every((id, index) => Buffer.from(cachedHead[index]!).equals(id));
    const baseState =
      state.conversationState && promptHeadMatches
        ? state.conversationState
        : create(ConversationStateStructureSchema, {
            rootPromptMessagesJson: systemPromptIds,
            turns: [],
            todos: [],
            pendingToolCalls: [],
            previousWorkspaceUris: [],
            fileStates: {},
            fileStatesV2: {},
            summaryArchives: [],
            turnTimings: [],
            subagentStates: {},
            selfSummaryCount: 0,
            readPaths: [],
          });

    const conversationState = create(ConversationStateStructureSchema, { ...baseState, rootPromptMessagesJson, turns });
    const runRequest = create(AgentRunRequestSchema, {
      conversationState,
      action,
      modelDetails: create(ModelDetailsSchema, {
        modelId: input.wireModelId,
        displayModelId: input.displayModelId,
        displayName: input.displayName,
        ...(input.maxMode ? { maxMode: true } : {}),
      }),
      requestedModel: create(RequestedModelSchema, { modelId: input.wireModelId, maxMode: input.maxMode }),
      conversationId: state.conversationId,
    });
    const clientMessage = create(AgentClientMessageSchema, { message: { case: 'runRequest', value: runRequest } });
    return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), conversationState };
  }
  ```
  Confirm `ConversationStateStructure` field names (`rootPromptMessagesJson`/`turns`/`todos`/`pendingToolCalls`/`previousWorkspaceUris`/`fileStates`/`fileStatesV2`/`summaryArchives`/`turnTimings`/`subagentStates`/`selfSummaryCount`/`readPaths`) against `src/gen/agent_pb.ts` and drop any that the generated message does not expose.
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 14: Server-message -> `LanguageModelV4StreamPart` mapper

**Files:**
- Create: `packages/plugins/cursor/src/runtime/stream/interaction.ts`
- Create: `packages/plugins/cursor/src/runtime/stream/interaction.test.ts`
- Create: `packages/plugins/cursor/src/runtime/stream/index.ts`

**Interfaces:**
- Produces:
  - `type CursorStreamAccumulator = { textId?: string; reasoningId?: string; tool?: { callId: string; toolName: string; buffer: string; started: boolean }; outputTokens: number; sawTurnEnded: boolean; toolCalls: number }`.
  - `createCursorStreamAccumulator(): CursorStreamAccumulator`.
  - `mapInteractionUpdate(update: InteractionUpdate, accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[]` — pure mapping of ONE `interactionUpdate` payload into ordered V4 parts; mutates the accumulator.
  - `finalizeCursorStream(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[]` — closes any open text/reasoning/tool block and emits the terminal `finish` part with structured `usage` + `finishReason`.
- Consumes: `InteractionUpdate`, `ValueSchema` (`@bufbuild/protobuf/wkt`), `fromBinary`/`toJson` (`@bufbuild/protobuf`); `LanguageModelV4StreamPart`/`LanguageModelV4Usage`/`LanguageModelV4FinishReason`/`LanguageModelV4ToolCall` (`@ai-sdk/provider`); `fromWireName` (Task 6). NOTE: `argsTextDelta` (partial/delta updates) is a CUMULATIVE snapshot — diff via `snapshot.startsWith(buffer) ? snapshot.slice(buffer.length) : snapshot`. Emit exactly one V4 `tool-call` per completed MCP call; apply `fromWireName` to `toolName`. `finishReason.unified` is `tool-calls` when any tool call was emitted, else `stop`. NO synthesized native tool-call blocks. `todo`/native tool starts (non-MCP `toolCallStarted`) are dropped (they are surfaced as A-class exec, not model output).

- [x] Write failing tests: text deltas emit start/delta and finalize emits end+finish(stop); a full MCP tool sequence emits `tool-input-*` and one `tool-call` with an un-escaped name and finish(tool-calls); token deltas accumulate into `usage.outputTokens.total`:
  ```ts
  import { create, toBinary } from '@bufbuild/protobuf';
  import { ValueSchema } from '@bufbuild/protobuf/wkt';
  import { expect, test } from 'bun:test';
  import { InteractionUpdateSchema } from '../../gen/agent_pb';
  import { createCursorStreamAccumulator, finalizeCursorStream, mapInteractionUpdate } from './interaction';

  const update = (value: Record<string, unknown>) => create(InteractionUpdateSchema, { message: value } as never);
  const argValue = (json: unknown) => toBinary(ValueSchema, create(ValueSchema, { kind: { case: 'stringValue', value: JSON.stringify(json) } }));

  test('text deltas stream and finalize as a stop finish', () => {
    const accumulator = createCursorStreamAccumulator();
    const parts = [
      ...mapInteractionUpdate(update({ case: 'textDelta', value: { text: 'Hel' } }), accumulator),
      ...mapInteractionUpdate(update({ case: 'textDelta', value: { text: 'lo' } }), accumulator),
      ...finalizeCursorStream(accumulator),
    ];
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => (p as { delta: string }).delta)).toEqual(['Hel', 'lo']);
    const finish = parts.at(-1) as { type: 'finish'; finishReason: { unified: string }; usage: unknown };
    expect(finish.type).toBe('finish');
    expect(finish.finishReason.unified).toBe('stop');
  });

  test('a completed MCP tool call emits one tool-call with an un-escaped name and tool-calls finish', () => {
    const accumulator = createCursorStreamAccumulator();
    const started = update({ case: 'toolCallStarted', value: { callId: 'c1', toolCall: { tool: { case: 'mcpToolCall', value: { args: { name: 'aio_proxy__read', toolCallId: 'c1', args: {} } } } } } });
    const delta = update({ case: 'partialToolCall', value: { callId: 'c1', argsTextDelta: '{"path":"/x"}' } });
    const completed = update({ case: 'toolCallCompleted', value: { callId: 'c1', toolCall: { tool: { case: 'mcpToolCall', value: { args: { name: 'aio_proxy__read', toolCallId: 'c1', args: { path: argValue('/x') } } } } } } });
    const parts = [
      ...mapInteractionUpdate(started, accumulator),
      ...mapInteractionUpdate(delta, accumulator),
      ...mapInteractionUpdate(completed, accumulator),
      ...finalizeCursorStream(accumulator),
    ];
    const toolCall = parts.find((p) => p.type === 'tool-call') as { toolName: string; toolCallId: string; input: string } | undefined;
    expect(toolCall?.toolName).toBe('read');
    expect(toolCall?.toolCallId).toBe('c1');
    expect(JSON.parse(toolCall!.input)).toMatchObject({ path: '/x' });
    expect((parts.at(-1) as { finishReason: { unified: string } }).finishReason.unified).toBe('tool-calls');
  });

  test('token deltas accumulate into usage.outputTokens.total', () => {
    const accumulator = createCursorStreamAccumulator();
    mapInteractionUpdate(update({ case: 'tokenDelta', value: { tokens: 7 } }), accumulator);
    mapInteractionUpdate(update({ case: 'tokenDelta', value: { tokens: 5 } }), accumulator);
    const finish = finalizeCursorStream(accumulator).at(-1) as { usage: { outputTokens: { total: number } } };
    expect(finish.usage.outputTokens.total).toBe(12);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/stream/interaction.test.ts` and confirm FAIL.
- [x] Implement `interaction.ts` (pure per-update mapping; cumulative arg diff; MCP-only tool-calls; drop native/todo starts). Split arg decoding into `stream/mcp-args.ts` if the file nears 300 lines:
  ```ts
  import type {
    LanguageModelV4FinishReason,
    LanguageModelV4StreamPart,
    LanguageModelV4Usage,
  } from '@ai-sdk/provider';
  import { fromBinary, toJson } from '@bufbuild/protobuf';
  import { ValueSchema } from '@bufbuild/protobuf/wkt';

  import type { InteractionUpdate } from '../../gen/agent_pb';
  import { fromWireName } from '../../tool-names';

  export type CursorStreamAccumulator = {
    textId?: string;
    reasoningId?: string;
    tool?: { callId: string; toolName: string; buffer: string; started: boolean };
    outputTokens: number;
    sawTurnEnded: boolean;
    toolCalls: number;
  };

  export function createCursorStreamAccumulator(): CursorStreamAccumulator {
    return { outputTokens: 0, sawTurnEnded: false, toolCalls: 0 };
  }

  export function mapInteractionUpdate(
    update: InteractionUpdate,
    accumulator: CursorStreamAccumulator,
  ): LanguageModelV4StreamPart[] {
    const message = update.message;
    switch (message.case) {
      case 'textDelta':
        return openAndDeltaText(accumulator, message.value.text ?? '');
      case 'thinkingDelta':
        return openAndDeltaReasoning(accumulator, message.value.text ?? '');
      case 'thinkingCompleted':
        return closeReasoning(accumulator);
      case 'toolCallStarted':
        return startMcpTool(accumulator, message.value);
      case 'partialToolCall':
      case 'toolCallDelta':
        return deltaMcpTool(accumulator, message.value);
      case 'toolCallCompleted':
        return completeMcpTool(accumulator, message.value);
      case 'tokenDelta':
        accumulator.outputTokens += message.value.tokens ?? 0;
        return [];
      case 'turnEnded':
        accumulator.sawTurnEnded = true;
        return [];
      default:
        return [];
    }
  }

  export function finalizeCursorStream(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = [];
    parts.push(...closeText(accumulator));
    parts.push(...closeReasoning(accumulator));
    parts.push(...flushIncompleteTool(accumulator));
    parts.push({ type: 'finish', usage: usageOf(accumulator), finishReason: finishReasonOf(accumulator) });
    return parts;
  }

  function openAndDeltaText(accumulator: CursorStreamAccumulator, delta: string): LanguageModelV4StreamPart[] {
    if (delta.length === 0) return [];
    const parts: LanguageModelV4StreamPart[] = [];
    parts.push(...closeReasoning(accumulator));
    if (accumulator.textId === undefined) {
      accumulator.textId = crypto.randomUUID();
      parts.push({ type: 'text-start', id: accumulator.textId });
    }
    parts.push({ type: 'text-delta', id: accumulator.textId, delta });
    return parts;
  }

  function closeText(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
    if (accumulator.textId === undefined) return [];
    const id = accumulator.textId;
    accumulator.textId = undefined;
    return [{ type: 'text-end', id }];
  }

  function openAndDeltaReasoning(accumulator: CursorStreamAccumulator, delta: string): LanguageModelV4StreamPart[] {
    if (delta.length === 0) return [];
    const parts: LanguageModelV4StreamPart[] = [];
    parts.push(...closeText(accumulator));
    if (accumulator.reasoningId === undefined) {
      accumulator.reasoningId = crypto.randomUUID();
      parts.push({ type: 'reasoning-start', id: accumulator.reasoningId });
    }
    parts.push({ type: 'reasoning-delta', id: accumulator.reasoningId, delta });
    return parts;
  }

  function closeReasoning(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
    if (accumulator.reasoningId === undefined) return [];
    const id = accumulator.reasoningId;
    accumulator.reasoningId = undefined;
    return [{ type: 'reasoning-end', id }];
  }

  function startMcpTool(accumulator: CursorStreamAccumulator, value: unknown): LanguageModelV4StreamPart[] {
    const mcp = mcpArgsOf(value);
    if (mcp === undefined) return []; // native/todo starts are surfaced as exec, not model output
    const parts: LanguageModelV4StreamPart[] = [];
    parts.push(...closeText(accumulator));
    parts.push(...closeReasoning(accumulator));
    const toolName = fromWireName(mcp.name);
    accumulator.tool = { callId: mcp.toolCallId, toolName, buffer: '', started: true };
    return [...parts, { type: 'tool-input-start', id: mcp.toolCallId, toolName }];
  }

  function deltaMcpTool(accumulator: CursorStreamAccumulator, value: { argsTextDelta?: string; callId?: string }): LanguageModelV4StreamPart[] {
    const tool = accumulator.tool;
    if (tool === undefined) return [];
    const snapshot = value.argsTextDelta ?? '';
    const chunk = snapshot.startsWith(tool.buffer) ? snapshot.slice(tool.buffer.length) : snapshot;
    if (chunk.length === 0) return [];
    tool.buffer += chunk;
    return [{ type: 'tool-input-delta', id: tool.callId, delta: chunk }];
  }

  function completeMcpTool(accumulator: CursorStreamAccumulator, value: unknown): LanguageModelV4StreamPart[] {
    const tool = accumulator.tool;
    if (tool === undefined) return [];
    const mcp = mcpArgsOf(value);
    const decoded = mcp ? decodeMcpArgsMap(mcp.args) : undefined;
    const input = decoded !== undefined ? JSON.stringify(decoded) : tool.buffer.length > 0 ? tool.buffer : '{}';
    accumulator.tool = undefined;
    accumulator.toolCalls += 1;
    return [
      { type: 'tool-input-end', id: tool.callId },
      { type: 'tool-call', toolCallId: tool.callId, toolName: tool.toolName, input },
    ];
  }

  function flushIncompleteTool(accumulator: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
    const tool = accumulator.tool;
    if (tool === undefined) return [];
    accumulator.tool = undefined;
    accumulator.toolCalls += 1;
    return [
      { type: 'tool-input-end', id: tool.callId },
      { type: 'tool-call', toolCallId: tool.callId, toolName: tool.toolName, input: tool.buffer.length > 0 ? tool.buffer : '{}' },
    ];
  }

  function mcpArgsOf(value: unknown): { name: string; toolCallId: string; args?: Record<string, Uint8Array> } | undefined {
    const toolCall = (value as { toolCall?: { tool?: { case?: string; value?: unknown } } } | undefined)?.toolCall;
    if (toolCall?.tool?.case !== 'mcpToolCall') return undefined;
    const args = (toolCall.tool.value as { args?: { name?: string; toolCallId?: string; args?: Record<string, Uint8Array> } } | undefined)?.args;
    if (!args) return undefined;
    return { name: args.name ?? '', toolCallId: args.toolCallId && args.toolCallId.length > 0 ? args.toolCallId : crypto.randomUUID(), ...(args.args === undefined ? {} : { args: args.args }) };
  }

  function decodeMcpArgsMap(args: Record<string, Uint8Array> | undefined): Record<string, unknown> | undefined {
    if (!args) return undefined;
    const decoded: Record<string, unknown> = {};
    for (const [key, bytes] of Object.entries(args)) decoded[key] = decodeMcpArgValue(bytes);
    return decoded;
  }

  function decodeMcpArgValue(bytes: Uint8Array): unknown {
    try {
      const json = toJson(ValueSchema, fromBinary(ValueSchema, bytes));
      if (typeof json === 'string') return safeJson(json);
      return json;
    } catch {
      return safeJson(new TextDecoder().decode(bytes));
    }
  }

  function safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function usageOf(accumulator: CursorStreamAccumulator): LanguageModelV4Usage {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: accumulator.outputTokens, text: undefined, reasoning: undefined },
    };
  }

  function finishReasonOf(accumulator: CursorStreamAccumulator): LanguageModelV4FinishReason {
    return accumulator.toolCalls > 0 ? { unified: 'tool-calls', raw: undefined } : { unified: 'stop', raw: undefined };
  }
  ```
  Confirm the exact structured shapes of `LanguageModelV4Usage` (`inputTokens`/`outputTokens` sub-objects) and `LanguageModelV4FinishReason` (`{ unified, raw }`) against `@ai-sdk/provider@4.0.3`; adjust field names if the installed version differs. Verify `InteractionUpdate.message` case names (`textDelta`/`thinkingDelta`/`thinkingCompleted`/`toolCallStarted`/`partialToolCall`/`toolCallDelta`/`toolCallCompleted`/`tokenDelta`/`turnEnded`) and the `ToolCall.tool` oneof `mcpToolCall` case against `src/gen/agent_pb.ts`.
- [x] Run the test again and confirm PASS.
- [x] Add `stream/index.ts` re-exporting the accumulator + mappers.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 15: Client-message writers (KV blob + exec + requestContext)

**Files:**
- Create: `packages/plugins/cursor/src/runtime/client-messages.ts`
- Create: `packages/plugins/cursor/src/runtime/client-messages.test.ts`

**Interfaces:**
- Produces:
  - `encodeKvResponse(kv: KvServerMessage, blobStore: Map<string, Uint8Array>): Uint8Array | undefined` — answers `getBlobArgs`/`setBlobArgs` against the shared blob store; returns framed `AgentClientMessage` bytes (already `frameConnectMessage`-wrapped), or `undefined` for an unknown KV case.
  - `encodeExecResponse(exec: ExecServerMessage, requestContextTools: McpToolDefinition[]): Uint8Array` — routes `requestContextArgs` to `buildRequestContextResult`, otherwise `respondToExec` (Task 9); serializes the chosen `ExecClientMessage` case (or a bare id+execId ack) and frames it.
- Consumes: `KvClientMessageSchema`, `GetBlobResultSchema`, `SetBlobResultSchema`, `ExecClientMessageSchema`, `AgentClientMessageSchema`, `type KvServerMessage`, `type ExecServerMessage`, `type McpToolDefinition` (Task 2); `respondToExec`/`buildRequestContextResult` (Task 9); `frameConnectMessage` (Task 3); `blobKey` (Task 11); `create`/`toBinary`. NOTE: this is where Task 9's pure `ExecClientResponse` becomes wire bytes; keeping it separate keeps `exec-policy.ts` free of transport concerns.

- [x] Write failing tests: a `getBlobArgs` hit returns the stored bytes; a `setBlobArgs` writes the store and returns a `setBlobResult`; `requestContextArgs` yields a `requestContextResult`; a `readArgs` exec yields a `readResult`; an unknown exec yields a bare ack (round-trip decode the framed bytes by stripping the 5-byte header):
  ```ts
  import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import { AgentClientMessageSchema, ExecServerMessageSchema, GetBlobArgsSchema, KvServerMessageSchema, SetBlobArgsSchema } from '../gen/agent_pb';
  import { encodeExecResponse, encodeKvResponse } from './client-messages';

  const unframe = (framed: Uint8Array) => fromBinary(AgentClientMessageSchema, framed.subarray(5));
  const blobKeyHex = (id: Uint8Array) => Buffer.from(id).toString('hex');

  test('getBlobArgs returns the stored blob', () => {
    const blobId = new Uint8Array([9, 9, 9]);
    const store = new Map<string, Uint8Array>([[blobKeyHex(blobId), new TextEncoder().encode('DATA')]]);
    const kv = create(KvServerMessageSchema, { id: 3, message: { case: 'getBlobArgs', value: create(GetBlobArgsSchema, { blobId }) } });
    const client = unframe(encodeKvResponse(kv, store)!);
    expect(client.message.case).toBe('kvClientMessage');
  });

  test('setBlobArgs writes the store', () => {
    const store = new Map<string, Uint8Array>();
    const blobId = new Uint8Array([1, 2]);
    const kv = create(KvServerMessageSchema, { id: 4, message: { case: 'setBlobArgs', value: create(SetBlobArgsSchema, { blobId, blobData: new Uint8Array([7]) }) } });
    encodeKvResponse(kv, store);
    expect(store.get(blobKeyHex(blobId))).toEqual(new Uint8Array([7]));
  });

  test('requestContextArgs is answered with a requestContextResult exec', () => {
    const exec = create(ExecServerMessageSchema, { id: 1, execId: 'e', message: { case: 'requestContextArgs', value: {} } } as never);
    const client = unframe(encodeExecResponse(exec, []));
    expect(client.message.case).toBe('execClientMessage');
    const inner = client.message.value;
    if (client.message.case !== 'execClientMessage') throw new Error('unreachable');
    expect(inner.message.case).toBe('requestContextResult');
  });

  test('an unknown exec case sends a bare ack (id + execId, no typed result)', () => {
    const exec = create(ExecServerMessageSchema, { id: 2, execId: 'z', message: { case: 'someFutureArgs', value: {} } } as never);
    const client = unframe(encodeExecResponse(exec, []));
    if (client.message.case !== 'execClientMessage') throw new Error('unreachable');
    expect(client.message.value.id).toBe(2);
    expect(client.message.value.execId).toBe('z');
    expect(client.message.value.message.case).toBeUndefined();
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/client-messages.test.ts` and confirm FAIL.
- [x] Implement `client-messages.ts`:
  ```ts
  import { create, toBinary } from '@bufbuild/protobuf';

  import { blobKey } from '../store/blobs';
  import {
    AgentClientMessageSchema,
    ExecClientMessageSchema,
    type ExecServerMessage,
    GetBlobResultSchema,
    KvClientMessageSchema,
    type KvServerMessage,
    type McpToolDefinition,
    SetBlobResultSchema,
  } from '../gen/agent_pb';
  import { frameConnectMessage } from '../wire/frame';
  import { buildRequestContextResult, respondToExec } from './exec-policy';

  export function encodeKvResponse(kv: KvServerMessage, blobStore: Map<string, Uint8Array>): Uint8Array | undefined {
    if (kv.message.case === 'getBlobArgs') {
      const data = blobStore.get(blobKey(kv.message.value.blobId));
      const response = create(KvClientMessageSchema, {
        id: kv.id,
        message: { case: 'getBlobResult', value: create(GetBlobResultSchema, data ? { blobData: data } : {}) },
      });
      return frame({ case: 'kvClientMessage', value: response });
    }
    if (kv.message.case === 'setBlobArgs') {
      blobStore.set(blobKey(kv.message.value.blobId), kv.message.value.blobData);
      const response = create(KvClientMessageSchema, { id: kv.id, message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) } });
      return frame({ case: 'kvClientMessage', value: response });
    }
    return undefined;
  }

  export function encodeExecResponse(exec: ExecServerMessage, requestContextTools: McpToolDefinition[]): Uint8Array {
    const response = exec.message.case === 'requestContextArgs' ? buildRequestContextResult(requestContextTools) : respondToExec(exec);
    if ('ack' in response) {
      const ack = create(ExecClientMessageSchema, { id: exec.id, execId: exec.execId });
      return frame({ case: 'execClientMessage', value: ack });
    }
    const execClient = create(ExecClientMessageSchema, {
      id: exec.id,
      execId: exec.execId,
      message: { case: response.messageCase, value: response.value } as never,
    });
    return frame({ case: 'execClientMessage', value: execClient });
  }

  function frame(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]['message']): Uint8Array {
    const client = create(AgentClientMessageSchema, { message } as never);
    return frameConnectMessage(toBinary(AgentClientMessageSchema, client));
  }
  ```
  Confirm `KvServerMessage`/`ExecClientMessage`/`ExecServerMessage` field + case names against `src/gen/agent_pb.ts` (`getBlobArgs`/`setBlobArgs`/`getBlobResult`/`setBlobResult`/`kvClientMessage`/`execClientMessage`/`requestContextArgs`/`requestContextResult`/`blobId`/`blobData`/`execId`).
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 16: Cursor turn driver and hand-written `LanguageModelV4`

**Files:**
- Create: `packages/plugins/cursor/src/runtime/driver.ts`
- Create: `packages/plugins/cursor/src/runtime/driver.test.ts`
- Create: `packages/plugins/cursor/src/runtime/cursor-model.ts`
- Create: `packages/plugins/cursor/src/runtime/cursor-model.test.ts`

**Interfaces:**
- Produces (from `driver.ts`):
  - `type CursorTurnResult = { conversationState: ConversationStateStructure; checkpointUsable: boolean; pendingToolCalls: Map<string, string>; blobStore: Map<string, Uint8Array> }`.
  - `runCursorTurn(input: { transport: CursorTransport; accessToken: string; baseUrl?: string; signal?: AbortSignal; requestBytes: Uint8Array; initialConversationState: ConversationStateStructure; requestContextTools: McpToolDefinition[]; blobStore: Map<string, Uint8Array>; heartbeatMs?: number }): { stream: ReadableStream<LanguageModelV4StreamPart>; result: Promise<CursorTurnResult> }` — opens the run stream, writes the framed request, pumps `ConnectFrame`s, routes each `AgentServerMessage`, and enqueues mapped V4 parts. `interactionUpdate` -> `mapInteractionUpdate`; `kvServerMessage` -> `encodeKvResponse` write; `execServerMessage` -> `encodeExecResponse` write; `conversationCheckpointUpdate` -> latest `conversationState`. Honors `sawTurnEnded` + clean `end` + `grpc-status`.
- Produces (from `cursor-model.ts`):
  - `type CursorModelRuntime = { transport: CursorTransport; credentials: CredentialPort<CursorCredential>; sessionStore: CursorSessionStore; credentialOptions?: CursorOAuthDependencies; model: { wireModelId: string; displayModelId: string; displayName: string; maxMode: boolean }; baseUrl?: string; now?: () => number }`.
  - `createCursorLanguageModel(modelId: string, runtime: CursorModelRuntime): LanguageModelV4` — `specificationVersion: 'v4'`, `provider: 'cursor-oauth'`, `supportedUrls: {}`, `doStream` (real transport-driven stream), `doGenerate` (drain `doStream`). `metadata` is NOT set here (routing owns metadata; a model must never claim `protocol`).
- Consumes: `runCursorTurn` (this task); `buildCursorRunRequestBytes`/`CursorRunState` (Task 13); `buildMcpToolDefinitions` (Task 10); `createCursorStreamAccumulator`/`mapInteractionUpdate`/`finalizeCursorStream` (Task 14); `encodeKvResponse`/`encodeExecResponse` (Task 15); `frameConnectMessage`/`parseConnectEndStream` (Task 3); `CursorSessionStore`/`sessionKey`/`CursorSessionState` (Task 7); `currentCursorCredential`/`CursorCredential` (Phase 1); `takeAioProxyOptions` precedent (`google-antigravity/src/runtime/private-options.ts`); `LanguageModelV4`/`LanguageModelV4CallOptions`/`LanguageModelV4StreamPart`/`LanguageModelV4FunctionTool` (`@ai-sdk/provider`); `fromBinary` + `AgentServerMessageSchema` (Task 2).

**Global constraints:** The driver holds NO module-level state — all conversation/blob state lives in the caller-supplied `blobStore` and the returned `CursorTurnResult`, which `cursor-model.ts` persists into the Task 7 `CursorSessionStore` (bounded `lru-cache`, identity-scoped key). Session identity = `sessionKey({ identityScope, logicalSessionKey })` where `logicalSessionKey = providerOptions.aioProxy.logicalRequest.session.key` and `identityScope = credential.subject ?? sha256(accessToken).slice(0,16)` (never the raw token). B-class suspend: when the mapper emits any `tool-call`, close the stream, write NO fake `mcpResult`, keep the real `conversationId`, set `checkpointUsable = false`, and record the `callId <-> toolCallId` map for the next turn's `ResumeAction` (Task 13). `turnEnded` is not a clean end: still wait for h2 `end` + a `grpc-status === '0'` trailer, else reject to the candidate loop. Never log tokens.

- [x] Write failing tests for `driver.ts` using a fake `CursorTransport` (reuse the `FakeClientHttp2Stream` pattern from Task 5): a text turn emits `text-start`/`text-delta`/`text-end`/`finish(stop)` and resolves `result`; a `kvServerMessage.getBlobArgs` triggers a framed `write`; a stream that ends without `turnEnded` rejects `result`.
  ```ts
  import { create, toBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import {
    AgentServerMessageSchema,
    ConversationStateStructureSchema,
    InteractionUpdateSchema,
  } from '../gen/agent_pb';
  import { frameConnectMessage } from '../wire/frame';
  import type { ConnectFrame } from '../wire/frame';
  import type { CursorTransport, CursorH2Stream } from '../wire/transport';
  import { runCursorTurn } from './driver';

  function frameServer(value: Record<string, unknown>): Uint8Array {
    const message = create(AgentServerMessageSchema, { message: value } as never);
    return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
  }

  function fakeTransport(frames: Uint8Array[], options: { turnEnded?: boolean } = {}): {
    transport: CursorTransport;
    writes: Uint8Array[];
  } {
    const writes: Uint8Array[] = [];
    const framePayloads: ConnectFrame[] = frames.map((bytes) => ({ flags: 0, payload: bytes.subarray(5) }));
    const stream: CursorH2Stream = {
      write: (frame) => writes.push(frame),
      end: () => {},
      frames: (async function* () {
        for (const frame of framePayloads) yield frame;
      })(),
      trailers: Promise.resolve({ 'grpc-status': '0' }),
    };
    return {
      writes,
      transport: {
        openRun: () => Promise.resolve(stream),
        unary: () => Promise.reject(new Error('unused')),
      },
    };
  }

  const textFrame = (text: string) =>
    frameServer({ case: 'interactionUpdate', value: create(InteractionUpdateSchema, { message: { case: 'textDelta', value: { text } } } as never) });
  const turnEndedFrame = () =>
    frameServer({ case: 'interactionUpdate', value: create(InteractionUpdateSchema, { message: { case: 'turnEnded', value: {} } } as never) });

  test('a text turn streams parts and resolves the turn result', async () => {
    const { transport } = fakeTransport([textFrame('Hi'), turnEndedFrame()]);
    const { stream, result } = runCursorTurn({
      transport,
      accessToken: 'tok',
      requestBytes: new Uint8Array([1]),
      initialConversationState: create(ConversationStateStructureSchema, {}),
      requestContextTools: [],
      blobStore: new Map(),
      heartbeatMs: 0,
    });
    const parts: string[] = [];
    for await (const part of stream as unknown as AsyncIterable<{ type: string }>) parts.push(part.type);
    await result;
    expect(parts).toContain('text-delta');
    expect(parts.at(-1)).toBe('finish');
  });

  test('rejects when the stream ends before turnEnded', async () => {
    const { transport } = fakeTransport([textFrame('Hi')]);
    const { stream, result } = runCursorTurn({
      transport,
      accessToken: 'tok',
      requestBytes: new Uint8Array([1]),
      initialConversationState: create(ConversationStateStructureSchema, {}),
      requestContextTools: [],
      blobStore: new Map(),
      heartbeatMs: 0,
    });
    for await (const _ of stream as unknown as AsyncIterable<unknown>) void _;
    await expect(result).rejects.toThrow(/before turnEnded/i);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/driver.test.ts` and confirm FAIL.
- [x] Implement `driver.ts` (no module state; frame the outbound request; heartbeat only when `heartbeatMs > 0`; the mapper owns the `finish` part):
  ```ts
  import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

  import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';

  import {
    AgentClientMessageSchema,
    AgentServerMessageSchema,
    ClientHeartbeatSchema,
    type ConversationStateStructure,
    type ExecServerMessage,
    type KvServerMessage,
    type McpToolDefinition,
  } from '../gen/agent_pb';
  import { CONNECT_END_STREAM_FLAG, frameConnectMessage, parseConnectEndStream } from '../wire/frame';
  import type { CursorTransport } from '../wire/transport';
  import { encodeExecResponse, encodeKvResponse } from './client-messages';
  import { createCursorStreamAccumulator, finalizeCursorStream, mapInteractionUpdate } from './stream';

  export type CursorTurnResult = {
    readonly conversationState: ConversationStateStructure;
    readonly checkpointUsable: boolean;
    readonly pendingToolCalls: Map<string, string>;
    readonly blobStore: Map<string, Uint8Array>;
  };

  export function runCursorTurn(input: {
    readonly transport: CursorTransport;
    readonly accessToken: string;
    readonly baseUrl?: string;
    readonly signal?: AbortSignal;
    readonly requestBytes: Uint8Array;
    readonly initialConversationState: ConversationStateStructure;
    readonly requestContextTools: readonly McpToolDefinition[];
    readonly blobStore: Map<string, Uint8Array>;
    readonly heartbeatMs?: number;
  }): { stream: ReadableStream<LanguageModelV4StreamPart>; result: Promise<CursorTurnResult> } {
    const accumulator = createCursorStreamAccumulator();
    const pendingToolCalls = new Map<string, string>();
    let conversationState = input.initialConversationState;
    let settle!: (result: CursorTurnResult) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<CursorTurnResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
          const h2 = await input.transport.openRun({
            accessToken: input.accessToken,
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          h2.write(frameConnectMessage(input.requestBytes));
          if (input.heartbeatMs && input.heartbeatMs > 0) {
            heartbeat = setInterval(() => h2.write(heartbeatFrame()), input.heartbeatMs);
          }
          let sawTurnEnded = false;
          let endStreamError: string | undefined;
          for await (const frame of h2.frames) {
            if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
              endStreamError = parseConnectEndStream(frame.payload).error?.message;
              continue;
            }
            const server = fromBinary(AgentServerMessageSchema, frame.payload);
            const message = server.message;
            if (message.case === 'interactionUpdate') {
              for (const part of mapInteractionUpdate(message.value, accumulator)) controller.enqueue(part);
              if (message.value.message?.case === 'turnEnded') sawTurnEnded = true;
            } else if (message.case === 'kvServerMessage') {
              const reply = encodeKvResponse(message.value as KvServerMessage, input.blobStore);
              if (reply !== undefined) h2.write(reply);
            } else if (message.case === 'execServerMessage') {
              h2.write(encodeExecResponse(message.value as ExecServerMessage, [...input.requestContextTools]));
            } else if (message.case === 'conversationCheckpointUpdate') {
              conversationState = message.value as ConversationStateStructure;
            }
          }
          const trailers = await h2.trailers;
          if (endStreamError !== undefined) throw new Error(`Cursor stream error: ${endStreamError}`);
          if (trailers['grpc-status'] !== undefined && trailers['grpc-status'] !== '0') {
            throw new Error(`Cursor gRPC status ${trailers['grpc-status']}: ${trailers['grpc-message'] ?? ''}`);
          }
          if (!sawTurnEnded) throw new Error('Cursor stream ended before turnEnded');
          for (const part of finalizeCursorStream(accumulator)) controller.enqueue(part);
          controller.close();
          settle({
            conversationState,
            checkpointUsable: accumulator.toolCalls === 0,
            pendingToolCalls,
            blobStore: input.blobStore,
          });
        } catch (error) {
          controller.error(error);
          fail(error);
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat);
        }
      },
    });
    return { stream, result };
  }

  function heartbeatFrame(): Uint8Array {
    const message = create(AgentClientMessageSchema, {
      message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
    });
    return frameConnectMessage(toBinary(AgentClientMessageSchema, message));
  }
  ```
  Confirm `AgentServerMessage.message` case names (`interactionUpdate`/`kvServerMessage`/`execServerMessage`/`conversationCheckpointUpdate`) and `ClientHeartbeatSchema` against `src/gen/agent_pb.ts`. If the driver + heartbeat helper approaches 300 lines, move `heartbeatFrame` next to the Task 15 writers; do not inline module state.
- [x] Run the test again and confirm PASS.
- [x] Write failing tests for `cursor-model.ts` with a fake transport + fake `CredentialPort` + real `CursorSessionStore`: `doStream` returns a stream whose parts include `finish`; the run request is built from the prompt (assert the fake transport received a non-empty framed write); a fresh conversation stores state under the identity-scoped session key; a second call with the same `session.key` reuses the stored `conversationId`.
  ```ts
  import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
  import { expect, test } from 'bun:test';
  import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
  import {
    AgentClientMessageSchema,
    AgentServerMessageSchema,
    InteractionUpdateSchema,
  } from '../gen/agent_pb';
  import { frameConnectMessage } from '../wire/frame';
  import type { ConnectFrame } from '../wire/frame';
  import type { CursorTransport, CursorH2Stream } from '../wire/transport';
  import { CursorSessionStore } from '../store/session-store';
  import { createCursorLanguageModel } from './cursor-model';

  const server = (value: Record<string, unknown>) => {
    const message = create(AgentServerMessageSchema, { message: value } as never);
    return { flags: 0, payload: toBinary(AgentServerMessageSchema, message) } satisfies ConnectFrame;
  };
  const text = (t: string) => server({ case: 'interactionUpdate', value: create(InteractionUpdateSchema, { message: { case: 'textDelta', value: { text: t } } } as never) });
  const turnEnded = () => server({ case: 'interactionUpdate', value: create(InteractionUpdateSchema, { message: { case: 'turnEnded', value: {} } } as never) });

  function makeTransport(): { transport: CursorTransport; runs: Uint8Array[][] } {
    const runs: Uint8Array[][] = [];
    const transport: CursorTransport = {
      openRun: () => {
        const writes: Uint8Array[] = [];
        runs.push(writes);
        const stream: CursorH2Stream = {
          write: (frame) => writes.push(frame),
          end: () => {},
          frames: (async function* () {
            yield text('ok');
            yield turnEnded();
          })(),
          trailers: Promise.resolve({ 'grpc-status': '0' }),
        };
        return Promise.resolve(stream);
      },
      unary: () => Promise.reject(new Error('unused')),
    };
    return { transport, runs };
  }

  const credentials = {
    get: async () => ({ accessToken: 'tok', refreshToken: 'r', expiresAt: Number.MAX_SAFE_INTEGER, subject: 'user-1' }),
    refresh: async () => ({ accessToken: 'tok', refreshToken: 'r', expiresAt: Number.MAX_SAFE_INTEGER, subject: 'user-1' }),
  } as never;

  const callOptions = (): LanguageModelV4CallOptions => ({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    providerOptions: { aioProxy: { logicalRequest: { requestId: 'r1', session: { key: 'sha256:abc', source: 'body-conversation' } } } },
  }) as never;

  test('doStream returns a finishing stream and persists session state', async () => {
    const { transport, runs } = makeTransport();
    const sessionStore = new CursorSessionStore();
    const model = createCursorLanguageModel('claude-4.5-sonnet', {
      transport,
      credentials,
      sessionStore,
      model: { wireModelId: 'claude-4.5-sonnet', displayModelId: 'claude-4.5-sonnet', displayName: 'Claude 4.5 Sonnet', maxMode: false },
    });
    const { stream } = await model.doStream(callOptions());
    const types: string[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      types.push(value.type);
    }
    expect(types.at(-1)).toBe('finish');
    expect(runs[0]?.length).toBeGreaterThan(0);
    const first = fromBinary(AgentClientMessageSchema, runs[0]![0]!.subarray(5));
    expect(first.message.case).toBe('runRequest');
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/cursor-model.test.ts` and confirm FAIL.
- [x] Implement `cursor-model.ts` (build request via Task 13, drive via `runCursorTurn`, persist to the session store on completion; a tool-turn keeps `checkpointUsable=false`). Extract the private-options reader into `runtime/private-options.ts` if `cursor-model.ts` nears 300 lines:
  ```ts
  import { createHash } from 'node:crypto';

  import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4FunctionTool,
    SharedV4ProviderOptions,
  } from '@ai-sdk/provider';
  import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
  import { type CredentialPort, type LogicalRequestContext, zod } from '@aio-proxy/plugin-sdk';

  import { ConversationStateStructureSchema } from '../gen/agent_pb';
  import { currentCursorCredential, type CursorCredential, type CursorOAuthDependencies } from '../oauth';
  import { CursorSessionStore, sessionKey, type CursorSessionState } from '../store/session-store';
  import { runCursorTurn } from './driver';
  import { buildCursorRunRequestBytes, type CursorRunState } from './run-request';
  import { buildMcpToolDefinitions } from './mcp-tools';

  export type CursorModelRuntime = {
    readonly transport: import('../wire/transport').CursorTransport;
    readonly credentials: CredentialPort<CursorCredential>;
    readonly sessionStore: CursorSessionStore;
    readonly credentialOptions?: CursorOAuthDependencies;
    readonly model: { readonly wireModelId: string; readonly displayModelId: string; readonly displayName: string; readonly maxMode: boolean };
    readonly baseUrl?: string;
    readonly now?: () => number;
  };

  const sessionSchema = zod.custom<LogicalRequestContext>((value) => {
    const session = (value as { session?: unknown })?.session as { key?: unknown } | undefined;
    return typeof session?.key === 'string' && session.key.startsWith('sha256:');
  });

  function logicalSessionKey(providerOptions: SharedV4ProviderOptions | undefined): string | undefined {
    const parsed = sessionSchema.safeParse((providerOptions ?? {}).aioProxy?.logicalRequest);
    return parsed.success ? parsed.data.session.key : undefined;
  }

  function functionTools(options: LanguageModelV4CallOptions): LanguageModelV4FunctionTool[] {
    return (options.tools ?? []).filter((tool): tool is LanguageModelV4FunctionTool => tool.type === 'function');
  }

  export function createCursorLanguageModel(modelId: string, runtime: CursorModelRuntime): LanguageModelV4 {
    const doStream: LanguageModelV4['doStream'] = async (options) => {
      const credential = await currentCursorCredential(runtime.credentials, {
        ...runtime.credentialOptions,
        ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      });
      const identityScope = credential.subject ?? createHash('sha256').update(credential.accessToken).digest('hex').slice(0, 16);
      const logicalKey = logicalSessionKey(options.providerOptions);
      const storeKey = logicalKey === undefined ? undefined : sessionKey({ identityScope, logicalSessionKey: logicalKey });
      const prior = storeKey === undefined ? undefined : runtime.sessionStore.get(storeKey);
      const conversationId = prior?.conversationId ?? crypto.randomUUID();
      const blobStore = new Map(prior?.blobs ?? []);
      const priorState =
        prior?.checkpointUsable && prior.conversationState !== undefined
          ? fromBinary(ConversationStateStructureSchema, prior.conversationState)
          : undefined;
      const runState: CursorRunState = {
        conversationId,
        blobStore,
        ...(priorState === undefined ? {} : { conversationState: priorState }),
      };
      const { requestBytes } = buildCursorRunRequestBytes({
        prompt: options.prompt,
        wireModelId: runtime.model.wireModelId,
        displayModelId: runtime.model.displayModelId,
        displayName: runtime.model.displayName,
        maxMode: runtime.model.maxMode,
        state: runState,
      });
      const requestContextTools = buildMcpToolDefinitions(functionTools(options));
      const { stream, result } = runCursorTurn({
        transport: runtime.transport,
        accessToken: credential.accessToken,
        ...(runtime.baseUrl === undefined ? {} : { baseUrl: runtime.baseUrl }),
        ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
        requestBytes,
        initialConversationState: runState.conversationState ?? create(ConversationStateStructureSchema, {}),
        requestContextTools,
        blobStore,
        heartbeatMs: 5_000,
      });
      void result.then((turn) => {
        if (storeKey === undefined) return;
        const next: CursorSessionState = {
          conversationId,
          conversationState: toBinary(ConversationStateStructureSchema, turn.conversationState),
          blobs: turn.blobStore,
          checkpointUsable: turn.checkpointUsable,
          pendingToolCalls: turn.pendingToolCalls,
        };
        runtime.sessionStore.set(storeKey, next);
      }).catch(() => {
        if (storeKey !== undefined) runtime.sessionStore.delete(storeKey);
      });
      return { stream };
    };
    return {
      specificationVersion: 'v4',
      provider: 'cursor-oauth',
      modelId,
      supportedUrls: {},
      doStream,
      doGenerate: async (options) => await drain(await doStream(options)),
    };
  }
  ```
  `drain` is a small local helper that reads the returned stream and folds the V4 parts into the `doGenerate` result shape `{ content, usage, finishReason, warnings: [] }` (accumulate `text-delta` into one text content part, collect any `tool-call` parts, and copy `usage`/`finishReason` from the terminal `finish` part). The persisted `conversationState` is the Task 13 checkpoint captured by `runCursorTurn` (`turn.conversationState`), serialized with `toBinary` to match the Task 7 store's `Uint8Array` field; a tool-turn keeps `checkpointUsable = false` so the next turn rebuilds a fresh base state instead of reusing a mid-tool checkpoint.
- [x] Run the test again and confirm PASS.
- [x] Run `bun run check` at repo root.
- [ ] Commit (only if the user asks).

### Task 17: Provider, runtime factory, catalog switch, and plugin wiring

**Files:**
- Create: `packages/plugins/cursor/src/runtime/provider.ts`
- Create: `packages/plugins/cursor/src/runtime/provider.test.ts`
- Create: `packages/plugins/cursor/src/runtime/index.ts`
- Modify: `packages/plugins/cursor/src/catalog.ts` — add the dynamic `discoverCursorModels` path and the retryable `initialCursorCatalogFallback` (Phase 1 shipped the static curated snapshot here; Task 8 wrote `catalog/discover.ts`).
- Modify: `packages/plugins/cursor/src/plugin.ts` — switch `catalog.policy` to `{ kind: 'ttl', ttlMs: CURSOR_CATALOG_TTL_MS }`, point `discover` at the dynamic path, and make `createRuntime` return `createCursorRuntime(context, dependencies)` (REMOVE the Phase 1 throw).
- Modify: `packages/plugins/cursor/src/index.ts` — re-export the runtime/store/wire public surface.
- Modify: `packages/core/src/plugins/builtins.test.ts` — assert the Cursor adapter now exposes a `ttl` catalog policy and a non-throwing runtime factory.

**Interfaces:**
- Produces:
  - `createCursorProviderV4(runtime: CursorProviderRuntime): ProviderV4` — `languageModel(modelId)` returns `createCursorLanguageModel(modelId, runtimeForModel(modelId))`; `embeddingModel`/`imageModel` throw `unsupported(...)` (mirrors antigravity/xai).
  - `type CursorProviderRuntime = { transport: CursorTransport; credentials: CredentialPort<CursorCredential>; sessionStore: CursorSessionStore; credentialOptions?: CursorOAuthDependencies; baseUrl?: string; modelById: Map<string, { wireModelId: string; displayModelId: string; displayName: string; maxMode: boolean }> }`.
  - `createCursorRuntime(context: RuntimeContext<CursorCredential, Record<string, never>>, dependencies?: CursorRuntimeDependencies): Promise<OAuthRuntimeResult>` — builds the transport + a per-runtime `CursorSessionStore`, derives `modelById` from `context.catalog.language`, and returns `{ provider }` only (no `raw`, no `tokenCount`).
  - `type CursorRuntimeDependencies = CursorOAuthDependencies & { transport?: CursorTransport; sessionStore?: CursorSessionStore }`.
- Consumes: `createCursorLanguageModel`/`CursorModelRuntime` (Task 16); `createNodeHttp2Transport`/`CursorTransport`/`CURSOR_API_URL` (Task 5); `CursorSessionStore` (Task 7); `currentCursorCredential`/`CursorCredential`/`CursorOAuthDependencies` (Phase 1); `ProviderV4`/`RuntimeContext`/`OAuthRuntimeResult` (`@aio-proxy/plugin-sdk`).

**Global constraints:** `createCursorRuntime` returns `{ provider }` only — Cursor has no raw passthrough (not a `ProtocolId`) and no separate token-count endpoint. The session store is created once per runtime (per account), not per request and not module-global. Model `metadata` is never given a `protocol`. Files stay < 300 lines; if `provider.ts` grows, keep `createCursorRuntime` in `runtime/index.ts` and the `ProviderV4` shape in `provider.ts`.

- [x] Write failing tests for `provider.ts`/`createCursorRuntime` with a fake transport + fake `CredentialPort` + a two-model catalog: `createCursorRuntime` resolves to a result whose `provider.specificationVersion === 'v4'`; `provider.languageModel('claude-4.5-sonnet').doStream(callOptions())` finishes; `provider.embeddingModel('x')` throws; a `modelId` absent from the catalog throws a clear error.
  ```ts
  import { expect, test } from 'bun:test';
  import type { ModelCatalog } from '@aio-proxy/plugin-sdk';
  import type { CursorTransport, CursorH2Stream } from '../wire/transport';
  import { createCursorRuntime } from './index';

  const catalog: ModelCatalog = {
    language: [{ id: 'claude-4.5-sonnet', displayName: 'Claude 4.5 Sonnet' }],
    image: [], embedding: [], speech: [], transcription: [], reranking: [],
  };
  const credentials = {
    get: async () => ({ accessToken: 'tok', refreshToken: 'r', expiresAt: Number.MAX_SAFE_INTEGER, subject: 'user-1' }),
    refresh: async () => ({ accessToken: 'tok', refreshToken: 'r', expiresAt: Number.MAX_SAFE_INTEGER, subject: 'user-1' }),
  } as never;
  const transport: CursorTransport = {
    openRun: () => {
      const stream: CursorH2Stream = { write: () => {}, end: () => {}, frames: (async function* () {})(), trailers: Promise.resolve({ 'grpc-status': '0' }) };
      return Promise.resolve(stream);
    },
    unary: () => Promise.reject(new Error('unused')),
  };

  test('createCursorRuntime returns a v4 provider and rejects unsupported surfaces', async () => {
    const result = await createCursorRuntime(
      { credentials, options: {}, catalog, fetch: globalThis.fetch as never },
      { transport },
    );
    expect(result.provider.specificationVersion).toBe('v4');
    expect(result.raw).toBeUndefined();
    expect(() => result.provider.embeddingModel('x')).toThrow(/embedding/i);
    expect(() => result.provider.languageModel('missing')).toThrow(/missing/);
  });
  ```
- [x] Run `cd packages/plugins/cursor && bun test src/runtime/provider.test.ts` and confirm FAIL.
- [x] Implement `provider.ts`:
  ```ts
  import type { CredentialPort, ProviderV4 } from '@aio-proxy/plugin-sdk';

  import type { CursorCredential, CursorOAuthDependencies } from '../oauth';
  import type { CursorSessionStore } from '../store/session-store';
  import type { CursorTransport } from '../wire/transport';
  import { createCursorLanguageModel } from './cursor-model';

  export type CursorModelDescriptor = {
    readonly wireModelId: string;
    readonly displayModelId: string;
    readonly displayName: string;
    readonly maxMode: boolean;
  };

  export type CursorProviderRuntime = {
    readonly transport: CursorTransport;
    readonly credentials: CredentialPort<CursorCredential>;
    readonly sessionStore: CursorSessionStore;
    readonly credentialOptions?: CursorOAuthDependencies;
    readonly baseUrl?: string;
    readonly modelById: ReadonlyMap<string, CursorModelDescriptor>;
  };

  export function createCursorProviderV4(runtime: CursorProviderRuntime): ProviderV4 {
    return {
      specificationVersion: 'v4',
      languageModel: (modelId) => {
        const model = runtime.modelById.get(modelId);
        if (model === undefined) throw new Error(`Cursor OAuth has no model "${modelId}" in the discovered catalog`);
        return createCursorLanguageModel(modelId, {
          transport: runtime.transport,
          credentials: runtime.credentials,
          sessionStore: runtime.sessionStore,
          ...(runtime.credentialOptions === undefined ? {} : { credentialOptions: runtime.credentialOptions }),
          ...(runtime.baseUrl === undefined ? {} : { baseUrl: runtime.baseUrl }),
          model,
        });
      },
      embeddingModel: unsupported('embedding'),
      imageModel: unsupported('image generation'),
    };
  }

  function unsupported(kind: string): (modelId: string) => never {
    return (modelId) => {
      throw new Error(`Cursor OAuth does not support ${kind} model ${modelId}`);
    };
  }
  ```
- [x] Implement `runtime/index.ts` (`createCursorRuntime` + barrel re-exports):
  ```ts
  import type { OAuthRuntimeResult, RuntimeContext } from '@aio-proxy/plugin-sdk';

  import type { CursorCredential, CursorOAuthDependencies } from '../oauth';
  import { CursorSessionStore } from '../store/session-store';
  import { CURSOR_API_URL, createNodeHttp2Transport, type CursorTransport } from '../wire/transport';
  import { createCursorProviderV4, type CursorModelDescriptor } from './provider';

  export type CursorRuntimeDependencies = CursorOAuthDependencies & {
    readonly transport?: CursorTransport;
    readonly sessionStore?: CursorSessionStore;
  };

  export function createCursorRuntime(
    context: RuntimeContext<CursorCredential, Record<string, never>>,
    dependencies: CursorRuntimeDependencies = {},
  ): Promise<OAuthRuntimeResult> {
    const { transport: injectedTransport, sessionStore: injectedStore, ...credentialOptions } = dependencies;
    const transport = injectedTransport ?? createNodeHttp2Transport();
    const sessionStore = injectedStore ?? new CursorSessionStore();
    const modelById = new Map<string, CursorModelDescriptor>(
      context.catalog.language.map((descriptor) => [
        descriptor.id,
        { wireModelId: descriptor.id, displayModelId: descriptor.id, displayName: descriptor.displayName ?? descriptor.id, maxMode: false },
      ]),
    );
    const provider = createCursorProviderV4({
      transport,
      credentials: context.credentials,
      sessionStore,
      ...(Object.keys(credentialOptions).length === 0 ? {} : { credentialOptions }),
      baseUrl: CURSOR_API_URL,
      modelById,
    });
    return Promise.resolve({ provider });
  }

  export { createCursorProviderV4, type CursorProviderRuntime, type CursorModelDescriptor } from './provider';
  export { createCursorLanguageModel, type CursorModelRuntime } from './cursor-model';
  export { runCursorTurn, type CursorTurnResult } from './driver';
  ```
  (`createCursorRuntime` is `async`-shaped via `Promise.resolve` to match the `OAuthAdapter.createRuntime` contract, mirroring xai's `createXAIGrokRuntime`. It intentionally does NOT set `raw`/`tokenCount`.)
- [x] Run the test again and confirm PASS.
- [x] Modify `catalog.ts` (add the dynamic discovery path; keep `staticCursorCatalog` as the curated source; the Phase 2 `initialCursorCatalogFallback` now returns the curated catalog for a retryable `CursorCatalogError`):
  ```ts
  import type { AccountContext, ModelCatalog } from '@aio-proxy/plugin-sdk';

  import { discoverCursorModels, initialCursorCatalogFallback as discoverFallback } from './catalog/discover';
  import { currentCursorCredential, type CursorOAuthDependencies } from './oauth';
  import type { CursorCredential } from './schema';
  import { createNodeHttp2Transport } from './wire/transport';

  // staticCursorCatalog(): ModelCatalog and CURSOR_CATALOG_TTL_MS stay as Phase 1 shipped them.

  export async function discoverCursorCatalog(
    context: AccountContext<CursorCredential, Record<string, never>>,
    dependencies: CursorOAuthDependencies & { transport?: import('./wire/transport').CursorTransport } = {},
  ): Promise<ModelCatalog> {
    const credential = await currentCursorCredential(context.credentials, { ...dependencies, signal: context.signal });
    const transport = dependencies.transport ?? createNodeHttp2Transport();
    return await discoverCursorModels({ accessToken: credential.accessToken, transport, signal: context.signal });
  }

  export const initialCursorCatalogFallback = discoverFallback;
  ```
  Keep the Phase 1 `staticCursorCatalog` + `CURSOR_CATALOG_TTL_MS` exports in this file; only ADD the dynamic path and RE-EXPORT the Task 8 retryable fallback (replacing the Phase 1 always-`undefined` version). If `catalog.ts` would exceed 300 lines, move `discoverCursorCatalog` into `catalog/index.ts` and keep `catalog.ts` as the curated snapshot.
- [x] Modify `plugin.ts` (TTL policy + dynamic discover + runtime factory):
  ```ts
  // imports: add discoverCursorCatalog from './catalog', createCursorRuntime + CursorRuntimeDependencies from './runtime'
  catalog: {
    policy: { kind: 'ttl', ttlMs: CURSOR_CATALOG_TTL_MS },
    discover: (context) => discoverCursorCatalog(context, dependencies),
    initialFallback: initialCursorCatalogFallback,
  },
  createRuntime: (context) => createCursorRuntime(context, dependencies),
  ```
  `dependencies` widens from `CursorOAuthDependencies` to `CursorRuntimeDependencies` so tests can inject a fake transport. Delete the Phase 1 `createRuntime: () => { throw ... }`.
- [x] Modify `index.ts` to re-export the runtime surface: add `export * from './runtime';` and `export * from './store';` and `export * from './wire';` (keep the Phase 1 `export * from './catalog'` etc.). Ensure no barrel exposes a private `foo/bar.ts` collaborator outside its directory.
- [x] Update `packages/core/src/plugins/builtins.test.ts`: change the Cursor catalog-policy assertion from `{ kind: 'static' }` to `{ kind: 'ttl', ttlMs: expect.any(Number) }`, and assert `createRuntime` no longer throws by resolving it against a fake context (or, if a live transport is required, assert the adapter exposes a `createRuntime` function and defer the resolve to the plugin's own `provider.test.ts`). Do NOT weaken the Phase 1 localized-copy assertions.
  ```ts
  const cursor = snapshot.registry.resolveOAuth('@aio-proxy/plugin-cursor', 'default');
  expect(cursor?.catalog.policy).toEqual({ kind: 'ttl', ttlMs: expect.any(Number) });
  expect(typeof cursor?.createRuntime).toBe('function');
  ```
- [x] Run `cd packages/plugins/cursor && bun test` and `cd packages/core && bun test src/plugins/builtins.test.ts` and confirm PASS.
- [x] Run `bun run --filter @aio-proxy/plugin-cursor build` to confirm the package compiles.
- [ ] Commit (only if the user asks).

---

## Final Verification

- [x] `bun run --filter @aio-proxy/plugin-cursor test:unit` — all colocated Phase 2 tests pass (frame, unary, transport, tool-names, session-store, blobs, discover, exec-policy, mcp-tools, history, run-request, stream, client-messages, driver, cursor-model, provider).
- [x] `bun run --filter @aio-proxy/plugin-cursor build` — the package type-checks and compiles (protobuf-es imports resolve; no `@ai-sdk/*` delegate import).
- [x] `cd packages/core && bun test src/plugins/builtins.test.ts` — the Cursor built-in now asserts a `ttl` catalog policy and a non-throwing `createRuntime`.
- [ ] `bun run preflight` (oxlint + oxfmt check + all unit tests) at repo root.
- [x] `bun run check` if any type-only edits landed after the last preflight.
- [ ] Manual e2e with a real Cursor account (records the Validation Gates): a text turn streams and finishes on `stop`; a caller (B-class) tool turn emits a `tool-call`, suspends, and resumes on the next request; an A-class built-in exec turn returns coherent text; discovery returns a live model list and falls back on a forced 503.

## Self-Review Checklist

- [x] Spec coverage (design doc `2026-07-31-cursor-oauth-design.md` + review `2026-08-01-cursor-oauth-design-review.md`): protobuf-es vendor + frame codec + unary decode (Tasks 2-4); HTTP/2 transport + ALPN error + run/discovery headers, never `x-cursor-checksum` (Task 5); reserved tool-name escaping (Task 6); bounded `lru-cache` session store + content-addressed blobs (Tasks 7, 11); dynamic discovery + typed retryable error + curated fallback (Tasks 8, 17); A-class per-case exec responder with NO synthesized tool-call leakage (Task 9); B-class MCP tool defs + stateless continuation via `ResumeAction` (Tasks 10, 13, 16); history builder (Task 12); server-message -> V4 stream mapping (Task 14); client-message writers (Task 15); hand-written `LanguageModelV4` + turn driver (Task 16); `ProviderV4` + `createCursorRuntime` + catalog/plugin/index/builtins wiring (Task 17).
- [x] No placeholders: every task step has real code; no "similar to Task N", no "TBD", no comment-as-implementation (Task 5's `createNodeHttp2Transport` and Task 16's persistence are spelled out).
- [x] Type-name consistency across tasks: `frameConnectMessage`/`ConnectFrameDecoder`/`parseConnectEndStream`/`CONNECT_END_STREAM_FLAG` (Task 3); `decodeConnectUnaryBody` (Task 4); `CursorTransport`/`CursorH2Stream`/`buildRunHeaders`/`buildDiscoveryHeaders`/`createNodeHttp2Transport`/`CURSOR_API_URL`/`CURSOR_GET_USABLE_MODELS_PATH` (Task 5); `toWireName`/`fromWireName`/`CURSOR_NATIVE_TOOL_NAMES` (Task 6); `CursorSessionStore`/`sessionKey`/`CursorSessionState` (Task 7); `discoverCursorModels`/`CursorCatalogError` (Task 8); `respondToExec`/`buildRequestContextResult`/`ExecClientResponse` (Task 9); `buildMcpToolDefinitions` (Task 10); `createBlobId`/`blobKey`/`storeCursorBlob`/`readCursorBlob` (Task 11); `buildCursorRunRequestBytes`/`CursorRunState` (Task 13); `createCursorStreamAccumulator`/`mapInteractionUpdate`/`finalizeCursorStream` (Task 14); `encodeKvResponse`/`encodeExecResponse` (Task 15); `runCursorTurn`/`CursorTurnResult`/`createCursorLanguageModel`/`CursorModelRuntime` (Task 16); `createCursorProviderV4`/`createCursorRuntime`/`CursorProviderRuntime`/`CursorRuntimeDependencies` (Task 17).
- [x] Task numbering + cross-references: no stale "Task 11" for the exec caller/heartbeat/affinity-drop; Validation Gates cite the tasks that bake in each assumption (Gate 2/3 -> Task 9, Gate 4 -> Tasks 5/16, Gate 5 -> Tasks 7/16); File Structure lists every created file with its task and matches the split modules the tasks actually create.
- [x] Discovery field names: `ModelDetails.model_id`/`display_name` -> protobuf-es `modelId`/`displayName`; `dedupeById` and the discovery test both read `modelId` (NOT `name`).
- [x] Constraints honored: model `metadata` never sets `protocol`; `conversationState` lives only in the bounded per-runtime `CursorSessionStore` (no module-level Maps); tokens never logged (identity scope hashes the access token, never stores it raw); every handwritten file < 300 lines with `src/gen/**` exempt; tests colocated in same-name dirs where private collaborators exist; B-class suspends honestly (no fake `mcpResult`, `checkpointUsable = false`); `turnEnded` is not treated as a clean end.
- [x] Store/runtime type seam: `CursorSessionState.conversationState` is `Uint8Array`; `cursor-model.ts` serializes with `toBinary` on write and `fromBinary` on read (no `ConversationStateStructure` leaks into the store type).
- [x] Dependencies: `@bufbuild/protobuf` catalog-managed; no `protobufjs`, no gRPC library, no `rsbuild-plugin-protobufjs`, no `@ai-sdk/cursor`.
