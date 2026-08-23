# aio-proxy Agent Notes

aio-proxy routes model requests across configured upstream providers while keeping client-facing protocols stable.

<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## Repo Basics

- Bun workspace monorepo (`packages/*`) orchestrated by Turborepo.
- `packages/dashboard/AGENTS.md` is the authority for dashboard/frontend rules.
- Before considering a change complete, run `bun run preflight` (oxlint + oxfmt check + all unit tests), or at minimum `bun run check` plus the affected package's tests.

## Changesets

Releases are driven by Changesets. All workspace packages share one lockstep version (`fixed` in `.changeset/config.json`), and only two packages get a published GitHub Release with notes: the `aio-proxy` CLI launcher and `@aio-proxy/plugin-sdk`.

- Every changeset that affects users MUST target a product package: `aio-proxy` (for CLI/proxy changes) and/or `@aio-proxy/plugin-sdk` (for SDK changes). This is what puts the note into a published Release.
- When the change actually lives in an internal package, also list that package alongside the product package, e.g. a `core` fix is a changeset targeting both `@aio-proxy/core` and `aio-proxy`.
- Never write a changeset that targets ONLY an internal or platform-binary package (`@aio-proxy/core`, `server`, `cli`, the plugins, `@aio-proxy/cli-*`). The `fixed` group still bumps `aio-proxy`, but its CHANGELOG entry would be empty, so `scripts/release.ts` skips its GitHub Release and the notes silently vanish.
- Keep the product package's bump level equal to the internal package's (internal `minor` -> `aio-proxy` `minor`).
- Use `bun changeset` to author them; commit the generated `.changeset/*.md` alongside the change. Do not run `changeset version`/`publish` by hand — CI owns both.

## Domain Language

Use these terms in code, docs, and discussion; avoid the listed synonyms.

- **Provider ID**: a stable identifier for an upstream provider. In user config, it is the key in the `providers` object. Avoid: provider name, provider key.
- **Provider priority**: an integer failover tier (`0..10000`, default `0`). Higher values are tried first. Avoid: order, rank.
- **Provider weight**: a finite authored number for same-priority traffic (default `1`, then `Math.round` and clamp to `0..10000`). Larger effective values receive more same-tier traffic. Avoid: order, rank.

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

### Testing

- Every unit test must protect meaningful product behavior, a public contract, or a concrete regression. Completing a TDD cycle is not sufficient justification for adding a test.
- Do not write tests that merely restate static configuration or implementation literals. Prefer a behavior-level check that would fail when the user-visible outcome breaks; if no such automated check is practical, do not add a low-value unit test just to claim coverage.
- Keep unit tests next to their source files. When a module has a colocated test, group the public entry point, implementation, and test in a same-name directory: `foo/index.ts`, `foo/foo.ts`, and `foo/foo.test.ts`.
- Existing `_test/` directories are legacy layout: do not add new test files there, and when materially modifying a module whose tests live in `_test/`, move those tests next to the source as part of the change.
- When adding a colocated test in a package whose `test:unit` script still only scans `_test/`, update that script in the same change so the new test actually runs.

Few-shot:

Bad:

```text
foo.ts
foo.test.ts
```

Good:

```text
foo/
├── index.ts
├── foo.ts
└── foo.test.ts
```

### Dependencies

- When a dependency is used by two or more workspace packages, manage its version in the root catalog (`workspaces.catalog` in the root `package.json`) and declare it with `"catalog:"` in each package.

### Bun

- This project runs on Bun. In Bun-executed code, prefer Bun APIs when Bun provides the required capability.
- When selecting or verifying a Bun API, consult the official documentation index at https://bun.com/llms.txt and load only the relevant referenced page.

### File Size

- The 500-line limit applies to handwritten non-test implementation files.
- At 400 lines, evaluate whether a non-test implementation file has accumulated multiple responsibilities and split it before adding more.
- Test files have no hard line limit. Keep tests for one module or feature together when splitting would scatter shared fixtures or obscure the behavior under test.
- Split a test file when it covers multiple independent responsibilities and those behavior groups can be separated without substantial duplicated setup. Do not split a cohesive test file solely to satisfy a line count.
- Generated files, externally managed files, migrations, and declarative fixtures are exempt.
- New non-test implementation files must follow these limits. Existing non-test implementation files over 500 lines must not grow and should be split when materially modified.

### File Splitting

- Split files by responsibility, not by moving arbitrary lines into a generic helper file.
- When extracting private collaborators from `foo.ts`, prefer a directory containing export-only `foo/index.ts`, the main `foo/foo.ts` implementation, and private collaborators such as `foo/bar.ts`.
- `foo/index.ts` is the public entry point and should contain only exports. Keep business logic and orchestration in named implementation files.
- Private modules such as `foo/bar.ts` must not be exported from higher-level barrels or imported from outside the `foo/` directory.
- Keep business-specific operations named and colocated with their domain. Do not move them into generic `utils.ts` files.
- Avoid circular dependencies when splitting files.

### Change Quality

- Do not add another utility dependency when the standard library, platform, or `es-toolkit` covers the requirement.
- Non-trivial behavior changes require the smallest relevant automated test.
- Comments should explain constraints or reasoning, not restate the code.

## Cross-Protocol Routing

Provider selection is model-first. After parsing the inbound request enough to get the requested model:

1. Resolve the exact Provider-qualified route first, then the exact normal model.
2. Merge Provider defaults with exact model overrides.
3. Remove normal candidates with effective weight zero.
4. Order priority tiers descending and weight within the tier.
5. Stable sessions use deterministic draws; generated sessions use random draws.
6. Response owner and session affinity override candidate order only for eligible normal candidates.
7. The server pipeline remains the only generation candidate loop.

For each candidate:

- If the inbound protocol matches an API provider's protocol, use raw API passthrough.
- Otherwise convert the inbound request into model messages and call upstream through the AI SDK. For `api` providers, build the matching AI SDK provider from the provider's protocol/base URL/API key metadata for that attempt; for `ai-sdk` providers, use the configured package/options directly.
- Raw API passthrough is never used for cross-protocol transforms.
- On provider failure, try the next candidate for the same model. Preserve the final failure when no candidate succeeds.

Example for an inbound OpenAI Responses request matching three providers:

1. `A`: `api` + `openai-compatible` -> protocol mismatch, invoke via an OpenAI-compatible AI SDK adapter; do not raw-passthrough.
2. `B`: `api` + `openai-response` -> protocol match, raw API passthrough.
3. `C`: `ai-sdk` + `@ai-sdk/openai-compatible` -> model-message conversion and AI SDK invocation.

## Protocol Routing Architecture

- `packages/core/src/protocol/` owns one stateless adapter per inbound protocol.
- Adapters are created with `defineProtocolAdapter()` and contain only parse, model/variant extraction, raw request rewriting, model invocation conversion, egress, protocol-shaped errors, and allowlisted request diagnostics.
- `packages/server/src/routes/pipeline.ts` is the only candidate loop. Route files must not implement provider-kind branching, fallback, usage capture, request recording, or stream preflight.
- Runtime providers expose `raw` and/or `model` capabilities. Dispatch uses capabilities, not provider kind.
- Same-protocol raw capability wins. All other supported calls use the materialized model capability.
- Adding an inbound protocol requires one core adapter, one thin route registration, adapter tests, and dispatch-matrix coverage.
