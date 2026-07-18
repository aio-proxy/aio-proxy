# OpenAI Responses Semantic Input Compatibility Plan

**Goal:** Accept the captured 318-item OpenAI Responses request without silently deleting known semantics. Portable features are transformed, OpenAI-specific but recoverable features are wrapped with metadata, intentional degradation is logged safely, and features without a sound model representation remain available only to same-protocol raw passthrough.

**Captured request:** `/Users/baran/.codex/attachments/012218db-ba16-44e3-909d-326391ded145/pasted-text.txt`

## Constraints

- Ingress must remain `318 -> 318` for the captured request.
- The input array uses `z.unknown().transform(safeParse)` followed by `compact`, but only untyped garbage may become `undefined` and be compacted.
- A known malformed item is a 400 validation error. An unknown typed semantic item becomes an explicit raw-only sentinel.
- Same-protocol raw passthrough forwards the original request body. Model conversion decides portability and may reject a candidate before fallback reaches a later raw candidate.
- Temporary compatibility diagnostics use `console.warn(feature, path, action)` as requested. They must never include request values, text, arguments, outputs, encrypted content, client metadata, or credentials.
- No repository-wide logging abstraction is introduced in this change.
- Custom and namespaced tools use AI SDK function tools plus JSON-safe metadata. JSON/SSE egress reads the same metadata to restore OpenAI wire identity.
- No new dependency is added. Existing `es-toolkit/array` `compact` is used.
- New handwritten TypeScript files remain below 300 lines. Legacy egress tests move beside source.
- Do not modify `.idea/dataSources.xml` or `docs/research/cross-protocol-reasoning-custom-tools-reference.md`.

## Captured Request Acceptance

| Wire item | Count | Required result |
| --- | ---: | --- |
| `additional_tools` | 1 | Parse and materialize 9 executable definitions |
| `message` | 37 | Preserve visible text and order |
| `reasoning` | 97 | Convert summaries; diagnose encrypted content |
| `custom_tool_call` | 40 | Preserve call IDs and raw string inputs via `{ input: string }` |
| `custom_tool_call_output` | 40 | Preserve 36 content arrays and 4 strings |
| `function_call` | 47 | Preserve call IDs, JSON arguments, and 43 namespaces |
| `function_call_output` | 47 | Preserve paired text outputs |
| `agent_message` | 9 | Preserve visible text with attribution; diagnose encrypted content |
| **Total** | **318** | **All parse; no known item is compacted away** |

Acceptance is semantic. A non-message item may contribute tools rather than an AI SDK message.

## Transformation Matrix

### 1. Losslessly portable

These have a direct provider-neutral representation and do not warn.

| OpenAI Responses feature | Model representation |
| --- | --- |
| String `input` | One user model message |
| Visible text in system/user/assistant messages | Matching model message/text parts |
| `input_text`, `output_text`, `text` | AI SDK text parts |
| Valid JSON `function_call.arguments` | Tool-call input object |
| String or text-only function output | Tool-result text/content |
| Function name, description, parameters | Function tool definition |
| `model`, `stream` | Existing routing and stream behavior |
| `temperature`, `top_p`, `max_output_tokens` | `temperature`, `topP`, `maxOutputTokens` |
| `parallel_tool_calls` | `parallelToolCalls` |
| Enum `tool_choice`: `none`, `auto`, `required` | Same AI SDK enum |
| `reasoning.effort` | Portable reasoning setting |
| `reasoning.summary` request setting | Portable setting plus OpenAI provider option |
| `store: false` or absent | No persistence dependency |
| `background: false` or absent | Synchronous invocation |

### 2. Reversibly transformed with metadata

These use a different AI SDK shape but retain enough metadata for aio-proxy to restore their OpenAI identity.

| OpenAI Responses feature | Forward transform | Reverse behavior |
| --- | --- | --- |
| Custom tool definition | Function tool with schema `{ input: string }` | Restore `type: "custom"`, name, description, format |
| `custom_tool_call.input` | Tool input `{ input: rawString }` | JSON/SSE unwrap exact raw string |
| Custom output string/content | Tool result plus output-kind metadata | Restore original string or ordered parts |
| Namespaced function | Flatten to `${namespace}__${name}` | Restore namespace and child name |
| Namespace definition | Flatten children into ToolSet | Regroup children under namespace |
| `additional_tools` | Merge executable definitions into normalized tools | Restore item at metadata `inputIndex` |
| Function `strict` | AI SDK per-tool `strict` | Restore boolean |
| Item IDs/status/phase/wire role | `providerOptions.aioProxy.openaiResponses` | Restore where reverse history supports it |
| Function/custom wire type and name | Tool metadata | Select correct JSON/SSE output item kind |
| Named `{type:"function"|"custom", name}` tool choice | Resolve unique normalized tool and emit `{type:"tool", toolName}` | Restore function/custom choice and original name |

A named tool choice is rejected if the name/type is missing or ambiguous after normalization.

### 3. Lossy but allowed with safe diagnostics

These may use a model capability only after logging the stable feature, path, and action.

| Feature | Degradation | Diagnostic action |
| --- | --- | --- |
| Reasoning summary text | Convert to assistant reasoning part | `reasoning.summary`, `converted` |
| `reasoning.encrypted_content` | Drop opaque provider content | `dropped` |
| `reasoning.context` | Drop provider-specific context | `dropped` |
| Developer role | Convert to system and retain wire role metadata | `converted` |
| Agent message | Convert visible text to attributed user text | `converted` |
| Agent encrypted content | Drop opaque part | `dropped` |
| Message annotations/logprobs | Keep visible text only | `dropped` |
| `background: true` | Execute synchronously | `synchronous` |
| `include` | Ignore provider-specific extras | `dropped` |
| `prompt_cache_key` | Ignore cross-provider cache affinity | `dropped` |
| `service_tier` | Use selected provider defaults | `dropped` |
| `text.verbosity` | Use selected provider defaults | `dropped` |
| `client_metadata` | Strip before model invocation | `stripped` |
| Untyped garbage without a valid type/role | Warn and compact the array element | `unknown`, `dropped` |

### 4. Raw-only; reject model conversion

Ingress recognizes or retains these so same-protocol raw forwarding can work. Before invoking a model, conversion warns with action `rejected` and throws `OpenAIResponsesUnsupportedFeatureError(feature, path)`.

| Feature | Reason |
| --- | --- |
| `item_reference` | No local Responses item store resolves it |
| `previous_response_id` | Depends on upstream response state |
| `store: true` | Requires provider persistence semantics |
| Unknown typed input item | Semantic effect is unknown |
| Unknown top-level request field | Model/response effect is unknown |
| Built-in call/result families | No provider-neutral side-effect/result adapter |
| Built-in hosted tool definitions | A ToolSet entry cannot reproduce hosted execution |
| Function `defer_loading: true` | Tool-search activation timing is not portable |
| Message image/file content | Text bridge cannot preserve it |
| Tool output image/file content | Current result bridge is text-only |
| Structured tool choice other than direct function/custom name | AI SDK cannot preserve `allowed_tools`, MCP, hosted, shell, apply-patch, or programmatic selection semantics |

Raw-only input item types include:

- `apply_patch_call`, `apply_patch_call_output`
- `code_interpreter_call`
- `computer_call`, `computer_call_output`
- `file_search_call`, `web_search_call`
- `shell_call`, `shell_call_output`
- `local_shell_call`, `local_shell_call_output`
- `image_generation_call`
- `tool_search_call`, `tool_search_output`
- `mcp_list_tools`, `mcp_approval_request`, `mcp_approval_response`, `mcp_call`

Raw-only tool types include:

- `apply_patch`
- `computer`, `computer_use`, `computer_use_preview`, `computer-use`
- `file_search`
- `shell`, `local_shell`
- `image_generation`
- `code_interpreter`
- `mcp`
- `tool_search`
- `web_search`, `web_search_2025_08_26`, `web_search_preview`, `web_search_preview_2025_03_11`

`computer_screenshot` content is raw-only.

### 5. Invalid at ingress

These are request errors rather than compatibility cases:

- A known item type whose required fields are missing or malformed.
- A known tool type whose shape is invalid.
- A typed message whose role/content schema is invalid.
- An input array that becomes empty after compacting only untyped garbage.

## Schema Boundary

The array element transform follows this policy:

```ts
const parsed = openAIResponsesInputItemSchema.safeParse(value);
if (parsed.success) return parsed.data;

const wireType = safeWireType(value);
if (wireType !== undefined && !knownInputItemTypes.has(wireType)) {
  return { type: "__aio_proxy_unsupported__", wireType };
}

if (wireType !== undefined || hasMessageDiscriminator(value)) {
  ctx.addIssue({ code: "custom", message: "Invalid OpenAI Responses input item" });
  return z.NEVER;
}

console.warn("[aio-proxy] OpenAI Responses input item degraded", "unknown", "input", "dropped");
return undefined;
```

The containing schema applies `compact` and verifies at least one semantic item remains.

## Implementation Map

### Ingress

- `packages/core/src/ingress/openai-responses/index.ts`: request fields, safeParse/compact boundary, named tool-choice schemas, passthrough fields.
- `packages/core/src/ingress/openai-responses/input-items.ts`: message, reasoning, function/custom call/results, `additional_tools`, `agent_message`, item reference, unknown typed sentinel.
- `packages/core/src/ingress/openai-responses/tools.ts`: function/custom/namespace definitions and unsupported typed tool sentinel.
- Colocated ingress tests verify survival, validation, compaction, and privacy.

### Transform and ToolSet

- `packages/core/src/transform/openai-responses.ts`: orchestration, top-level compatibility, settings, named tool-choice rewrite.
- `packages/core/src/transform/openai-responses-compat.ts`: input history conversion and call/result pairing.
- `packages/core/src/transform/openai-responses-tools.ts`: flattening, normalization, metadata parsing, safe diagnostics, raw-only rejection.
- `packages/core/src/transform/openai-responses-types.ts`: normalized tools, metadata, portable settings.
- `packages/core/src/transform/openai-responses-from-model.ts`: reverse tool identity, namespace grouping, `additional_tools` placement, tool-choice restoration.
- `packages/core/src/protocol/tools.ts`: propagate tool `strict` and `metadata` into AI SDK ToolSet entries.
- `packages/core/src/protocol/openai-responses.ts`: invoke normalized tools without custom-tool rejection.
- Colocated compatibility, round-trip, transform, and protocol tests cover the matrix.

### Egress

- Replace the oversized single module with `packages/core/src/egress/openai-responses/index.ts` and `state.ts`.
- Restore function versus custom JSON/SSE items from `toolMetadata`.
- Move legacy tests beside source and add focused custom-tool egress coverage.

### Routing

- `packages/server/src/routes/openai-responses-fallback.integration.test.ts`: model rejection followed by raw fallback.
- `packages/server/src/routes/pipeline/attempt.test.ts`: candidate lifecycle after conversion rejection.

## Execution Checklist

- [x] Add captured item/tool schemas, unknown typed sentinels, and safe compact behavior.
- [x] Add function/custom/namespace normalization and metadata.
- [x] Convert custom calls/results, reasoning, agent messages, and namespaced calls.
- [x] Classify and reject raw-only fields/items/tools only on the model path.
- [x] Transform named function/custom tool choices and reject other structured choices.
- [x] Rebuild top-level tools, namespaces, custom tools, and `additional_tools` during reverse conversion.
- [x] Split Responses egress and emit custom JSON/SSE event families.
- [x] Add routing fallback coverage.
- [x] Replay the captured request and verify all 318 items survive ingress.
- [x] Format and run focused core/server tests.
- [x] Run `rtk bun run check` and `rtk bun run preflight`.
- [x] Run `rtk git diff --check` and file-size checks.
- [x] Review against `origin/main` and this plan.
- [ ] Commit only intended files, push the existing PR, then post separate `@codex review` and `@cursor review` comments.

## Verification Commands

```bash
rtk bun test \
  packages/core/src/ingress/openai-responses.test.ts \
  packages/core/src/ingress/openai-responses/request.test.ts \
  packages/core/src/transform/openai-responses.test.ts \
  packages/core/src/transform/openai-responses-compatibility.test.ts \
  packages/core/src/transform/openai-responses-roundtrip.test.ts \
  packages/core/src/protocol/openai-responses-basic.test.ts \
  packages/core/src/egress/openai-responses.test.ts \
  packages/core/src/egress/openai-responses-custom.test.ts

rtk bun run --filter @aio-proxy/server test:unit -- \
  src/routes/openai-responses-fallback.integration.test.ts \
  src/routes/pipeline/attempt.test.ts

rtk bun run check
rtk bun run preflight
rtk git diff --check
```

## Reference Facts

- OpenAI Responses direct named choices use `{ type: "function" | "custom", name }`; other structured choices include hosted, MCP, `allowed_tools`, shell, apply-patch, and programmatic forms.
- AI SDK 7 named selection uses `{ type: "tool", toolName }`.
- AI SDK tool definitions carry `strict` and `metadata`; generated calls expose definition metadata as `toolMetadata`.
- OpenAI custom tool streaming uses `response.custom_tool_call_input.delta` and `response.custom_tool_call_input.done`.

References:

- `https://developers.openai.com/api/docs/guides/tools`
- `https://developers.openai.com/api/reference/resources/responses/streaming-events#response.custom_tool_call_input.delta`
- `https://developers.openai.com/api/reference/resources/responses/streaming-events#response.custom_tool_call_input.done`
- `https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling`
- Installed OpenAI and AI SDK type sources under `packages/core/node_modules/`
