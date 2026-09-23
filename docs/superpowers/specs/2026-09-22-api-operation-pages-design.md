# API operation pages

## Goal

Give each public HTTP operation its own Rspress page, with a stable URL, the site's existing navigation, and a Scalar reference for that operation only.

## Current facts

- The documentation site is the private workspace package `@aio-proxy/website` at `website/`. It uses `@rspress/core` `2.0.19`, React 19, Tailwind through `@rsbuild/plugin-tailwindcss`, and `rspress-plugin-mermaid`. Scripts are only `rspress dev` and `rspress build`.
- `website/rspress.config.ts` sets `root: 'docs'`, `outDir: 'dist'`, default language `en`, and locales `en` / `zh`. It does not set `base`, `search`, or `llms`. GitHub Pages serves the site at the `aioproxy.dev` apex, so the effective base is `/`. Rspress local search is on by default; SSG-MD / `llms` is off.
- Content is `website/docs/{en,zh}`. Navigation is `_nav.json` plus directory `_meta.json`. The custom theme re-exports Rspress components and already maps site colors and fonts onto `--rp-*` variables in `website/theme/index.css`. `DocContent` wraps every document in `.typeset`.
- There is no OpenAPI document and no generation pipeline. Public routes are registered in `packages/server/src/server/create-routes.ts` and `packages/server/src/routes/**`. Request bodies are Zod schemas inside protocol ingress modules, such as `packages/core/src/ingress/openai-completions.ts`. Zod 4 can emit JSON Schema, but these schemas describe only the fields the proxy branches on. They are not the public contract.
- `/v1/*` and `/v1beta/*` use model authentication (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, or `key` / `auth_token` query). The server sets no CORS headers. The default local API is `http://127.0.0.1:9317`.
- Streaming language routes return `text/event-stream; charset=utf-8` from `packages/server/src/routes/pipeline/stream.ts`. Same-protocol raw passthrough can also return the upstream stream.
- Root Turbo `dev`, `build`, `test`, and `e2e` exclude `@aio-proxy/website`. Root lint, format, and `lint:types` include it. Website tests are not in a package script; `website/theme/components/command-tabs/command-tabs.test.tsx` runs under root `bun test`.

## Decision

Keep Rspress. The public OpenAPI document is generated from code; no OpenAPI file is authored or committed.

Request bodies come from the Zod schemas the routes already parse. Zod 4 `z.toJSONSchema(schema, { io: 'input' })` converts them. Response documentation comes from separate schemas colocated with the response constructors. Those schemas are used by documentation generation and contract tests only. This change must not add `schema.parse()` to a request or response path, replace Hono or Zod, or alter route behavior.

Public operation metadata lives in `packages/server/src/server/public-operations/`. `index.ts` is export-only, and `public-operations.ts` holds the descriptors and schema references. The module imports neither `createRoutes()` nor `ServerState`, so the website build can load it without starting the server. Existing route factories continue to return their Hono apps, and `createRoutes()` keeps its current return contract.

The website generator imports the pure descriptors, converts their schemas, validates and dereferences the resulting document, and writes one MDX page per documented operation. Generated MDX, `_meta.json`, per-operation JSON, and the manifest are ignored build artifacts. Website dev/build generates them before Rspress starts; CI builds the website, reruns generation in check mode, and runs the website tests.

Dashboard, admin, OAuth, internal, and health routes remain outside the descriptor module. A test classifies every route owned by the public route factories, but missing documentation metadata is a test failure, not a claim of TypeScript exhaustiveness.

Do not migrate frameworks, use the community Rspress Scalar plugin, write an Rspress plugin, fork Scalar, import private Scalar components, use an iframe, or rewrite server routes.

## First public scope

The first document contains exactly these operations:

| Operation ID | Method and path | Why it is first |
| --- | --- | --- |
| `listModels` | `GET /v1/models` | JSON, no request body; the first integration spike |
| `createChatCompletion` | `POST /v1/chat/completions` | JSON or SSE; the streaming spike |
| `createResponse` | `POST /v1/responses` | Primary documented client protocol |
| `createMessage` | `POST /v1/messages` | Primary Anthropic-compatible ingress |

`POST /v1/chat/completions`, `POST /v1/responses`, and `POST /v1/messages` document both `application/json` and `text/event-stream` responses. Their descriptions state that SSE is emitted only when `stream` is true. The event schema describes one JSON event payload. The HTTP example is generated deterministically from validated events, including the protocol's `event:` and `data:` framing and its terminal frame. `data: [DONE]` remains framing, not a JSON event.

## Explicit non-goals

- Dashboard, admin, OAuth/device, agent-installation, health, and dashboard-artifact routes.
- Registered but unsupported routes that return 501, including response retrieval/cancel/delete/input-items and the unsupported realtime/video route tables.
- Gemini, embeddings, images, audio, video, realtime, legacy completions, token counting, response compaction, and SystemOne until their supported subset is deliberately specified.
- Claiming that OpenAI or Anthropic compatibility includes every upstream field. A field's documentation status follows the actual schema and forwarding behavior. A normal `z.object()` strips unknown fields from its parsed result but does not reject them. Same-protocol raw forwarding may retain those fields, as `rewriteOpenAICompletionsRaw()` does when it forwards the original body. Stripping, strict rejection, catchall preservation, and raw forwarding must not be collapsed into one `additionalProperties` claim.
- A separate API client, streaming debugger, credential store, request proxy, or backend CORS change.
- Enabling SSG-MD. It stays off until separately requested.

## Source and ownership

No source OpenAPI file exists. The OpenAPI document is built in memory by the website generator and is not written to `website/openapi/`.

The authoritative operation list is the pure `publicOperations` export. Each descriptor contains:

- method and path;
- stable `operationId` and ASCII `slug`;
- request schema export, when the route has a body;
- response schema exports and content types;
- tag, navigation order, and the i18n message IDs for title, summary, and description.

The first descriptors are defined beside:

- `GET /v1/models`: add `PublicModelListSchema` beside `listModels()` in `packages/server/src/server/list-models/list-models.ts`. Contract tests parse representative ordinary catalog values; `listModels()` itself does not call the schema. The v1 page documents only the unnegotiated catalog returned by `listModels()`. Agent negotiation and `client_version` catalogs are explicitly outside this operation and are stated as such on the page.
- `POST /v1/chat/completions`: request `OpenAICompletionsRequestSchema`; add `OpenAIChatCompletionSchema` and `OpenAIChatCompletionChunkSchema` beside the egress writer in `packages/core/src/egress/openai-completions/openai-completions.ts`.
- `POST /v1/responses`: request `OpenAIResponsesRequestSchema`; add the response schema beside `packages/core/src/egress/openai-responses/sse.ts` and its JSON writer.
- `POST /v1/messages`: request `AnthropicMessagesRequestSchema`; add the response schema beside the Anthropic egress writer.

Titles and prose live in a new website-local catalog, `website/i18n/en.json` and `website/i18n/zh.json`, keyed by operation ID. The website currently has no i18n catalog. Do not add these page-only strings to `packages/i18n/messages`, because that shared catalog requires parity for every repository locale and this site publishes only English and Chinese. Changing either string or navigation order does not change the URL; only the route descriptor's `slug` does.

The generator creates the OpenAPI document in memory:

1. Import `publicOperations` from `packages/server/src/server/public-operations/index.ts`.
2. Convert request schemas with `z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12', unrepresentable })` and response schemas with `io: 'output'`. The `unrepresentable` callback returns `{ not: {} }` only for a JSON Schema `undefined` type. Every other unrepresentable type still throws.
3. Attach path, method, parameters, content types, and shared security schemes. Examples come only from metadata on the schema instance actually referenced by the descriptor. `.meta()` returns a new schema, so the descriptor must reference that returned schema.
4. Emit `application/json` plus `text/event-stream` for every documented operation whose adapter has `wantsStream`, including messages.
5. Validate the complete document, dereference it, validate each projected operation, and then serialize it. All four checks fail the build independently.

A strict object remains closed. A `.catchall(z.unknown())` or `.loose()` object remains open. Current Zod represents that open object as `additionalProperties: {}`; the generator preserves that value and does not rewrite it to `true`. A normal `z.object()` is not rewritten to `additionalProperties: false`.

`z.toJSONSchema()` does not recover constraints hidden in `.transform()`, `.refine()`, `.superRefine()`, or `z.unknown()`. Where those constructs define the wire contract, the descriptor references a documentation projection built from the existing named wire-schema constituents. It does not author a second semantic schema. A hidden constraint that cannot be represented by composing those constituents gets one explicit JSON Schema annotation at the projected node, such as a required field or `not` constraint. Tests parse the rejected payload with the runtime schema and also evaluate the emitted JSON Schema; both must reject it. Responses input items and Anthropic `tool_result.tool_use_id` are required cases. The `{ not: {} }` callback and these explicit projected-node annotations are the only permitted conversion overrides.

## Examples

Examples belong to the schemas, not to a generated OpenAPI file or the documentation manifest.

- A request example is attached by assigning the result of Zod `.meta({ examples: [...] })` to the schema that the descriptor exports. `z.toJSONSchema()` copies `examples` from that instance.
- A response or SSE event example is attached the same way to the colocated response schema.
- Every example must parse successfully with the schema that carries it. The schema test feeds each example back through `schema.parse()`.
- Start with one minimal valid example per operation. Add a second request example with `stream: true` for chat completions, responses, and messages.
- The generator does not invent, transform, or select examples. A public operation with no example fails generation.
- Examples contain no real credentials, user content, provider addresses, or private model data.

For example, the chat request schema owns both its JSON example and the meaning of `stream`; the SSE schema owns the event example:

```ts
export const documentedOpenAICompletionsRequestSchema = OpenAICompletionsRequestSchema.meta({
  examples: [{ model: 'model-name', messages: [{ role: 'user', content: 'Hello' }], stream: true }],
});
```

The page reads those examples from the generated operation document. There is no separately authored request or response sample.

## Operation documents

`@scalar/openapi-parser` `validate()` checks the OpenAPI document, and its separate `dereference()` call resolves references. Neither check replaces the other. The generator also rejects a schema cycle even when the parser can represent it, and it rejects a projected document that cannot be serialized to JSON. Duplicate IDs, method/path pairs, slugs, missing metadata, and unresolved references fail the build.

For each operation it writes a document that:

- keeps `openapi`, `info`, `components`, and `security` definitions;
- has exactly one path and one method;
- copies path-level parameters onto that operation before removing sibling methods;
- retains explicit `security: []` rather than letting root security replace it;
- retains every public component. It does not prune the reference graph. The authored file has no internal-only components, so this cannot publish them.

Zod-to-JSON-Schema output may contain internal `$ref`. `@scalar/openapi-parser` resolves those references. External references and cyclic references are rejected. `oneOf`, `anyOf`, `allOf`, multiple content types, and examples remain inside the dereferenced operation. No second renderer interprets them.

The streaming response is a sibling content type, not a second operation:

```json
{
  "responses": {
    "200": {
      "content": {
        "application/json": {},
        "text/event-stream": {}
      }
    }
  }
}
```

## Pages, URLs, and navigation

Generated files, all disposable and regenerated together:

- `website/docs/en/api/<slug>.mdx`
- `website/docs/zh/api/<slug>.mdx`
- `website/docs/en/api/_meta.json`
- `website/docs/zh/api/_meta.json`
- `website/src/generated/operations/<locale>/<slug>.json`
- `website/src/generated/manifest.json`

The URL is `/api/<slug>` in English and `/zh/api/<slug>` in Chinese. The first slugs are `list-models`, `chat-completions`, `responses`, and `messages`.

Each MDX file imports `ApiOperation` directly:

```mdx
import { ApiOperation } from '../../../src/components/api-operation';
```

It has Rspress frontmatter (`title`, `description`, `outline: false`) and a visible H1 containing the method and path. It then renders `<ApiOperation slug="..." locale="..." />`. The component is not registered globally and is not resolved as a bare MDX tag. The static body also contains the locale summary and a short Markdown parameter/response index generated from the same operation document. That is the searchable text. The component does not repeat the H1, and the static index is a compact index rather than a second full reference.

`_nav.json` gains one API entry in each locale. `_meta.json` emits one ordinary `section-header` per tag, followed by that tag's flat file entries. Section order is the minimum `navOrder` of each tag, and file order is `navOrder`. Do not use `dir-section-header`: the pages remain flat under `api/`, and Rspress resolves a directory section by reading a child directory. Tag IDs and localized labels come from the website-local catalog. No separate navigation config exists.

The generator removes a previously generated page when its slug disappears. It deletes files listed in the previous manifest; if that ignored manifest is missing, it discovers generated MDX by its frontmatter marker and JSON in its reserved output directory. Hand-written API guides are safe.

## React and layout

`ApiReferenceReact` accepts only `configuration`. Its React package is documented as a client wrapper and is not supported for SSR/SSG. The shared component renders it through `BrowserOnly` from `@rspress/core/runtime`, with the loader inside the required async child:

```tsx
<BrowserOnly fallback={<p>{copy.loading}</p>}>
  {async () => {
    const [{ ApiReferenceReact }, { ApiOperationFrame }] = await Promise.all([
      import('@scalar/api-reference-react'),
      import('./api-operation-frame'),
    ]);
    await import('@scalar/api-reference-react/style.css');
    return <ApiOperationFrame ApiReference={ApiReferenceReact} />;
  }}
</BrowserOnly>
```

The CSS import stays inside that child, so guide pages do not load Scalar and SSG does not evaluate it.

Configuration for the embedded reference:

- `content`: the generated single-operation document object, not a URL;
- `layout: 'modern'`;
- `showSidebar: false`, `hideModels: true`, `hideSearch: true`, `hideDarkModeToggle: true`, `hideClientButton: true`, `documentDownloadType: 'none'`, `withDefaultFonts: false`;
- `forceDarkModeState`: read from Rspress `useDark()` so the embedded client follows the site toggle;
- `pathRouting` and `operationsSorter` are not used. Page identity is the Rspress route.
- The component keys its instance by `${locale}:${slug}` and reads the current pathname. Route changes do not reuse the previous operation.

A CSS layer scoped under `.api-operation` overrides Scalar colors with existing `--rp-*` variables and neutralizes heading/link rules inherited from `.typeset`. Tailwind preflight stays outside that scope. If the spike shows a layer conflict, the fix is a scoped reset, not a Tailwind build change.

The page uses `pageType: doc-wide` and `outline: false`: Rspress keeps the top navigation and API sidebar; Scalar fills the wide content area with its center reference and right-hand examples. The component has `min-width: 0` and a stacked mobile layout so neither sidebar nor example pane causes horizontal overflow.

A local React error boundary surrounds the Scalar region. A dynamic-import or render failure leaves the Rspress page and its static index intact and shows a plain error message. `BrowserOnly` fallback covers only the loading state; it is not the failure boundary.

## Try It

No proxy service and no persisted credential is added. `proxyUrl` is omitted. `servers` is a runtime value, defaulting to `http://127.0.0.1:9317`, with a text field for another absolute `http` or `https` origin. Relative URLs and the current documentation origin are rejected before rendering Scalar.

The page states that the browser calls the selected origin directly. Public `https://aioproxy.dev` cannot call an `http://` instance because the browser treats that as mixed content. A remote instance also needs its own CORS policy; aio-proxy does not add one. Localhost can work only when the browser permits that local origin. Scalar's native request panel is the only tester.

Streaming responses use the SSE content type and a literal event example. The spike must verify whether Scalar's Try It renders the stream. If it does not, the page keeps the example and says the panel cannot display the stream; no custom stream debugger is added.

## Search, HTML, and Markdown

- Static HTML comes from the MDX: H1, method, path, summary, and the compact parameter/response index are present without JavaScript. The Scalar region is the `BrowserOnly` fallback until hydration.
- Rspress local search indexes `doc` pages by default. The operation pages remain `doc` pages, so those same static strings are searchable. Detailed nested schema trees are not indexed in v1.
- SSG-MD stays disabled. Enabling it would require a site-wide SSR-compatible Markdown render and is not required for this feature. The generator does not emit `.md` API pages.

## Dependencies

- `@scalar/api-reference-react` in `website/package.json` dependencies: the required official React integration.
- `@scalar/openapi-parser` in `website/package.json` devDependencies: reference resolution and validation. Do not hand-write a dereferencer.

Zod 4 is already a workspace dependency. Use its built-in `z.toJSONSchema`; do not add `zod-to-openapi`, `@asteasolutions/zod-to-openapi`, or another schema framework.

Both new packages are website-only and do not enter the root catalog. Server packages gain no documentation dependency.

## Coverage boundary

Every route owned by a public route factory, plus the inline `GET /v1/models` registration in `create-routes.ts`, has one classification: `documented`, `deferred`, or `unsupported`. Only `documented` routes generate pages. The first documented set is the four operations above. Existing routes such as response compaction, response retrieval, and token counting must be explicitly `deferred` or `unsupported`; an unclassified route fails the coverage test. The models route is included even though it is not inside a factory. This test is executable coverage, not a TypeScript exhaustiveness proof.

Dashboard, admin, OAuth, and health routes are outside the public factories and are not scanned. `createRoutes()` continues to return only its Hono app. The website generator imports the pure descriptor module and fails if its documented IDs differ from that module.

Response schemas are documentation contracts. Tests parse representative JSON, tool-call, absent-usage, and streaming outputs from the existing writers. They do not wrap those writers in runtime parsing.

## Development and CI

Do not rely on `predev` or `prebuild` hooks. Website `dev` and `build` explicitly run `api:generate` before Rspress starts. `api:generate` and `api:check` first run the root `dev:prepare` task, because schema imports resolve `@aio-proxy/core` through its built `dist` and may need built workspace dependencies. There is no schema watcher: restart website dev after changing a descriptor, schema, or example, or run `api:generate` manually to update its generated inputs.

Generated files are not committed. `.github/workflows/ci.yml` and `.github/workflows/deploy-website.yml` build the core dependency graph, build the website (which generates the files), then run `api:check` and website tests. Check mode verifies idempotence after generation; it no longer compares against tracked output. The deploy workflow also triggers on core and server changes, so a source-only API contract change republishes the site. The handwritten `overview.md` files remain tracked.

`website/package.json` declares `zod` as `"zod": "catalog:"` because the generator imports it directly. Zod is not added to production website dependencies.

## Risks to settle in the spike

- Scalar modern layout, with its sidebar hidden, must still produce a readable center column and example column inside `doc-wide`.
- `z.toJSONSchema()` must preserve normal object stripping, strict objects, passthrough objects, discriminated unions, descriptions, and examples on the schema instances the descriptors reference. A schema it cannot represent fails the build.
- Metadata attached to a schema copy must not be lost before descriptor export. Cyclic references must fail before page serialization.
- Tailwind and `.typeset` must not override Scalar typography or code blocks.
- Scalar Try It may show an SSE response as plain text. That result is accepted and documented; it is not a reason to build another client.
- Pinned versions are selected during the spike and then locked in `bun.lock`.
