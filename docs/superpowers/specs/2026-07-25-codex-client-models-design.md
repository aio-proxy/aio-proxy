# Codex Client Models Endpoint Design

## Problem

Codex CLI probes `GET /v1/models?client_version=<v>` to discover models. Unlike a
generic OpenAI client, it expects a Codex-specific response: a top-level
`{"models": [...]}` array where each entry carries rich agent-runtime fields
(`base_instructions`, `model_messages`, `context_window`, `supported_reasoning_levels`,
`input_modalities`, and more). The reference implementation `.reference/CLIProxyAPI`
(CPA) already serves this shape.

Today `aio-proxy` serves only the standard OpenAI/Anthropic superset list
(`{object:"list", data:[...]}`) from `listModels()` in
`packages/server/src/server/server.ts`. When Codex CLI hits our proxy it gets a
list it cannot consume as a Codex catalog, so Codex-specific runtime metadata
(instructions, reasoning levels) is unavailable.

We want `aio-proxy` to return the Codex-format catalog when, and only when, the
request looks like a Codex probe, while leaving the standard list untouched for
everyone else.

## Reference Behavior (CPA)

- Trigger: CPA branches to the Codex catalog when the `/v1/models` URL contains a
  `client_version` query **key**. The value is ignored; there is no
  `minimal_client_version` gating.
- Response: `{"models": [ ...rich items... ]}`, not the standard list shape.
- Source data: CPA embeds a `codex_client_models.json` snapshot and merges each
  requested model against a default template (`gpt-5.5`), deleting
  `availability_nux` from synthesized entries.

We reuse the *shape* and *trigger* but not CPA's snapshot-merge mechanics. Our
data comes from the upstream Codex `models.json` (already fetched by the
`openai-chatgpt` plugin) plus our own `models-dev` catalog.

## Desired Behavior

`GET /v1/models`:

1. If the request URL's query string contains a `client_version` key (any value,
   including empty), return the **Codex catalog**: `{"models": [...]}`.
2. Otherwise, return the existing standard list unchanged (`{object:"list", ...}`).

The Codex catalog lists **every client-facing alias of every enabled provider**
(the same alias set `listModels()` enumerates), so Codex sees the exact model ids
it can actually call. Each entry's `slug` and `id` equal the client-facing alias,
identical to the standard list's `id`.

Ordering: entries are sorted by ascending `priority`. Entries built from an
upstream template (see below) sort ahead of fully-synthesized entries; within
each group, ascending `priority`, then config/enumeration order for ties.

## Data Sources

### Upstream Codex `models.json`

`https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json`.
Top-level `{ "models": [ ... ] }`. Each item is a full Codex-client model record.
Verified fields on a representative item (`gpt-5.6-sol`) include: `slug`,
`display_name`, `description`, `priority`, `visibility`, `supported_in_api`,
`context_window`, `max_context_window`, `input_modalities`,
`supported_reasoning_levels` (array of `{effort, description}`),
`default_reasoning_level`, `supports_search_tool`, `base_instructions` (~17.7KB),
`model_messages.instructions_template` (identical to `base_instructions` for the
5.6 family), and `availability_nux`.

The `openai-chatgpt` plugin already fetches this file in
`packages/plugins/openai-chatgpt/src/catalog.ts` but currently discards everything
except `slug`/`display_name`/`priority`/`supported_in_api`/`visibility`. We will
widen that plugin to preserve the **entire** upstream item as opaque JSON on the
model descriptor's metadata, so the server can pass it through verbatim.

### models-dev Catalog

`packages/core/src/models-dev-catalog.ts` exposes `metadata(modelId)` returning
`{capabilities:{effort:{low,medium,high,xhigh,max,supported},image_input,pdf_input,...},
displayName, maxInputTokens, maxTokens, releaseDate}`. This is our structural
fallback for models with no upstream Codex row.

## Entry Construction

For each enabled alias, resolve the route (`alias` -> `modelId`) exactly as
`listModels()` does via `modelRoutes(provider)`.

### Case A — upstream row exists

If the resolved `route.modelId` matches an upstream Codex `slug`, **return the
upstream item verbatim**, except `slug` and `id` are set to the client-facing
alias. No field is added, removed, or rewritten. In particular, if the upstream
item carries `availability_nux`, it is passed through unchanged; we never strip
or inject it. This is the "template" group for ordering.

Data path: plugin preserves the full item -> `RuntimeModelMetadata.codex`
(opaque `JsonValue`) -> `modelMetadata()` passes it through -> the Codex-catalog
module reads it back.

### Case B — no upstream row (synthesized)

Build the entry field-by-field. **Each field is its own zod schema with a
`.default()`**, and the object schema is `.loose()` so any pre-existing unknown
fields on a partial source pass through untouched. Defaults are taken from the
`gpt-5.6-sol` values (the current 5.6 shape). Structural fields prefer real
`models-dev` values when available:

- `slug` / `id`: the client-facing alias (required, no default).
- `display_name`: `models-dev` `displayName` -> default `slug`.
- `context_window` / `max_context_window`: `models-dev` `maxInputTokens` -> default.
- `input_modalities`: derived from `models-dev` `capabilities.image_input`/`pdf_input`
  (always includes `"text"`) -> default `["text","image"]`.
- `supported_reasoning_levels`: derived from `models-dev` `capabilities.effort`
  (one `{effort, description}` per supported level) -> default 5.6 level list.
- `default_reasoning_level`: default `"low"`.
- `base_instructions` and `model_messages.instructions_template`: both filled from
  a single static **markdown file** (see below).
- All other Codex fields: schema defaults copied from `gpt-5.6-sol`.

We do **not** add `availability_nux` to synthesized entries.

## System-Prompt Markdown Snapshot

Annotation 1 decision: the ~17.7KB `base_instructions` / `instructions_template`
text is stored as a static **markdown file** checked into the new module's
directory (a declarative fixture, exempt from the 300-line limit).

- Content: the full 5.6 instructions text.
- The single occurrence of the model name in the opening line
  (`You are Codex, an agent based on GPT-5.`) is replaced with a placeholder
  `{{model_name}}`, e.g. `... based on {{model_name}}.`. (The product name
  `Codex` is not a placeholder.)
- At assembly time, `{{model_name}}` is substituted with the target model name
  and the result is written to both `base_instructions` and
  `model_messages.instructions_template`.

## Architecture

- New module `packages/server/src/server/codex-client-models/`:
  - `index.ts` — exports only.
  - `codex-client-models.ts` — `codexClientModels(state)`; enumerates aliases,
    branches Case A / Case B, applies zod schemas + defaults, substitutes the md
    placeholder, sorts, returns `{ models: [...] }`.
  - `default-instructions.md` — the 5.6 snapshot with `{{model_name}}`.
  - `codex-client-models.test.ts` — colocated behavior tests.
- The endpoint stays in `server.ts`. `app.get("/v1/models", ...)` inspects the
  query for a `client_version` key and delegates to `codexClientModels(state)` or
  the existing `listModels(state)`. `codexClientModels` runs parallel to
  `listModels`; it does not enter the routing pipeline.

### Touched files

1. `packages/plugins/openai-chatgpt/src/catalog.ts` — widen `CodexModelsSchema`
   (loose per-item) and keep the full upstream item in `metadata.codex`; update
   `catalog.test.ts`.
2. `packages/server/src/runtime.ts` — add `codex?: JsonValue` to
   `RuntimeModelMetadata`.
3. `packages/server/src/plugin-runtime/catalog.ts` — `modelMetadata()` passes the
   `codex` field through.
4. `packages/server/src/server/codex-client-models/**` — new module + md + tests.
5. `packages/server/src/server/server.ts` — `/v1/models` query-key branch.

## Error Handling

- `models-dev` fetch failures degrade gracefully: Case B falls back entirely to
  schema defaults (same tolerance as `listModels()`, which catches and ignores
  catalog errors).
- Missing/partial upstream `codex` metadata routes an alias to Case B rather than
  failing the request.
- A malformed upstream item that fails the loose per-item schema is skipped, not
  fatal, so one bad row cannot break Codex discovery.

## Testing (behavior-level)

1. With `?client_version=...`, the response is `{"models":[...]}` and a
   synthesized entry exposes `supported_reasoning_levels` populated from
   `models-dev` effort capabilities.
2. Without the query key, the response is still the standard `{object:"list", ...}`
   shape (regression guard on the existing endpoint).
3. For an alias with no upstream row (Case B), the entry is assembled, its
   `base_instructions` contains the substituted model name, and it carries no
   `availability_nux`. For an alias with an upstream row (Case A), the upstream
   item is returned verbatim (including its own `availability_nux` if present).

## Global Constraints

- Bun + Turborepo monorepo. Run `bun run preflight` (or `bun run check` + affected
  package tests) before completion.
- `zod` is imported via `@aio-proxy/plugin-sdk`'s `zod` export.
- Prefer `es-toolkit` with narrow imports (`es-toolkit/fp`, etc.).
- Colocated test layout: `foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts`.
- Handwritten files <= 300 lines; the md snapshot is a declarative fixture (exempt).
- JSON import precedent: `import x from "./y.json" with { type: "json" }`.
- Branch prefix `codex/`; commit footer `Co-authored-by: Codex <noreply@openai.com>`.
- Terminology: Provider ID, Provider weight.
