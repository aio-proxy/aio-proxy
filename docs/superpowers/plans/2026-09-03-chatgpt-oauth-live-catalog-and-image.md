# ChatGPT OAuth Live Catalog + `gpt-image-2` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ChatGPT OAuth provider expose exactly the models the signed-in account can actually use — including `gpt-5.3-codex-spark` — and route `/v1/images/*` requests for `gpt-image-2` to the ChatGPT Codex image endpoints.

**Architecture:** The `openai-chatgpt` plugin currently discovers models by fetching a **static file on GitHub** (`codex-rs/models-manager/models.json`) and filtering it by `supported_in_api`. Both halves are wrong. We replace the data source with the account-authenticated live endpoint `GET https://chatgpt.com/backend-api/codex/models?client_version=<pinned>` (reachable because `catalog.discover` receives the account's `CredentialPort`), and drop the `supported_in_api` filter because upstream Codex short-circuits that flag in ChatGPT mode. Separately, `gpt-image-2` is declared as a hardcoded image-catalog entry — the models endpoint has no output-modality field and cannot describe it — and the plugin runtime gains raw passthrough for the `openai-image` protocol plus URL rewriting for `/images/generations` and `/images/edits`.

**Tech Stack:** Bun, TypeScript, Turborepo, Zod (via `@aio-proxy/plugin-sdk`'s `zod` re-export), `es-toolkit/fp`, `bun:test`, Changesets.

## Global Constraints

- **Changeset is mandatory and must target the product package.** Every changeset that affects users MUST list `aio-proxy`. When the change lives in an internal package, list that package alongside it. A changeset that targets ONLY internal packages produces an empty CHANGELOG and its GitHub Release note silently vanishes. Bump levels must match between the internal package and `aio-proxy`.
- **Test colocation.** Keep unit tests next to their source. When a module has a colocated test, group entry point, implementation, and test in a same-name directory (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`). Files that already sit flat next to a flat test (`src/catalog.ts` + `src/catalog.test.ts`) stay as-is in this change; do not restructure them.
- **Verification command:** `bun run preflight` (= `lint:types` + `format:check` + all tests). Minimum acceptable per-task check: `turbo run test:unit --filter=@aio-proxy/plugin-openai-chatgpt` plus `bun run check`.
- **Formatting is enforced.** `format:check` runs `oxfmt --check .`. Run `bun run format` before committing if a step's code does not already match.
- **`es-toolkit` narrow imports only** — `es-toolkit/fp`, `es-toolkit/array`, `es-toolkit/object`, `es-toolkit/predicate`, `es-toolkit/function`. Never `es-toolkit/compat`.
- **Object shape guards:** `isPlainObject` from `es-toolkit/predicate` for parsed/authored plain data; `isRecord` from `@aio-proxy/shared` for structural TypeScript contracts that may be class instances. This change adds neither.
- **500-line limit** on handwritten non-test implementation files; evaluate splitting at 400. No file in this change approaches either bound.
- **Domain language:** Provider ID, provider priority, provider weight. Avoid "provider name/key", "order", "rank".
- **Do not run `changeset version` or `changeset publish`.** CI owns both.
- **First-time setup in a fresh worktree:** run `bun install` before any test command, otherwise `turbo` fails resolving `@aio-proxy/infra/rslib`.

---

## Background: why each change is needed

Read this once before Task 1. It is the evidence base; every claim below was verified against the live ChatGPT backend on 2026-09-03 using a real Plus account.

**1. The static GitHub file and the live endpoint disagree in both directions.**

Static file (`https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json`), 10 entries:
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`, `codex-auto-review`.

Live endpoint (`GET /backend-api/codex/models?client_version=0.135.0`), 5 entries:
`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `codex-auto-review`.

So today we **over-report 6 models the account cannot use** and **under-report `gpt-5.3-codex-spark`, which it can**. `gpt-5.3-codex-spark` is absent from the static file entirely — removing the `supported_in_api` filter without switching the data source would NOT expose it.

**2. `supported_in_api` is the wrong filter for a ChatGPT account.** Upstream Codex (`codex-rs/protocol/src/openai_models.rs`) short-circuits it:

```rust
pub fn filter_by_auth(models: Vec<ModelPreset>, chatgpt_mode: bool) -> Vec<ModelPreset> {
    models.into_iter().filter(|model| chatgpt_mode || model.supported_in_api).collect()
}
```

`gpt-5.3-codex-spark` reports `supported_in_api: false`, and a `POST /backend-api/codex/responses` with `{"model":"gpt-5.3-codex-spark"}` returns a valid SSE stream (`response.created`, status `in_progress`). The flag describes API-key access, not ChatGPT access.

**3. `client_version` gates the response and is required.** Omitting it returns HTTP 400 (`Field required`). The endpoint filters by each model's `minimal_client_version`:

| `client_version` | models returned |
| --- | --- |
| `0.1.0` | 0 |
| `0.123.0` | 4 (no `gpt-5.5`) |
| `0.135.0` | 5 |
| `99.0.0` | 9 (includes unreleased `gpt-reserve`, `gpt-5.6-*`) |

Pin it to the same version the plugin already claims in its `User-Agent` (`0.135.0`) so the catalog matches what a real codex-tui of that version sees. Do not send an inflated version — that surfaces models the account is not meant to have.

**4. `gpt-image-2` cannot be discovered, only declared.** Zero occurrences of `gpt-image` in either the static file or the live response. Codex hardcodes it (`const IMAGE_MODEL: &str = "gpt-image-2"` in `codex-rs/ext/image-generation/src/tool.rs`), and the endpoint's `ModelInfo` schema has only `input_modalities` and `supports_image_detail_original` — there is no output-modality field, so the schema structurally cannot express "produces images." All three reference projects in `.reference/` hardcode it; `CLIProxyAPI` does so explicitly in `internal/registry/model_definitions.go` (`WithCodexBuiltins` / `codexBuiltinImageModelID = "gpt-image-2"`). Hardcoding is the permanent answer, not a stopgap.

**5. The image endpoints work and the `model` field is decorative.**
- `POST /backend-api/codex/images/generations` with `{"model":"gpt-image-2","prompt":...}` → HTTP 200, `{created, background, data:[{b64_json}], output_format, quality, size, usage}`, ~900 KB.
- Six different `model` values (`gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `dall-e-3`, `definitely-not-a-model`, omitted) all returned 200 with identical usage (`input_tokens: 9`, `output_tokens: 229`) and identical C2PA metadata (`name: gpt-image`, `version: 2.0`).
- `POST /backend-api/codex/images/edits` accepts **JSON only**, shaped `{"images":[{"image_url":"data:image/png;base64,..."}]}` → HTTP 200. It rejects `multipart/form-data` with `{"detail":"Unsupported content type"}`, and rejects `images[0].b64_json` / `images[0].data` / `images[0].type` as unknown parameters. Its accepted item shape is exactly our inbound `imageSourceSchema` (`{image_url}` | `{file_id}`), so JSON raw passthrough is byte-compatible.
- `stream: true` is accepted but the response is still `application/json`, not SSE.

**Known limitation this change does not fix:** a `multipart/form-data` inbound to `/v1/images/edits` will fail against ChatGPT (upstream rejects the content type). The AI SDK model path fares no better — `@ai-sdk/openai` posts `/images/edits` as FormData. Raw passthrough is therefore strictly the better of the two, and multipart edits remain unsupported for this provider. Do not attempt a multipart→JSON transcode in this change.

**6. The URL rewrite currently drops image paths on the floor.** `codexEndpointFor` returns `undefined` for anything that is not `/responses`, `/responses/compact`, or `/chat/completions`, and `rewriteCodexUrl` then returns the URL unchanged — which is *our own inbound URL*. Reproduced:

```
http://localhost:8787/v1/responses         -> https://chatgpt.com/backend-api/codex/responses
http://localhost:8787/v1/images/generations -> http://localhost:8787/v1/images/generations   (loops back into the proxy)
http://localhost:8787/v1/images/edits       -> http://localhost:8787/v1/images/edits         (loops back into the proxy)
```

The image branch in `codexEndpointFor` is mandatory, not optional.

**7. Host plumbing is already in place** — no changes needed outside the plugin:
- `packages/server/src/plugin-runtime/capabilities.ts` maps `'openai-image' -> 'openai-image'` in `pluginProtocol`, and `rawCapability().resolve` looks the descriptor up in `imageCatalogById` first when `protocol === ProviderProtocol.OpenAIImage`.
- `buildModelCapabilityIndex` derives the `image` capability from `catalog.image` ids (`packages/server/src/provider-runtime/capability-index/capability-index.ts:31,39`) — which is precisely why today's `image: []` hides `gpt-image-2` from both `/v1/models` and routing.
- `createRuntimeProvider` takes the `catalog.language.length > 0` branch and attaches `raw` and `image` there.
- `dispatchImageCandidate` (`packages/server/src/routes/pipeline/attempt/image.ts`) prefers `provider.raw?.resolve({protocol, modelId, requestPath})` and only falls back to `provider.image`.
- `oauthExposedModels(catalogModelIds(catalog), config.excludedModels)` unions language + image + embedding ids, so an image-catalog id becomes a public model route automatically.

---

## File Structure

**Created:**

- `packages/plugins/openai-chatgpt/src/codex-client.ts` — the pinned codex-tui client version and the `User-Agent` derived from it. Two constants shared by catalog discovery and the runtime, so the version the catalog queries can never drift from the version the runtime claims. No logic. It is a leaf: it imports nothing, so `catalog.ts -> runtime/index -> runtime.ts -> codex-client` introduces no cycle.
- `packages/plugins/openai-chatgpt/src/plugin.test.ts` — adapter-level test that `catalog.discover` surfaces the image catalog. Guards the `image: []` regression at the seam that actually matters.

**Modified:**

- `packages/plugins/openai-chatgpt/src/catalog.ts` — swap the static GitHub URL for the credentialed live endpoint; drop the `supported_in_api` filter; export the hardcoded `gpt-image-2` descriptor. Stays well under 100 lines.
- `packages/plugins/openai-chatgpt/src/catalog.test.ts` — rewritten. Its current `'unsupported'` fixture asserts the behavior we are deliberately removing.
- `packages/plugins/openai-chatgpt/src/plugin.ts` — pass `credentials` into discovery; wire the image catalog in place of `image: []`.
- `packages/plugins/openai-chatgpt/src/index.ts` — the public constant is renamed `CODEX_MODELS_URL` → `CODEX_MODELS_ENDPOINT`.
- `packages/plugins/openai-chatgpt/src/runtime/runtime.ts` — import the shared `User-Agent`; add the two Codex image endpoints; add the image branch to `codexEndpointFor`; accept `openai-image` in the raw resolver.
- `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts` — add image URL-rewrite coverage; extend the raw-resolver assertions.

**Created (release):**

- `.changeset/chatgpt-live-catalog-and-image.md`

**Explicitly NOT modified:**

- `packages/types/src/codex-model/codex-model.ts` — `CodexLeanModelSchema` keeps `supported_in_api`. We stop *filtering* on it; the field is still present in the live payload and the schema is shared with `packages/server/src/server/list-models/codex-client-models/codex-cache.ts`. Touching it would force an unrelated test edit for no behavior gain.
- `packages/server/src/server/list-models/codex-client-models/codex-cache.ts` — a separate consumer of the static GitHub file for the codex *client* model list. Different purpose. Leave it.
- Anything under `packages/server/src/routes/` or `packages/core/src/protocol/` — see Background item 7.

---

### Task 1: Live, credentialed model discovery

Replaces the static GitHub file with the account-authenticated Codex models endpoint and removes the `supported_in_api` filter. After this task `gpt-5.3-codex-spark` appears and the 6 phantom models disappear.

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/codex-client.ts`
- Modify: `packages/plugins/openai-chatgpt/src/catalog.ts` (whole file replaced)
- Modify: `packages/plugins/openai-chatgpt/src/plugin.ts:128-135` (the `discover` callback)
- Modify: `packages/plugins/openai-chatgpt/src/index.ts:4` (renamed export)
- Test: `packages/plugins/openai-chatgpt/src/catalog.test.ts` (whole file replaced)

**Interfaces:**
- Produces: `CODEX_CLIENT_VERSION: string` and `CHATGPT_USER_AGENT: string` from `./codex-client` — Task 3 imports `CHATGPT_USER_AGENT` from here.
- Produces: `discoverOpenAIChatGPTModels(credentials: CredentialPort<ChatGPTCredential>, signal: AbortSignal, fetch?: RuntimeFetch): Promise<readonly ModelDescriptor[]>` — note the **new leading `credentials` parameter**; the old signature was `(signal, fetch)`.
- Produces: `CODEX_MODELS_ENDPOINT: string` (was `CODEX_MODELS_URL`).
- Consumes: `currentCredential(port: CredentialPort<ChatGPTCredential>, fetcher?: RuntimeFetch): Promise<ChatGPTCredential>`, already exported from `./runtime/index`. It reads the port and refreshes through `port.refresh` when the token is expired or empty, so discovery never sends a stale bearer.
- Consumes: `AccountContext<ChatGPTCredential, Record<string, never>>` from `@aio-proxy/plugin-sdk` — the object `catalog.discover` receives. Its shape is `{ credentials: CredentialPort<Credential>; options: AccountOptions; signal: AbortSignal; fetch?: RuntimeFetch }`.
- Consumes: `RuntimeFetch` — `typeof globalThis.fetch` widened to accept `RuntimeRequestInit`, which adds the optional `aioProxy: { traffic?: 'model' | 'control' }` field. Model discovery is `'control'` traffic.
- `CredentialPort<Credential>` is `{ read: () => Promise<CredentialSnapshot<Credential>>; refresh: (expectedRevision: number, exchange: (...) => Promise<...>) => Promise<{ status: 'updated' | 'superseded'; snapshot: CredentialSnapshot<Credential> }> }`, and `CredentialSnapshot` is `{ revision: number; value: Credential }`. `ChatGPTCredential` is `{ accessToken: string; accountId: string; expiresAt: number; refreshToken: string; email?: string }` (from `./schema`).
- All of `CredentialPort`, `RuntimeRequestInit`, `RuntimeFetch`, `AccountContext`, `ModelDescriptor`, `OAuthAdapter`, and `PluginDescriptor` are re-exported from the `@aio-proxy/plugin-sdk` root; import them from there, not from subpaths.

- [ ] **Step 1: Create the shared client-version module**

Create `packages/plugins/openai-chatgpt/src/codex-client.ts`:

```ts
// Pinned to the codex-tui build this plugin impersonates. The ChatGPT models
// endpoint gates each model on its `minimal_client_version`, so this value
// decides which models the catalog can see: 0.123.0 hides gpt-5.5, and an
// inflated version surfaces unreleased models the account is not meant to have.
// Keep it equal to the version reported in the User-Agent below.
export const CODEX_CLIENT_VERSION = '0.135.0';

export const CHATGPT_USER_AGENT =
  `codex-tui/${CODEX_CLIENT_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; ${CODEX_CLIENT_VERSION})` as const;
```

- [ ] **Step 2: Write the failing tests**

Replace the entire contents of `packages/plugins/openai-chatgpt/src/catalog.test.ts` with:

```ts
import { afterEach, expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CODEX_MODELS_ENDPOINT, discoverOpenAIChatGPTModels } from './catalog';
import type { ChatGPTCredential } from './schema';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
  return {
    accessToken: 'access-token',
    accountId: 'acct-123',
    expiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token',
    ...overrides,
  };
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

test('queries the account Codex models endpoint with pinned client version and ChatGPT auth', async () => {
  const calls: { readonly url: string; readonly headers: Headers; readonly traffic: string | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      headers: new Headers(request.headers),
      traffic: init?.aioProxy?.traffic,
    });
    return Response.json({ models: [] });
  }) as typeof globalThis.fetch;

  await discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal);

  const call = calls[0];
  if (call === undefined) throw new Error('missing catalog fetch');
  const url = new URL(call.url);
  expect(`${url.origin}${url.pathname}`).toBe(CODEX_MODELS_ENDPOINT);
  expect(url.searchParams.get('client_version')).toBe('0.135.0');
  expect(call.headers.get('authorization')).toBe('Bearer access-token');
  expect(call.headers.get('ChatGPT-Account-Id')).toBe('acct-123');
  expect(call.headers.get('Originator')).toBe('codex-tui');
  expect(call.headers.get('User-Agent')).toBe(
    'codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)',
  );
  expect(call.traffic).toBe('control');
});

test('exposes api-unsupported and hidden ChatGPT models in priority order', async () => {
  globalThis.fetch = async () =>
    Response.json({
      models: [
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', priority: 43, supported_in_api: true, visibility: 'hide' },
        { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3-Codex-Spark', priority: 26, supported_in_api: false, visibility: 'list' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 12, supported_in_api: true, visibility: 'list' },
      ],
    });

  await expect(
    discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal),
  ).resolves.toEqual([
    { id: 'gpt-5.5', displayName: 'GPT-5.5', extra: { protocol: 'openai-response' } },
    { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3-Codex-Spark', extra: { protocol: 'openai-response' } },
    { id: 'codex-auto-review', displayName: 'Codex Auto Review', extra: { protocol: 'openai-response' } },
  ]);
});

test('refreshes an expired credential before querying the catalog', async () => {
  const headers: Headers[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Headers(new Request(input, init).headers));
    return Response.json({ models: [] });
  }) as typeof globalThis.fetch;
  const port: CredentialPort<ChatGPTCredential> = {
    read: async () => ({ revision: 7, value: credential({ accessToken: 'stale', expiresAt: Date.now() - 1 }) }),
    refresh: async (revision) => {
      expect(revision).toBe(7);
      return { status: 'updated', snapshot: { revision: 8, value: credential({ accessToken: 'fresh' }) } };
    },
  };

  await discoverOpenAIChatGPTModels(port, new AbortController().signal);

  expect(headers[0]?.get('authorization')).toBe('Bearer fresh');
});

test('ignores unknown upstream fields while keeping the lean projection', async () => {
  globalThis.fetch = async () =>
    Response.json({
      models: [
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          priority: 12,
          supported_in_api: true,
          visibility: 'list',
          model_messages: { instructions_template: 'x'.repeat(20000) },
          brand_new_field: true,
        },
      ],
    });

  await expect(
    discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal),
  ).resolves.toEqual([{ id: 'gpt-5.5', displayName: 'GPT-5.5', extra: { protocol: 'openai-response' } }]);
});

test('fails loudly when the models endpoint rejects the account', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 401 });

  await expect(
    discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal),
  ).rejects.toThrow('Codex model catalog request failed with 401');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
turbo run test:unit --filter=@aio-proxy/plugin-openai-chatgpt
```

Expected: FAIL. `CODEX_MODELS_ENDPOINT` is not exported from `./catalog`, and `discoverOpenAIChatGPTModels` still takes `(signal, fetch)`.

- [ ] **Step 4: Rewrite the catalog module**

Replace the entire contents of `packages/plugins/openai-chatgpt/src/catalog.ts` with:

```ts
import { type CredentialPort, type ModelDescriptor, type RuntimeFetch, zod } from '@aio-proxy/plugin-sdk';
import { CodexLeanModelSchema } from '@aio-proxy/types';
import { map, pipe, sortBy } from 'es-toolkit/fp';

import { CHATGPT_USER_AGENT, CODEX_CLIENT_VERSION } from './codex-client';
import { currentCredential } from './runtime/index';
import type { ChatGPTCredential } from './schema';

export const CODEX_MODELS_ENDPOINT = 'https://chatgpt.com/backend-api/codex/models';
export const CHATGPT_CATALOG_TTL_MS = 6 * 60 * 60_000;

const CodexModelsSchema = zod.object({
  models: zod.array(CodexLeanModelSchema),
});

/**
 * The account's own model list, not the published defaults. The static
 * `models-manager/models.json` on GitHub describes what some codex build ships
 * with and drifts from a real account in both directions, so it is not a usable
 * source: it advertises models the account cannot call and omits ones it can.
 *
 * `supported_in_api` is deliberately NOT filtered. Upstream short-circuits it
 * for ChatGPT auth (`filter_by_auth(models, chatgpt_mode)` keeps everything when
 * `chatgpt_mode`), so it describes API-key access, not ChatGPT access — filtering
 * on it hides models such as `gpt-5.3-codex-spark` that the account can use.
 *
 * `visibility: 'hide'` is also kept: it is a codex-TUI picker hint, not an
 * access control, and the host already lets users hide models via
 * `excludedModels`.
 */
export async function discoverOpenAIChatGPTModels(
  credentials: CredentialPort<ChatGPTCredential>,
  signal: AbortSignal,
  fetch: RuntimeFetch = globalThis.fetch,
): Promise<readonly ModelDescriptor[]> {
  const credential = await currentCredential(credentials, fetch);
  const url = new URL(CODEX_MODELS_ENDPOINT);
  // Required: the endpoint 400s without it, and gates each model on its
  // `minimal_client_version`.
  url.searchParams.set('client_version', CODEX_CLIENT_VERSION);
  const response = await fetch(url, {
    signal,
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
      Originator: 'codex-tui',
      'User-Agent': CHATGPT_USER_AGENT,
      'session-id': crypto.randomUUID(),
    },
    aioProxy: { traffic: 'control' },
  });
  if (!response.ok) throw new Error(`Codex model catalog request failed with ${response.status}`);
  const { models } = CodexModelsSchema.parse(await response.json());
  return pipe(
    models,
    sortBy([(model) => model.priority]),
    map(
      (model): ModelDescriptor => ({
        id: model.slug,
        displayName: model.display_name,
        extra: { protocol: 'openai-response' },
      }),
    ),
  );
}
```

- [ ] **Step 5: Pass credentials through the adapter's discover callback**

In `packages/plugins/openai-chatgpt/src/plugin.ts`, change the `catalog.discover` callback (currently at lines 128-135) so it destructures `credentials` and forwards it. Leave `image: []` exactly as it is — Task 2 owns that line.

Replace:

```ts
      discover: async ({ fetch, signal }) => ({
        language: await discoverOpenAIChatGPTModels(signal, fetch),
```

with:

```ts
      discover: async ({ credentials, fetch, signal }) => ({
        language: await discoverOpenAIChatGPTModels(credentials, signal, fetch),
```

- [ ] **Step 6: Rename the public constant**

In `packages/plugins/openai-chatgpt/src/index.ts`, replace line 4:

```ts
export { CHATGPT_CATALOG_TTL_MS, CODEX_MODELS_URL } from './catalog';
```

with:

```ts
export { CHATGPT_CATALOG_TTL_MS, CODEX_MODELS_ENDPOINT } from './catalog';
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
turbo run test:unit --filter=@aio-proxy/plugin-openai-chatgpt
```

Expected: PASS, all 5 catalog tests included. If `format:check` would complain, run `bun run format` now.

- [ ] **Step 8: Confirm nothing else referenced the old name**

```bash
grep -rn "CODEX_MODELS_URL" packages/plugins packages/server packages/core packages/cli packages/types --include="*.ts"
```

Expected: exactly two hits, both in `packages/server/src/server/list-models/codex-client-models/codex-cache.ts` (lines 5 and 43), where it is a *private* constant for the static GitHub file feeding the codex *client* model list. Different purpose — leave it untouched. Ignore any hits under `dist/` (stale build output). Any other `src/` hit is a miss from Step 6 — fix it before committing.

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/openai-chatgpt/src/codex-client.ts packages/plugins/openai-chatgpt/src/catalog.ts packages/plugins/openai-chatgpt/src/catalog.test.ts packages/plugins/openai-chatgpt/src/plugin.ts packages/plugins/openai-chatgpt/src/index.ts
git commit -m "fix(openai-chatgpt): discover models from the account's Codex endpoint"
```

---

### Task 2: Declare `gpt-image-2` in the image catalog

Puts `gpt-image-2` into `catalog.image` so `buildModelCapabilityIndex` grants it the `image` capability and `oauthExposedModels` publishes it in `/v1/models`. Routing still cannot reach ChatGPT after this task — Task 3 fixes the transport. That is deliberate: this task is independently reviewable as "the model is declared and exposed."

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/catalog.ts` (append the exported constant)
- Modify: `packages/plugins/openai-chatgpt/src/plugin.ts:130` (`image: []`)
- Test: `packages/plugins/openai-chatgpt/src/plugin.test.ts` (new file)

**Interfaces:**
- Consumes: `discoverOpenAIChatGPTModels(credentials, signal, fetch?)` from Task 1.
- Produces: `CHATGPT_IMAGE_MODELS: readonly ModelDescriptor[]` exported from `./catalog`, containing exactly one descriptor with `id: 'gpt-image-2'`.
- `ModelDescriptor` is `{ id: string; displayName?: string; extra?: JsonValue; modelMetadata?: DescriptorModelMetadata }`, where `DescriptorModelMetadata` is `Pick<ModelMetadataInput, 'name' | 'description' | 'limit' | 'capabilities' | 'cost'>`. `capabilities.modalities` is `{ input?: Modality[]; output?: Modality[] }` and `Modality` is `'text' | 'audio' | 'image' | 'video' | 'pdf'`.
- The image descriptor carries no `extra.protocol`. The host does deliver an image descriptor's `extra` to the plugin: for an inbound `OpenAIImage` protocol, `rawCapability.resolve` resolves the descriptor from `imageCatalogById` ahead of the language and embedding catalogs (`capabilities.ts:62-63`) and spreads `extra` into the `rawResolver({...})` input (`capabilities.ts:68`). This plugin's raw resolver destructures `{ protocol, capability }` (`runtime/runtime.ts:42`) and matches on the inbound protocol that `dispatchImageCandidate` passes as `ctx.adapter.protocol` (`image.ts:24`), so a `protocol` field on this descriptor would be delivered and dropped. It is omitted rather than carried as a decorative field.
- Membership in `catalog.image` is what grants the routable `image` capability: `buildModelCapabilityIndex` adds `'image'` unconditionally for every `catalog.image` id (`capability-index.ts:31,39`), so `modelMetadata` is NOT load-bearing for routing — delete it and `supportsImage` is still `true`. `metadataHasImageOutput` (line 41) is a redundant second path here, and `catalogOnlyImageOutput` cannot apply at all because `resolveCatalogModalities` skips OAuth providers by design (`resolve-catalog-modalities.ts:52-65`). Declare the modalities anyway because `modalities.input` reaches users as `/v1/models` `capabilities.image_input` (`model-capabilities.ts:59,69`) and the agent catalog's `input` field (`agent-catalog.ts:25`). Do not assert the modalities as if routing depended on them — that assertion would pass even if the feature regressed.
- `descriptor.setup` takes **two** arguments — `(api, options)` — so the test helper must call `descriptor.setup({ oauth: { register } }, undefined)`. The `adapterFrom` helper below mirrors `packages/plugins/github-copilot/src/plugin.test.ts:154-170`.
- `ModelModalitiesSchema` is `.loose()`, so `modelMetadata.capabilities.modalities` accepts `{ input, output }` with `Modality = 'text' | 'audio' | 'image' | 'video' | 'pdf'`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/openai-chatgpt/src/plugin.test.ts`:

```ts
import { expect, test } from 'bun:test';

import type { CredentialPort, OAuthAdapter, PluginDescriptor, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import openAIChatGPTPlugin from '.';
import type { ChatGPTCredential } from './schema';

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, ChatGPTCredential>> {
  let registered: OAuthAdapter<Record<string, never>, ChatGPTCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, never>, ChatGPTCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('OpenAI ChatGPT OAuth adapter was not registered');
  return registered;
}

function staticCredentialPort(): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: {
        accessToken: 'access-token',
        accountId: 'acct-123',
        expiresAt: Date.now() + 60_000,
        refreshToken: 'refresh-token',
      },
    }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

test('discovery exposes gpt-image-2 as an image model alongside the language catalog', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const catalog = await adapter.catalog.discover({
    credentials: staticCredentialPort(),
    options: {},
    signal: new AbortController().signal,
    fetch: (async () =>
      Response.json({
        models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 12, supported_in_api: true, visibility: 'list' },
        ],
      })) as unknown as RuntimeFetch,
  });

  expect(catalog.language.map(({ id }) => id)).toEqual(['gpt-5.5']);
  // Each assertion below protects a user-visible contract: live language discovery
  // must not clobber the hardcoded image catalog (membership is what grants the
  // routable `image` capability), and `modalities` must survive to the descriptor
  // because `input` reaches users as /v1/models `capabilities.image_input`.
  // Deliberately not a whole-object `toEqual`: that also pinned `displayName` and
  // the absence of `extra`, neither of which has a contract to protect.
  expect(catalog.image.map(({ id }) => id)).toEqual(['gpt-image-2']);
  expect(catalog.image[0]?.modelMetadata?.capabilities?.modalities).toEqual({
    input: ['text', 'image'],
    output: ['image'],
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
turbo run test:unit --filter=@aio-proxy/plugin-openai-chatgpt
```

Expected: FAIL — `expected [] to equal [ "gpt-image-2" ]`, because `plugin.ts` still returns `image: []`.

- [ ] **Step 3: Export the hardcoded image descriptor**

Append to the end of `packages/plugins/openai-chatgpt/src/catalog.ts`:

```ts
/**
 * Hardcoded, and permanently so. The Codex models endpoint describes language
 * models only — its `ModelInfo` carries `input_modalities` but no output
 * modality — so it structurally cannot report an image model, and `gpt-image-2`
 * appears in neither the endpoint nor the published `models.json`. codex itself
 * hardcodes the id (`IMAGE_MODEL`), as does every reference proxy. Meanwhile
 * `/backend-api/codex/images/generations` serves it for the same account.
 *
 * The upstream `model` field is decorative: every value tested returned the same
 * gpt-image 2.0 output. The id exists so users have something to route to.
 *
 * No `extra.protocol`. The host does hand this descriptor's `extra` to the raw
 * resolver — for an inbound `openai-image` it resolves the descriptor from the
 * image catalog first and spreads `extra` into the resolver input
 * (`plugin-runtime/capabilities.ts:62-63,68`). This plugin's resolver ignores
 * `extra` and matches on the inbound protocol, so a `protocol` here would reach
 * it and be dropped. Omitted rather than carried as a decorative field.
 */
export const CHATGPT_IMAGE_MODELS: readonly ModelDescriptor[] = [
  {
    id: 'gpt-image-2',
    displayName: 'GPT Image 2',
    modelMetadata: {
      capabilities: { modalities: { input: ['text', 'image'], output: ['image'] } },
    },
  },
];
```

- [ ] **Step 4: Wire it into the adapter catalog**

In `packages/plugins/openai-chatgpt/src/plugin.ts`, extend the import on line 10:

```ts
import { CHATGPT_CATALOG_TTL_MS, CHATGPT_IMAGE_MODELS, discoverOpenAIChatGPTModels } from './catalog';
```

and replace `image: [],` inside the `discover` callback with:

```ts
        image: CHATGPT_IMAGE_MODELS,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
turbo run test:unit --filter=@aio-proxy/plugin-openai-chatgpt
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/openai-chatgpt/src/catalog.ts packages/plugins/openai-chatgpt/src/plugin.ts packages/plugins/openai-chatgpt/src/plugin.test.ts
git commit -m "feat(openai-chatgpt): expose gpt-image-2 in the image catalog"
```

---

### Task 3: Route `openai-image` raw passthrough to the Codex image endpoints

Two changes that must land together: the raw resolver has to accept the `openai-image` protocol, and `codexEndpointFor` has to rewrite `/images/*` — accepting the protocol without the rewrite would send the request back to the proxy's own inbound URL, and rewriting without accepting the protocol would be dead code.

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts:16` (drop the local `CHATGPT_USER_AGENT`, import it), `:13-15` (endpoint constants), `:37-42` (raw resolver), `:153-159` (`codexEndpointFor`)
- Test: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts` (extend)

**Interfaces:**
- Consumes: `CHATGPT_USER_AGENT` from `../codex-client` (Task 1).
- Produces: nothing new for later tasks; this completes the transport.
- `RawResolver` signature (from `@aio-proxy/plugin-sdk`): `(input: { protocol: ProtocolId; modelId: string; extra?: JsonValue; capability?: 'language' | 'embedding'; requestPath?: string }) => RawTransport | undefined`, where `ProtocolId` includes `'openai-image'` and `RawTransport` is `{ invoke: (request: Request, context?: LogicalRequestContext, options?: RawTransportOptions) => Promise<Response> }`.
- Note `capability` is only ever `'language' | 'embedding'` — there is **no** `'image'` capability value. The image dispatch path (`dispatchImageCandidate`) calls `resolve({ protocol, modelId, requestPath })` with `capability` absent, so the existing `capability === 'embedding'` guard already lets image requests through and must not be widened.
- `shouldRewriteResponsesBody` matches only paths ending in `/responses`, so image bodies stream through untouched (no `store: false` injection). Do not change it.
- `createOpenAIStreamFetch('openai-response', ...)` is a passthrough for non-SSE responses: with `accept-encoding: identity` set and a JSON `content-type`, `normalizeControlledResponse` returns the response unmodified. The image JSON body is therefore forwarded verbatim.

- [ ] **Step 1: Write the failing tests**

In `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`, extend the existing raw-capability assertions. Inside the `describe('OpenAI ChatGPT runtime', ...)` block, in the test named `'returns a ProviderV4 with same-protocol raw capability only'`, add these two lines immediately after the existing `expect(runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5' })).toBeDefined();`:

```ts
    expect(runtime.raw?.({ protocol: 'openai-image', modelId: 'gpt-image-2' })).toBeDefined();
    expect(runtime.raw?.({ protocol: 'gemini-interactions', modelId: 'gpt-5.5' })).toBeUndefined();
```

Then append this new test at the end of the file, immediately before the `function credential(` helper:

```ts
test('routes image generations and edits to the Codex image endpoints', async () => {
  const calls: FetchCall[] = [];
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(staticCredentialPort(credential()), captureFetch(calls));
  const body = JSON.stringify({ model: 'gpt-image-2', prompt: 'a tiny red square' });

  await dynamicFetch('https://proxy.local/v1/images/generations?trace=1', { method: 'POST', body });
  await dynamicFetch('https://proxy.local/v1/images/edits', { method: 'POST', body });

  expect(requiredCall(calls, 0).url).toBe('https://chatgpt.com/backend-api/codex/images/generations?trace=1');
  expect(requiredCall(calls, 1).url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
  // Image bodies are forwarded verbatim: the `store: false` rewrite is
  // Responses-only, and the Codex image endpoints reject unknown parameters.
  expect(requiredCall(calls, 0).body).toBe(body);
  expect(requiredCall(calls, 0).headers.get('authorization')).toBe('Bearer access-token');
  expect(requiredCall(calls, 0).headers.get('ChatGPT-Account-Id')).toBe('acct-123');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
turbo run test:unit --filter=@aio-proxy/plugin-openai-chatgpt
```

Expected: FAIL twice — `runtime.raw?.({ protocol: 'openai-image', ... })` is `undefined`, and the rewritten URL is still `https://proxy.local/v1/images/generations?trace=1`.

- [ ] **Step 3: Add the image endpoint constants and share the User-Agent**

In `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`, add this import after the existing `import { isPlainObject } from 'es-toolkit/predicate';` line:

```ts
import { CHATGPT_USER_AGENT } from '../codex-client';
```

Then replace the constant block (lines 13-17) with:

```ts
const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex' as const;
const CHATGPT_CODEX_RESPONSES_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/responses` as const;
const CHATGPT_CODEX_COMPACT_ENDPOINT = `${CHATGPT_CODEX_RESPONSES_ENDPOINT}/compact` as const;
const CHATGPT_CODEX_IMAGE_GENERATIONS_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/images/generations` as const;
const CHATGPT_CODEX_IMAGE_EDITS_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/images/edits` as const;
const PLACEHOLDER_CREDENTIAL = 'dynamic-credential' as const;
```

The local `CHATGPT_USER_AGENT` declaration is gone — it now comes from `../codex-client` with an identical value, so the existing assertion on the exact User-Agent string still passes.

- [ ] **Step 4: Accept the `openai-image` protocol in the raw resolver**

In the same file, replace the `raw` property of the returned object (lines 37-42):

```ts
    raw: ({ protocol, capability }) =>
      capability === 'embedding'
        ? undefined
        : protocol === 'openai-response'
          ? { invoke: (request, _context, options) => dynamicFetch(request, undefined, options) }
          : undefined,
```

with:

```ts
    // `capability` is only ever 'language' | 'embedding'; image dispatch resolves
    // with it absent, so the embedding guard already excludes the one case that
    // must not passthrough.
    raw: ({ protocol, capability }) =>
      capability === 'embedding'
        ? undefined
        : protocol === 'openai-response' || protocol === 'openai-image'
          ? { invoke: (request, _context, options) => dynamicFetch(request, undefined, options) }
          : undefined,
```

- [ ] **Step 5: Rewrite image paths onto the Codex image endpoints**

In the same file, replace `codexEndpointFor` and its comment (lines 149-159):

```ts
// The Codex backend exposes both the streaming create endpoint and the
// stateless compaction endpoint, so an inbound `/responses/compact` must land on
// its own upstream path instead of collapsing onto create — otherwise the
// rewrite would leave the proxy's own inbound URL and the request would loop.
function codexEndpointFor(pathname: string): string | undefined {
  if (pathname.endsWith('/responses/compact')) return CHATGPT_CODEX_COMPACT_ENDPOINT;
  if (pathname.endsWith('/responses') || pathname.endsWith('/chat/completions')) {
    return CHATGPT_CODEX_RESPONSES_ENDPOINT;
  }
  return undefined;
}
```

with:

```ts
// Every inbound path this runtime accepts must map to an explicit upstream
// endpoint: an unmapped path leaves the proxy's own inbound URL in place and the
// request loops back into the proxy. `/responses/compact` therefore needs its own
// entry rather than collapsing onto create, and the image paths need theirs.
function codexEndpointFor(pathname: string): string | undefined {
  if (pathname.endsWith('/responses/compact')) return CHATGPT_CODEX_COMPACT_ENDPOINT;
  if (pathname.endsWith('/responses') || pathname.endsWith('/chat/completions')) {
    return CHATGPT_CODEX_RESPONSES_ENDPOINT;
  }
  if (pathname.endsWith('/images/generations')) return CHATGPT_CODEX_IMAGE_GENERATIONS_ENDPOINT;
  if (pathname.endsWith('/images/edits')) return CHATGPT_CODEX_IMAGE_EDITS_ENDPOINT;
  return undefined;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
turbo run test:unit --filter=@aio-proxy/plugin-openai-chatgpt
```

Expected: PASS.

- [ ] **Step 7: Run the full preflight**

```bash
bun run preflight
```

Expected: PASS. This is the first point at which the whole monorepo is exercised against the renamed export and the new discovery signature; fix anything it surfaces before committing.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/openai-chatgpt/src/runtime/runtime.ts packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts
git commit -m "feat(openai-chatgpt): pass /v1/images/* through to the Codex image endpoints"
```

---

### Task 4: Changeset

**Files:**
- Create: `.changeset/chatgpt-live-catalog-and-image.md`

**Interfaces:**
- Consumes: nothing. Produces the release note for Tasks 1-3.
- Bump level `minor`: this adds a model and changes which models are exposed. Both listed packages take the same level, per the Global Constraints.
- `@aio-proxy/plugin-openai-chatgpt` is where the change lives; `aio-proxy` is the product package that actually gets a published GitHub Release. Listing only the plugin would produce an empty CHANGELOG for `aio-proxy` and `scripts/release.ts` would skip its Release, losing the note.

- [ ] **Step 1: Write the changeset**

Create `.changeset/chatgpt-live-catalog-and-image.md`:

```markdown
---
'@aio-proxy/plugin-openai-chatgpt': minor
'aio-proxy': minor
---

ChatGPT OAuth providers now discover models from the signed-in account's own Codex endpoint instead of a published `models.json` snapshot, so the exposed list matches what the account can actually call. Models the account cannot use no longer appear, and `gpt-5.3-codex-spark` — previously hidden by a `supported_in_api` filter that does not apply to ChatGPT accounts — is now available.

`gpt-image-2` is also exposed, and `/v1/images/generations` and `/v1/images/edits` now pass through to the ChatGPT image endpoints. JSON image requests are supported; `multipart/form-data` requests to `/v1/images/edits` are not, because the ChatGPT backend rejects that content type.
```

- [ ] **Step 2: Verify the changeset parses**

```bash
bunx changeset status
```

Expected: the pending changeset is listed with `minor` bumps for `@aio-proxy/plugin-openai-chatgpt` and `aio-proxy` (plus the rest of the `fixed` group). Do NOT run `changeset version` or `changeset publish`.

- [ ] **Step 3: Check for stale pending notes**

```bash
grep -rln "supported_in_api\|models.json\|gpt-image" .changeset/
```

Expected: only `.changeset/chatgpt-live-catalog-and-image.md`. A pending note describes the shipped state — if another unreleased note announces behavior this change reverses, correct or delete it in this commit.

- [ ] **Step 4: Commit**

```bash
git add .changeset/chatgpt-live-catalog-and-image.md
git commit -m "chore: changeset for ChatGPT live catalog and gpt-image-2"
```

---

## Manual verification (optional, requires a real ChatGPT account)

Not part of the automated suite — the unit tests mock `fetch`. Run this once after Task 3 if you have a logged-in ChatGPT OAuth provider configured, to confirm the end-to-end path.

```bash
curl -s http://localhost:22078/v1/models | jq -r '.data[].id' | grep -E 'gpt-image-2|gpt-5.3-codex-spark'
```

Expected: both ids present. Then:

```bash
curl -s http://localhost:22078/v1/images/generations -H 'content-type: application/json' -d '{"model":"gpt-image-2","prompt":"a tiny red square","size":"1024x1024","n":1}' | jq '{created, size, quality, data: (.data | length)}'
```

Expected: a JSON object with `data: 1`. A response body of a few hundred KB is normal — the image comes back as `b64_json`.
