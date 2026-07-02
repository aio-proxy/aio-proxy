---
slug: protocol-adapter-refactor
status: awaiting-approval
intent: unclear
pending-action: write .omo/plans/protocol-adapter-refactor.md
approach: ProtocolAdapter contract in core + one shared route pipeline in server + Router multi-candidate fallback + API->AI-SDK cross-protocol bridge (implements documented AGENTS.md routing rules)
---

# Draft: protocol-adapter-refactor

## Components (topology ledger)
| id | outcome | status | evidence |
|----|---------|--------|----------|
| C1 | ProtocolAdapter contract + 4 protocol adapters in core (parse/model/stream/toModelMessages/json/sse/errors/probe) | active | packages/core/src/{ingress,egress,transform}/* |
| C2 | Router returns ordered candidate list per alias (config order), multi-provider alias allowed | active | packages/core/src/index.ts:195-251 |
| C3 | ONE generic route pipeline in server; 4 route files become thin registrations | active | packages/server/src/routes/*.ts |
| C4 | API->AI-SDK bridge: protocol-mismatched API provider invoked via matching AI SDK adapter | active | AGENTS.md routing rules; packages/core/src/provider/{ai-sdk,ai-sdk-loader}.ts |
| C5 | Egress gap fixes pulled into core (anthropic non-stream JSON writer w/ tools+usage; responses wrong error tag) | active | routes/anthropic-messages.ts:148-197; routes/openai-responses.ts:75,94 |
| C6 | provider-runtime probe requests sourced from adapters | active | packages/server/src/provider-runtime.ts:134-169 |
| C7 | naming unification (USER DIRECTIVE at gate): internal "openai-chat" family renamed to "openai-completions" - files core/src/{ingress,egress,transform}/openai-chat*.ts, exported symbols (parseOpenAICompletions, openaiCompletionsToModelMessages, writeOpenAICompletionsResponse/SSE), error tag, _test/fixtures/openai-chat/ dir; egress writer names aligned to write<Protocol>{Response,SSE} across all protocols; ProviderProtocol.OpenAICompatible ("openai-compatible") config value UNCHANGED (user-facing config, different semantic) | active | user gate reply 2026-07-02 |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|------------|-----------------|-----------|-------------|
| "base class" realization | interface + adapter objects + ONE shared pipeline function (composition), NOT abstract class inheritance | repo is 100% functions+readonly types (only Error subclasses + Router are classes); TS best practice: composition over inheritance; same outcome user wants (one contract, N impls) | yes - contract shape identical either way |
| fallback scope | implement multi-candidate fallback (config order) per AGENTS.md | AGENTS.md explicitly documents it as target; current Router THROWS collision on multi-provider alias, contradicting docs | yes - keep collision error instead (config change) |
| cross-protocol scope | implement API->AI-SDK bridge per AGENTS.md | AGENTS.md documents exact behavior incl. example; all needed AI SDK pkgs already in workspace catalog | yes - keep 501 seam |
| behavior drift = bugs | fix while refactoring: gemini missing 8MiB guard; responses toIngressError tagged "openai-chat"; anthropic non-stream drops tool-calls/usage | drift is caused by the duplication being removed; keeping bugs would require extra code | yes but pointless |
| subscription providers | remain non-invokable (skipped as candidates / 501 when sole match) | no invoke path exists today; out of refactor scope | yes |
| weighted routing | NOT implemented; config order = weight | AGENTS.md: "until weights exist, config order is the weight" | yes |

## Findings (cited - path:lines)
- F1 4x duplicated pipeline: routes/{openai-completions,openai-responses,anthropic-messages,gemini-generate-content}.ts each hand-roll: content-length guard / parseRequest try-catch / resolveRoute try-catch (verbatim x4) / protocol-match passthrough check / kind!==AiSdk -> 501 / ensureAiSdkProviderAvailable+invoke try-catch duplicated per stream+non-stream / SSE headers block (verbatim x4) / per-protocol error helper.
- F2 drift bugs caused by duplication:
  - gemini-generate-content.ts: NO maxBodyBytes guard (other 3 have 8MiB).
  - openai-responses.ts:75,94: errors funneled through toIngressError(error, "openai-chat") - egress/error.ts's IngressProtocol union has ONLY "openai-chat" (error.ts:6-30 per explore lane); the error module was never extended for responses, so responses errors come out chat-shaped.
  - anthropic-messages.ts:148-178 anthropicMessage(): non-stream egress hand-rolled IN route; hardcoded id/model, drops tool_use blocks, no usage; core/egress/anthropic-messages.ts only exports SSE writer (route patches types via `declare module "@aio-proxy/core"` lines 20-24).
  - anthropic-messages.ts:180-221 aiSdkMessages()+contentText(): transform logic leaked into route; LOSSY (tool-call -> "", tool role -> content: []) while transform/anthropic-messages.ts exists in core.
  - error translation: 3 different mechanisms (anthropicProviderError / toIngressError / geminiProviderError).
- F3 Router (core/src/index.ts:195-251): Map<alias, ONE resolution>; addRoute THROWS RouterModelCollisionError when 2 providers expose same alias -> multi-provider fallback structurally impossible; contradicts AGENTS.md "Resolve every provider that exposes that model alias, preserving config order".
- F4 cross-protocol: all 4 routes return 501 for API provider with mismatched protocol; AGENTS.md demands AI SDK invocation built from API provider metadata (protocol/baseUrl/apiKey). Passthrough-eligibility check duplicated inline per route.
- F5 provider-runtime.ts:134-169 providerProbeRequest(): 4-protocol switch (probe path+body) - protocol knowledge scattered outside protocol modules.
- F6 conventions: bun workspaces + turbo + biome + rslib; tests in packages/*/_test (bun test); zod v4; hono with typed AppType export (server.ts:76-77); no classes except Errors+Router; i18n error keys exist (error_alias_collision, error_provider_not_installed).
- F7 AI SDK catalog already has @ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/openai-compatible (root package.json catalog) - bridge needs no new deps.
- F8 core already exposes per-protocol pieces the adapters will wrap: ingress/parse*, transform/*ToModelMessages, egress/write*{Response,SSE,Completion}, egress/error.toIngressError.
- F9 RouterModelCollisionError blast radius: server-state.ts:225-226 maps it to reload stage "alias-collision"; i18n format-error.ts:7,151 + en/zh messages error_alias_collision; tests: server/_test/server-reload.test.ts:58, i18n/_test/format-error.test.ts:38, core/_test/router.test.ts. D3 keeps the class for same-provider duplicates; cross-provider tests flip to fallback-order assertions; reload stage + i18n key stay valid.

## Decisions (with rationale)
- D1 Adapter contract lives in core (packages/core/src/protocol/), one file per protocol adapter wrapping existing ingress/transform/egress functions; server imports adapters, never protocol functions directly.
- D2 ONE generic handler createProtocolRoutes(adapter, source) in server replaces 4 pipelines; per-protocol URL quirks stay in thin registration files (gemini path-model extraction + :streamGenerateContent, anthropic /count_tokens, responses GET /:id 501).
- D3 Router.resolve(model) -> ordered candidates (readonly RouterResolution[]); provider-prefixed alias (id/alias) -> exactly that provider; same-provider duplicate alias stays an error; cross-provider duplicate becomes fallback order (removes RouterModelCollisionError for that case).
- D4 Pipeline candidate loop per AGENTS.md: for each candidate -> same-protocol API = passthrough; AiSdk = invoke; mismatched API = AI SDK bridge invoke; subscription = skip; on failure try next; exhaust -> final failure. Non-stream failures fall through to next candidate; once a stream response has started bytes, no fallback.
- D5 Fix F2 bugs in the same pass (they are artifacts of the duplication).

## Scope IN
- packages/core: protocol adapters, Router candidates, anthropic non-stream egress writer, API->AI-SDK bridge factory.
- packages/server: generic pipeline, 4 thin route files, provider-runtime probe wiring, provider-availability integration.
- Tests: unit (core adapters/router/egress) + existing server _test suites updated for changed shapes; new fallback + bridge tests.
- AGENTS.md: update to describe adapter architecture (it already documents the routing semantics).

## Scope OUT (Must NOT have)
- NO new npm dependencies.
- NO weighted routing, NO retry policies/circuit breakers.
- NO subscription-provider invocation.
- NO dashboard/CLI feature changes (only compile-compat).
- NO change to same-protocol raw passthrough semantics (byte-for-byte proxy stays).
- NO renaming of public HTTP routes or config schema fields (except: cross-provider alias collision no longer errors - documented behavior change).
- NO speculative extension points beyond the 4 protocols.

## Open questions
- none blocking; all resolved via repo evidence + AGENTS.md. User vetoes defaults at gate.

## Approval gate
status: approved
approved: 2026-07-02 user reply "批准，枚举改，不用兼容，项目还没发布"
scope-additions-at-gate:
- C7 naming unification INCLUDING ProviderProtocol enum values; NO compatibility layer (project unreleased).
- enum: OpenAICompatible "openai-compatible" -> OpenAICompletions "openai-completions"; ALSO normalize OpenAIResponse "openai-response" -> OpenAIResponses "openai-responses" (announced default: full vocabulary consistency with route files; reversible).
- sample configs (aio-proxy.json at root + packages/cli/aio-proxy.json) and generated config.schema.json must follow.
pending-action: dual Momus review (native momus + codex gpt-5.5 xhigh) -> fix cited issues -> fill TL;DR -> deliver.
metis: DONE (bg_bd3f405f) - folded: todo2 dashboard derived-id break (server.test.ts /dashboard/providers/openai-compatible), todo3 declare-module deletion moved into todo3, todo9 streaming-fallback boundary wording + subscription-only-exhaustion 501, todo10 error.ts deletion + AppType preservation via handler-only pipeline export, todo12 per-package option contracts + openai-responses resolveModel pin. Contrarian grill (defer C2/C4) REJECTED: user explicitly chose full scope at gate (was offered the cut as an option).
notes: explore lane bg_14745803 integrated. librarian lane bg_d227e21b integrated (LiteLLM BaseConfig hooks / one-api Adaptor interface / bifrost central fallback - all confirm adapter contract + single pipeline + shared-layer fallback).
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
