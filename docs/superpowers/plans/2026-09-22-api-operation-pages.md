# API Operation Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one stable Rspress page per selected public HTTP operation, rendered by a shared Scalar React reference.

**Architecture:** A pure route-descriptor module references existing Zod request schemas and documentation-only response schemas. A Bun generator validates, dereferences, and serializes one operation document per documented route. Pages load Scalar only in the browser. Generation does not change request or response runtime behavior.

**Tech Stack:** Rspress 2.0.19, React 19, Bun, Zod 4 `z.toJSONSchema`, `@scalar/api-reference-react`, `@scalar/openapi-parser`, committed generated MDX/JSON.

**Spec:** `docs/superpowers/specs/2026-09-22-api-operation-pages-design.md`

## Global Constraints

- Stay on the existing Rspress site; do not add a documentation framework, Rspress plugin, iframe, or Scalar fork.
- One HTTP method plus path is one Rspress page and one stable URL. Scalar `pathRouting` must not be the page identity.
- English URLs are `/api/<slug>`; Chinese URLs are `/zh/api/<slug>`.
- The build must not start aio-proxy, connect to a database, or require an API key. It may import route and schema modules.
- Do not author or commit an OpenAPI source file. Do not add a second schema framework.
- Do not add CORS, a proxy service, credential persistence, or a custom API client.
- Do not enable `llms` / SSG-MD.
- Generated pages and operation JSON are committed; check mode must be deterministic.
- First scope is only `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, and `POST /v1/messages`.
- Do not describe unsupported upstream fields as accepted. Preserve each schema's actual unknown-field behavior and distinguish parsed, converted, and raw-forwarded requests.
- Website dependencies stay in `website/package.json`, not the root catalog.

## File structure

- `packages/server/src/server/public-operations/index.ts`: export-only entry.
- `packages/server/src/server/public-operations/public-operations.ts`: pure documented, deferred, and unsupported route descriptors. It has no server or app dependency.
- `packages/server/src/server/public-operations/public-operations.test.ts`: classifies the inline models route and public factories without changing `createRoutes()`.
- `packages/server/src/server/list-models/public-model-list.ts`: response schema colocated with `listModels()`.
- `packages/core/src/egress/openai-completions/public-response.ts`: chat response schemas.
- `packages/core/src/egress/openai-responses/public-response.ts`: responses response schemas.
- `packages/core/src/egress/anthropic-messages/public-response.ts`: messages response schemas.
- `website/scripts/openapi-from-routes/`: conversion implementation, export entry, and colocated test.
- `website/scripts/generate-api-reference/`: page generation implementation, export entry, and colocated test.
- `website/scripts/operation-document/`: pure projection implementation, export entry, and colocated test.
- `website/i18n/en.json` and `website/i18n/zh.json`: page copy for the site's two locales.
- `website/src/components/api-operation/**`: shared browser-only Scalar frame.
- `website/docs/{en,zh}/api/**` and `website/src/generated/**`: generated output only.

## Review Focus

- A path-level parameter overridden by the operation must remain the operation parameter.
- Explicit `security: []` must remain empty after projection.
- A cyclic or unresolvable `$ref` must fail generation, not emit a partial page.
- A strict Zod object must remain closed, a catchall object must remain open, and a normal `z.object()` must not be rewritten as `additionalProperties: false`.
- Switching pages must not retain the previous operation.
- The default server must not be the documentation origin.

---

### Task 1: Spike the two real operations

**Files:**
- Create: `website/src/components/api-operation/index.ts`
- Create: `website/src/components/api-operation/api-operation.tsx`
- Create: `website/src/components/api-operation/scalar-frame.tsx`
- Create: `website/src/components/api-operation/api-operation.css`
- Create: `website/docs/en/api/list-models.mdx`
- Create: `website/docs/en/api/chat-completions.mdx`
- Create: `website/docs/en/api/_meta.json`
- Modify: `website/package.json`
- Modify: `website/docs/en/_nav.json`
- Test: manual browser and production build

**Interfaces:**
- Consumes: local fixture documents `listModelsDocument` and `chatCompletionsDocument`.
- Produces: `ApiOperation({ slug, locale }: { slug: 'list-models' | 'chat-completions'; locale: 'en' })`, used by both spike MDX files. The component selects the fixture by slug.

- [ ] **Step 1: Add the pinned website dependencies**

Run:

```bash
bun add --exact @scalar/api-reference-react --cwd website
bun add --exact -d @scalar/openapi-parser --cwd website
```

Expected: both packages resolve in `website/package.json` and `bun.lock`, with no root catalog entry. Also add `"zod": "catalog:"` to website devDependencies; the generator imports Zod directly and must not rely on another workspace package to expose it.

- [ ] **Step 2: Write two hand-made operation fixtures**

Create `website/src/components/api-operation/fixtures.ts` exporting two OpenAPI 3.1 documents. Each has one path and method. `chatCompletionsDocument` has `application/json` and `text/event-stream` 200 responses. Neither document contains `servers`.

- [ ] **Step 3: Render Scalar only after browser load**

```tsx
import { BrowserOnly, useDark } from '@rspress/core/runtime';

export function ApiOperation({ slug }: { slug: 'list-models' | 'chat-completions' }) {
  const dark = useDark();
  return (
    <BrowserOnly fallback={<p>Loading API reference…</p>}>
      {async () => {
        const [{ ApiReferenceReact }, { ScalarFrame }] = await Promise.all([
          import('@scalar/api-reference-react'),
          import('./scalar-frame'),
        ]);
        await import('@scalar/api-reference-react/style.css');
        return <ScalarFrame ApiReference={ApiReferenceReact} dark={dark} slug={slug} />;
      }}
    </BrowserOnly>
  );
}
```

`ScalarFrame` passes `content`, `layout: 'modern'`, `showSidebar: false`, `hideModels: true`, `hideSearch: true`, `hideDarkModeToggle: true`, `hideClientButton: true`, `documentDownloadType: 'none'`, `withDefaultFonts: false`, and `forceDarkModeState: dark ? 'dark' : 'light'`. Its React key is the slug. A local error boundary wraps this dynamic region.

- [ ] **Step 4: Add temporary pages and navigation**

Both MDX files directly import `{ ApiOperation }` from the component module, then use `pageType: doc-wide`, `outline: false`, an H1 with method and path, and `<ApiOperation>`. `_meta.json` lists `list-models` then `chat-completions`. `_nav.json` links to `/api/list-models`.

- [ ] **Step 5: Run and inspect the integration**

Run:

```bash
bun run --filter @aio-proxy/website dev
bun run --filter @aio-proxy/website build
```

Open `/api/list-models` and `/api/chat-completions` directly, refresh both, and use browser back/forward. Verify one sidebar, no Scalar sidebar, theme switching, no horizontal overflow at 375px and 1440px, and distinct content after navigation. Inspect `website/dist/api/list-models.html` and confirm the H1 and path are in the HTML while the Scalar fallback is present before hydration. Stop here if layout or operation switching fails; do not generate the full set against a broken frame.

- [ ] **Step 6: Commit**

```bash
git add website/package.json bun.lock website/src/components/api-operation website/docs/en/api website/docs/en/_nav.json
git commit -m "test(website): spike single-operation API pages"
```

### Task 2: Project one operation without losing semantics

**Files:**
- Create: `website/scripts/operation-document/index.ts`
- Create: `website/scripts/operation-document/operation-document.ts`
- Create: `website/scripts/operation-document/operation-document.test.ts`
- Test: `website/scripts/operation-document/operation-document.test.ts`

**Interfaces:**
- Consumes: a dereferenced OpenAPI document object.
- Produces:
  `projectOperation(document: OpenApiDocument, operationId: string): OpenApiDocument`.
  It throws `OperationProjectionError` for a missing ID, duplicate ID, or unresolved reference marker.

- [ ] **Step 1: Write the failing projection tests**

```ts
import { expect, test } from 'bun:test';
import { projectOperation } from './operation-document';

test('keeps one method and operation-level parameter override', () => {
  const projected = projectOperation(fixture(), 'createPet');
  expect(Object.keys(projected.paths['/pets'] ?? {})).toEqual(['post']);
  expect(projected.paths['/pets']?.post.parameters).toEqual([
    { name: 'limit', in: 'query', schema: { type: 'integer' } },
  ]);
});

test('preserves explicit empty security', () => {
  const projected = projectOperation(fixture(), 'publicStatus');
  expect(projected.paths['/status']?.get.security).toEqual([]);
});

test('rejects duplicate operation IDs', () => {
  expect(() => projectOperation(duplicateFixture(), 'dup')).toThrow('Duplicate operationId');
});
```

The fixtures must also include a shared component used by the selected operation, an unselected sibling method, and `oneOf` content.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `bun test website/scripts/operation-document/operation-document.test.ts`

Expected: FAIL because `projectOperation` is not defined.

- [ ] **Step 3: Implement the projection**

Find the unique operation by `operationId`. Copy path item parameters and inherited fields according to OpenAPI precedence, then emit a document with the original `openapi`, `info`, `components`, and root security keys but only the selected path/method. Do not include sibling methods. Preserve explicit empty security. Retain the complete `components` object.

- [ ] **Step 4: Run the tests**

Run: `bun test website/scripts/operation-document/operation-document.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add website/scripts/operation-document
git commit -m "test(website): project one OpenAPI operation"
```

### Task 3: Generate OpenAPI from the route schemas

**Files:**
- Create: `packages/server/src/server/public-operations/index.ts`
- Create: `packages/server/src/server/public-operations/public-operations.ts`
- Create: `packages/server/src/server/public-operations/public-operations.test.ts`
- Create: `website/scripts/openapi-from-routes/index.ts`
- Create: `website/scripts/openapi-from-routes/openapi-from-routes.ts`
- Create: `website/scripts/openapi-from-routes/openapi-from-routes.test.ts`
- Create: `website/i18n/en.json`
- Create: `website/i18n/zh.json`
- Modify: the ingress modules that own private wire constituents (`packages/core/src/ingress/openai-responses/` and `packages/core/src/ingress/anthropic-messages/`) to export only the constituents required by documentation projections.
- Create: `packages/server/src/server/list-models/public-model-list/index.ts`
- Create: `packages/server/src/server/list-models/public-model-list/public-model-list.ts`
- Create: `packages/core/src/egress/openai-completions/public-response/index.ts`
- Create: `packages/core/src/egress/openai-completions/public-response/public-response.ts`
- Create: `packages/core/src/egress/openai-responses/public-response/index.ts`
- Create: `packages/core/src/egress/openai-responses/public-response/public-response.ts`
- Create: `packages/core/src/egress/anthropic-messages/public-response/index.ts`
- Create: `packages/core/src/egress/anthropic-messages/public-response/public-response.ts`
- Modify: `packages/core/src/index.ts` and the relevant egress barrels to export the documentation schemas and required wire constituents.
- Test: `website/scripts/openapi-from-routes/openapi-from-routes.test.ts` and `packages/server/src/server/public-operations/public-operations.test.ts`

**Interfaces:**
- Consumes: exported Zod schemas and `projectOperation`.
- Produces: `loadPublicOpenApi(): Promise<OpenApiDocument>` and `operationSlugs(document: OpenApiDocument): readonly string[]`.

- [ ] **Step 1: Add failing contract tests**

Parse representative outputs from the existing response writers, including JSON, tool calls, absent usage, and one streaming event. Assert that an unknown chat-completions field survives `rewriteOpenAICompletionsRaw()` when model and effort are unchanged. Assert that a normal request object does not gain `additionalProperties: false`. Assert that the current catchall conversion remains open through `additionalProperties: {}`, not literal `true`. Export metadata through the schema instance the descriptor references. Include one Responses payload that the runtime rejects even though a naive converted item schema would accept it.

- [ ] **Step 2: Add documentation-only schemas**

Add the smallest response schemas that parse the tested outputs from `listModels()`, chat completions, responses, and messages. Do not call them from production constructors. Assign `.meta({ examples })` results to the exported schema constants. Event schemas describe one JSON payload. A tested formatter function adds SSE framing and the terminal frame deterministically.

- [ ] **Step 3: Export a pure classified operation set**

Create `publicOperations` without importing `createRoutes()` or `ServerState`. Classify every public-factory route and the inline `GET /v1/models` registration as `documented`, `deferred`, or `unsupported`, with exactly four `documented` entries. Convert requests as input and responses as output. Pass an `unrepresentable` callback that maps only JSON Schema `undefined` to `{ not: {} }`; a probe must show that this is required for `FunctionToolSchema`. For constraints hidden by `.transform()`, `.refine()`, `.superRefine()`, or `z.unknown()`, project the existing named wire constituents. If a constituent still hides a constraint, add one explicit JSON Schema annotation at that projected node. The test must show both runtime parsing and emitted JSON Schema reject a Responses input item and an Anthropic `tool_result` without `tool_use_id`. Then run document validation, dereference, cycle rejection, projection validation, and JSON serialization as separate checks. State on the models page that agent negotiation and `client_version` catalogs are excluded.

```ts
test('builds the four operations from implementation schemas', async () => {
  const document = await loadPublicOpenApi();
  expect(operationSlugs(document)).toEqual([
    'list-models',
    'chat-completions',
    'responses',
    'messages',
  ]);
  const chat = projectOperation(document, 'createChatCompletion');
  expect(chat.paths['/v1/chat/completions']?.post.responses['200'].content).toContainKeys([
    'application/json',
    'text/event-stream',
  ]);
  expect(chat.paths['/v1/chat/completions']?.post.requestBody.content['application/json'].schema.additionalProperties).not.toBe(false);
  expect(chat.paths['/v1/chat/completions']?.post.requestBody.content['application/json'].schema.properties.metadata.additionalProperties).toEqual({});
  expect(projectOperation(document, 'createMessage').paths['/v1/messages']?.post.responses['200'].content).toContainKey('text/event-stream');
});
```

- [ ] **Step 4: Run the tests and commit**

Run:

```bash
bun run build
bun test website/scripts/openapi-from-routes/openapi-from-routes.test.ts packages/server/src/server/public-operations/public-operations.test.ts packages/core/src/egress packages/server/src/server/list-models
```

Expected: PASS.

```bash
git add website/scripts website/i18n packages/server/src/server/public-operations packages/server/src/server/list-models packages/core/src/index.ts packages/core/src/ingress packages/core/src/egress
git commit -m "feat(api): generate the public contract from route schemas"
```

### Task 4: Generate, clean, and check pages

**Files:**
- Create: `website/scripts/generate-api-reference/index.ts`
- Create: `website/scripts/generate-api-reference/generate-api-reference.ts`
- Create: `website/scripts/generate-api-reference/generate-api-reference.test.ts`
- Modify: `website/package.json`
- Modify: `website/rspress.config.ts`
- Modify: `website/docs/en/_nav.json`
- Modify: `website/docs/zh/_nav.json`
- Test: `website/scripts/generate-api-reference/generate-api-reference.test.ts`

**Interfaces:**
- Consumes: `publicOperations`, `website/i18n/en.json`, `website/i18n/zh.json`, `loadPublicOpenApi`, and `projectOperation`.
- Produces: `generateApiReference({ check }: { check: boolean }): Promise<void>`.

- [ ] **Step 1: Test deterministic output and cleanup**

The test uses a temporary directory and fixture document. It asserts both locale MDX files, stable `_meta.json` order, separate English and Chinese operation JSON, and manifest entries. The Chinese JSON contains the Chinese summary. A second run changes nothing. Removing an operation deletes only its generated files. Check mode throws before opening any file for writing.

- [ ] **Step 2: Implement the generator**

Iterate `publicOperations` by `operationId`, resolve each locale string from `website/i18n/<locale>.json`, call `loadPublicOpenApi()`, and project the matching operation. Do not derive slug, navigation order, tag, or localized text from the OpenAPI document. Write:

- `website/docs/<locale>/api/<slug>.mdx`
- `website/docs/<locale>/api/_meta.json`
- `website/src/generated/operations/<locale>/<slug>.json`
- `website/src/generated/manifest.json`

Every generated MDX file begins with YAML frontmatter, including `pageType: doc-wide` and `outline: false`. The import follows the closing frontmatter delimiter: `import { ApiOperation } from '../../../src/components/api-operation';`. Its frontmatter uses the locale title and summary. The body contains H1, method, path, summary, the compact index, and `<ApiOperation slug="..." locale="..." />`. The generator test fails if that import is absent. `ApiOperation` loads the locale-specific JSON. JSON is serialized with stable key order and a trailing newline. `--check` compares bytes, changes nothing, and exits 1 on drift. There is no schema watcher; after schema changes, run `bun run build` and then `api:generate`.

Add a `test` script to `website/package.json` and run it from `.github/workflows/ci.yml`. Root `test:unit` continues to exclude the website package.

Add scripts, without `predev` or `prebuild`:

```json
{
  "api:generate": "bun scripts/generate-api-reference/generate-api-reference.ts",
  "api:check": "bun scripts/generate-api-reference/generate-api-reference.ts --check"
}
```

Rspress config does not gain a plugin. In `.github/workflows/ci.yml`, add `api:check` and `bun run --filter @aio-proxy/website test` after the existing `bun run build`, because schema imports require built workspace packages. In `.github/workflows/deploy-website.yml`, add `bun run build` before those two commands and the website build. A clean runner has no tracked `dist` outputs.

- [ ] **Step 3: Replace spike fixtures and verify**

Change `ApiOperation` to import `website/src/generated/operations/<locale>/<slug>.json` from its `locale` and `slug` props. Remove only `fixtures.ts`. Keep the generated `list-models.mdx` and `chat-completions.mdx`; they replace the spike content at the same paths. Wrap the dynamic Scalar region in a local error boundary and test a rejected dynamic import; the static H1 and index remain.

Run:

```bash
bun run --filter @aio-proxy/website api:generate
bun run --filter @aio-proxy/website api:check
bun test website/scripts
bun run --filter @aio-proxy/website build
```

Expected: check passes, tests pass, `website/dist/api/*.html` contains the four English pages, and `website/dist/zh/api/*.html` contains the four Chinese pages.

- [ ] **Step 4: Commit**

```bash
git add website/scripts website/docs website/src/generated website/src/components/api-operation website/package.json .github/workflows/ci.yml .github/workflows/deploy-website.yml
git commit -m "feat(website): generate one page per API operation"
```

### Task 5: Verify search, theme, navigation, and request safety

**Files:**
- Modify: `website/src/components/api-operation/scalar-frame.tsx`
- Modify: `website/src/components/api-operation/api-operation.css`
- Test: `website/src/components/api-operation/server-url.test.ts`

**Interfaces:**
- Consumes: generated operation documents.
- Produces: `selectedServer(input: string, pageOrigin: string): string`. The initial empty field uses `http://127.0.0.1:9317` before calling this function. A submitted empty, relative, documentation-origin, or non-HTTP value throws `InvalidDocumentationServerError`.

- [ ] **Step 1: Test the server guard**

```ts
expect(selectedServer('https://proxy.example', 'https://aioproxy.dev')).toBe('https://proxy.example');
expect(() => selectedServer('', 'https://aioproxy.dev')).toThrow('empty server');
expect(() => selectedServer('https://aioproxy.dev', 'https://aioproxy.dev')).toThrow('documentation origin');
```

- [ ] **Step 2: Wire the guard to Scalar**

Pass the returned absolute URL as the single runtime `servers` entry. Omit `proxyUrl`. Add the mixed-content and CORS limitation to both locale catalogs. For SSE operations, add one sentence: “Try It sends the request, but Scalar does not provide a separate streaming debugger; use the SSE example when the panel does not render events.” Run `bun run --filter @aio-proxy/website api:generate` immediately after those catalog edits and before `api:check`.

- [ ] **Step 3: Run the full verification**

Run:

```bash
bun run build
bun run check
bun test website/scripts packages/server/src/server/public-operations packages/core/src/egress packages/server/src/server/list-models
bun run --filter @aio-proxy/website test
bun run --filter @aio-proxy/website api:check
bun run --filter @aio-proxy/website build
rg -n "list-models|chat-completions" website/dist
```

In `bun run --filter @aio-proxy/website dev`, verify desktop and mobile layout, language switching, direct load, refresh, and back/forward for all four operations. Search for “chat completions” and “GET /v1/models”. Confirm a guide page does not request `@scalar/api-reference-react` resources. Trigger one Try It request only against an explicitly selected local server and confirm the request URL is not `aioproxy.dev`.

- [ ] **Step 4: Commit**

```bash
git add website/src/components/api-operation website/docs website/src/generated website/i18n
git commit -m "fix(website): keep API try-it requests on the selected server"
```

### Task 6: Add the release note

**Files:**
- Create: `.changeset/<generated-name>.md`

**Interfaces:**
- Consumes: the shipped public documentation behavior from Tasks 1–5.
- Produces: one pending changeset consumed by CI.

- [ ] **Step 1: Create the changeset with the repository command**

Run `bun changeset`. Target `@aio-proxy/server`, `@aio-proxy/core`, and `aio-proxy` at the same `minor` level. The body is one user-facing paragraph: the documentation site publishes one stable page per selected public operation, generated from the implementation schemas. Do not prefix the body with a package or area label.

- [ ] **Step 2: Commit**

```bash
git add .changeset
git commit -m "docs(api): note the public API reference pages"
```
