# Shared Protocol Routing Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four duplicated protocol route orchestrators with one shared routing pipeline while preserving same-protocol raw passthrough and using materialized AI SDK model transports for cross-protocol calls.

**Architecture:** `packages/core` owns protocol adapters, their factory, protocol-shaped errors, request/tool conversion, and model egress. `packages/server` materializes each provider into optional `raw` and `model` capabilities, then one pipeline owns candidate selection, raw/model dispatch, fallback, preflight, usage capture, and request recording. Route files retain only URL registration and protocol-specific auxiliary endpoints.

**Tech Stack:** Bun 1.3.14, TypeScript 6.0, Hono 4, Zod 4, AI SDK 7.0.8, Bun test.

## Global Constraints

- The product contract is protocol compatibility first; cross-protocol conversion may be lossy, same-protocol raw passthrough may not be normalized through AI SDK.
- Dispatch rule: `same protocol + raw capability -> raw`; otherwise `model capability -> model`; otherwise record an unsupported attempt.
- Preserve Router candidate order. Raw `429`, raw `5xx`, raw network failures, model failures before response commitment, and model first-event failures may fall back.
- Do not fall back for raw ordinary `4xx`, inbound aborts, parse failures, or after a streaming response has been committed.
- Apply the existing `Content-Length > 8 MiB` guard uniformly. Do not add a streaming body limiter.
- `defineProtocolAdapter()` supplies contextual typing, default `variant: () => undefined`, and shallow freezing only. It must not own pipeline lifecycle behavior.
- Protocol adapters are stateless. Request-specific mutable state is passed as method arguments or kept inside one method call.
- API-to-AI-SDK bridges are created once during provider materialization and replaced only when the provider snapshot reloads.
- Treat `protocol-adapter-refactor` as reference material only; do not merge or rebase that branch into current `main`.
- Do not add dependencies, inbound protocols, transport-selection configuration, weighted random routing, health routing, circuit breakers, or configurable retry policies.
- Do not redesign raw `baseUrl` or credential semantics in this work.
- Keep unrelated workspace changes, especially the existing `.gitignore` modification, untouched.
- Every commit must append `Co-authored-by: Codex <noreply@openai.com>`.
- Write each known drift regression immediately before the task that fixes it, so every committed task remains green while still following red-green-refactor.

---

## Target File Map

### New core files

- `packages/core/src/protocol/adapter.ts` — `ProtocolAdapter`, `ModelInvocation`, `defineProtocolAdapter()`.
- `packages/core/src/protocol/request.ts` — JSON request reading and model rewriting.
- `packages/core/src/protocol/tools.ts` — function-tool to AI SDK `ToolSet` conversion.
- `packages/core/src/protocol/errors.ts` — protocol-shaped request/provider error mappers.
- `packages/core/src/protocol/openai-completions.ts` — OpenAI Chat Completions adapter.
- `packages/core/src/protocol/openai-responses.ts` — OpenAI Responses adapter.
- `packages/core/src/protocol/anthropic-messages.ts` — Anthropic Messages adapter and lossless AI SDK message conversion.
- `packages/core/src/protocol/gemini-generate-content.ts` — Gemini generateContent adapter.
- `packages/core/src/protocol/index.ts` — protocol module exports.

### New server files

- `packages/server/src/routes/pipeline.ts` — the only candidate loop and raw/model dispatch implementation.
- `packages/server/_test/pipeline-helpers.ts` — focused fake adapter/source/provider builders.
- `packages/server/_test/pipeline.test.ts` — pipeline contract tests.
- `packages/server/_test/cross-protocol-routing.test.ts` — HTTP-level dispatch matrix.
- `packages/server/_test/provider-runtime-capabilities.test.ts` — materialization and bridge lifecycle tests.

### Modified files

- `packages/core/src/index.ts` — export protocol interfaces and adapters.
- `packages/core/src/transform/anthropic-messages.ts` — retain tool names in tool-result history.
- `packages/core/src/egress/anthropic-messages.ts` — add non-stream response writer and tool-use SSE.
- `packages/core/_test/transform/anthropic-messages.test.ts` — pin tool name preservation.
- `packages/core/_test/egress/anthropic-messages.test.ts` — pin JSON/SSE tool output.
- `packages/server/src/runtime.ts` — expose raw/model capabilities and test input type.
- `packages/server/src/provider-runtime.ts` — materialize capabilities and one bridge per API provider.
- `packages/server/src/server-state.ts` — normalize injected providers before Router construction.
- `packages/server/src/server.ts` — accept `RuntimeProviderInput` test providers.
- `packages/server/src/route-observation.ts` — retain abort/completion helpers; remove provider message mapping.
- Four files under `packages/server/src/routes/` — replace orchestration with pipeline registrations.
- Existing route tests — retain external behavior and replace drift expectations.
- `AGENTS.md` — document the adapter/pipeline invariant.

### Deleted files after migration

- `packages/server/src/route-dispatch.ts`
- `packages/server/src/provider-availability.ts`
- `packages/core/src/egress/error.ts`

---

### Task 1: Protocol Adapter Factory and Shared Conversion Helpers

**Files:**
- Create: `packages/core/src/protocol/adapter.ts`
- Create: `packages/core/src/protocol/request.ts`
- Create: `packages/core/src/protocol/tools.ts`
- Create: `packages/core/src/protocol/index.ts`
- Create: `packages/core/_test/protocol/adapter.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ProtocolAdapter<TRequest, TContext>`, `ProtocolAdapterDefinition<TRequest, TContext>`, `ProtocolErrorMapper`, `ModelInvocation`, `ModelEventStream`, `EmptyProtocolContext`.
- Produces: `defineProtocolAdapter(definition)`.
- Produces: `readJsonRequest(raw)`, `rewriteJsonRequestModel(raw, modelId)`.
- Produces: `functionToolSet(tools)`.
- Consumes: existing AI SDK bridge types and `ProviderProtocol`.

- [ ] **Step 1: Write failing factory and helper tests**

Create `packages/core/_test/protocol/adapter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import {
  defineProtocolAdapter,
  functionToolSet,
  rewriteJsonRequestModel,
  type ProtocolAdapter,
} from "../../src/index";

type RequestValue = { readonly model: string };
type RouteContext = { readonly stream: boolean };

describe("defineProtocolAdapter", () => {
  test("adds the no-variant default and freezes the adapter", () => {
    const adapter = defineProtocolAdapter<RequestValue, RouteContext>({
      protocol: ProviderProtocol.OpenAICompatible,
      async parse(raw) {
        return (await raw.clone().json()) as RequestValue;
      },
      model: (request) => request.model,
      wantsStream: (_request, context) => context.stream,
      async rawRequest(raw) {
        return raw.clone();
      },
      modelInvocation: () => ({ messages: [] }),
      modelJson: async () => ({ ok: true }),
      modelSse: () => new ReadableStream<Uint8Array>(),
      errors: {
        requestError: () => undefined,
        modelNotFound: (message) => Response.json({ message }, { status: 404 }),
        tooLarge: () => new Response(null, { status: 413 }),
        unsupported: () => new Response(null, { status: 501 }),
        provider: () => undefined,
      },
    });

    expect(adapter.variant({ model: "m" }, { stream: false })).toBeUndefined();
    expect(Object.isFrozen(adapter)).toBe(true);
    const typed: ProtocolAdapter<RequestValue, RouteContext> = adapter;
    expect(typed.protocol).toBe(ProviderProtocol.OpenAICompatible);
  });
});

test("rewriteJsonRequestModel preserves unknown fields and removes content-length", async () => {
  const rewritten = await rewriteJsonRequestModel(
    new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: { "content-length": "99", "content-type": "application/json" },
      body: JSON.stringify({ model: "client-model", beta_field: { enabled: true } }),
    }),
    "upstream-model",
  );

  expect(rewritten.headers.get("content-length")).toBeNull();
  expect(await rewritten.json()).toEqual({
    model: "upstream-model",
    beta_field: { enabled: true },
  });
});

test("functionToolSet converts function definitions without mutating schemas", () => {
  const schema = { type: "object", properties: { city: { type: "string" } } };
  const tools = functionToolSet([{ name: "weather", description: "Weather", inputSchema: schema }]);

  expect(Object.keys(tools ?? {})).toEqual(["weather"]);
  expect(tools?.weather).toMatchObject({ type: "function", description: "Weather" });
  expect(schema).toEqual({ type: "object", properties: { city: { type: "string" } } });
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run:

```bash
bun test packages/core/_test/protocol/adapter.test.ts
```

Expected: FAIL because `packages/core/src/protocol/*` exports do not exist.

- [ ] **Step 3: Implement the adapter contract and factory**

Create `packages/core/src/protocol/adapter.ts`:

```ts
import type { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, ModelMessage, TextStreamPart, ToolSet } from "../ai-sdk-bridge";
export type EmptyProtocolContext = Readonly<Record<never, never>>;
export type ModelEventStream = ReadableStream<TextStreamPart<ToolSet>>;

export type ProtocolErrorMapper = Readonly<{
  requestError: (error: unknown) => Response | undefined;
  modelNotFound: (message: string) => Response;
  tooLarge: () => Response;
  unsupported: (feature: string) => Response;
  provider: (error: unknown) => Response | undefined;
}>;

export type ModelInvocation = {
  readonly messages: readonly ModelMessage[];
  readonly settings?: CallSettings;
  readonly tools?: ToolSet;
};

export type ProtocolAdapter<TRequest, TContext> = Readonly<{
  protocol: ProviderProtocol;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  variant: (request: TRequest, context: TContext) => string | undefined;
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (
    raw: Request,
    request: TRequest,
    resolvedModel: string,
    context: TContext,
  ) => Promise<Request>;
  modelInvocation: (request: TRequest, context: TContext) => ModelInvocation;
  modelJson: (stream: ModelEventStream) => Promise<unknown>;
  modelSse: (stream: ModelEventStream) => ReadableStream<Uint8Array>;
  errors: ProtocolErrorMapper;
}>;

export type ProtocolAdapterDefinition<TRequest, TContext> = Omit<
  ProtocolAdapter<TRequest, TContext>,
  "variant"
> & {
  readonly variant?: ProtocolAdapter<TRequest, TContext>["variant"];
};

const noVariant = (): undefined => undefined;

export function defineProtocolAdapter<TRequest, TContext>(
  definition: ProtocolAdapterDefinition<TRequest, TContext>,
): ProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    variant: definition.variant ?? noVariant,
  });
}
```

- [ ] **Step 4: Implement request and tool helpers**

Create `packages/core/src/protocol/request.ts`:

```ts
import { z } from "zod";

const jsonObjectSchema = z.object({}).catchall(z.unknown());

export function readJsonRequest(raw: Request): Promise<unknown> {
  return raw.clone().json();
}

export async function rewriteJsonRequestModel(raw: Request, modelId: string): Promise<Request> {
  const body = jsonObjectSchema.parse(await readJsonRequest(raw));
  const headers = new Headers(raw.headers);
  headers.delete("content-length");
  return new Request(raw, {
    body: JSON.stringify({ ...body, model: modelId }),
    headers,
  });
}
```

Create `packages/core/src/protocol/tools.ts`:

```ts
import { z } from "zod";
import type { JSONValue, ToolSet } from "../ai-sdk-bridge";
import { jsonSchema } from "../ai-sdk-bridge";

const jsonValueSchema = z.json();

export type FunctionToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
};

export function functionToolSet(tools: readonly FunctionToolDefinition[] | undefined): ToolSet | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const result: ToolSet = {};
  for (const tool of tools) {
    result[tool.name] = {
      type: "function",
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: jsonSchema(jsonSchemaObject(tool.inputSchema)),
      outputSchema: jsonSchema({}),
    };
  }
  return result;
}

function jsonSchemaObject(value: unknown): Parameters<typeof jsonSchema>[0] {
  const parsed = jsonValue(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function jsonValue(value: unknown): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
```

- [ ] **Step 5: Add protocol exports and run the focused test**

Create `packages/core/src/protocol/index.ts`:

```ts
export * from "./adapter";
export * from "./request";
export * from "./tools";
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./protocol";
```

Run:

```bash
bun test packages/core/_test/protocol/adapter.test.ts
bun run check
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol packages/core/src/index.ts packages/core/_test/protocol/adapter.test.ts
git commit -m "feat(core): define protocol adapter construction" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Protocol-Shaped Error Mappers

**Files:**
- Create: `packages/core/src/protocol/errors.ts`
- Create: `packages/core/_test/protocol/errors.test.ts`
- Modify: `packages/core/src/protocol/index.ts`

**Interfaces:**
- Consumes: `ProtocolErrorMapper` from Task 1.
- Produces: `openAICompletionsErrors`, `openAIResponsesErrors`, `anthropicMessagesErrors`, `geminiGenerateContentErrors`.
- Consumes: current typed parse/transform/provider errors.

- [ ] **Step 1: Write exact-envelope failure tests**

Create `packages/core/_test/protocol/errors.test.ts` with a table that asserts status and exact JSON for:

```ts
import { describe, expect, test } from "bun:test";
import {
  AnthropicMessagesTransformError,
  GeminiInlineDataTooLargeError,
  OpenAIResponsesUnsupportedFeatureError,
  ProviderNotInstalledError,
  anthropicMessagesErrors,
  geminiGenerateContentErrors,
  openAICompletionsErrors,
  openAIResponsesErrors,
} from "../../src/index";

async function body(response: Response | undefined): Promise<unknown> {
  if (response === undefined) {
    throw new Error("expected mapped response");
  }
  return response.json();
}

describe("protocol errors", () => {
  test("maps request errors to each inbound protocol", async () => {
    expect(await body(openAICompletionsErrors.requestError(new SyntaxError("bad")))).toEqual({
      error: { code: "invalid_request", message: "Invalid OpenAI Completions request", type: "invalid_request_error" },
    });
    expect(await body(openAIResponsesErrors.requestError(
      new OpenAIResponsesUnsupportedFeatureError("custom_tool", "tools"),
    ))).toEqual({
      error: {
        code: "unsupported_feature",
        message: "OpenAI Responses feature is not supported: custom_tool",
        type: "unsupported_feature",
      },
    });
    expect(await body(anthropicMessagesErrors.requestError(
      new AnthropicMessagesTransformError("messages.1"),
    ))).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid Anthropic Messages request" },
    });
    expect(await body(geminiGenerateContentErrors.requestError(
      new GeminiInlineDataTooLargeError("contents.0", 10, 11),
    ))).toEqual({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0 is 11 bytes; limit is 10",
        status: "RESOURCE_EXHAUSTED",
      },
    });
  });

  test("maps missing providers and declines truly unknown values", async () => {
    const missing = new ProviderNotInstalledError("p", "@vendor/provider");
    expect(openAICompletionsErrors.provider(missing)?.status).toBe(503);
    expect(anthropicMessagesErrors.provider(missing)?.status).toBe(503);
    expect(geminiGenerateContentErrors.provider(missing)?.status).toBe(503);
    expect(openAIResponsesErrors.provider(Symbol("unknown"))).toBeUndefined();
  });

  test("returns exact body-limit and model-not-found envelopes", async () => {
    expect(openAICompletionsErrors.tooLarge().status).toBe(413);
    expect(await body(anthropicMessagesErrors.modelNotFound("Model not found: x"))).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "Model not found: x" },
    });
    expect(await body(geminiGenerateContentErrors.modelNotFound("Model not found: x"))).toEqual({
      error: { code: 404, message: "Model not found: x", status: "NOT_FOUND" },
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm missing exports**

Run:

```bash
bun test packages/core/_test/protocol/errors.test.ts
```

Expected: FAIL because protocol error mappers do not exist.

- [ ] **Step 3: Implement the error mapper interface and exact response helpers**

Create `packages/core/src/protocol/errors.ts` with:

```ts
import { ZodError } from "zod";
import {
  AiSdkProviderError,
  AnthropicMessagesTransformError,
  GeminiGenerateContentTransformError,
  GeminiInlineDataTooLargeError,
  OpenAICompletionsTransformError,
  OpenAIResponsesTransformError,
  OpenAIResponsesUnsupportedFeatureError,
  ProviderNotInstalledError,
} from "../error";
import type { ProtocolErrorMapper } from "./adapter";

export const openAICompletionsErrors: ProtocolErrorMapper = {
  requestError: (error) =>
    error instanceof SyntaxError || error instanceof ZodError || error instanceof OpenAICompletionsTransformError
      ? openAIInvalid(400, "invalid_request", "Invalid OpenAI Completions request")
      : undefined,
  modelNotFound: (message) => openAIInvalid(404, "model_not_found", message),
  tooLarge: () => openAIInvalid(413, "request_too_large", "Request body too large"),
  unsupported: () =>
    openAIInvalid(501, "not_implemented", "Provider does not support OpenAI Completions transform dispatch"),
  provider: openAIProviderError,
};

export const openAIResponsesErrors: ProtocolErrorMapper = {
  requestError(error) {
    if (error instanceof OpenAIResponsesUnsupportedFeatureError) {
      return openAIUnsupported(error.feature);
    }
    return error instanceof SyntaxError || error instanceof ZodError || error instanceof OpenAIResponsesTransformError
      ? openAIInvalid(400, "invalid_request", "Invalid OpenAI Responses request")
      : undefined;
  },
  modelNotFound: (message) => openAIInvalid(404, "model_not_found", message),
  tooLarge: () => openAIInvalid(413, "request_too_large", "Request body too large"),
  unsupported: openAIUnsupported,
  provider: openAIProviderError,
};

export const anthropicMessagesErrors: ProtocolErrorMapper = {
  requestError: (error) =>
    error instanceof SyntaxError || error instanceof ZodError || error instanceof AnthropicMessagesTransformError
      ? anthropicError(400, "invalid_request_error", "Invalid Anthropic Messages request")
      : undefined,
  modelNotFound: (message) => anthropicError(404, "not_found_error", message),
  tooLarge: () => anthropicError(413, "invalid_request_error", "Request body too large"),
  unsupported: () =>
    anthropicError(501, "invalid_request_error", "Provider does not support Anthropic Messages transform dispatch"),
  provider: (error) => genericProviderError(error, (status, message) =>
    anthropicError(status, "invalid_request_error", message),
  ),
};

export const geminiGenerateContentErrors: ProtocolErrorMapper = {
  requestError(error) {
    if (error instanceof GeminiInlineDataTooLargeError) {
      return geminiError(413, "RESOURCE_EXHAUSTED", error.message);
    }
    return error instanceof SyntaxError || error instanceof ZodError || error instanceof GeminiGenerateContentTransformError
      ? geminiError(400, "INVALID_ARGUMENT", "Invalid Gemini request")
      : undefined;
  },
  modelNotFound: (message) => geminiError(404, "NOT_FOUND", message),
  tooLarge: () => geminiError(413, "RESOURCE_EXHAUSTED", "Request body too large"),
  unsupported: () =>
    geminiError(501, "UNIMPLEMENTED", "Provider does not support Gemini generateContent transform dispatch"),
  provider: (error) => genericProviderError(error, (status, message) =>
    geminiError(status, "UNAVAILABLE", message),
  ),
};
```

Add the private helpers in the same file:

```ts
function openAIProviderError(error: unknown): Response | undefined {
  const cause = error instanceof AiSdkProviderError ? error.cause : error;
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return openAIInvalid(503, "provider_not_installed", missing.message);
  }
  const message = providerMessage(cause);
  if (message === undefined) {
    return undefined;
  }
  if (isAbortOrTimeout(cause)) {
    return openAIInvalid(499, "aborted", message);
  }
  const status = statusCode(cause);
  return openAIInvalid(status ?? 500, status === undefined ? "internal_error" : "upstream_error", message);
}

function genericProviderError(
  error: unknown,
  response: (status: 500 | 503, message: string) => Response,
): Response | undefined {
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return response(503, missing.message);
  }
  const message = providerMessage(error);
  return message === undefined ? undefined : response(500, message);
}

function providerNotInstalled(error: unknown): ProviderNotInstalledError | undefined {
  if (error instanceof ProviderNotInstalledError) {
    return error;
  }
  return error instanceof AiSdkProviderError && error.cause instanceof ProviderNotInstalledError
    ? error.cause
    : undefined;
}

function providerMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null) return "Upstream provider error";
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return undefined;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("response" in error && typeof error.response === "object" && error.response !== null &&
      "status" in error.response && typeof error.response.status === "number") return error.response.status;
  return undefined;
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function openAIUnsupported(feature: string): Response {
  return Response.json({
    error: {
      code: "unsupported_feature",
      message: `OpenAI Responses feature is not supported: ${feature}`,
      type: "unsupported_feature",
    },
  }, { status: 501 });
}

function openAIInvalid(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, type: "invalid_request_error" } }, { status });
}

function anthropicError(
  status: number,
  type: "invalid_request_error" | "not_found_error",
  message: string,
): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function geminiError(
  code: 400 | 404 | 413 | 500 | 501 | 503,
  status: "INVALID_ARGUMENT" | "NOT_FOUND" | "RESOURCE_EXHAUSTED" | "UNAVAILABLE" | "UNIMPLEMENTED",
  message: string,
): Response {
  return Response.json({ error: { code, message, status } }, { status: code });
}
```

- [ ] **Step 4: Export and verify**

Add to `packages/core/src/protocol/index.ts`:

```ts
export * from "./errors";
```

Run:

```bash
bun test packages/core/_test/protocol/errors.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/errors.ts packages/core/src/protocol/index.ts packages/core/_test/protocol/errors.test.ts
git commit -m "feat(core): centralize protocol error mapping" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: OpenAI Protocol Adapters

**Files:**
- Create: `packages/core/src/protocol/openai-completions.ts`
- Create: `packages/core/src/protocol/openai-responses.ts`
- Create: `packages/core/_test/protocol/openai-completions.test.ts`
- Create: `packages/core/_test/protocol/openai-responses.test.ts`
- Modify: `packages/core/src/protocol/index.ts`

**Interfaces:**
- Produces: `openAICompletionsAdapter`.
- Produces: `openAIResponsesAdapter`.
- Consumes: Task 1 factory/helpers and Task 2 error mappers.

- [ ] **Step 1: Write failing adapter tests**

Tests must assert:

```ts
const raw = new Request("https://proxy.test/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "alias",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
    reasoning_effort: "high",
    beta_field: true,
  }),
});

const parsed = await openAICompletionsAdapter.parse(raw, {});
expect(openAICompletionsAdapter.model(parsed, {})).toBe("alias");
expect(openAICompletionsAdapter.variant(parsed, {})).toBe("high");
expect(Object.keys(openAICompletionsAdapter.modelInvocation(parsed, {}).tools ?? {})).toEqual(["weather"]);
expect(await (await openAICompletionsAdapter.rawRequest(raw, parsed, "upstream", {})).json()).toMatchObject({
  model: "upstream",
  beta_field: true,
});
```

For Responses, assert absent stream defaults to non-stream, reasoning effort selects a variant, custom tools throw `OpenAIResponsesUnsupportedFeatureError`, and JSON/SSE functions reference the current egress writers.

- [ ] **Step 2: Run tests and confirm missing adapters**

```bash
bun test packages/core/_test/protocol/openai-completions.test.ts packages/core/_test/protocol/openai-responses.test.ts
```

Expected: FAIL because adapter modules do not exist.

- [ ] **Step 3: Implement OpenAI Completions adapter**

Create `packages/core/src/protocol/openai-completions.ts`:

```ts
import { ProviderProtocol } from "@aio-proxy/types";
import {
  writeOpenAICompletionsResponse,
  writeOpenAICompletionsSSE,
} from "../egress/openai-completions";
import {
  type OpenAICompletionsRequest,
  parseOpenAICompletions,
} from "../ingress/openai-completions";
import { openAICompletionsToModelMessages } from "../transform/openai-completions";
import { defineProtocolAdapter, type EmptyProtocolContext } from "./adapter";
import { openAICompletionsErrors } from "./errors";
import { readJsonRequest, rewriteJsonRequestModel } from "./request";
import { functionToolSet } from "./tools";

export const openAICompletionsAdapter = defineProtocolAdapter<
  OpenAICompletionsRequest,
  EmptyProtocolContext
>({
  protocol: ProviderProtocol.OpenAICompatible,
  async parse(raw) {
    return parseOpenAICompletions(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  variant: (request) => request.reasoning_effort,
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel ? Promise.resolve(raw.clone()) : rewriteJsonRequestModel(raw, resolvedModel);
  },
  modelInvocation(request) {
    const transformed = openAICompletionsToModelMessages(request);
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: transformed.settings,
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelJson: writeOpenAICompletionsResponse,
  modelSse: writeOpenAICompletionsSSE,
  errors: openAICompletionsErrors,
});
```

- [ ] **Step 4: Implement OpenAI Responses adapter**

Create `packages/core/src/protocol/openai-responses.ts`:

```ts
import { ProviderProtocol } from "@aio-proxy/types";
import { OpenAIResponsesUnsupportedFeatureError } from "../error";
import {
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "../egress/openai-responses";
import { type OpenAIResponsesRequest, parseOpenAIResponses } from "../ingress/openai-responses";
import { openAIResponsesToModelMessages } from "../transform/openai-responses";
import { defineProtocolAdapter, type EmptyProtocolContext } from "./adapter";
import { openAIResponsesErrors } from "./errors";
import { readJsonRequest, rewriteJsonRequestModel } from "./request";
import { functionToolSet } from "./tools";

export const openAIResponsesAdapter = defineProtocolAdapter<OpenAIResponsesRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.OpenAIResponse,
  async parse(raw) {
    return parseOpenAIResponses(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  variant: (request) => request.reasoning?.effort,
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel ? Promise.resolve(raw.clone()) : rewriteJsonRequestModel(raw, resolvedModel);
  },
  modelInvocation(request) {
    const transformed = openAIResponsesToModelMessages(request);
    const custom = transformed.tools?.find((tool) => tool.type === "custom");
    if (custom !== undefined) {
      throw new OpenAIResponsesUnsupportedFeatureError("custom_tool", "tools");
    }
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: transformed.settings,
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelJson: writeOpenAIResponsesResponse,
  modelSse: writeOpenAIResponsesSSE,
  errors: openAIResponsesErrors,
});
```

- [ ] **Step 5: Export, run adapter and existing transform/egress tests**

Add both exports to `packages/core/src/protocol/index.ts`.

Run:

```bash
bun test packages/core/_test/protocol/openai-completions.test.ts packages/core/_test/protocol/openai-responses.test.ts
bun test packages/core/_test/transform/openai-completions.test.ts packages/core/_test/transform/openai-responses.test.ts
bun test packages/core/_test/egress/openai-completions.test.ts packages/core/_test/egress/openai-responses.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol packages/core/_test/protocol
git commit -m "feat(core): add OpenAI protocol adapters" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Preserve Anthropic Tool Semantics in Transform and Egress

**Files:**
- Modify: `packages/core/src/transform/anthropic-messages.ts`
- Modify: `packages/core/src/egress/anthropic-messages.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/_test/transform/anthropic-messages.test.ts`
- Modify: `packages/core/_test/egress/anthropic-messages.test.ts`

**Interfaces:**
- Produces: tool-result model parts with a non-empty tool name when a preceding tool-use supplies it.
- Produces: `writeAnthropicMessagesResponse(stream)`.
- Extends: `writeAnthropicMessagesSSE(stream)` with Anthropic `tool_use` frames.

- [ ] **Step 1: Add failing transform and egress tests**

Add a transform assertion for the existing `multi-tool.json` fixture:

```ts
expect(converted.messages[2]).toEqual({
  role: "user",
  content: [
    expect.objectContaining({ type: "tool-result", toolCallId: "toolu_weather", toolName: "weather" }),
    expect.objectContaining({ type: "tool-result", toolCallId: "toolu_time", toolName: "clock" }),
    { type: "text", text: "Summarize both." },
  ],
});
```

Add JSON and SSE egress tests using these model events:

```ts
const parts = [
  { type: "tool-input-start", id: "tool-1", toolName: "weather" },
  { type: "tool-input-delta", id: "tool-1", delta: "{\"city\":\"Paris\"}" },
  { type: "tool-input-end", id: "tool-1" },
  {
    type: "finish",
    finishReason: "tool-calls",
    rawFinishReason: "tool_use",
    totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
  },
] satisfies readonly TextStreamPart<ToolSet>[];
```

Assert JSON contains:

```ts
{
  type: "tool_use",
  id: "tool-1",
  name: "weather",
  input: { city: "Paris" },
}
```

Assert SSE contains `content_block_start` with `tool_use`, `input_json_delta`, `content_block_stop`, and `stop_reason:"tool_use"`.

- [ ] **Step 2: Run tests and verify current failures**

```bash
bun test packages/core/_test/transform/anthropic-messages.test.ts packages/core/_test/egress/anthropic-messages.test.ts
```

Expected: FAIL because tool names are empty, non-stream writer is absent, and SSE ignores tool events.

- [ ] **Step 3: Track tool names while transforming request history**

Replace the direct `req.messages.map(messageToModelMessage)` call with an ordered loop:

```ts
const toolNames = new Map<string, string>();
const messages: AnthropicModelMessage[] = [];
for (const message of req.messages) {
  messages.push(messageToModelMessage(message, toolNames));
}
```

Change assistant conversion so each `tool_use` records `id -> name`, and change user `tool_result` conversion to use:

```ts
function toolResultPart(part: AnthropicToolResultBlock, toolNames: ReadonlyMap<string, string>): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: part.tool_use_id,
    toolName: toolNames.get(part.tool_use_id) ?? "",
    output:
      typeof part.content === "string"
        ? { type: "text", value: part.content }
        : { type: "content", value: part.content.map(({ text }) => ({ type: "text", text })) },
    ...(part.cache_control === undefined ? {} : { providerOptions: cacheProviderOptions(part.cache_control) }),
  };
}
```

Keep round-trip output unchanged; Anthropic wire tool results still identify calls by `tool_use_id`.

- [ ] **Step 4: Add the non-stream writer and tool SSE state**

In `packages/core/src/egress/anthropic-messages.ts`, export:

```ts
export type AnthropicMessageResponse = {
  readonly id: "msg_aio_proxy";
  readonly type: "message";
  readonly role: "assistant";
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  )[];
  readonly model: "aio-proxy";
  readonly stop_reason: AnthropicStopReason;
  readonly stop_sequence: null;
  readonly usage?: AnthropicUsage;
};

export async function writeAnthropicMessagesResponse(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
): Promise<AnthropicMessageResponse> {
  const text: string[] = [];
  const tools = new Map<string, { readonly id: string; readonly name: string; input: string }>();
  let stopReason: AnthropicStopReason = "end_turn";
  let usage: AnthropicUsage | undefined;

  for await (const part of stream) {
    if (part.type === "text-delta") text.push(textDelta(part));
    if (part.type === "tool-input-start") tools.set(part.id, { id: part.id, name: part.toolName, input: "" });
    if (part.type === "tool-input-delta") {
      const tool = tools.get(part.id);
      if (tool !== undefined) tool.input += part.delta;
    }
    if (part.type === "finish") {
      stopReason = anthropicStopReason(part.finishReason);
      usage = anthropicUsage(finishUsage(part));
    }
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content: [
      ...(text.length === 0 ? [] : [{ type: "text" as const, text: text.join("") }]),
      ...Array.from(tools.values(), (tool) => ({
        type: "tool_use" as const,
        id: tool.id,
        name: tool.name,
        input: parseJson(tool.input),
      })),
    ],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    ...(usage === undefined ? {} : { usage }),
  };
}
```

Extend SSE with a monotonically increasing content-block index. On `tool-input-start`, emit:

```ts
event("content_block_start", {
  type: "content_block_start",
  index,
  content_block: { type: "tool_use", id: part.id, name: part.toolName, input: {} },
})
```

On `tool-input-delta`, emit:

```ts
event("content_block_delta", {
  type: "content_block_delta",
  index: tool.index,
  delta: { type: "input_json_delta", partial_json: part.delta },
})
```

On `tool-input-end`, emit `content_block_stop` for that tool index. Before `message_delta`, close any open text/tool blocks.

- [ ] **Step 5: Export and verify**

Export `writeAnthropicMessagesResponse` and `AnthropicMessageResponse` from `packages/core/src/index.ts`.

Run:

```bash
bun test packages/core/_test/transform/anthropic-messages.test.ts packages/core/_test/egress/anthropic-messages.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transform/anthropic-messages.ts packages/core/src/egress/anthropic-messages.ts packages/core/src/index.ts packages/core/_test/transform/anthropic-messages.test.ts packages/core/_test/egress/anthropic-messages.test.ts
git commit -m "fix(core): preserve Anthropic tool semantics" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Anthropic Protocol Adapter

**Files:**
- Create: `packages/core/src/protocol/anthropic-messages.ts`
- Create: `packages/core/_test/protocol/anthropic-messages.test.ts`
- Modify: `packages/core/src/protocol/index.ts`

**Interfaces:**
- Produces: `anthropicMessagesAdapter`.
- Consumes: Task 4 transform and egress behavior.

- [ ] **Step 1: Write failing adapter tests**

Cover:

- stream absent/false/true;
- alias model rewrite while preserving an unknown beta field;
- system message provider options;
- assistant tool call;
- user tool result split into an AI SDK `tool` message followed by remaining user text;
- non-stream writer reference.

The critical expected message sequence is:

```ts
expect(invocation.messages.slice(1)).toEqual([
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "toolu_weather", toolName: "weather", input: { city: "Paris" } }],
  },
  {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "toolu_weather",
      toolName: "weather",
      output: { type: "text", value: "Sunny" },
    }],
  },
  { role: "user", content: [{ type: "text", text: "Summarize." }] },
]);
```

- [ ] **Step 2: Run the focused test**

```bash
bun test packages/core/_test/protocol/anthropic-messages.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement ordered Anthropic-to-AI-SDK conversion**

Create `packages/core/src/protocol/anthropic-messages.ts` using `defineProtocolAdapter`. Implement `modelInvocation()` by converting `AnthropicModelMessage` values to real `ModelMessage` values:

```ts
function aiSdkMessages(messages: readonly AnthropicModelMessage[]): readonly ModelMessage[] {
  return messages.flatMap((message) => {
    switch (message.role) {
      case "system":
        return [{
          role: "system",
          content: message.content,
          ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }),
        }];
      case "assistant":
        return [{
          role: "assistant",
          content: typeof message.content === "string" ? message.content : message.content.map(assistantPart),
        }];
      case "tool":
        return [{ role: "tool", content: message.content.map(toolResultPart) }];
      case "user":
        return userMessages(message.content);
    }
  });
}
```

Implement `userMessages()` so consecutive text parts become a user message, consecutive tool results become a tool message, and source ordering is preserved by flushing when the part kind changes. Preserve `providerOptions` on text, reasoning, tool-call, and tool-result parts.

- [ ] **Step 4: Define the adapter object**

```ts
export const anthropicMessagesAdapter = defineProtocolAdapter<
  AnthropicMessagesRequest,
  EmptyProtocolContext
>({
  protocol: ProviderProtocol.Anthropic,
  async parse(raw) {
    return parseAnthropicMessages(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel ? Promise.resolve(raw.clone()) : rewriteJsonRequestModel(raw, resolvedModel);
  },
  modelInvocation(request) {
    const transformed = anthropicMessagesToModelMessages(request);
    return { messages: aiSdkMessages(transformed.messages), settings: transformed.settings };
  },
  modelJson: writeAnthropicMessagesResponse,
  modelSse: writeAnthropicMessagesSSE,
  errors: anthropicMessagesErrors,
});
```

- [ ] **Step 5: Export and verify**

```bash
bun test packages/core/_test/protocol/anthropic-messages.test.ts
bun test packages/core/_test/transform/anthropic-messages.test.ts packages/core/_test/egress/anthropic-messages.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol/anthropic-messages.ts packages/core/src/protocol/index.ts packages/core/_test/protocol/anthropic-messages.test.ts
git commit -m "feat(core): add Anthropic protocol adapter" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Gemini Protocol Adapter

**Files:**
- Create: `packages/core/src/protocol/gemini-generate-content.ts`
- Create: `packages/core/_test/protocol/gemini-generate-content.test.ts`
- Modify: `packages/core/src/protocol/index.ts`

**Interfaces:**
- Produces: `GeminiRouteContext`.
- Produces: `geminiGenerateContentAdapter`.
- Consumes: Task 1 tool helper and existing Gemini transforms/egress.

- [ ] **Step 1: Write failing adapter tests**

Assert:

- route context model overrides any body model;
- `context.stream` controls streaming;
- `thinkingLevel: "HIGH"` returns variant `"HIGH"` and model invocation reasoning `"high"`;
- generation settings, safety settings, and function tools reach `ModelInvocation`;
- alias rewrite changes only the URL model segment and preserves request body bytes.

- [ ] **Step 2: Run the focused test**

```bash
bun test packages/core/_test/protocol/gemini-generate-content.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement Gemini settings conversion and adapter**

Create `packages/core/src/protocol/gemini-generate-content.ts`. Move the current `aiSdkSettings`, `geminiReasoning`, `aiSdkProviderOptions`, and route-local function-tool mapping from `packages/server/src/routes/gemini-generate-content.ts` into this module.

Use:

```ts
export type GeminiRouteContext = {
  readonly model: string;
  readonly stream: boolean;
};

export const geminiGenerateContentAdapter = defineProtocolAdapter<
  GeminiGenerateContentRequest,
  GeminiRouteContext
>({
  protocol: ProviderProtocol.Gemini,
  async parse(raw, context) {
    const body = await readJsonRequest(raw);
    return parseGeminiGenerateContent(
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...body, model: context.model }
        : body,
    );
  },
  model: (_request, context) => context.model,
  variant: (request) => request.generationConfig?.thinkingConfig?.thinkingLevel,
  wantsStream: (_request, context) => context.stream,
  async rawRequest(raw, _request, resolvedModel, context) {
    if (context.model === resolvedModel) return raw.clone();
    const url = new URL(raw.url);
    url.pathname = `/v1beta/models/${encodeURIComponent(resolvedModel)}${
      context.stream ? ":streamGenerateContent" : ":generateContent"
    }`;
    return new Request(url, raw.clone());
  },
  modelInvocation(request) {
    const transformed = geminiGenerateContentToModelMessages(request);
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: aiSdkSettings(transformed.settings),
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelJson: writeGeminiGenerateContentResponse,
  modelSse: writeGeminiGenerateContentSSE,
  errors: geminiGenerateContentErrors,
});
```

Keep the current accepted reasoning enum exactly: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.

- [ ] **Step 4: Export and verify**

```bash
bun test packages/core/_test/protocol/gemini-generate-content.test.ts
bun test packages/core/_test/transform/gemini-generate-content.test.ts packages/core/_test/egress/gemini-generate-content.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/gemini-generate-content.ts packages/core/src/protocol/index.ts packages/core/_test/protocol/gemini-generate-content.test.ts
git commit -m "feat(core): add Gemini protocol adapter" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Materialize Raw and Model Provider Capabilities

**Files:**
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/provider-runtime.ts`
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/src/server.ts`
- Create: `packages/server/_test/provider-runtime-capabilities.test.ts`

**Interfaces:**
- Produces: `RawTransport`, `ModelTransport`, `RuntimeCapabilities`.
- Produces: `RuntimeProviderInput`, `RuntimeProviderInstance`.
- Produces: `materializeRuntimeProvider(input, options)`.
- Changes: `CreateServerOptions.providerInstances` accepts legacy test instances or pre-materialized instances.

- [ ] **Step 1: Write failing materialization tests**

Test these exact facts:

```ts
const bridge = {
  id: "api:bridge",
  kind: ProviderKind.AiSdk,
  invoke: () => new ReadableStream(),
} satisfies AiSdkProviderInstance;

let bridgeCalls = 0;
const runtime = materializeProviders(config, {
  bridgeApiProvider(provider) {
    bridgeCalls += 1;
    expect(provider.id).toBe("api");
    return bridge;
  },
});

expect(bridgeCalls).toBe(1);
expect(runtime.providers[0]?.raw?.protocol).toBe(ProviderProtocol.OpenAICompatible);
expect(runtime.providers[0]?.model?.invoke).toBe(bridge.invoke);
```

Also test:

- AI SDK and OAuth inputs expose only `model`;
- an injected API test double without `baseUrl` exposes `raw` but does not synthesize a bridge;
- passing an already materialized object returns the same object;
- two reads from one snapshot return the same `model` reference.

- [ ] **Step 2: Run the focused test**

```bash
bun test packages/server/_test/provider-runtime-capabilities.test.ts
```

Expected: FAIL because capability types/functions do not exist.

- [ ] **Step 3: Add runtime capability types**

In `packages/server/src/runtime.ts` define:

```ts
export type RawTransport = {
  readonly protocol: ProviderProtocol;
  readonly invoke: ApiProviderInstance["passthrough"];
};

export type ModelTransport = {
  readonly ensureAvailable?: () => Promise<void>;
  readonly invoke: AiSdkProviderInstance["invoke"];
};

export type RuntimeCapabilities = {
  readonly raw?: RawTransport;
  readonly model?: ModelTransport;
};

export type LegacyRuntimeProviderInstance =
  | ApiProviderInstance
  | AiSdkProviderInstance
  | OAuthProviderInstance;

export type RuntimeProviderInstance = LegacyRuntimeProviderInstance & RuntimeCapabilities;
export type RuntimeProviderInput = LegacyRuntimeProviderInstance | RuntimeProviderInstance;
```

Keep `kind` and optional `protocol` on the underlying instance for request-log metadata; pipeline dispatch must use only `raw` and `model`.

- [ ] **Step 4: Implement capability materialization**

In `packages/server/src/provider-runtime.ts` add:

```ts
export type MaterializeProvidersOptions = {
  readonly bridgeApiProvider?: typeof bridgeApiProviderToAiSdk;
};

export function materializeRuntimeProvider(
  provider: RuntimeProviderInput,
  options: { readonly apiBridge?: AiSdkProviderInstance } = {},
): RuntimeProviderInstance {
  if ("raw" in provider || "model" in provider) {
    return provider;
  }

  if (provider.kind === ProviderKind.Api) {
    return {
      ...provider,
      raw: { protocol: provider.protocol, invoke: provider.passthrough },
      ...(options.apiBridge === undefined
        ? {}
        : {
            model: {
              ...(options.apiBridge.ensureAvailable === undefined
                ? {}
                : { ensureAvailable: options.apiBridge.ensureAvailable }),
              invoke: options.apiBridge.invoke,
            },
          }),
    };
  }

  return {
    ...provider,
    model: {
      ...(provider.ensureAvailable === undefined ? {} : { ensureAvailable: provider.ensureAvailable }),
      invoke: provider.invoke,
    },
  };
}
```

Change `materializeProviders(config, options = {})` so API providers call the bridge factory exactly once:

```ts
const bridgeApiProvider = options.bridgeApiProvider ?? bridgeApiProviderToAiSdk;
const api = createApiProvider(provider);
const instance = materializeRuntimeProvider(api, { apiBridge: bridgeApiProvider(provider) });
```

AI SDK and OAuth instances call `materializeRuntimeProvider(instance)`.

- [ ] **Step 5: Normalize injected test providers and update summaries**

In `packages/server/src/server-state.ts`, change `providerInstances` to `readonly RuntimeProviderInput[]`, then:

```ts
function buildSnapshotWithProviders(config: Config, providers: readonly RuntimeProviderInput[]): Snapshot {
  const materialized = providers.map((provider) => materializeRuntimeProvider(provider));
  return buildSnapshot(
    config,
    materialized,
    new Map<string, ProviderProbe>(),
    materialized.map((provider) => providerSummary(provider)),
  );
}
```

In `providerSummary()`, set dashboard passthrough from `provider.raw !== undefined`. Keep `hasApiKey` based on API kind.

Update `CreateServerOptions.providerInstances` in `server.ts` to `readonly RuntimeProviderInput[]`.

- [ ] **Step 6: Run focused and existing runtime tests**

```bash
bun test packages/server/_test/provider-runtime-capabilities.test.ts packages/server/_test/oauth-provider-runtime.test.ts packages/server/_test/server-reload.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/runtime.ts packages/server/src/provider-runtime.ts packages/server/src/server-state.ts packages/server/src/server.ts packages/server/_test/provider-runtime-capabilities.test.ts
git commit -m "refactor(server): materialize provider capabilities" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Shared Routing Pipeline

**Files:**
- Create: `packages/server/src/routes/pipeline.ts`
- Create: `packages/server/_test/pipeline-helpers.ts`
- Create: `packages/server/_test/pipeline.test.ts`

**Interfaces:**
- Produces: `handleProtocolRequest(options): Promise<Response>`.
- Consumes: protocol adapters, provider capabilities, Router, request recorder, usage capture.
- Owns: body limit, candidate loop, raw/model selection, fallback, preflight, request recording.

- [ ] **Step 1: Build focused fake helpers and failing contract tests**

`pipeline-helpers.ts` must provide:

- a `defineProtocolAdapter()` test adapter with deterministic JSON/SSE output;
- capability-based raw and model provider builders;
- a `ProviderRouteSource` with a real `Router`;
- request-recorder arrays for attempts/final outcomes;
- identity usage-capture wrappers with resolved completion promises.

`pipeline.test.ts` must cover:

1. 8 MiB + 1 byte rejects before parse/provider.
2. Parse error and model-not-found return adapter envelopes without beginning a provider attempt.
3. Same protocol with both capabilities calls only raw.
4. Different raw protocol with model capability calls only model.
5. Raw `429` and `503` fall back; raw `400` does not.
6. Raw network throw falls back.
7. Model `ensureAvailable` or first event failure falls back.
8. Model error after the first event is visible to the client and does not call the next candidate.
9. Inbound abort records cancelled and does not fall back.
10. Unsupported candidate records one failed attempt and continues.
11. All candidates failing returns the final failure.
12. Unknown unmapped provider values are rethrown.

- [ ] **Step 2: Run tests and confirm the missing pipeline**

```bash
bun test packages/server/_test/pipeline.test.ts
```

Expected: FAIL because `handleProtocolRequest` does not exist.

- [ ] **Step 3: Implement the pipeline entry and body/parse/resolve flow**

Create `packages/server/src/routes/pipeline.ts`:

```ts
const MAX_BODY_BYTES = 8 * 1_024 * 1_024;
const SSE_RESPONSE_INIT = {
  headers: {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  },
} as const;

export type HandleProtocolRequestOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly source: ProviderRouteSource;
};

export async function handleProtocolRequest<TRequest, TContext>({
  adapter,
  context,
  rawRequest,
  source,
}: HandleProtocolRequestOptions<TRequest, TContext>): Promise<Response> {
  const contentLength = rawRequest.headers.get("content-length");
  if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return adapter.errors.tooLarge();
  }

  let request: TRequest;
  try {
    request = await adapter.parse(rawRequest, context);
  } catch (error) {
    const mapped = adapter.errors.requestError(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }

  const requestedModel = adapter.model(request, context);
  let candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  try {
    candidates = source.currentProviderSnapshot().router.resolve(
      requestedModel,
      adapter.variant(request, context),
    );
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return adapter.errors.modelNotFound(error.message);
    }
    throw error;
  }

  return attemptCandidates({
    adapter,
    candidates,
    context,
    rawRequest,
    request,
    requestedModel,
    source,
  });
}
```

Define the private options type:

```ts
type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModel: string;
  readonly source: ProviderRouteSource;
};

```

At the start of `attemptCandidates()`, destructure the options, call `source.requestRecorder.begin()` exactly once with `adapter.protocol` and `requestedModel`, and declare:

```ts
let invocation: ModelInvocation | undefined;
let lastFailure: Response | undefined;
```

The function then runs one `for (const [index, candidate] of candidates.entries())` loop containing the complete raw/model branches in Steps 4 and 5. After the loop, finish the session as failure and return `lastFailure ?? adapter.errors.unsupported("transform_dispatch")`.

- [ ] **Step 4: Implement raw and model attempts**

Inside the same file, implement one loop with these exact branches:

```ts
if (provider.raw?.protocol === adapter.protocol) {
  const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
  const response = await provider.raw.invoke(upstream);
  if (hasNext && shouldFallbackStatus(response.status)) {
    session.attempt(failedAttempt(provider, candidate.modelId, response.status, startedAt));
    lastFailure = response;
    continue;
  }
  if (response.status < 200 || response.status >= 400) {
    session.finish(finalFailure(provider, candidate.modelId, response.status, startedAt));
    return response;
  }
  const captured = source.usageCapture.passthrough({
    response,
    protocol: provider.raw.protocol,
    providerId: provider.id,
    modelId: candidate.modelId,
  });
  session.finishFrom(attemptBase(provider, candidate.modelId, startedAt), terminalCompletion(
    captured.completion,
    rawRequest.signal,
  ));
  return captured.value;
}
```

For model capability:

```ts
if (provider.model !== undefined) {
  if (invocation === undefined) {
    try {
      invocation = adapter.modelInvocation(request, context);
    } catch (error) {
      const mapped = adapter.errors.requestError(error);
      if (mapped === undefined) throw error;
      session.finish({ outcome: "failure", finalStatusCode: mapped.status });
      return mapped;
    }
  }
  await provider.model.ensureAvailable?.();
  const captured = source.usageCapture.stream({
    providerId: provider.id,
    modelId: candidate.modelId,
    stream: provider.model.invoke({
      messages: invocation.messages,
      modelId: candidate.modelId,
      signal: rawRequest.signal,
      ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
      ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
    }),
  });

  if (adapter.wantsStream(request, context)) {
    const stream = await preflightStream(captured.value);
    session.finishFrom(attemptBase(provider, candidate.modelId, startedAt), terminalCompletion(
      captured.completion,
      rawRequest.signal,
    ));
    return new Response(adapter.modelSse(stream), SSE_RESPONSE_INIT);
  }

  const value = await adapter.modelJson(captured.value);
  session.finishFrom(attemptBase(provider, candidate.modelId, startedAt), terminalCompletion(
    captured.completion,
    rawRequest.signal,
  ));
  return Response.json(value);
}
```

If neither branch applies, use:

```ts
const unsupported = adapter.errors.unsupported("transform_dispatch");
if (hasNext) {
  session.attempt(failedAttempt(provider, candidate.modelId, unsupported.status, startedAt));
  lastFailure = unsupported;
  continue;
}
session.finish(finalFailure(provider, candidate.modelId, unsupported.status, startedAt));
return unsupported;
```

Add these exact metadata helpers so request logging stays uniform without using provider kind for dispatch:

```ts
function attemptBase(
  provider: RuntimeProviderInstance,
  modelId: string,
  startedAt: number,
): Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode"> {
  return {
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    ...("protocol" in provider ? { protocol: provider.protocol } : {}),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function failedAttempt(
  provider: RuntimeProviderInstance,
  modelId: string,
  statusCode: number,
  startedAt: number,
): RequestAttemptInput {
  return {
    ...attemptBase(provider, modelId, startedAt),
    outcome: "failure",
    statusCode,
  };
}

function finalFailure(
  provider: RuntimeProviderInstance,
  modelId: string,
  statusCode: number,
  startedAt: number,
): RequestFinishInput {
  return {
    outcome: "failure",
    finalProviderId: provider.id,
    finalModelId: modelId,
    finalStatusCode: statusCode,
    attempt: failedAttempt(provider, modelId, statusCode, startedAt),
  };
}

function shouldFallbackStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
```

- [ ] **Step 5: Centralize exception fallback and preflight**

Wrap each candidate attempt in `try/catch` using:

```ts
} catch (error) {
  const mapped = adapter.errors.provider(error);
  if (mapped === undefined) throw error;

  const cancelled = isInboundAbort(error, rawRequest.signal);
  const outcome = cancelled ? "cancelled" as const : "failure" as const;
  const attempt = {
    ...attemptBase(provider, candidate.modelId, startedAt),
    outcome,
    statusCode: mapped.status,
  };

  if (!cancelled && hasNext) {
    session.attempt(attempt);
    lastFailure = mapped;
    continue;
  }

  session.finish({
    outcome,
    finalProviderId: provider.id,
    finalModelId: candidate.modelId,
    finalStatusCode: mapped.status,
    attempt,
  });
  return mapped;
}
```

This makes every pre-commit model failure eligible for fallback, but never retries an inbound cancellation.

Add this preflight implementation to `pipeline.ts`:

```ts
async function preflightStream<T>(stream: ReadableStream<T>): Promise<ReadableStream<T>> {
  const reader = stream.getReader();
  const first = await reader.read();
  let firstPending = !first.done;

  return new ReadableStream<T>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first.value);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
```

Keep `terminalCompletion()`, recursive abort detection, and `providerErrorMessage()` in `route-observation.ts` during this task because unmigrated routes still import them. Task 11 removes the obsolete message helper after all routes use protocol error mappers.

- [ ] **Step 6: Run pipeline tests and type checks**

```bash
bun test packages/server/_test/pipeline.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/pipeline.ts packages/server/_test/pipeline-helpers.ts packages/server/_test/pipeline.test.ts
git commit -m "refactor(server): centralize protocol routing pipeline" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 9: Migrate OpenAI Routes

**Files:**
- Modify: `packages/server/src/routes/openai-completions.ts`
- Modify: `packages/server/src/routes/openai-responses.ts`
- Modify: `packages/server/_test/openai-completions.test.ts`
- Modify: `packages/server/_test/openai-responses.test.ts`
- Modify: `packages/server/_test/openai-responses-missing-provider.test.ts`

**Interfaces:**
- Consumes: Task 3 adapters and Task 8 pipeline.
- Removes: OpenAI route-local parse, transform, tool mapping, candidate loop, error mapping, preflight, and model rewrite.

- [ ] **Step 1: Add route-level regression assertions before migration**

Add an OpenAI Completions test proving a cross-protocol-capable provider's `model` capability receives function tools. Add a Responses test proving unknown raw fields survive alias rewrite. Keep existing fallback, error, usage, and missing-provider tests.

- [ ] **Step 2: Run current OpenAI route tests**

```bash
bun test packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/openai-responses-missing-provider.test.ts
```

Expected: the new Completions tool-capability assertion FAILS because the current route does not pass transformed tools.

- [ ] **Step 3: Replace OpenAI Completions route with a thin registration**

The complete route module becomes:

```ts
import { openAICompletionsAdapter } from "@aio-proxy/core";
import { Hono } from "hono";
import type { ProviderRouteSource } from "../runtime";
import { handleProtocolRequest } from "./pipeline";

export function createOpenAICompletionsRoutes(source: ProviderRouteSource) {
  return new Hono().post("/v1/chat/completions", (context) =>
    handleProtocolRequest({
      adapter: openAICompletionsAdapter,
      context: {},
      rawRequest: context.req.raw,
      source,
    }),
  );
}
```

- [ ] **Step 4: Replace OpenAI Responses route with a thin registration**

```ts
import { openAIResponsesAdapter } from "@aio-proxy/core";
import { Hono } from "hono";
import type { ProviderRouteSource } from "../runtime";
import { handleProtocolRequest } from "./pipeline";

export function createOpenAIResponsesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post("/v1/responses", (context) =>
      handleProtocolRequest({
        adapter: openAIResponsesAdapter,
        context: {},
        rawRequest: context.req.raw,
        source,
      }),
    )
    .get("/v1/responses/:id", () => openAIResponsesAdapter.errors.unsupported("response_retrieval"));
}
```

- [ ] **Step 5: Run OpenAI suites**

```bash
bun test packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/openai-responses-missing-provider.test.ts
bun test packages/server/_test/pipeline.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/openai-completions.ts packages/server/src/routes/openai-responses.ts packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/openai-responses-missing-provider.test.ts
git commit -m "refactor(server): route OpenAI through shared pipeline" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 10: Migrate Anthropic and Gemini Routes

**Files:**
- Modify: `packages/server/src/routes/anthropic-messages.ts`
- Modify: `packages/server/src/routes/gemini-generate-content.ts`
- Modify: `packages/server/_test/anthropic-messages.test.ts`
- Modify: `packages/server/_test/gemini-generate-content.test.ts`
- Modify: `packages/server/_test/gemini-missing-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, and 8.
- Keeps: Anthropic `/v1/messages/count_tokens`.
- Keeps: Gemini path parsing in the thin route.

- [ ] **Step 1: Add the three drift regression tests**

Add:

1. Anthropic first model event failure falls back to the next candidate.
2. Anthropic tool-use/tool-result history reaches the model capability without empty strings or empty tool content.
3. Gemini `Content-Length: 8388609` returns a Gemini 413 before provider invocation.

Replace the existing test named `Given 9MiB inlineData with large Content-Length When generateContent is posted Then provider receives it` with the new 413 expectation. Do not allocate the previous 12 MiB string; use a small valid body and a forged oversized `Content-Length`.

- [ ] **Step 2: Run route tests and confirm regressions**

```bash
bun test packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts
```

Expected: the Anthropic preflight and Gemini body-limit tests FAIL on current routes.

- [ ] **Step 3: Replace Anthropic main route with the pipeline**

Keep `tokenEstimate()`. Use the adapter for count-token parsing and its error mapper:

```ts
export function createAnthropicMessagesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post("/v1/messages", (context) =>
      handleProtocolRequest({
        adapter: anthropicMessagesAdapter,
        context: {},
        rawRequest: context.req.raw,
        source,
      }),
    )
    .post("/v1/messages/count_tokens", async (context) => {
      try {
        const request = await anthropicMessagesAdapter.parse(context.req.raw, {});
        return Response.json({ input_tokens: tokenEstimate(request) });
      } catch (error) {
        const mapped = anthropicMessagesAdapter.errors.requestError(error);
        if (mapped !== undefined) return mapped;
        throw error;
      }
    });
}
```

Delete route-local `anthropicMessage`, `aiSdkMessages`, `contentText`, provider error mapping, and the candidate loop.

- [ ] **Step 4: Replace Gemini main route with path context plus pipeline**

Keep `routeTarget()` in the route file. The handler becomes:

```ts
export function createGeminiGenerateContentRoutes(source: ProviderRouteSource) {
  return new Hono().post("/v1beta/models/*", (context) => {
    const target = routeTarget(new URL(context.req.url).pathname);
    if (target === undefined) {
      return context.text("404 Not Found", 404);
    }
    return handleProtocolRequest({
      adapter: geminiGenerateContentAdapter,
      context: target,
      rawRequest: context.req.raw,
      source,
    });
  });
}
```

Delete route-local settings/tool/JSON conversion, model rewrite, body-limit, provider error mapping, and candidate loop.

- [ ] **Step 5: Run all four protocol route suites**

```bash
bun test packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts packages/server/_test/gemini-missing-provider.test.ts
bun test packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts
bun test packages/server/_test/pipeline.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/anthropic-messages.ts packages/server/src/routes/gemini-generate-content.ts packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts packages/server/_test/gemini-missing-provider.test.ts
git commit -m "refactor(server): route Anthropic and Gemini through shared pipeline" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 11: Cross-Protocol Matrix, Cleanup, and Architecture Documentation

**Files:**
- Create: `packages/server/_test/cross-protocol-routing.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server/src/route-observation.ts`
- Delete: `packages/core/src/egress/error.ts`
- Delete: `packages/server/src/route-dispatch.ts`
- Delete: `packages/server/src/provider-availability.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Verifies: all four inbound protocols select raw only for matching raw protocol and model otherwise.
- Verifies: mixed fallback records ordered attempts and stops after success.
- Documents: new protocol work must add one core adapter and one thin route registration, not a route-local pipeline.

- [ ] **Step 1: Write a data-driven 4×4 dispatch matrix**

Create cases for all inbound protocols:

```ts
const inboundCases = [
  {
    protocol: ProviderProtocol.OpenAICompatible,
    path: "/v1/chat/completions",
    body: { model: "m", messages: [{ role: "user", content: "hello" }] },
  },
  {
    protocol: ProviderProtocol.OpenAIResponse,
    path: "/v1/responses",
    body: { model: "m", input: "hello" },
  },
  {
    protocol: ProviderProtocol.Anthropic,
    path: "/v1/messages",
    body: { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hello" }] },
  },
  {
    protocol: ProviderProtocol.Gemini,
    path: "/v1beta/models/m:generateContent",
    body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  },
] as const;
```

For each inbound case and each of the four provider protocols, inject a pre-materialized provider with:

- `raw.protocol` set to the provider protocol;
- `raw.invoke` returning `raw:<protocol>`;
- `model.invoke` returning text and finish events;
- counters for raw/model calls.

Assert matching protocol calls raw exactly once and model zero times. Assert every mismatch calls model exactly once and raw zero times.

- [ ] **Step 2: Add mixed candidate and reload lifecycle tests**

Add one HTTP test with:

1. first candidate model capability fails before first event;
2. second candidate matching raw capability succeeds;
3. third candidate counter remains zero;
4. request log attempts are `[failure, success]`.

Extend `provider-runtime-capabilities.test.ts` or `server-reload.test.ts` so config reload produces a new API `model` capability object while repeated snapshot reads before reload preserve reference identity.

- [ ] **Step 3: Run matrix and full server unit tests**

```bash
bun test packages/server/_test/cross-protocol-routing.test.ts packages/server/_test/provider-runtime-capabilities.test.ts
bun run --filter @aio-proxy/server test:unit
```

Expected: PASS.

- [ ] **Step 4: Delete obsolete dispatch helpers**

Delete:

```text
packages/core/src/egress/error.ts
packages/server/src/route-dispatch.ts
packages/server/src/provider-availability.ts
```

Remove the `IngressError`/`toIngressError` export from `packages/core/src/index.ts` and remove `providerErrorMessage()` from `route-observation.ts`. Confirm no callers:

```bash
rg -n "route-dispatch|provider-availability|providerErrorMessage|toIngressError|toAiSdkProvider|resolveCandidates" packages/core/src packages/server/src packages/server/_test
```

Expected: no matches.

- [ ] **Step 5: Document the architecture invariant**

Append to `AGENTS.md`:

```markdown
## Protocol Routing Architecture

- `packages/core/src/protocol/` owns one stateless adapter per inbound protocol.
- Adapters are created with `defineProtocolAdapter()` and contain only parse, model/variant extraction, raw request rewriting, model invocation conversion, egress, and protocol-shaped errors.
- `packages/server/src/routes/pipeline.ts` is the only candidate loop. Route files must not implement provider-kind branching, fallback, usage capture, request recording, or stream preflight.
- Runtime providers expose `raw` and/or `model` capabilities. Dispatch uses capabilities, not provider kind.
- Same-protocol raw capability wins. All other supported calls use the materialized model capability.
- Adding an inbound protocol requires one core adapter, one thin route registration, adapter tests, and dispatch-matrix coverage.
```

- [ ] **Step 6: Run final verification**

Run:

```bash
bun run check
bun run test:unit
bun run test:e2e:api
bun run build
```

Expected: all commands PASS with no route-local candidate loops and no change to unrelated `.gitignore`.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md packages/core/src/index.ts packages/server/src/route-observation.ts packages/server/_test/cross-protocol-routing.test.ts packages/server/_test/provider-runtime-capabilities.test.ts packages/server/_test/server-reload.test.ts
git add -u packages/core/src/egress/error.ts packages/server/src/route-dispatch.ts packages/server/src/provider-availability.ts
git commit -m "refactor(server): finish shared protocol routing migration" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Completion Checklist

- [ ] All 11 task commits exist and contain only their declared files.
- [ ] Same-protocol API requests preserve unknown request fields and upstream response bytes.
- [ ] API protocol mismatch uses the snapshot's materialized model transport.
- [ ] AI SDK and OAuth providers use model capability without route-level kind branching.
- [ ] Raw `429`/`5xx` and pre-commit model errors fall back in Router order.
- [ ] Raw ordinary `4xx`, inbound aborts, and post-commit stream failures do not fall back.
- [ ] Anthropic tool-use/tool-result history reaches AI SDK without empty text/tool messages.
- [ ] Anthropic JSON and SSE egress preserve tool calls.
- [ ] Gemini observes the shared 8 MiB `Content-Length` guard.
- [ ] Request attempts, final provider/model, cancellation, and usage remain correctly recorded.
- [ ] `route-dispatch.ts` and `provider-availability.ts` are deleted.
- [ ] The obsolete `toIngressError` implementation and export are deleted.
- [ ] `bun run check`, `bun run test:unit`, `bun run test:e2e:api`, and `bun run build` pass.
