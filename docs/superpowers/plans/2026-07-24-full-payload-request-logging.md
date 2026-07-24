# Full Payload Request Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sanitized debug snapshots with ordered, unbounded text-body events for inbound requests, final upstream requests, and consumed upstream responses while preserving only the agreed credential boundaries.

**Architecture:** A pure `body-tap` stream wrapper forwards each source byte chunk unchanged and emits decoded text or complete SSE frames under downstream backpressure. The existing request/attempt context supplies immutable correlation fields; `wire` emits metadata immediately and body chunk/terminal events as Fetch consumers read each wrapped stream.

**Tech Stack:** Bun, TypeScript, Web Fetch/Streams APIs, LogTape-backed structured server logging, Bun test.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-24-request-wire-debug-logging-design.md`; do not broaden its scope.
- Use existing dependencies only. LogTape remains the sink; do not add an HTTP capture, storage, or SSE dependency.
- Model JSON/SSE text is not redacted, hashed, summarized, aggregated, or truncated by logging.
- Preserve all query values and header values except case-insensitive `authorization` and `x-api-key`; continue removing URL user info.
- OAuth login, token exchange, and refresh secret redaction remains unchanged.
- Do not remove `REQUEST_BODY_LIMITS`; those are protocol validation limits, not logging limits.
- A body that starts consumption emits ordered chunks and exactly one terminal event. Null and never-consumed bodies emit no body event.
- Logging must not change source bytes, backpressure, cancellation, errors, fallback, or usage capture.
- At non-debug levels, preserve the original request/response path without wrapping or decoding.
- Use `Provider ID` exactly as the repository domain language requires.
- Use `rtk` before every shell command and `apply_patch` for every edit or move.
- Keep handwritten source and test files below 300 lines. New tested modules use the required `module/index.ts`, `module/module.ts`, `module/module.test.ts` layout.
- Every task is a separate review gate and commit. Every commit includes `Co-authored-by: Codex <noreply@openai.com>`.
- Final verification is `rtk bun run preflight`; do not claim completion before it passes.

---

## Locked File Structure

```text
packages/server/src/request-logging/
├── body-tap/
│   ├── index.ts                  # export-only public entry
│   ├── body-tap.ts               # byte-preserving text/SSE stream tap
│   └── body-tap.test.ts          # framing, UTF-8, terminal, failure behavior
├── request-metadata/
│   ├── index.ts                  # export-only public entry
│   ├── request-metadata.ts       # URL/header/request/response metadata policy
│   └── request-metadata.test.ts  # exact preservation and credential boundaries
├── wire/
│   ├── index.ts                  # export-only public entry
│   ├── wire.ts                   # request context, events, Fetch wrappers
│   ├── wire.test.ts              # request/inbound/upstream behavior
│   └── wire-response.test.ts     # response completion/cancel/error behavior
├── context.ts
├── context.test.ts
├── index.ts
└── test-support.ts               # shared server tests only
```

Delete the superseded `snapshot.ts`, `snapshot.test.ts`, `snapshot-body.ts`, `snapshot-request-body.test.ts`, and flat `wire*` files after their coverage is moved.

## Locked Interfaces

Task 1 owns these names:

```ts
export type BodyTapOutcome = "complete" | "cancelled" | "error";

export type BodyTapTerminal = {
  readonly byteLength: number;
  readonly error?: unknown;
  readonly outcome: BodyTapOutcome;
};

export type BodyTapObserver = {
  readonly chunk: (text: string) => void;
  readonly terminal: (terminal: BodyTapTerminal) => void;
};

export function tapTextBody(
  source: ReadableStream<Uint8Array>,
  contentType: string | null,
  observer: BodyTapObserver,
): ReadableStream<Uint8Array>;
```

Task 2 owns these event types:

```ts
export type RequestBodyDirection = "inbound" | "upstream_request" | "upstream_response";

export type RequestBodyChunkLog = RequestBodyIdentity & {
  readonly event: "request.body_chunk";
  readonly sequence: number;
  readonly text: string;
};

export type RequestBodyTerminalLog = RequestBodyIdentity & {
  readonly event: "request.body_terminal";
  readonly sequence: number;
  readonly byteLength: number;
  readonly outcome: "complete" | "cancelled" | "error";
  readonly errorType?: string;
};
```

Task 3 owns metadata names:

```ts
export type HttpRequestMetadata = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

export type HttpResponseMetadata = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
};

export function requestMetadata(request: Request): HttpRequestMetadata;
export function responseMetadata(response: Response): HttpResponseMetadata;
```

Task 4 replaces `logInboundRequest()` with this interface:

```ts
export function observeInboundRequest(request: Request, inboundProtocol: string): Request;
```

### Task 1: Add the byte-preserving text and SSE body tap

**Files:**

- Create: `packages/server/src/request-logging/body-tap/index.ts`
- Create: `packages/server/src/request-logging/body-tap/body-tap.ts`
- Create: `packages/server/src/request-logging/body-tap/body-tap.test.ts`

**Interfaces:**

- Consumes: a Fetch `ReadableStream<Uint8Array>`, its `content-type`, and `BodyTapObserver`.
- Produces: the locked Task 1 interfaces and a stream that forwards the original `Uint8Array` chunks.

- [ ] **Step 1: Write the failing stream-contract tests**

Create `body-tap.test.ts` with these focused cases:

```ts
import { expect, test } from "bun:test";

import type { BodyTapTerminal } from ".";

import { tapTextBody } from ".";

const encoder = new TextEncoder();

test("forwards bytes and reconstructs split UTF-8 text", async () => {
  const bytes = encoder.encode("前缀🙂后缀");
  const source = streamOf(bytes.slice(0, 8), bytes.slice(8, 10), bytes.slice(10));
  const chunks: string[] = [];
  const terminals: BodyTapTerminal[] = [];

  const returned = new Uint8Array(await new Response(tapTextBody(source, "application/json", {
    chunk: (text) => chunks.push(text),
    terminal: (terminal) => terminals.push(terminal),
  })).arrayBuffer());

  expect(returned).toEqual(bytes);
  expect(chunks.join("")).toBe("前缀🙂后缀");
  expect(terminals).toEqual([{ byteLength: bytes.byteLength, outcome: "complete" }]);
});

test("emits complete SSE frames across mixed line endings", async () => {
  const chunks: string[] = [];
  const text = "event: first\r\ndata: 1\r\n\r\ndata: 2\n\ndata: tail";
  const tapped = tapTextBody(
    streamOf(encoder.encode(text.slice(0, 18)), encoder.encode(text.slice(18, 31)), encoder.encode(text.slice(31))),
    "text/event-stream; charset=utf-8",
    { chunk: (chunk) => chunks.push(chunk), terminal() {} },
  );

  expect(await new Response(tapped).text()).toBe(text);
  expect(chunks).toEqual(["event: first\r\ndata: 1\r\n\r\n", "data: 2\n\n", "data: tail"]);
});

test("reports cancellation and preserves the source cancel reason", async () => {
  const terminals: BodyTapTerminal[] = [];
  let reason: unknown;
  const tapped = tapTextBody(new ReadableStream({
    cancel(value) { reason = value; },
  }), "application/json", { chunk() {}, terminal: (value) => terminals.push(value) });

  await tapped.cancel("client-left");

  expect(reason).toBe("client-left");
  expect(terminals).toEqual([{ byteLength: 0, outcome: "cancelled" }]);
});

test("observer failure never changes returned bytes", async () => {
  const bytes = encoder.encode("visible");
  const returned = await new Response(tapTextBody(streamOf(bytes), "application/json", {
    chunk() { throw new Error("logger failed"); },
    terminal() {},
  })).text();

  expect(returned).toBe("visible");
});

test("does not read ahead before a consumer requests bytes", async () => {
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.close();
    },
  }, { highWaterMark: 0 });

  tapTextBody(source, "application/json", { chunk() {}, terminal() {} });
  await Bun.sleep(0);

  expect(pulls).toBe(0);
  expect(source.locked).toBeFalse();
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }, { highWaterMark: 0 });
}
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
rtk bun test packages/server/src/request-logging/body-tap/body-tap.test.ts
```

Expected: FAIL because `tapTextBody` and the module do not exist.

- [ ] **Step 3: Implement the minimal body tap**

Create the export-only `index.ts`:

```ts
export {
  type BodyTapObserver,
  type BodyTapOutcome,
  type BodyTapTerminal,
  tapTextBody,
} from "./body-tap";
```

Implement `body-tap.ts` with one reader and one terminal guard:

```ts
export type BodyTapOutcome = "complete" | "cancelled" | "error";

export type BodyTapTerminal = {
  readonly byteLength: number;
  readonly error?: unknown;
  readonly outcome: BodyTapOutcome;
};

export type BodyTapObserver = {
  readonly chunk: (text: string) => void;
  readonly terminal: (terminal: BodyTapTerminal) => void;
};

export function tapTextBody(
  source: ReadableStream<Uint8Array>,
  contentType: string | null,
  observer: BodyTapObserver,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  const sse = contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
  let buffered = "";
  let byteLength = 0;
  let diagnosticActive = true;
  let settled = false;
  const sourceReader = () => (reader ??= source.getReader());

  const emit = (text: string, final = false) => {
    if (!diagnosticActive) return;
    try {
      if (!sse) {
        if (text !== "") observer.chunk(text);
        return;
      }
      buffered += text;
      let end: number;
      while ((end = sseEventEnd(buffered)) >= 0) {
        observer.chunk(buffered.slice(0, end));
        buffered = buffered.slice(end);
      }
      if (final && buffered !== "") observer.chunk(buffered);
    } catch (error) {
      diagnosticActive = false;
      terminal({ outcome: "error", error });
    }
  };

  const terminal = (value: Omit<BodyTapTerminal, "byteLength">) => {
    if (settled) return;
    settled = true;
    try {
      observer.terminal({ ...value, byteLength });
    } catch {}
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const activeReader = sourceReader();
        const next = await activeReader.read();
        if (next.done) {
          emit(decoder.decode(), true);
          terminal({ outcome: "complete" });
          try { activeReader.releaseLock(); } catch {}
          controller.close();
          return;
        }
        byteLength += next.value.byteLength;
        controller.enqueue(next.value);
        emit(decoder.decode(next.value, { stream: true }));
      } catch (error) {
        terminal({ outcome: "error", error });
        try { reader?.releaseLock(); } catch {}
        controller.error(error);
      }
    },
    async cancel(reason) {
      terminal({ outcome: "cancelled" });
      try {
        await sourceReader().cancel(reason);
      } finally {
        try { reader?.releaseLock(); } catch {}
      }
    },
  }, { highWaterMark: 0 });
}

function sseEventEnd(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const first = lineEndingLength(text, index);
    if (first === 0) continue;
    const second = lineEndingLength(text, index + first);
    if (second > 0) return index + first + second;
    index += first - 1;
  }
  return -1;
}

function lineEndingLength(text: string, index: number): number {
  if (text[index] === "\n") return 1;
  if (text[index] !== "\r") return 0;
  return text[index + 1] === "\n" ? 2 : 1;
}
```

Keep the observer callback after `controller.enqueue(next.value)`. A diagnostic exception must never prevent delivery of the source bytes.

- [ ] **Step 4: Run the body-tap tests**

Run: `rtk bun test packages/server/src/request-logging/body-tap/body-tap.test.ts`

Expected: PASS for UTF-8 reconstruction, exact SSE framing, completion, cancellation, and observer isolation.

- [ ] **Step 5: Commit Task 1**

```bash
rtk git add packages/server/src/request-logging/body-tap
rtk git commit -m "feat(server): add streaming debug body tap" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Add body log contracts and debug-level mapping

**Files:**

- Modify: `packages/server/src/server-log.ts`
- Modify: `packages/server/src/logging/bridge/bridge.ts`
- Modify: `packages/server/src/logging/bridge/bridge.test.ts`

**Interfaces:**

- Consumes: existing `ServerLog`, `ServerLogSink`, and request/attempt correlation fields.
- Produces: the locked Task 2 event types and debug-level mappings used by Task 3.

- [ ] **Step 1: Add failing bridge entries for both body events**

Add these values to the `entries` array in `bridge.test.ts`:

```ts
{
  event: "request.body_chunk",
  requestId: "body",
  direction: "upstream_response",
  attemptIndex: 1,
  providerId: "provider",
  modelId: "model",
  sequence: 0,
  text: "{\"visible\":true}",
},
{
  event: "request.body_terminal",
  requestId: "body",
  direction: "upstream_response",
  attemptIndex: 1,
  providerId: "provider",
  modelId: "model",
  sequence: 1,
  byteLength: 16,
  outcome: "complete",
},
```

Also add direct mapping assertions:

```ts
expect(SERVER_LOG_LEVEL["request.body_chunk"]).toBe("debug");
expect(SERVER_LOG_LEVEL["request.body_terminal"]).toBe("debug");
```

- [ ] **Step 2: Run the bridge test and verify the type failure**

Run: `rtk bun test packages/server/src/logging/bridge/bridge.test.ts`

Expected: FAIL because the body events are not members of `ServerLog` or `SERVER_LOG_LEVEL`.

- [ ] **Step 3: Define the event contracts**

Add this block before `ServerLog` in `server-log.ts`:

```ts
export type RequestBodyDirection = "inbound" | "upstream_request" | "upstream_response";

type RequestBodyIdentity = {
  readonly requestId: string;
  readonly direction: RequestBodyDirection;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
};

export type RequestBodyChunkLog = RequestBodyIdentity & {
  readonly event: "request.body_chunk";
  readonly sequence: number;
  readonly text: string;
};

export type RequestBodyTerminalLog = RequestBodyIdentity & {
  readonly event: "request.body_terminal";
  readonly sequence: number;
  readonly byteLength: number;
  readonly outcome: "complete" | "cancelled" | "error";
  readonly errorType?: string;
};
```

Add `RequestBodyChunkLog | RequestBodyTerminalLog` to `ServerLog`. Add both event keys with value `"debug"` to the exhaustive `SERVER_LOG_LEVEL` record.

- [ ] **Step 4: Run the bridge test**

Run: `rtk bun test packages/server/src/logging/bridge/bridge.test.ts`

Expected: PASS and both body records are forwarded unchanged at debug level.

- [ ] **Step 5: Commit Task 2**

```bash
rtk git add packages/server/src/server-log.ts packages/server/src/logging/bridge/bridge.ts packages/server/src/logging/bridge/bridge.test.ts
rtk git commit -m "feat(server): define debug body log events" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Replace sanitized snapshots with metadata and upstream body taps

**Files:**

- Create: `packages/server/src/request-logging/request-metadata/index.ts`
- Create: `packages/server/src/request-logging/request-metadata/request-metadata.ts`
- Create: `packages/server/src/request-logging/request-metadata/request-metadata.test.ts`
- Create: `packages/server/src/request-logging/wire/index.ts`
- Create: `packages/server/src/request-logging/wire/wire.ts`
- Create: `packages/server/src/request-logging/wire/wire.test.ts`
- Create: `packages/server/src/request-logging/wire/wire-response.test.ts`
- Rename: `packages/server/src/request-logging/wire.test-support.ts` to `packages/server/src/request-logging/test-support.ts`
- Modify: `packages/server/src/request-logging/index.ts`
- Modify: `packages/server/src/provider-runtime/observed-fetch.test.ts`
- Modify: `packages/server/src/plugin-runtime/host-fetch-context.test.ts`
- Modify: `packages/server/src/routes/pipeline/debug-logging.test.ts`
- Modify: `packages/server/src/routes/token-count-debug-logging.test.ts`
- Modify: `packages/server/src/server-log.ts`
- Delete: `packages/server/src/request-logging/snapshot.ts`
- Delete: `packages/server/src/request-logging/snapshot.test.ts`
- Delete: `packages/server/src/request-logging/snapshot-body.ts`
- Delete: `packages/server/src/request-logging/snapshot-request-body.test.ts`
- Delete: flat `packages/server/src/request-logging/wire.ts`, `wire.test.ts`, and `wire-response.test.ts` after moving coverage.

**Interfaces:**

- Consumes: `tapTextBody`, Task 2 body events, current debug request/attempt scope, and existing observed fetch installation.
- Produces: `createObservedFetch()` with full upstream request/response body events and the locked metadata interfaces.

- [ ] **Step 1: Write metadata and upstream reconstruction tests**

In `request-metadata.test.ts`, assert this exact policy:

```ts
test("preserves query and ordinary headers while redacting only explicit credentials", () => {
  const request = new Request(
    "https://user:pass@upstream.test/v1/responses?token=query-token&prompt=hello",
    { headers: {
      authorization: "Bearer secret",
      "x-api-key": "api-secret",
      "x-long": "x".repeat(700),
      cookie: "visible-cookie",
    } },
  );

  expect(requestMetadata(request)).toEqual({
    method: "GET",
    url: "https://upstream.test/v1/responses?token=query-token&prompt=hello",
    headers: {
      authorization: "[REDACTED]",
      cookie: "visible-cookie",
      "x-api-key": "[REDACTED]",
      "x-long": "x".repeat(700),
    },
  });
});
```

In `wire.test.ts`, keep the existing non-debug identity test, then make the debug fetch consume the delegated request and make the caller consume the returned response:

```ts
const delegatedBodies: string[] = [];
const fetcher = createObservedFetch((async (input, init) => {
  delegatedBodies.push(await new Request(input, init).text());
  return new Response('{"output":"response-visible"}', {
    headers: { "content-type": "application/json", "x-result": "visible-header" },
  });
}) as typeof globalThis.fetch);

const response = await inDebugAttempt(logs, () => fetcher(new Request(
  "https://upstream.test/v1/responses?token=visible-query",
  {
    method: "POST",
    headers: {
      authorization: "Bearer hidden",
      "content-type": "application/json",
      "x-observable": "visible-header",
    },
    body: '{"input":"request-visible","token":"body-visible"}',
  },
)));
expect(await response.text()).toBe('{"output":"response-visible"}');
expect(delegatedBodies).toEqual(['{"input":"request-visible","token":"body-visible"}']);
expect(reconstructed(logs, "upstream_request")).toBe('{"input":"request-visible","token":"body-visible"}');
expect(reconstructed(logs, "upstream_response")).toBe('{"output":"response-visible"}');
```

Update `provider-runtime/observed-fetch.test.ts` so the proxy fetch consumes the wrapped request body and the assertions separate metadata from content:

```ts
const delegated: { readonly body: string; readonly proxy: string | undefined; readonly url: string }[] = [];

// Inside createProxyFetch(proxy):
return (async (input, init) => {
  const request = new Request(input, init);
  delegated.push({ body: await request.text(), proxy, url: request.url });
  return new Response(null, { status: 204 });
}) as ProviderFetch;

// After the two debug calls:
expect(snapshots[0]).toMatchObject({
  url: "https://final-api.test/v1/responses?api_key=api-query-secret",
  headers: {
    "content-type": "application/json",
    "user-agent": "api-generated-agent",
    "x-api-key": "[REDACTED]",
  },
});
expect(snapshots[1]).toMatchObject({
  url: "https://final-sdk.test/v1/chat/completions?token=sdk-query-secret",
  headers: {
    accept: "application/json",
    authorization: "[REDACTED]",
    "content-type": "application/json",
  },
});
expect(reconstructed(logs, "upstream_request", 0)).toContain("api-prompt-secret");
expect(reconstructed(logs, "upstream_request", 0)).toContain("api-body-secret");
expect(reconstructed(logs, "upstream_request", 1)).toContain("sdk-content-secret");
expect(delegated.slice(-2).map(({ body }) => body)).toEqual([
  reconstructed(logs, "upstream_request", 0),
  reconstructed(logs, "upstream_request", 1),
]);
```

Update `plugin-runtime/host-fetch-context.test.ts` so its host fetch consumes the body, then assert the built-in OAuth path is observable:

```ts
const baseFetchBodies: string[] = [];
const baseFetch = (async (input, init) => {
  const request = new Request(input, init);
  baseFetchCalls.push(request);
  baseFetchBodies.push(await request.text());
  return new Response(null, { status: 204 });
}) as typeof globalThis.fetch;

// After the captured fetch call:
expect(baseFetchBodies).toEqual(["wire-secret"]);
expect(reconstructed(logs, "upstream_request")).toBe("wire-secret");
```

Add this helper to the shared `test-support.ts`:

```ts
export function reconstructed(
  logs: readonly ServerLog[],
  direction: RequestBodyDirection,
  attemptIndex?: number,
): string {
  return logs
    .filter((entry): entry is RequestBodyChunkLog =>
      entry.event === "request.body_chunk" &&
      entry.direction === direction &&
      (attemptIndex === undefined || entry.attemptIndex === attemptIndex))
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => entry.text)
    .join("");
}
```

In `wire-response.test.ts`, replace the bounded clone/deadline tests with these exact lifecycle assertions:

```ts
test("consumed response emits complete terminal", async () => {
  const logs: ServerLog[] = [];
  const response = await inDebugAttempt(logs, () => createObservedFetch(captureFetch([], () =>
    new Response("complete", { headers: { "content-type": "application/json" } }),
  ))("https://upstream.test/v1"));

  expect(await response.text()).toBe("complete");
  expect(reconstructed(logs, "upstream_response")).toBe("complete");
  expect(terminals(logs, "upstream_response")).toEqual([
    expect.objectContaining({ outcome: "complete", byteLength: 8, sequence: 1 }),
  ]);
});

test("response cancellation reaches the source and emits cancelled", async () => {
  const logs: ServerLog[] = [];
  let reason: unknown;
  const source = new ReadableStream<Uint8Array>({ cancel(value) { reason = value; } });
  const response = await inDebugAttempt(logs, () => createObservedFetch(captureFetch([], () =>
    new Response(source, { headers: { "content-type": "application/json" } }),
  ))("https://upstream.test/v1"));

  await response.body?.cancel("client-left");

  expect(reason).toBe("client-left");
  expect(terminals(logs, "upstream_response")).toEqual([
    expect.objectContaining({ outcome: "cancelled", byteLength: 0, sequence: 0 }),
  ]);
});

test("response errors remain observable and emit error terminal", async () => {
  const logs: ServerLog[] = [];
  const failure = new Error("source failed");
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } });
  const response = await inDebugAttempt(logs, () => createObservedFetch(captureFetch([], () =>
    new Response(source, { headers: { "content-type": "application/json" } }),
  ))("https://upstream.test/v1"));

  await expect(response.text()).rejects.toBe(failure);
  expect(terminals(logs, "upstream_response")).toEqual([
    expect.objectContaining({ outcome: "error", errorType: "Error", byteLength: 0, sequence: 0 }),
  ]);
});

test("null and never-consumed responses emit no body events", async () => {
  const logs: ServerLog[] = [];

  await inDebugAttempt(logs, () => createObservedFetch(captureFetch([], () =>
    new Response("not-consumed", { headers: { "content-type": "application/json" } }),
  ))("https://upstream.test/v1"));
  await inDebugAttempt(logs, () => createObservedFetch(captureFetch([], () =>
    new Response(null, { status: 204 }),
  ))("https://upstream.test/v1"));
  await Bun.sleep(0);

  expect(logs.filter((entry) => entry.event === "request.body_chunk")).toHaveLength(0);
  expect(logs.filter((entry) => entry.event === "request.body_terminal")).toHaveLength(0);
});
```

Add `terminals()` beside `reconstructed()` in shared test support:

```ts
export function terminals(logs: readonly ServerLog[], direction: RequestBodyDirection): RequestBodyTerminalLog[] {
  return logs.filter((entry): entry is RequestBodyTerminalLog =>
    entry.event === "request.body_terminal" && entry.direction === direction);
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
rtk bun test \
  packages/server/src/request-logging/request-metadata/request-metadata.test.ts \
  packages/server/src/request-logging/wire/wire.test.ts \
  packages/server/src/request-logging/wire/wire-response.test.ts
```

Expected: FAIL because the new modules and body events are not wired.

- [ ] **Step 3: Implement metadata-only snapshots**

Create export-only `request-metadata/index.ts` and implement `request-metadata.ts`:

```ts
export type HttpRequestMetadata = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

export type HttpResponseMetadata = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
};

const REDACTED = "[REDACTED]";
const credentialHeaders = new Set(["authorization", "x-api-key"]);

export function requestMetadata(request: Request): HttpRequestMetadata {
  try {
    return { method: request.method, url: visibleUrl(request.url), headers: visibleHeaders(request.headers) };
  } catch {
    return { method: "[UNREADABLE]", url: "[UNREADABLE]", headers: {} };
  }
}

export function responseMetadata(response: Response): HttpResponseMetadata {
  try {
    return { statusCode: response.status, headers: visibleHeaders(response.headers) };
  } catch {
    return { statusCode: 0, headers: {} };
  }
}

function visibleUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}

function visibleHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries([...headers].map(([name, value]) => [
    name,
    credentialHeaders.has(name.toLowerCase()) ? REDACTED : value,
  ]));
}
```

Export the four locked names from `request-metadata/index.ts`. Change snapshot types in `server-log.ts` to intersect with `HttpRequestMetadata`, and remove `SafeBodySnapshot` from upstream results.

- [ ] **Step 4: Implement upstream request and response taps**

Move `wire` into its directory and keep its public `index.ts` export-only. In `wire.ts`, capture identity before asynchronous stream work and use one emitter:

```ts
type BodyIdentity = {
  readonly requestId: string;
  readonly direction: RequestBodyDirection;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
};

function observedBody(
  body: ReadableStream<Uint8Array>,
  contentType: string | null,
  identity: BodyIdentity,
  logger: ServerLogSink,
): ReadableStream<Uint8Array> {
  let sequence = 0;
  return tapTextBody(body, contentType, {
    chunk(text) {
      logServerEvent(logger, { event: "request.body_chunk", ...identity, sequence: sequence++, text });
    },
    terminal({ byteLength, error, outcome }) {
      logServerEvent(logger, {
        event: "request.body_terminal",
        ...identity,
        sequence,
        byteLength,
        outcome,
        ...(error === undefined ? {} : { errorType: serverErrorType(error) }),
      });
    },
  });
}
```

Within `createObservedFetch`, retain the current non-debug early return and use this orchestration for debug attempts:

```ts
export function createObservedFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const scope = currentDebugRequestLogScope();
    if (scope?.attemptIndex === undefined || scope.providerId === undefined || scope.modelId === undefined) {
      return fetcher(input, init);
    }
    const identity = {
      requestId: scope.requestId,
      attemptIndex: scope.attemptIndex,
      providerId: scope.providerId,
      modelId: scope.modelId,
    } as const;
    const startedAt = performance.now();
    try {
      const request = new Request(input, init);
      logServerEvent(scope.logger, { event: "request.upstream_snapshot", ...identity, ...requestMetadata(request) });
      const delegated = requestWithObservedBody(request, { ...identity, direction: "upstream_request" }, scope.logger);
      const decompress = (init as BunFetchInit | undefined)?.decompress;
      const response = await fetcher(delegated, decompress === undefined ? undefined : { decompress });
      logServerEvent(scope.logger, {
        event: "request.upstream_result",
        ...identity,
        durationMs: performance.now() - startedAt,
        outcome: "response",
        ...responseMetadata(response),
      });
      return responseWithObservedBody(response, { ...identity, direction: "upstream_response" }, scope.logger);
    } catch (error) {
      logServerEvent(scope.logger, {
        event: "request.upstream_result",
        ...identity,
        durationMs: performance.now() - startedAt,
        outcome: "exception",
        ...serverErrorDetails(error),
      });
      throw error;
    }
  }) as typeof globalThis.fetch;
}

function requestWithObservedBody(request: Request, identity: BodyIdentity, logger: ServerLogSink): Request {
  try {
    const body = request.body;
    if (body === null) return request;
    const contentType = request.headers.get("content-type");
    const init: RequestInit = {
      cache: request.cache,
      credentials: request.credentials,
      headers: request.headers,
      integrity: request.integrity,
      keepalive: request.keepalive,
      method: request.method,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
    };
    return new Request(request.url, { ...init, body: observedBody(body, contentType, identity, logger) });
  } catch {
    return request;
  }
}

function responseWithObservedBody(response: Response, identity: BodyIdentity, logger: ServerLogSink): Response {
  let source: ReadableStream<Uint8Array>;
  let contentType: string | null;
  let metadata: ResponseInit & { readonly redirected: boolean; readonly type: Response["type"]; readonly url: string };
  try {
    const body = response.body;
    if (body === null) return response;
    source = body;
    contentType = response.headers.get("content-type");
    metadata = {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      type: response.type,
      url: response.url,
    };
  } catch {
    return response;
  }
  return responseWithBody(response, observedBody(source, contentType, identity, logger), metadata);
}
```

Use this response helper so current consumers retain Fetch metadata:

```ts
function responseWithBody(
  original: Response,
  body: ReadableStream<Uint8Array>,
  metadata: ResponseInit & { readonly redirected: boolean; readonly type: Response["type"]; readonly url: string },
): Response {
  try {
    const wrapped = new Response(body, {
      headers: metadata.headers,
      status: metadata.status,
      statusText: metadata.statusText,
    });
    Object.defineProperties(wrapped, {
      redirected: { configurable: true, value: metadata.redirected },
      type: { configurable: true, value: metadata.type },
      url: { configurable: true, value: metadata.url },
    });
    return wrapped;
  } catch {
    return original;
  }
}
```

If reading metadata or constructing a wrapper fails, emit the smallest metadata result and return the original response. Never clone or drain a response.

- [ ] **Step 5: Delete the superseded sanitizer and update exports/imports**

Delete the old snapshot and snapshot-body source/tests. Update `request-logging/index.ts` to export context plus:

```ts
export { createObservedFetch } from "./wire";
```

Do not export body-tap or request-metadata through the package-level barrel; they are private request-logging collaborators. Rename the shared test support and make these exact import changes:

```ts
// provider-runtime/observed-fetch.test.ts, plugin-runtime/host-fetch-context.test.ts,
// routes/token-count-debug-logging.test.ts
import { reconstructed, waitFor } from "../request-logging/test-support";

// routes/pipeline/debug-logging.test.ts
import { reconstructed, waitFor } from "../../request-logging/test-support";

// request-logging/wire/*.test.ts
import { captureFetch, inDebugAttempt, reconstructed, terminals } from "../test-support";
```

- [ ] **Step 6: Run request-logging and provider observation tests**

Run:

```bash
rtk bun test \
  packages/server/src/request-logging \
  packages/server/src/provider-runtime/observed-fetch.test.ts \
  packages/server/src/plugin-runtime/host-fetch-context.test.ts \
  packages/server/src/logging/bridge/bridge.test.ts
```

Expected: PASS. Debug tests contain complete query/header/body sentinels except `authorization` and `x-api-key`; non-debug tests retain original fetch input identity.

- [ ] **Step 7: Commit Task 3**

```bash
rtk git add packages/server/src/request-logging packages/server/src/server-log.ts packages/server/src/provider-runtime/observed-fetch.test.ts packages/server/src/plugin-runtime/host-fetch-context.test.ts packages/server/src/logging/bridge/bridge.test.ts packages/server/src/routes/pipeline/debug-logging.test.ts packages/server/src/routes/token-count-debug-logging.test.ts
rtk git commit -m "feat(server): log complete upstream payload streams" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Put the inbound tap on the actual protocol parsing path

**Files:**

- Modify: `packages/server/src/request-logging/wire/wire.ts`
- Modify: `packages/server/src/request-logging/wire/wire.test.ts`
- Modify: `packages/server/src/routes/pipeline/index.ts`
- Modify: `packages/server/src/routes/pipeline/debug-logging.test.ts`
- Modify: `packages/server/src/routes/token-count.ts`
- Modify: `packages/server/src/routes/token-count-debug-logging.test.ts`

**Interfaces:**

- Consumes: Task 3 metadata/body emitter and request context.
- Produces: `observeInboundRequest(request, inboundProtocol): Request`, used by both model and token-count pipelines.

- [ ] **Step 1: Write the failing inbound behavior tests**

Replace the old fire-and-forget inbound snapshot test with:

```ts
test("debug inbound observation logs complete consumed input", async () => {
  const logs: ServerLog[] = [];
  const request = new Request("https://proxy.test/v1/responses?api_key=visible-query", {
    method: "POST",
    headers: { authorization: "hidden", "content-type": "application/json", "x-client": "visible" },
    body: '{"input":"visible-input","token":"visible-body-token"}',
  });

  const observed = withRequestLogContext(
    { requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) },
    () => observeInboundRequest(request, "openai-response"),
  );

  expect(await observed.text()).toBe('{"input":"visible-input","token":"visible-body-token"}');
  expect(reconstructed(logs, "inbound")).toBe('{"input":"visible-input","token":"visible-body-token"}');
  expect(logs).toContainEqual(expect.objectContaining({
    event: "request.inbound_snapshot",
    url: "https://proxy.test/v1/responses?api_key=visible-query",
    headers: expect.objectContaining({ authorization: "[REDACTED]", "x-client": "visible" }),
  }));
});
```

Keep a separate assertion that no-scope and `debug: false` return the original `Request` object.

Update `pipeline/debug-logging.test.ts` after the existing `response.json()` assertion. The fixtures already consume one inbound body and two attempt responses:

```ts
expect(reconstructed(harness.logs, "inbound")).toContain(inboundPrompt);
expect(reconstructed(harness.logs, "upstream_request", 0)).toContain(inboundPrompt);
expect(reconstructed(harness.logs, "upstream_request", 1)).toContain(inboundPrompt);
expect(reconstructed(harness.logs, "upstream_response", 0)).toContain(primaryBody);
expect(reconstructed(harness.logs, "upstream_response", 1)).toContain(backupBody);
expect(harness.logs.filter((entry) => entry.event === "request.body_terminal")).toHaveLength(5);
```

- [ ] **Step 2: Run the inbound and pipeline tests and verify they fail**

Run:

```bash
rtk bun test \
  packages/server/src/request-logging/wire/wire.test.ts \
  packages/server/src/routes/pipeline/debug-logging.test.ts \
  packages/server/src/routes/token-count-debug-logging.test.ts
```

Expected: FAIL because routes still call `logInboundRequest()` and continue parsing the unobserved request.

- [ ] **Step 3: Implement and install the inbound wrapper**

Implement in `wire/wire.ts`:

```ts
export function observeInboundRequest(request: Request, inboundProtocol: string): Request {
  const scope = currentDebugRequestLogScope();
  if (scope === undefined) return request;
  logServerEvent(scope.logger, {
    event: "request.inbound_snapshot",
    requestId: scope.requestId,
    inboundProtocol,
    ...requestMetadata(request),
  });
  if (request.body === null) return request;
  try {
    return new Request(request, {
      body: observedBody(request.body, request.headers.get("content-type"), {
        requestId: scope.requestId,
        direction: "inbound",
      }, scope.logger),
    });
  } catch {
    return request;
  }
}
```

In `handleProtocolRequest`, create the observed request inside `withRequestLogContext` and pass it to the existing context function:

```ts
const rawRequest = observeInboundRequest(options.rawRequest, options.adapter.protocol);
return await handleProtocolRequestInContext({ ...options, rawRequest }, session);
```

Apply the same two lines in `handleTokenCount`. Remove all `await logInboundRequest(...)` calls and the old export.

Change `request-logging/index.ts` to publish the completed wire surface:

```ts
export { createObservedFetch, observeInboundRequest } from "./wire";
```

- [ ] **Step 4: Run the focused route tests**

Run the same command as Step 2.

Expected: PASS. Inbound content is emitted only when protocol parsing consumes it, fallback attempts retain distinct body identities, and token-count requests remain correlated.

- [ ] **Step 5: Commit Task 4**

```bash
rtk git add packages/server/src/request-logging/wire packages/server/src/routes/pipeline packages/server/src/routes/token-count.ts packages/server/src/routes/token-count-debug-logging.test.ts
rtk git commit -m "feat(server): tap complete inbound model requests" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Verify security boundaries, formatting, and the whole repository

**Files:**

- Modify: only the Task 1-4 files named above if verification exposes a defect; do not add features.

**Interfaces:**

- Consumes: Tasks 1-4.
- Produces: a preflight-clean branch ready to push to Draft PR #65.

- [ ] **Step 1: Scan for superseded sanitizer and limit code**

Run:

```bash
rtk rg -n 'SafeBodySnapshot|SafeJsonValue|SafeValueDescriptor|snapshotRequestBody|snapshotResponseBody|sanitizeJson|BODY_DEADLINE_MS|MAX_JSON_BYTES|request snapshot deadline exceeded' packages/server/src
```

Expected: no matches.

- [ ] **Step 2: Run all server tests**

First run the OAuth control-plane security regressions explicitly:

```bash
rtk bun test \
  packages/server/src/plugin-account-control-plane.test.ts \
  packages/server/src/plugin-account.test.ts \
  packages/server/src/plugin-quota/credential-refresh.test.ts \
  packages/server/src/plugin-quota/reset-security.test.ts
```

Expected: PASS; login, refresh, account, and quota failures still redact derived credentials.

Then run the complete server suite:

Run: `rtk bun run --filter @aio-proxy/server test:unit`

Expected: PASS with no hanging stream tests or unhandled rejections.

- [ ] **Step 3: Run static checks**

Run: `rtk bun run check`

Expected: PASS for oxlint, oxfmt check, and TypeScript constraints configured by the repository.

- [ ] **Step 4: Run full preflight**

Run: `rtk bun run preflight`

Expected: PASS for formatting, lint, and all workspace unit tests.

- [ ] **Step 5: Review the final diff and commit verification fixes if needed**

Run:

```bash
rtk git status --short
rtk git diff --check
rtk git diff origin/codex/cross-protocol-image-input...HEAD --stat
```

Expected: only the approved request-logging/spec/plan changes and prior PR work are present. If Steps 2-4 required code fixes, stage only the already-scoped implementation files:

```bash
rtk git add packages/server/src/request-logging packages/server/src/server-log.ts packages/server/src/logging/bridge packages/server/src/routes/pipeline packages/server/src/routes/token-count.ts packages/server/src/routes/token-count-debug-logging.test.ts packages/server/src/provider-runtime/observed-fetch.test.ts packages/server/src/plugin-runtime/host-fetch-context.test.ts
rtk git commit -m "fix(server): harden full payload logging" -m "Co-authored-by: Codex <noreply@openai.com>"
```

If verification changed nothing, do not create an empty commit.
