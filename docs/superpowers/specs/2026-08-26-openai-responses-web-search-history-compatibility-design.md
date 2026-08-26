# OpenAI Responses Hosted History and Custom Grammar Compatibility Design

## Goal

Allow the reproduced `grok-4.6` request family to continue through model candidates instead of failing inside aio-proxy before a useful upstream call. The change addresses both locally generated blockers present in the captured traffic:

1. completed provider-executed `web_search_call` history that cannot be replayed through a provider-neutral model invocation; and
2. OpenAI Responses `custom` tools whose `format.type` is `grammar` when the xAI Grok OAuth endpoint supports ordinary function tools but not native custom grammar tools.

The design preserves raw OpenAI Responses fidelity, uses candidate-specific compatibility behavior, and does not claim to fix the separate Cursor transport failure observed in the same incident.

## Incident Boundary

The 2026-08-25 `grok-4.6` snapshot contained 921 successful requests and 120 requests that failed after a carpool attempt:

- 24 requests contained both historical `web_search_call` items and one grammar custom tool. They failed during aio-proxy Responses-to-model conversion before either xAI or Cursor runtime executed.
- 96 requests contained the grammar custom tool without `web_search_call` history. xAI attempted 95 of them and returned a local grammar-unsupported response before its host model fetch. Cursor attempted all 96 and failed before an upstream request snapshot was produced.

All 120 grammar declarations were the same top-level tool:

```json
{
  "type": "custom",
  "name": "apply_patch",
  "format": {
    "type": "grammar",
    "syntax": "lark",
    "definition": "<same 578-character definition in every captured request>"
  }
}
```

The 24 hosted-search requests contained only completed `search` and `open_page` actions. Every item lacked top-level `results` and `action.sources`; visible assistant answers were separate `message` items.

OAuth readiness is not the root cause. OAuth lifecycle, model routing, hosted-search history compatibility, custom-tool compatibility, and Cursor transport health remain separate capability axes.

## Reference Behavior

- `oh-my-pi` emits a native custom grammar tool only when the model catalog explicitly advertises freeform support. Otherwise the same tool falls back to its ordinary function schema. This is the primary reference for the xAI behavior.
- `opencode` uses a required ordinary tool plus validation/retry for provider-independent JSON structured output, but has no generic grammar conversion.
- `CLIProxyAPI`, `new-api`, and `claude-code-hub` do not provide a general grammar-to-function compatibility layer. Their behavior is a mixture of pass-through, narrow tool-name drops, partial field loss, or unsupported handling.
- CodexBar and the CLI proxy management center are not inference compatibility implementations.

The applicable pattern is therefore capability-gated native emission with a defined function fallback, not blind pass-through and not a grammar compiler inside the proxy.

## Decisions

### 1. Hosted-search ingress

- Add `web_search_call` to the known OpenAI Responses input-item schema.
- Preserve `id`, `status`, `action`, `results`, and additional wire fields in the parsed value.
- Continue using the existing raw-request rewrite path for same-protocol forwarding. Parsing must not reconstruct or remove the hosted item.
- Keep all other unknown typed items on the existing `__aio_proxy_unsupported__` raw-only path.

### 2. Hosted-search model conversion

A `web_search_call` is safe to omit from provider-neutral model history only when all of these conditions hold:

1. `status === "completed"`;
2. `Object.hasOwn(item, "results") === false`; and
3. `action` is not an object with an owned `sources` property.

The `action.sources` rule is conservative: `null`, an empty array, and a non-empty array all remain model-unsupported when the property is present.

For the eligible shape, model conversion:

- emits no assistant function call or tool result;
- performs no proxy-owned search;
- preserves surrounding messages and their order;
- resets function-call/result adjacency before later items; and
- records a typed model-invocation diagnostic with the input index.

Active, failed, ambiguous, result-bearing, or source-bearing hosted items remain model-unsupported so a later same-protocol raw candidate can still receive the original request.

### 3. Custom grammar function fallback

This decision applies only to `tools[].type === "custom"` with a valid OpenAI Responses `format.type === "grammar"`. It does not apply to `text.format.type === "grammar"`, which constrains the final model response and cannot be represented as an ordinary tool without changing the API contract.

For provider-neutral model invocation, aio-proxy already represents every Responses custom tool as a reversible ordinary function tool:

```json
{
  "type": "function",
  "name": "apply_patch",
  "parameters": {
    "type": "object",
    "properties": { "input": { "type": "string" } },
    "required": ["input"],
    "additionalProperties": false
  }
}
```

OpenAI Responses wire metadata retains the original custom type, wire name, namespace, source, and grammar format so compatible targets and client egress can restore the original protocol shape.

The xAI Grok OAuth runtime does not advertise native custom grammar support. At its outbound `/responses` request boundary it therefore:

- converts grammar custom declarations to the same ordinary function representation already used for text custom tools;
- converts a matching `tool_choice` from `custom` to `function`;
- converts `custom_tool_call` history to `function_call` with `{"input":"..."}` arguments;
- converts `custom_tool_call_output` history to `function_call_output`;
- preserves the tool name and description; and
- removes the grammar definition from the xAI-bound request.

This is an operational fallback, not lossless constrained decoding. xAI may generate an `input` string that does not satisfy the original Lark or regex grammar. aio-proxy does not implement a grammar engine, buffer an entire model stream, or retry tool generation. The client-side tool executor remains responsible for validating the tool input and returning a tool error that the model can correct on a later turn.

Unknown or invalid custom-tool formats keep the current conservative behavior; only parsed `text` and `grammar` formats use the function compiler.

### 4. Response restoration

- A function call produced by an xAI grammar fallback is restored through existing OpenAI Responses wire metadata as `custom_tool_call` for the client.
- The client receives the raw string from the function argument's `input` property, not the JSON wrapper.
- Function-call IDs, names, namespace metadata, and custom call/output history retain their existing round-trip rules.
- A missing or non-string `input`, an object with extra fields, or otherwise malformed wrapper is not fabricated into a successful custom call.

### 5. Candidate routing

- A same-protocol raw candidate receives the original hosted-search and custom grammar fields, subject only to existing model/background/effort rewrites.
- A model candidate receives eligible hosted-search history omitted from messages and custom tools in provider-neutral function form.
- xAI applies its grammar function fallback at its own runtime boundary.
- Cursor already advertises provider-neutral function tools through its synthetic MCP provider. Grammar conversion is therefore not a proposed fix for Cursor's observed pre-network failure.
- Model invocation remains lazily materialized once and reused across model candidates. Existing preflight and fallback rules are unchanged: only failures before SSE commitment can advance to another candidate.

### 6. Observability

For each actually invoked model candidate, eligible hosted-search omission emits one structured `request.feature_downgraded` event containing only candidate identity, `feature: "web_search_call"`, `action: "dropped"`, `reason: "completed_without_results_or_sources"`, and `inputIndex`.

For each outbound xAI `/responses` fetch attempt that converts one or more grammar declarations, the runtime emits exactly one safe provider-runtime diagnostic. AI SDK retries are separate outbound fetch attempts and may therefore emit the same diagnostic again. The diagnostic contains only:

- `feature: "custom_tool.grammar"`;
- `action: "function_fallback"`;
- `reason: "provider_lacks_native_grammar"`.

Neither diagnostic may include the grammar definition, tool name, search action, query, URL, source list, results, model ID, messages, request body, headers, credentials, or arbitrary upstream error text.

The privacy assertion applies to these downgrade events. Existing opt-in debug request-body logging is outside this guarantee.

## Data Flow

```text
OpenAI Responses request
  -> ingress recognizes web_search_call and custom grammar tool
  -> candidate loop
     -> same-protocol raw candidate
        -> original hosted item and grammar preserved
        -> exact original bytes when top-level rewrite is a no-op
     -> provider-neutral model candidate
        -> completed/no-results/no-sources hosted item omitted
        -> custom grammar represented as function { input: string }
        -> xAI runtime compiles custom/tool_choice/history to function wire shapes
        -> xAI host model fetch executes
        -> response function call restored to client custom_tool_call
```

## Cursor Fault Line

The captured Cursor failures are not attributed to grammar:

- core has already converted the custom grammar tool into a function tool before Cursor invocation;
- Cursor's MCP tool builder accepts function tools and serializes their JSON Schema; and
- all 96 captured Cursor attempts failed before an upstream request snapshot was available.

This change adds a trace-derived Cursor transport-boundary characterization test whose mock server sends `requestContextArgs`, captures the client's `requestContextResult`, decodes the returned `AgentClientMessage`, and proves that the expected `apply_patch` MCP tool name and JSON Schema cross the local handshake. It does not claim to resolve production Cursor authentication, session, protocol, or transport initialization failures. Those require a separate root-cause investigation with narrower boundary instrumentation.

## Non-goals

- Do not add xAI `x_search`, proxy-owned search, or hosted-search-to-function history conversion.
- Do not execute Cursor `WebSearchToolCall` or claim that Cursor production calls are fixed.
- Do not implement a Lark/regex parser, server-side patch validation, tool-generation retry loop, or whole-stream buffering.
- Do not convert `text.format.type === "grammar"` into a tool.
- Do not change OAuth login, refresh, credential selection, catalog discovery, database schemas, dashboard UI, or public plugin SDK types.
- Do not add support for `web_search_preview_call` or other hosted-call families.

## Verification

- Ingress returns a typed `web_search_call` item instead of the unsupported sentinel.
- Model conversion omits only completed hosted items with neither top-level `results` nor owned `action.sources`.
- Source-bearing and result-bearing shapes remain model-unsupported, including `null` and empty values.
- Raw forwarding compares the exact original `Uint8Array` from a deliberately noncanonical body with unusual whitespace, unusual field order, and an integer above `Number.MAX_SAFE_INTEGER`, not parsed JSON equivalence.
- The trace-derived `apply_patch` grammar declaration reaches the real xAI dynamic fetch host as a function tool; host call count is one rather than zero.
- xAI-bound `tool_choice` and custom history are converted consistently.
- A model-produced function call is restored to an OpenAI Responses `custom_tool_call` with raw string input.
- Safe hosted-search and grammar diagnostics contain no search payload, grammar payload, tool name, or model ID.
- A Cursor model test responds to mocked `requestContextArgs`, decodes the client's `requestContextResult`, and verifies the function-form `apply_patch` MCP name and schema, while the production Cursor incident remains explicitly out of scope.
- Focused package tests, `bun run check`, `bun run preflight`, and `git diff --check` pass before implementation completion.
