# aio-proxy Agent Notes

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## Coding Standards

### Utilities

- Search the codebase before adding a utility.
- Prefer `es-toolkit`, or a composition of its functions, for generic collection, object, string, and function utilities.
- Do not hand-write utilities without business meaning when `es-toolkit` already provides equivalent behavior.
- Keep trivial native JavaScript when it is clearer, such as `map`, `filter`, `some`, `every`, object spread, or a simple loop.
- Prefer narrow imports such as `es-toolkit/array`, `es-toolkit/object`, and `es-toolkit/function`.
- Avoid `es-toolkit/compat` unless lodash-compatible behavior is explicitly required.
- Each workspace package using `es-toolkit` must declare it with `"es-toolkit": "catalog:"`.
- When selecting an `es-toolkit` function or verifying its import path, behavior, or FP signature, consult the official documentation index: https://es-toolkit.dev/llms.txt
- Load only the relevant referenced documentation page. Do not load `llms-full.txt` unless broad API research is explicitly required.

### Functional Pipelines

- Prefer `es-toolkit/fp` for multi-step, side-effect-free collection transformations when `pipe` makes the data flow clearer.
- Do not convert loops that rely on early exit, mutation, async sequencing, streaming, or state-machine behavior into functional pipelines.
- Do not assume `es-toolkit/fp` is faster. For performance-sensitive code, benchmark the actual path and prefer a single loop when it avoids repeated traversal or intermediate allocations.

### File Size

- Handwritten code files, including tests, should not exceed 300 lines.
- At 240 lines, evaluate whether the file has accumulated multiple responsibilities and split it before adding more.
- Generated files, externally managed files, migrations, and declarative fixtures are exempt.
- New files must follow these limits. Existing files over 300 lines must not grow and should be split when materially modified.

### File Splitting

- Split files by responsibility, not by moving arbitrary lines into a generic helper file.
- When extracting private collaborators from `foo.ts`, prefer a private directory such as `foo/index.ts` and `foo/bar.ts`.
- `foo/index.ts` is the public entry point and should contain only exports and lightweight orchestration.
- Private modules such as `foo/bar.ts` must not be exported from higher-level barrels or imported from outside the `foo/` directory.
- Keep business-specific operations named and colocated with their domain. Do not move them into generic `utils.ts` files.
- Avoid circular dependencies when splitting files.

### Change Quality

- Do not add another utility dependency when the standard library, platform, or `es-toolkit` covers the requirement.
- Non-trivial behavior changes require the smallest relevant automated test.
- Run `bun run check` and the affected package tests before considering a change complete.
- Comments should explain constraints or reasoning, not restate the code.

## Cross-Protocol Routing

Provider selection is model-first:

1. Parse the inbound request enough to get the requested model.
2. Resolve every provider that exposes that model alias.
3. Resolve candidates by descending configured `weight`; equal or absent weights preserve config order.

For each candidate:

- If the inbound protocol matches an API provider protocol, use raw API
  passthrough.
- Otherwise use an AI SDK invocation path. Convert the inbound protocol request
  into model messages and call the upstream through the AI SDK abstraction. For
  API providers, this means building the matching AI SDK provider from the API
  provider's protocol/base URL/API key metadata for that attempt; for `ai-sdk`
  providers, use the configured package/options directly.
- Raw API providers are never used for cross-protocol transforms directly.
- On provider failure, try the next candidate for the same model. Preserve the
  final failure when no candidate succeeds.

Example for an inbound OpenAI Responses request whose model matches three
providers:

1. `A`: `api` + `openai-compatible` -> protocol mismatch, call through AI SDK
   semantics using an OpenAI-compatible AI SDK adapter; do not raw-passthrough.
2. `B`: `api` + `openai-response` -> protocol match, raw API passthrough.
3. `C`: `ai-sdk` + `@ai-sdk/openai-compatible` -> protocol mismatch handled by
   model-message conversion and AI SDK invocation.

The implementation should therefore keep same-protocol passthrough simple while
moving fallback selection and cross-protocol conversion into shared routing
logic, not duplicating ad hoc conversions in individual route files.

## Protocol Routing Architecture

- `packages/core/src/protocol/` owns one stateless adapter per inbound protocol.
- Adapters are created with `defineProtocolAdapter()` and contain only parse, model/variant extraction, raw request rewriting, model invocation conversion, egress, and protocol-shaped errors.
- `packages/server/src/routes/pipeline.ts` is the only candidate loop. Route files must not implement provider-kind branching, fallback, usage capture, request recording, or stream preflight.
- Runtime providers expose `raw` and/or `model` capabilities. Dispatch uses capabilities, not provider kind.
- Same-protocol raw capability wins. All other supported calls use the materialized model capability.
- Adding an inbound protocol requires one core adapter, one thin route registration, adapter tests, and dispatch-matrix coverage.
