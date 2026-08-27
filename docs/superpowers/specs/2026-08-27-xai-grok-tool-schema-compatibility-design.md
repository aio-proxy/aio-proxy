# xAI Grok Tool Schema Compatibility Design

## Goal

Allow Codex Desktop to use built-in and third-party function tools through the xAI Grok OAuth Responses transport without weakening valid tool contracts or letting one unsupported schema invalidate the entire request.

## Incident Evidence

Trace `768acf3f3d392281a77aa76c2bc6e07a` exhausted three candidates:

1. Cursor OAuth returned HTTP 500.
2. xAI Grok OAuth returned HTTP 400 with `mcp__codex_app__automation_update: tool parameter root must be an object type`.
3. The final raw carpool candidate returned HTTP 400 `openai_error`, which became the client-visible error.

The xAI-bound `mcp__codex_app__automation_update` parameters were already declared with root `type: "object"`, but the root `oneOf` contained four local `$ref` branches. Resolving those references and the nested create/update unions yields six concrete object branches: view, cron create, heartbeat create, cron update, heartbeat update, and delete.

The current sanitizer is a tool-name workaround. It recognizes only `codex_app__automation_update` or a nested `codex_app.automation_update`, so it misses the actual `mcp__codex_app__automation_update` name. Even when it matches, replacing the parameters with an open empty object discards the Codex tool contract.

## Reference Behavior

- `.reference/opencodex` resolves local references, normalizes root unions only when it can preserve their meaning, and omits only the incompatible tool when it cannot.
- `.reference/oh-my-pi` applies xAI-specific schema compatibility at the provider boundary, quarantines one invalid tool instead of failing the whole request, and keeps tool selection consistent with the remaining catalog.
- Codex third-party providers use the Responses wire protocol. The compatibility fix therefore belongs in aio-proxy's xAI outbound runtime, not in Codex's built-in `automation_update` implementation.

## Decisions

### 1. Provider-specific boundary

Keep the change inside `packages/plugins/xai-grok/src/runtime/sanitize-responses/`. The xAI OAuth runtime exposes no raw capability, and every `/responses` request already passes through `sanitizeXAIGrokResponsesBody()` before the dynamic fetch dispatches it.

Do not change the shared OpenAI Responses adapter, Codex tools, provider routing, or other providers.

### 2. Generic schema normalization

Apply the compatibility rule to every xAI-bound function tool, regardless of its name:

1. Resolve local JSON Pointer references beginning with `#/`, including escaped pointer tokens.
2. Detect unresolved, external, and cyclic references and fail normalization for that tool.
3. Remove `$defs`, `definitions`, and `$schema` only after every reachable reference has been expanded.
4. At the parameter root, expand nested branches using the same `oneOf` or `anyOf` combinator.
5. Require every resulting terminal branch to be an object schema and write explicit `type: "object"` on each branch.
6. Preserve root properties, required fields, `additionalProperties`, descriptions, and the tool's original `strict` value.
7. Leave already-compatible object-root schemas unchanged apart from reference expansion.

The captured `automation_update` schema must remain one tool with six explicit object alternatives. It must not become an open empty object.

### 3. Fail-closed tool quarantine

If normalization cannot prove that a function parameter root is object-shaped, remove only that function tool. Apply the same behavior to:

- top-level `tools`;
- functions inside namespace tools; and
- `input[].type === "additional_tools"` catalogs.

Remove a namespace or `additional_tools` item if all of its tools were quarantined. Custom and hosted tools remain untouched; the existing custom-tool compiler continues to run after this sanitizer.

### 4. Tool choice consistency

Track both quarantined and retained tool names, including flattened namespace aliases. If a named `tool_choice` targets a quarantined tool with no retained tool of the same name, replace it with `"auto"` while any tools remain, or remove `tool_choice` when none remain.

For `allowed_tools`, remove only entries that refer to quarantined tools. Keep the original mode when at least one allowed entry remains; otherwise apply the same `"auto"` or removal fallback.

Do not rewrite unrelated hosted-tool choices or string choices that still have a valid catalog.

### 5. Release scope

Add a patch changeset for both `@aio-proxy/plugin-xai-grok` and the product package `aio-proxy`. No dependency, configuration, database, dashboard, or public SDK changes are required.

## Non-goals

- Do not special-case `automation_update`, `codex_app`, or the `mcp__` prefix.
- Do not merge mutually exclusive branches into a weaker bag of optional properties.
- Do not replace failed schemas with `{ type: "object", properties: {}, additionalProperties: true }`.
- Do not add a general JSON Schema library or another dependency.
- Do not claim to fix the independent Cursor 500 or carpool `openai_error` failures.

## Verification

- The trace-derived schema is retained with six explicit object branches and no reachable `$ref`.
- `strict`, required sets, enums, properties, and `additionalProperties` survive normalization.
- Compatible ordinary function tools are unchanged.
- Cyclic, external, primitive-root, and mixed invalid branches quarantine only their tool.
- Namespace and `additional_tools` catalogs are sanitized.
- Named and `allowed_tools` choices do not reference quarantined tools.
- The real xAI dynamic fetch sends the normalized schema to `cli-chat-proxy.grok.com/v1/responses`.
- Focused tests, the xAI package tests, `bun run check`, `bun run preflight`, and `git diff --check` pass.
