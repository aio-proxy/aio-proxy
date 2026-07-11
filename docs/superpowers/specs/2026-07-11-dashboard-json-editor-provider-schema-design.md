# Dashboard JSON Editor and Provider Options Schema Design

## Goal

Improve the dashboard provider form by:

1. making `CodeEditor` focus and invalid states visually match the shared `Input` control;
2. adding a reusable Monaco-based `JsonEditor` that accepts JSON Schema;
3. replacing the AI SDK provider `options` textarea with the JSON editor; and
4. generating provider option schemas at build time from an explicit npm package allowlist.

Schema support is progressive enhancement. A package without an embedded schema remains configurable with valid object-shaped JSON.

## Non-goals

- Changing the provider configuration format.
- Replacing Zod as the application's validation and schema source.
- Supporting functions or other non-JSON values in provider options.
- Parsing npm declaration files inside the standalone aio-proxy binary.
- Generating schemas for arbitrary runtime-installed packages.
- Adding registry selection, npm version ranges, or user-configurable trust patterns to the dashboard.

## Confirmed Decisions

- `JsonEditor` supports every JSON root value. The provider options adapter separately requires a plain object.
- Empty editor content represents `undefined`; JSON `null` remains distinct.
- Unknown object properties remain allowed in generated schemas.
- Loaded schema errors for required fields, types, and enums block provider submission. Warnings do not.
- A package without an embedded schema falls back to JSON syntax plus provider root-object validation.
- Changing `packageName` preserves the current options text, clears the previous schema immediately, and revalidates when a new schema arrives.
- Optional non-JSON or unresolved fields are omitted with warnings. A required non-JSON or unresolved field makes that package's generated schema unavailable.
- npm declaration JSDoc is included in JSON Schema descriptions for Monaco hover help.
- Zod remains the only business and API validation system.
- Babel TypeScript AST and TypeBox `Script` are build-only tools inside a new schema package. Neither enters the runtime dependency graph.
- The schema generation allowlist is the explicit package/factory catalog in `packages/provider-schemas/src/allowlist.ts`; entries do not carry versions.
- The initial runtime trust allowlist contains only the Bun glob `@ai-sdk/**`.
- Trusted missing packages install automatically after the package field loses focus or the user presses Enter. Input changes alone never install packages.
- Other missing packages require explicit installation confirmation.

## Provider Schemas Package

Create a new workspace package named `@aio-proxy/provider-schemas`.

The package owns three separate concerns:

1. an explicit schema generation allowlist containing `{ packageName, factoryName }` entries;
2. build-only declaration parsing and JSON Schema generation; and
3. a runtime export containing only the generated schema records.

The allowlist is intentionally versionless. Allowlisted providers are not dependencies or development dependencies of `@aio-proxy/provider-schemas`; adding a catalog entry does not install that provider into the workspace.

For a one-shot build, the generator resolves each package's public npm `dist-tags.latest`, verifies the tarball integrity, and caches only the package manifest and declaration files. Watch builds reuse the newest valid immutable registry observation already in the local cache and contact npm only when no usable observation exists. Because `latest` can move, schema output is intentionally not reproducible across builds made at different times; the emitted entry records the resolved package version.

### Rslib generation plugin

The package's Rslib configuration registers a custom build-only `api.transform` plugin. `onBeforeBuild.isWatch` selects only whether npm latest is refreshed; schema generation remains exclusively in the transform. The transform targets the physical `src/schema-module.ts` placeholder and:

1. resolves each allowlisted package to its cached npm-latest declaration source;
2. resolves the declaration entrypoint from `exports.types`, `types`, or `typings`;
3. parses declarations with `@babel/parser` and its TypeScript plugin;
4. locates the configured factory export and first public call signature;
5. follows relative imports and re-exports within the package;
6. collects referenced `type` and `interface` declarations plus JSDoc;
7. converts the self-contained type module with TypeBox `Script`;
8. normalizes the resulting JSON Schema and warnings; and
9. returns the generated TypeScript module to Rspack for emission into `dist`.

Generated schema data is not committed and no explicit generation command exists. `src/schema-module.ts` contains only an empty typed record needed as transform input; package consumers resolve the built `dist` entrypoints. The transform registers cached provider manifests and declaration files as dependencies so watch mode regenerates from the real inputs without importing registry/cache code into runtime output.

Babel stays behind a narrow declaration-parser module that returns package-owned declaration metadata. Babel AST types do not cross that boundary, allowing a future public Bun AST API to replace Babel without changing schema normalization or runtime consumers.

### Generation limits

All resolved files must remain inside the allowlisted package directory. Traversal stops after 64 declaration files, relative import depth is limited to 16, total declaration input is limited to 4 MiB, and cycles terminate through a visited-file set.

Supported factory declaration shapes are exported function declarations and exported variables with callable function type annotations. Overloads use the first public call signature, and relative import aliases are preserved in the self-contained generated type module. Unsupported declaration shapes produce a deterministic unavailable entry with a build warning rather than guessed schema.

### TypeBox normalization

Use TypeBox 1.x `Script` only in the build generator. Do not use TypeBox validators, `Static`, compiler APIs, or schema builders elsewhere.

Normalization:

- selects the factory parameter root schema;
- removes `undefined` from an optional parameter;
- sets `additionalProperties: true` on generated object schemas;
- detects unresolved `$ref` and non-JSON nodes;
- removes optional unsupported properties and returns their paths as warnings;
- rejects a package schema when an unsupported property is required; and
- attaches Babel-extracted JSDoc as `description` values.

The runtime export contains ordinary serializable JSON Schema data and warning paths only. It has no Babel, TypeBox, provider package, or filesystem dependency.

## Runtime Package Trust and Installation

Runtime trust is independent from schema generation coverage.

Define the trusted package pattern in server-side code:

```ts
const TRUSTED_PROVIDER_PACKAGE_GLOBS = [new Bun.Glob("@ai-sdk/**")];
```

Trust is computed only by the server with `Glob.match(packageName)`. The dashboard cannot assert trust.

On package-field blur or Enter:

- bundled package: no installation action;
- installed package: no installation action;
- missing trusted package: automatically call the existing npm installation primitive;
- missing untrusted package: show **Install Provider Package** and require an `AlertDialog` confirmation.

Installation status does not control schema availability. A schema may already be embedded for an allowlisted package, while a runtime-installed package outside the schema allowlist may have no schema.

Package-status `version` describes the runtime package: bundled providers use the explicit versions compiled into core, and cached providers use their installed manifest version. Options-schema `packageVersion` separately records the npm-latest declaration version used to generate that embedded schema.

## Dashboard API

Add `GET /dashboard/api/providers/package-status?npm=<packageName>`. It is side-effect-free and returns:

- whether the package is trusted;
- whether it is bundled, installed, or missing;
- the installed or bundled version when available; and
- whether an embedded options schema exists.

An invalid package name returns HTTP 400 with the stable `invalid_package_name` code.

Add `GET /dashboard/api/providers/options-schema?npm=<packageName>`. It performs a pure lookup in `@aio-proxy/provider-schemas` and returns either:

```ts
{ npm, factoryName, schema, warnings }
```

or HTTP 404 with `schema_unavailable`.

Keep `POST /dashboard/api/providers/install` as the only installation command and implementation of download, locking, registry handling, and package-name validation. Extend its server-side policy so missing trusted packages may be installed by the dashboard workflow without an additional user confirmation, while untrusted packages still require `confirmed: true`.

Schema requests contain only the package name. Provider option values and secrets never participate.

## CodeEditor

Style the `CodeEditor` wrapper as the shared control boundary:

- transparent border and `bg-input/50` at rest;
- the same rounded shape as `Input`;
- the same color, background, and box-shadow transition;
- `:focus-within` border and ring matching `Input`'s `focus-visible` state; and
- matching destructive border/ring behavior when `aria-invalid` is true.

Monaco's internal background remains transparent so the wrapper owns the appearance.

## JsonEditor

Create a reusable dashboard component above `CodeEditor` with no provider, TanStack Form, Zod, or schema-package dependency.

Its public behavior is:

- accepts a JSON value or `undefined`;
- accepts an optional ordinary JSON Schema;
- emits parsed value changes only for valid JSON or empty content;
- emits syntax and schema errors and warnings; and
- retains its raw text draft while the user temporarily types invalid JSON.

The component synchronously parses changes so syntax failure invalidates the form immediately. Monaco's `onValidate` supplies schema markers. Syntax or schema errors make the editor invalid; warnings do not.

Each editor receives a stable unique Monaco model URI. Monaco JSON diagnostics configuration is global, so a module-level registry tracks every mounted editor's schema URI and model URI. Registration, updates, and unmounting rebuild the combined diagnostics configuration so multiple editors cannot overwrite each other.

`JsonEditor` respects the supplied schema without changing unknown-property behavior. Schema normalization belongs to the build generator.

## Provider Form Integration

Replace `ProviderOptionsTextarea` with a provider-specific adapter around `JsonEditor`.

The adapter:

- binds to the TanStack Form `options` field;
- serializes initial options with two-space indentation;
- requires a non-array object when content is present;
- exposes validity to the page's Save button;
- renders `FieldError` for syntax, root-value, and loaded-schema errors;
- renders schema unavailable and warning states using i18n copy; and
- never sends current options to package endpoints.

The package-name field performs local shape checks while typing. Blur and Enter commit the package name to the package-status workflow. A package-name change clears the active schema and invalidates older requests immediately while retaining the editor draft.

When an embedded schema exists, the dashboard fetches it without executing the provider package. When no embedded schema exists, the editor remains in schema-less JSON mode.

Trusted missing packages install automatically after commit. Untrusted missing packages display the explicit install action and confirmation dialog. Stale status, install, or schema responses for an older package name are ignored.

## Failure Behavior

| Failure | Dashboard behavior | Save behavior |
| --- | --- | --- |
| Invalid JSON | Show syntax error | Blocked |
| JSON root is not an object | Show provider options error | Blocked |
| Loaded schema error | Show Monaco marker and field error | Blocked |
| Loaded schema warning | Show marker/status warning | Allowed |
| Package has no embedded schema | Show schema unavailable helper | Allowed for valid object JSON |
| Package installation fails | Show install error; preserve editor | Allowed for valid object JSON |
| Optional unsupported field at schema build | Omit field and embed warning path | Allowed |
| Required unsupported field at schema build | Embed unavailable package entry | Allowed for valid object JSON |

## Security

- Package names use the existing strict npm-name validation.
- Schema lookup is pure data access and never imports provider code.
- Automatic installation applies only to the server-owned `@ai-sdk/**` trust pattern and only on blur or Enter.
- Untrusted installation requires explicit confirmation.
- Build-time declaration traversal is path-contained, bounded, and cycle-safe.
- Babel, TypeBox, and provider declaration files are absent from the runtime dependency graph.
- Schema and status requests never contain provider options or secrets.

## Testing

### Provider schemas package

- Resolve `exports.types`, `types`, and `typings` while rejecting path escapes.
- Parse relative imports/re-exports and terminate cycles.
- Convert nested objects, arrays, records, literal unions, required fields, and optional fields.
- Preserve declaration and property JSDoc as schema descriptions.
- Allow unknown properties on generated objects.
- Drop optional unresolved/non-JSON fields with warning paths.
- Reject schemas containing required unresolved/non-JSON fields.
- Enforce traversal limits.
- Generate every current allowlist entry from npm latest, verify deterministic rendering for fixed resolved inputs, and inspect the built `dist` module without committing a generated artifact.
- Assert `@ai-sdk/openai-compatible` requires `name` and `baseURL`.
- Build the package and inspect its runtime bundle to ensure it does not import Babel, TypeBox, or provider packages.

### Server

- Return trusted/bundled/installed/missing status without installing or importing packages.
- Report embedded schema availability independently from installation state.
- Return embedded schema records and `schema_unavailable` for unknown packages.
- Automatically install a matching missing `@ai-sdk/**` fixture after the committed trigger request.
- Reject unconfirmed untrusted installation.
- Preserve existing install error behavior.

### Dashboard

- Unit-test JSON parsing, empty-versus-null behavior, and provider root-object validation as pure functions.
- Test Monaco schema registry registration, replacement, and unmount behavior.
- Test package workflow stale-response guards, trusted automatic install, untrusted confirmation, and schema-less fallback.
- Test provider form wiring using the repository's existing source/component test style.
- Build the dashboard successfully.

### Browser QA

- CodeEditor focus and invalid rings visually match Input.
- JSON completion, required/type/enum diagnostics, and JSDoc hover work.
- Schema errors disable Save; warnings do not.
- Packages without embedded schemas fall back to valid object JSON.
- Trusted packages install only after blur or Enter.
- Untrusted packages do not install before confirmation.
- Switching package names preserves options and removes the previous schema immediately.

## Verification

Run provider-schemas, core, server, dashboard, and i18n tests; build provider-schemas and dashboard; run the repository check; and perform the browser QA flow against the real dashboard server. Do not claim completion unless all automated and interaction checks pass.
