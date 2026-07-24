# Request Wire Debug Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ChatGPT OAuth `Host` forwarding failure and add safe, request-correlated debug snapshots for inbound and final upstream HTTP requests.

**Architecture:** Keep one `AsyncLocalStorage` request scope in `@aio-proxy/server`, nest provider-attempt identity around each real invocation, and observe provider traffic through a host-owned fetch wrapper passed at existing provider materialization seams. Snapshot helpers preserve transport structure while redacting payloads, and all non-debug paths delegate without cloning or reading bodies.

**Tech Stack:** Bun 1.3.14, TypeScript, Web Crypto SHA-256, `node:async_hooks`, LogTape, `bun:test`.

## Global Constraints

- Use the existing `server.logging.level: "debug"`; add no logging switch or dependency.
- Never emit clear-text credentials, cookies, prompts, tool data, images, files, or encrypted reasoning.
- Keep header names; retain values only for `host`, `content-type`, `content-length`, `accept`, `accept-encoding`, and `user-agent`.
- At non-debug levels, do not construct replacement requests, clone bodies, hash, parse, or serialize payload snapshots.
- Never clone or buffer successful upstream response bodies; read non-2xx response clones to at most 1 MiB.
- Keep request routing, fallback, cancellation, streaming, usage capture, and persisted request-attempt behavior unchanged.
- Keep third-party OAuth plugins source-compatible: `RuntimeContext.fetch` is optional.
- Add no clear-text escape hatch, sampling, remote shipping, Dashboard storage, or unrelated refactor.
- Keep handwritten source and test files at or below 300 lines; `packages/server/src/routes/pipeline/attempt.ts` must shrink before adding behavior.

---

### Task 1: Fix ChatGPT OAuth `Host` forwarding

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts:createOpenAIChatGPTDynamicFetch`

**Interfaces:**
- Consumes: `createOpenAIChatGPTDynamicFetch(credentials, fetcher)`.
- Produces: the existing dynamic fetch with caller `authorization` and `host` removed before ChatGPT identity headers are injected.

- [ ] **Step 1: Write the failing regression assertion**

Extend the existing “replaces caller auth” test input and assertions:

```ts
headers: {
  authorization: "Bearer caller-token",
  host: "127.0.0.1:22078",
  "x-keep": "1",
},

expect(first.headers.get("host")).toBeNull();
expect(first.headers.get("x-keep")).toBe("1");
```

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`

Expected: FAIL because the captured request still contains `host: 127.0.0.1:22078`.

- [ ] **Step 3: Apply the minimal root-cause fix**

Immediately after cloning caller headers:

```ts
const headers = new Headers(request.headers);
headers.delete("authorization");
headers.delete("host");
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk bun test packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`

Expected: PASS.

```bash
rtk git add packages/plugins/openai-chatgpt/src/runtime/runtime.ts packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts
rtk git commit -m "fix(openai-chatgpt): drop inbound host header" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Add request-scoped correlation and bridge propagation

**Files:**
- Create: `packages/server/src/request-logging/index.ts`
- Create: `packages/server/src/request-logging/context.ts`
- Create: `packages/server/src/request-logging/context.test.ts`
- Modify: `packages/server/src/logging/bridge/bridge.ts`
- Modify: `packages/server/src/logging/bridge/bridge.test.ts`

**Interfaces:**
- Produces: `withRequestLogContext<T>(input, operation): T`.
- Produces: `withAttemptLogContext<T>(input, operation): T`.
- Produces: `currentRequestLogContext(): RequestLogContext | undefined`.
- Produces: `currentDebugRequestLogScope(): RequestLogScope | undefined` for the wire observer in Task 3.
- `RequestLogContext` contains `requestId`, optional `attemptIndex`, optional `providerId`, and optional `modelId`.
- Internal `RequestLogScope` additionally contains `debug: boolean` and `logger: ServerLogSink`.

- [ ] **Step 1: Write failing async-context tests**

Cover nested attempt restoration, concurrent isolation, promise continuations, and stream callbacks:

```ts
const seen = await Promise.all(
  ["request-a", "request-b"].map((requestId, attemptIndex) =>
    withRequestLogContext({ requestId, debug: false, logger: () => {} }, async () => {
      await Promise.resolve();
      return await withAttemptLogContext(
        { attemptIndex, providerId: `provider-${attemptIndex}`, modelId: `model-${attemptIndex}` },
        async () => {
          const stream = new ReadableStream<string>({
            start(controller) {
              queueMicrotask(() => {
                controller.enqueue(JSON.stringify(currentRequestLogContext()));
                controller.close();
              });
            },
          });
          return JSON.parse(await new Response(stream).text());
        },
      );
    }),
  ),
);

expect(seen).toEqual([
  { requestId: "request-a", attemptIndex: 0, providerId: "provider-0", modelId: "model-0" },
  { requestId: "request-b", attemptIndex: 1, providerId: "provider-1", modelId: "model-1" },
]);
expect(currentRequestLogContext()).toBeUndefined();
```

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/server/src/request-logging/context.test.ts`

Expected: FAIL because the request-logging module does not exist.

- [ ] **Step 3: Implement the `AsyncLocalStorage` scope**

Use one module-owned store and immutable nested values:

```ts
import { AsyncLocalStorage } from "node:async_hooks";

import type { ServerLogSink } from "../server-log";

export type RequestLogContext = {
  readonly requestId: string;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
};

export type AttemptLogContext = Required<Omit<RequestLogContext, "requestId">>;

export type RequestLogScope = RequestLogContext & {
  readonly debug: boolean;
  readonly logger: ServerLogSink;
};

const storage = new AsyncLocalStorage<RequestLogScope>();

export function withRequestLogContext<T>(input: RequestLogScope, operation: () => T): T {
  return storage.run(input, operation);
}

export function withAttemptLogContext<T>(input: AttemptLogContext, operation: () => T): T {
  const parent = storage.getStore();
  return parent === undefined ? operation() : storage.run({ ...parent, ...input }, operation);
}
```

`currentRequestLogContext()` must return only correlation fields. `currentDebugRequestLogScope()` must return `undefined` unless an active scope has `debug: true`.

- [ ] **Step 4: Merge ambient correlation in both logging bridges**

At emission time, spread ambient fields last so plugins cannot spoof them:

```ts
const contextual = <Entry extends object>(entry: Entry) => ({
  ...entry,
  ...currentRequestLogContext(),
});
```

Use `contextual(entry)` for configured logger calls and fallback calls in both `createServerLogSink()` and `createPluginLogSink()`. Keep plugin logger category construction based on the original `entry.context`.

Extend `bridge.test.ts` to run both sinks inside an attempt scope and assert ambient `requestId`, `attemptIndex`, Provider ID, and model overwrite same-named caller fields. Also assert a background call remains byte-for-byte unchanged.

- [ ] **Step 5: Verify and commit**

Run:

```bash
rtk bun test packages/server/src/request-logging/context.test.ts
rtk bun test packages/server/src/logging/bridge/bridge.test.ts
```

Expected: both commands PASS.

```bash
rtk git add packages/server/src/request-logging packages/server/src/logging/bridge/bridge.ts packages/server/src/logging/bridge/bridge.test.ts
rtk git commit -m "feat(server): correlate request-scoped logs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Build safe snapshots and the observed fetch boundary

**Files:**
- Create: `packages/server/src/request-logging/snapshot.ts`
- Create: `packages/server/src/request-logging/snapshot.test.ts`
- Create: `packages/server/src/request-logging/wire.ts`
- Create: `packages/server/src/request-logging/wire.test.ts`
- Modify: `packages/server/src/request-logging/index.ts`
- Modify: `packages/server/src/server-log.ts`
- Modify: `packages/server/src/logging/bridge/bridge.ts`
- Modify: `packages/server/src/logging/bridge/bridge.test.ts`

**Interfaces:**
- Produces: `snapshotRequest(request: Request): Promise<HttpRequestSnapshot>`.
- Produces: `snapshotResponse(response: Response): Promise<HttpResponseSnapshot>`.
- Produces: `createObservedFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch`.
- Produces: `logInboundRequest(request: Request, inboundProtocol: string): Promise<void>`.
- Produces debug events `request.inbound_snapshot`, `request.upstream_snapshot`, and `request.upstream_result`.

- [ ] **Step 1: Write failing redaction tests**

Use unique sentinels in query values, credentials, prompts, tool arguments, image data, encrypted content, and unknown headers. Assert serialized snapshots never contain them while retaining safe structure:

```ts
expect(snapshot.url).toBe("https://upstream.test/v1/responses?api_key=%5BREDACTED%5D");
expect(snapshot.headers).toMatchObject({
  host: "proxy.test:22078",
  "content-type": "application/json",
  authorization: "[REDACTED]",
  "x-unknown": "[REDACTED]",
});
expect(snapshot.body).toMatchObject({ byteLength: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
expect(JSON.stringify(snapshot)).not.toContain(secretSentinel);
```

Test JSON protocol controls retain only string values under exact keys `model`, `stream`, `role`, `type`, and `effort`. Test bodies over 1 MiB omit JSON structure but keep request byte length and digest.

- [ ] **Step 2: Write failing transport tests**

Cover these contracts:

```ts
// Non-debug: preserve exact call arguments and perform no Request construction or cloning.
expect(baseCalls[0]?.input).toBe(originalRequest);

// Debug success: emit request + result metadata, but never call response.clone().
expect(responseCloneCalls).toBe(0);

// Debug non-2xx: sanitize at most 1 MiB from a clone and leave the returned body readable.
expect(await returned.text()).toBe(upstreamFailureBody);

// Debug exception: emit the bounded code without the message.
expect(logs).toContainEqual(expect.objectContaining({ outcome: "exception", exceptionCode: "ConnectionRefused" }));
expect(JSON.stringify(logs)).not.toContain("exception-message-sentinel");
```

Also assert Bun's existing `decompress: false` init extension reaches the delegated fetch after request materialization.

- [ ] **Step 3: Verify RED**

Run:

```bash
rtk bun test packages/server/src/request-logging/snapshot.test.ts
rtk bun test packages/server/src/request-logging/wire.test.ts
```

Expected: FAIL because snapshot and wire modules do not exist.

- [ ] **Step 4: Implement bounded snapshot types and helpers**

Use these diagnostic shapes:

```ts
export type SafeValueDescriptor = {
  readonly kind: "payload" | "redacted" | "string";
  readonly byteLength: number;
  readonly sha256?: string;
};

export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | SafeValueDescriptor
  | readonly SafeJsonValue[]
  | Readonly<Record<string, SafeJsonValue>>;

export type SafeBodySnapshot = {
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly atLeastByteLength?: number;
  readonly sha256?: string;
  readonly json?: SafeJsonValue;
  readonly omitted?: "non-json" | "oversized" | "unreadable";
};

export type HttpRequestSnapshot = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: SafeBodySnapshot;
};

export type HttpResponseSnapshot = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: SafeBodySnapshot;
};
```

Implementation rules:

- sanitize URL user info and query values before logging;
- cap retained header values at 512 characters;
- use `crypto.subtle.digest("SHA-256", bytes)` and lowercase hex;
- parse structured JSON only at or below 1 MiB;
- replace credential branches with `{ kind: "redacted", byteLength }` and no branch digest;
- replace free-form strings and sensitive payload branches with length/digest descriptors;
- catch all snapshot failures and return `{ omitted: "unreadable" }`, never raw data;
- stream-read non-2xx clones only until 1 MiB + 1 byte, cancel oversized clones, and omit exact digest/length in that case.

- [ ] **Step 5: Add safe exception extraction and debug event types**

Extend `RequestProviderAttemptFailedLog` and add upstream result fields with only own data properties:

```ts
export type SafeExceptionLog = {
  readonly errorType?: string;
  readonly exceptionCode?: string;
  readonly causeType?: string;
  readonly causeCode?: string;
  readonly errno?: string | number;
  readonly syscall?: string;
};
```

`serverErrorDetails(error)` must use `Object.getOwnPropertyDescriptor()` and accept only bounded strings or finite numbers. It must never read `message`, `stack`, or an accessor.

Add all three debug events to `ServerLog` and map them to `debug` in `SERVER_LOG_LEVEL`.

- [ ] **Step 6: Implement `createObservedFetch()`**

Fast path first:

```ts
const scope = currentDebugRequestLogScope();
if (scope === undefined || scope.attemptIndex === undefined || scope.providerId === undefined || scope.modelId === undefined) {
  return fetcher(input, init);
}
```

On debug attempts, materialize one `Request`, snapshot a clone, emit `request.upstream_snapshot`, then delegate that same `Request`. Preserve only the known Bun transport extension `decompress` in the second argument. Emit exactly one `request.upstream_result` for a response or exception. Do not clone 2xx responses.

`logInboundRequest()` uses the active debug scope, calls `snapshotRequest()`, and emits one inbound event with the active request ID.

- [ ] **Step 7: Verify and commit**

Run:

```bash
rtk bun test packages/server/src/request-logging
rtk bun test packages/server/src/logging/bridge/bridge.test.ts
```

Expected: PASS with no sentinel leakage.

```bash
rtk git add packages/server/src/request-logging packages/server/src/server-log.ts packages/server/src/logging/bridge
rtk git commit -m "feat(server): add safe wire debug snapshots" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Scope the shared request pipeline and improve failure diagnostics

**Files:**
- Create: `packages/server/src/routes/pipeline/attempt-base.ts`
- Create: `packages/server/src/routes/pipeline/debug-logging.test.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/_test/pipeline-helpers/providers.ts`
- Modify: `packages/server/src/routes/pipeline/test-support.ts`
- Modify: `packages/server/src/routes/pipeline/index.ts`
- Modify: `packages/server/src/routes/pipeline/attempt.ts`
- Modify: `packages/server/src/routes/pipeline/logging.ts`
- Modify: `packages/server/src/routes/pipeline/raw-fallback.test.ts`

**Interfaces:**
- `ProviderRouteSource` gains optional `debugLogging?: boolean`.
- The real `ServerState` sets it from the boot config's `server.logging.level === "debug"`.
- `request.provider_attempt_failed` gains required `attemptIndex` and optional safe exception fields.

- [ ] **Step 1: Write failing end-to-end pipeline assertions**

Create a two-provider fallback test whose raw transports call `createObservedFetch()` around a local capture fetch. Run with `debugLogging: true` and assert:

```ts
expect(harness.logs).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ event: "request.inbound_snapshot", requestId: "request-1" }),
    expect.objectContaining({
      event: "request.upstream_snapshot",
      requestId: "request-1",
      attemptIndex: 0,
      providerId: "primary",
    }),
    expect.objectContaining({
      event: "request.upstream_snapshot",
      requestId: "request-1",
      attemptIndex: 1,
      providerId: "backup",
    }),
  ]),
);
```

Assert the inbound prompt and upstream body sentinels do not occur in serialized logs. Add an info-level control case asserting only the existing warn event is present and the observed fetch receives the original `Request` identity.

- [ ] **Step 2: Extend the network failure regression**

Throw an error with own data properties:

```ts
const cause = Object.assign(new Error("cause-message-sentinel"), { code: "ECONNREFUSED" });
const failure = Object.assign(new Error("exception-message-sentinel"), {
  code: "ConnectionRefused",
  cause,
  errno: -61,
  syscall: "connect",
});
```

Assert the warning contains `attemptIndex: 0`, `exceptionCode`, `causeCode`, `errno`, and `syscall`, while neither message sentinel appears. Add a getter-backed `code` case and assert the getter is never invoked.

- [ ] **Step 3: Verify RED**

Run:

```bash
rtk bun test packages/server/src/routes/pipeline/debug-logging.test.ts
rtk bun test packages/server/src/routes/pipeline/raw-fallback.test.ts
```

Expected: FAIL because the pipeline does not install request/attempt scopes or emit snapshots and the warning lacks safe codes.

- [ ] **Step 4: Install the request scope without changing the candidate loop**

Keep `RequestRecorder.begin()` as the ID source and move the existing body into a private helper:

```ts
export async function handleProtocolRequest<TRequest, TContext>(options: HandleProtocolRequestOptions<TRequest, TContext>) {
  const session = options.source.requestRecorder.begin({ inboundProtocol: options.adapter.protocol });
  return await withRequestLogContext(
    {
      requestId: session.requestId,
      debug: options.source.debugLogging === true,
      logger: options.source.logger,
    },
    async () => {
      await logInboundRequest(options.rawRequest, options.adapter.protocol);
      return await handleProtocolRequestInContext(options, session);
    },
  );
}
```

`handleProtocolRequestInContext()` receives the already-created `RequestSession`; its routing, error mapping, body cancellation, and lease logic remain unchanged.

- [ ] **Step 5: Nest attempt identity only around real provider work**

Change the loop to `for (const [index, candidate] of candidates.entries())` and define:

```ts
const inAttempt = <T>(operation: () => T): T =>
  withAttemptLogContext(
    { attemptIndex: index, providerId: provider.id, modelId: candidate.modelId },
    operation,
  );
```

Use `inAttempt()` for `raw.invoke()`, `model.ensureAvailable()`, and `model.invoke()`. The AI SDK stream is constructed inside this scope so its promise and `ReadableStream` callbacks retain the attempt identity.

Move `attemptBase()` unchanged into `attempt-base.ts` before adding these calls so `attempt.ts` ends below 300 lines.

- [ ] **Step 6: Emit attempt index and safe error fields**

Pass `index` into `logProviderAttemptFailed()`, add `attemptIndex` to the event, and spread `serverErrorDetails(options.error)` only for `failureKind: "exception"`. Keep exception messages excluded.

Extend pipeline helpers with an optional debug flag; do not enable it by default because existing tests assert only warn/info events.

- [ ] **Step 7: Verify and commit**

Run:

```bash
rtk bun test packages/server/src/routes/pipeline/debug-logging.test.ts
rtk bun test packages/server/src/routes/pipeline/raw-fallback.test.ts
rtk bun test packages/server/src/routes/pipeline
```

Expected: PASS and `attempt.ts` remains below 300 lines.

```bash
rtk git add packages/server/src/runtime.ts packages/server/src/server-state/index.ts packages/server/_test/pipeline-helpers/providers.ts packages/server/src/routes/pipeline
rtk git commit -m "feat(server): trace protocol pipeline attempts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Observe built-in API and AI SDK provider fetches

**Files:**
- Create: `packages/server/src/provider-runtime/observed-fetch.test.ts`
- Modify: `packages/server/src/provider-runtime/materialize.ts`

**Interfaces:**
- Consumes: `createObservedFetch(fetcher)` from Task 3.
- Produces: API raw, API-to-AI-SDK bridge, and configured AI SDK providers sharing the observed wrapper around their effective proxy fetch.

- [ ] **Step 1: Write the failing materialization test**

Inject `createProxyFetch`, `createApiProvider`, `bridgeApiProvider`, and `createAiSdkProvider` spies. Capture each factory's `options.fetch`, call it inside a debug request+attempt scope, and assert each call emits an upstream snapshot with the final URL, generated header names, and sanitized body.

The key assertion is:

```ts
expect(apiFetch).toBe(bridgeFetch);
expect(logs.filter((entry) => entry.event === "request.upstream_snapshot")).toHaveLength(2);
```

Use a separate AI SDK provider fixture for the second event. Assert probes called outside a request scope delegate without emitting.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/server/src/provider-runtime/observed-fetch.test.ts`

Expected: FAIL because materialization passes the proxy fetch directly.

- [ ] **Step 3: Wrap the existing fetch seam once per provider**

For both configured provider kinds:

```ts
const providerFetch = createObservedFetch(createFetch(effectiveProxy(config.proxy, provider.proxy)));
```

Pass the same `providerFetch` to `createApiProvider()` and `bridgeApiProviderToAiSdk()` for an API provider. Pass it to `createAiSdkProvider()` for an AI SDK provider. Do not modify core provider implementations.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk bun test packages/server/src/provider-runtime/observed-fetch.test.ts
rtk bun test packages/server/src/provider-runtime
```

Expected: PASS.

```bash
rtk git add packages/server/src/provider-runtime/materialize.ts packages/server/src/provider-runtime/observed-fetch.test.ts
rtk git commit -m "feat(server): observe api provider fetches" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Add the host fetch to OAuth runtime context

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts`
- Create: `packages/server/src/plugin-runtime/host-fetch-context.test.ts`
- Modify: `packages/server/src/plugin-runtime/types.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`
- Modify: `packages/server/src/server-state/snapshot.ts`

**Interfaces:**
- `RuntimeContext<Credential, AccountOptions>` gains `readonly fetch?: typeof globalThis.fetch`.
- `MaterializePluginProviderOptions` gains optional `runtimeFetch?: typeof globalThis.fetch`.
- The server snapshot builder passes one `createObservedFetch(globalThis.fetch)` as `runtimeFetch` when creating OAuth runtimes.
- Existing third-party runtimes that ignore the field or construct contexts without it remain valid.

- [ ] **Step 1: Write the failing host-context test**

Register a test OAuth adapter whose `createRuntime(context)` captures `context.fetch`. Supply `runtimeFetch: createObservedFetch(baseFetch)` to materialization and assert:

```ts
expect(capturedFetch).toBeFunction();

await withRequestLogContext(
  { requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) },
  () =>
    withAttemptLogContext(
      { attemptIndex: 0, providerId: "oauth", modelId: "model" },
      () => capturedFetch?.("https://oauth-upstream.test/v1", { method: "POST", body: "wire-secret" }),
    ),
);

expect(logs).toContainEqual(expect.objectContaining({ event: "request.upstream_snapshot", providerId: "oauth" }));
expect(baseFetchCalls).toHaveLength(1);
```

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/server/src/plugin-runtime/host-fetch-context.test.ts`

Expected: FAIL because `RuntimeContext` and runtime materialization do not provide fetch.

- [ ] **Step 3: Add the optional SDK field and server injection**

```ts
export type RuntimeContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly catalog: ModelCatalog;
  readonly fetch?: typeof globalThis.fetch;
};
```

Pass `options.runtimeFetch` in the existing `adapter.createRuntime({...})` object only when defined. In `buildSnapshot()`, construct one observed wrapper and pass it to every OAuth materialization. Do not pass it to catalog discovery, login, quota, startup jobs, or background jobs.

- [ ] **Step 4: Verify SDK compatibility and commit**

Run:

```bash
rtk bun test packages/server/src/plugin-runtime/host-fetch-context.test.ts
rtk bun run --filter @aio-proxy/plugin-sdk test:types
```

Expected: PASS; existing contexts without `fetch` still type-check.

```bash
rtk git add packages/plugin-sdk/src/oauth.ts packages/server/src/plugin-runtime/types.ts packages/server/src/plugin-runtime/materialize.ts packages/server/src/plugin-runtime/host-fetch-context.test.ts packages/server/src/server-state/snapshot.ts
rtk git commit -m "feat(plugin-sdk): expose host runtime fetch" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Make every built-in OAuth runtime use the host fetch

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/runtime/host-fetch.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`
- Create: `packages/plugins/github-copilot/src/runtime/host-fetch.test.ts`
- Modify: `packages/plugins/github-copilot/src/runtime/runtime.ts`
- Create: `packages/plugins/kimi-code/src/runtime/host-fetch.test.ts`
- Modify: `packages/plugins/kimi-code/src/runtime/runtime.ts`
- Create: `packages/plugins/google-antigravity/src/runtime/host-fetch.test.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/provider.ts`
- Move: `packages/plugins/xai-grok/src/runtime.ts` -> `packages/plugins/xai-grok/src/runtime/runtime.ts`
- Move: `packages/plugins/xai-grok/src/runtime.test.ts` -> `packages/plugins/xai-grok/src/runtime/runtime.test.ts`
- Create: `packages/plugins/xai-grok/src/runtime/index.ts`

**Interfaces:**
- Each built-in selects `dependencies.fetch ?? context.fetch ?? globalThis.fetch` at runtime construction.
- Explicit dependency injection remains highest priority for existing unit tests.
- ChatGPT credential refresh uses the same selected fetch as its model transport.

- [ ] **Step 1: Write one failing final-request test per built-in**

For each runtime, provide a valid non-expired credential and a `context.fetch` capture function, invoke its raw transport or one language-model request, and assert exactly one final provider request reached that function. Install and restore a throwing `globalThis.fetch` guard so RED fails deterministically without network access.

Use these expected endpoints:

```ts
expect(chatgptRequest.url).toBe("https://chatgpt.com/backend-api/codex/responses");
expect(copilotRequest.url).toBe("https://api.githubcopilot.com/v1/chat/completions");
expect(kimiRequest.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
expect(antigravityRequest.url).toContain("cloudcode-pa.googleapis.com");
expect(grokRequest.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
```

Each test must also assert provider identity headers were added before the host fetch saw the request. The ChatGPT raw test must include a loopback `Host` and assert the host fetch sees no `host` header.

- [ ] **Step 2: Verify RED in all five packages**

Run:

```bash
rtk bun test packages/plugins/openai-chatgpt/src/runtime/host-fetch.test.ts
rtk bun test packages/plugins/github-copilot/src/runtime/host-fetch.test.ts
rtk bun test packages/plugins/kimi-code/src/runtime/host-fetch.test.ts
rtk bun test packages/plugins/google-antigravity/src/runtime/host-fetch.test.ts
rtk bun test packages/plugins/xai-grok/src/runtime/runtime.test.ts
```

Expected: FAIL because runtime traffic still reaches injected dependencies or `globalThis.fetch`, not `context.fetch`.

- [ ] **Step 3: Thread the selected fetch through each runtime**

Apply these exact precedence patterns:

```ts
// OpenAI ChatGPT
const dynamicFetch = createOpenAIChatGPTDynamicFetch(context.credentials, context.fetch);

// Kimi, Google, and xAI
const fetcher = dependencies.fetch ?? context.fetch;
// pass `fetcher` through only when defined; existing helper fallback remains globalThis.fetch

// GitHub Copilot
const fetcher = context.fetch ?? globalThis.fetch;
// pass `fetcher` into both dynamic and raw `fetchWithCredential` calls
```

Extend `currentCredential()` in ChatGPT to pass the selected fetch to `refreshAccessToken()`. Keep GitHub catalog/login fetch behavior unchanged; only runtime credential/model calls are in scope.

Move xAI runtime source and test into the required `runtime/index.ts`, `runtime/runtime.ts`, `runtime/runtime.test.ts` layout; keep `plugin.ts` importing `./runtime`.
Update moved xAI source imports from `./schema`, `./cli-headers`, and `./oauth` to their `../` forms, and update the moved test imports the same way.

- [ ] **Step 4: Verify all built-ins and commit**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit
rtk bun run --filter @aio-proxy/plugin-kimi-code test:unit
rtk bun run --filter @aio-proxy/plugin-google-antigravity test:unit
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
```

Expected: all five commands PASS.

```bash
rtk git add packages/plugins/openai-chatgpt packages/plugins/github-copilot packages/plugins/kimi-code packages/plugins/google-antigravity packages/plugins/xai-grok
rtk git commit -m "feat(plugins): observe oauth runtime requests" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Correlate token-count requests without changing persisted outcomes

**Files:**
- Create: `packages/server/src/routes/token-count-debug-logging.test.ts`
- Modify: `packages/server/src/routes/token-count.ts`
- Modify: `packages/server/src/routes/token-count.test-support.ts`
- Modify: `packages/server/src/routes/token-count.lifecycle.test.ts`

**Interfaces:**
- Valid token-count calls use the same request and attempt scopes as generation requests.
- `RequestRecorder.begin()` remains the request-ID source.
- Early validation failures create a transient session for correlation but do not call `finish()`, preserving the existing absence of persisted rows.

- [ ] **Step 1: Write the failing token-count debug test**

Enable debug logging on a token-count fixture, have the provider inspect `currentRequestLogContext()`, and assert:

```ts
expect(seen).toEqual({
  requestId: "request-1",
  attemptIndex: 0,
  providerId: "counter",
  modelId: "counter-wire",
});
expect(logs).toContainEqual(
  expect.objectContaining({ event: "request.inbound_snapshot", requestId: "request-1" }),
);
```

Add two concurrent count calls and assert their request IDs do not cross. Extend the validation lifecycle assertion to expect one `begin()` and zero `finish()` calls.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun test packages/server/src/routes/token-count-debug-logging.test.ts
rtk bun test packages/server/src/routes/token-count.lifecycle.test.ts
```

Expected: FAIL because token count creates its session after parsing and never enters request/attempt context.

- [ ] **Step 3: Wrap the route and provider calls**

Create the session at `handleTokenCount()` entry and run the existing logic inside:

```ts
return await withRequestLogContext(
  {
    requestId: session.requestId,
    debug: source.debugLogging === true,
    logger: source.logger,
  },
  async () => {
    await logInboundRequest(rawRequest, adapter.protocol);
    return await handleTokenCountInContext(options, session);
  },
);
```

Pass the session into `countCandidates()` instead of creating a second one. Iterate candidates with `.entries()` and wrap only `count.countTokens()` in `withAttemptLogContext({ attemptIndex, providerId, modelId }, ...)`.

Do not finish early parse/model-not-found sessions. Keep all existing success, failure, cancellation, fallback, estimate, lease, and body-cancellation logic unchanged.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk bun test packages/server/src/routes/token-count-debug-logging.test.ts
rtk bun test packages/server/src/routes/token-count.lifecycle.test.ts
rtk bun test packages/server/src/routes/token-count.test.ts
```

Expected: PASS.

```bash
rtk git add packages/server/src/routes/token-count.ts packages/server/src/routes/token-count.test-support.ts packages/server/src/routes/token-count.lifecycle.test.ts packages/server/src/routes/token-count-debug-logging.test.ts
rtk git commit -m "feat(server): correlate token count requests" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 9: Run final security and repository verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-request-wire-debug-logging-design.md`
- Modify: `docs/superpowers/plans/2026-07-24-request-wire-debug-logging.md`

**Interfaces:**
- Produces: a fully verified branch ready to push to draft PR #65.

- [ ] **Step 1: Run focused security regressions**

Run:

```bash
rtk bun test packages/server/src/request-logging
rtk bun test packages/server/src/routes/pipeline/debug-logging.test.ts
rtk bun test packages/server/src/routes/pipeline/raw-fallback.test.ts
rtk bun test packages/server/src/routes/token-count-debug-logging.test.ts
rtk bun test packages/plugins/openai-chatgpt/src/runtime
```

Expected: PASS; no serialized log contains any test sentinel.

- [ ] **Step 2: Run package and repository checks**

Run:

```bash
rtk bun run check
rtk bun run preflight
```

Expected: PASS with no lint, format, unit, type, artifact, or task-graph failures.

- [ ] **Step 3: Verify file sizes and diff scope**

Run:

```bash
rtk wc -l packages/server/src/routes/pipeline/attempt.ts packages/server/src/request-logging/*.ts
rtk git diff --check origin/main...HEAD
rtk git status --short
```

Expected: every handwritten file is at or below 300 lines, diff check is empty, and only intended plan-status edits remain uncommitted.

- [ ] **Step 4: Mark the approved spec and plan complete**

Set the design status to `Implemented` and check completed task boxes only after every command above passes.

```bash
rtk git add docs/superpowers/specs/2026-07-24-request-wire-debug-logging-design.md docs/superpowers/plans/2026-07-24-request-wire-debug-logging.md
rtk git commit -m "docs: complete request wire debug logging" -m "Co-authored-by: Codex <noreply@openai.com>"
```

- [ ] **Step 5: Inspect the final branch before push**

Run:

```bash
rtk git log --oneline origin/codex/cross-protocol-image-input..HEAD
rtk git diff --stat origin/codex/cross-protocol-image-input...HEAD
```

Expected: the history contains the design, plan, Host fix, correlation, snapshots, provider wiring, OAuth adoption, token-count integration, and completion commits only.
