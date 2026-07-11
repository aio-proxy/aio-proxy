# Dashboard JSON Editor and Provider Options Schema Design

## Goal

Improve the dashboard provider form by:

1. making `CodeEditor` focus and invalid states visually match the shared `Input` control;
2. adding a reusable Monaco-based `JsonEditor` that accepts JSON Schema;
3. replacing the AI SDK provider `options` textarea with the JSON editor; and
4. deriving the options schema from the selected npm provider factory's first parameter type.

The schema feature is progressive enhancement. A package that has no usable schema must still be configurable with valid object-shaped JSON.

## Non-goals

- Changing the provider configuration format.
- Replacing Zod as the application's validation and schema source.
- Supporting JavaScript functions or other non-JSON values in provider options.
- Adding registry selection or npm version ranges to the dashboard form.
- Guaranteeing semantic conversion of every possible TypeScript declaration. Unsupported declarations degrade cleanly.

## Confirmed Decisions

- `JsonEditor` supports every JSON root value. The provider options adapter separately requires a plain object.
- Empty editor content represents `undefined`; JSON `null` remains distinct.
- Unknown object properties remain allowed in generated schemas.
- Schema errors for required fields, types, and enums block provider submission once a schema has loaded. Warnings do not block submission.
- If schema extraction fails, submission falls back to JSON syntax plus provider root-object validation.
- Changing `packageName` preserves the current options text, clears the previous schema immediately, and revalidates when a new schema arrives.
- Runtime loading and schema extraction select the same provider factory.
- Optional non-JSON or unresolved fields are omitted with warnings. A required non-JSON or unresolved field makes the schema unavailable.
- npm declaration JSDoc is included in JSON Schema descriptions for Monaco hover help.
- Zod remains the only business and API validation system. TypeBox is used only as an external TypeScript-syntax-to-JSON-Schema adapter.
- The initial trusted package allowlist contains only the Bun glob `@ai-sdk/**`.
- Trusted packages install, dynamically import, and load their schema automatically after the package field loses focus or the user presses Enter.
- Other packages require explicit confirmation before installation or dynamic execution.

## Architecture

### Package metadata and factory selection

Extend the npm package metadata resolver in `@aio-proxy/core` to return:

- package name and installed version;
- JavaScript entrypoint;
- TypeScript declaration entrypoint resolved from `exports.types`, `types`, or `typings`; and
- cache directory.

All resolved paths must remain inside the installed package directory.

The resolver supports both package locations used by aio-proxy: bundled dependencies resolved from the compiled application and third-party dependencies installed under the aio-proxy package cache.

Refactor provider factory selection into a shared helper. Bundled providers declare their factory export name explicitly. A cached third-party module keeps the current behavior of selecting the first callable export whose name starts with `create`. Runtime invocation and schema extraction both call this helper so editor guidance cannot target a different factory from the one that will run.

### Trust policy

Define the trusted package patterns in server-side code:

```ts
const TRUSTED_PROVIDER_PACKAGE_GLOBS = [new Bun.Glob("@ai-sdk/**")];
```

Trust is computed only by the server with `Glob.match(packageName)`. The dashboard cannot assert that a package is trusted. The list is a constant for this iteration; adding configuration UI or user-defined patterns is out of scope.

For trusted packages, package-field blur or Enter triggers installation when missing, dynamic import, and schema extraction without a confirmation dialog. Input changes alone never install packages.

For untrusted packages, the dashboard first performs a side-effect-free status request. It shows either **Load Schema** for an installed package or **Install and Load Schema** for a missing package. Both actions use an `AlertDialog` that explains that third-party code will execute in the aio-proxy server process.

### Declaration extraction

Use `@babel/parser` with the TypeScript plugin to parse declaration files. Babel is used only for syntax AST, source spans, imports/exports, and attached comments; it does not provide TypeScript type checking.

Keep Babel behind a narrow declaration-parser module that returns project-owned declaration metadata. No Babel AST type crosses that boundary, allowing a future public Bun AST API to replace Babel without changing schema conversion, server routes, or dashboard code.

The declaration extractor:

1. locates the selected exported factory declaration;
2. obtains its first parameter type and optionality;
3. follows relative import and re-export declarations within the installed package;
4. collects referenced local `type` and `interface` declarations;
5. records declaration and property JSDoc by symbol and field path; and
6. emits a self-contained TypeScript type module for TypeBox.

Supported factory declaration shapes are exported function declarations and exported variables with callable function type annotations. Overloads use the first public call signature, matching the first callable factory contract exposed by the declaration. Other shapes return an unsupported-declaration result.

Bare-package semantic resolution, compiler-only conditional evaluation, and unsupported declaration constructs return a controlled unavailable result rather than guessed schema.

The extractor must enforce bounded work: paths stay inside the package directory, visited files are deduplicated, traversal stops after 64 declaration files, relative import depth is limited to 16, total declaration input is limited to 4 MiB, and cycles terminate through the visited-file set.

### TypeBox conversion

Use `typebox` 1.x `Script` only in the npm schema extraction module. Do not use TypeBox validators, schema builders, `Static`, or compiler APIs elsewhere.

The TypeBox result is immediately normalized to the project's JSON Schema transport type:

- select the factory parameter root schema;
- remove `undefined` from an optional parameter;
- set `additionalProperties: true` on generated object schemas;
- detect unresolved `$ref` and non-JSON schema nodes;
- drop optional unsupported properties and return their paths as warnings;
- reject the schema if an unsupported property is required; and
- attach Babel-extracted JSDoc as `description` values.

The normalized result contains no TypeBox-specific runtime types.

### Cache

Cache successful and unavailable extraction results in memory by:

```text
packageName + installedVersion + factoryExportName
```

The cache is not written to provider configuration or disk. Installing a different version naturally produces a new key.

## Dashboard API

Add `GET /dashboard/api/providers/package-status?npm=<packageName>`. It is side-effect-free and returns:

- whether it is trusted;
- whether it is bundled, installed, or missing; and
- the installed version when available.

An invalid package name returns HTTP 400 with the stable `invalid_package_name` code.

Add `POST /dashboard/api/providers/options-schema` with JSON body `{ npm: string, confirmed?: true }`. Its behavior is server-enforced:

- trusted package: install if missing, import, and extract;
- untrusted installed package: require `confirmed: true`, then import and extract;
- untrusted missing package: require `confirmed: true`, install, import, and extract.

A successful response is `{ npm, version, factoryName, schema, warnings }`. Controlled failures use stable error codes for invalid names, confirmation required, install failure, import failure, missing factory, missing declarations, unsupported declarations, and extraction limits. Internal stacks and package option values are never returned.

The existing npm installation primitive remains the single implementation of download, locking, registry handling, and package-name validation.

## CodeEditor

Style the `CodeEditor` wrapper as the shared control boundary:

- transparent border and `bg-input/50` at rest;
- the same rounded shape as `Input`;
- the same color, background, and box-shadow transition;
- `:focus-within` border and ring matching `Input`'s `focus-visible` state; and
- matching destructive border/ring behavior when `aria-invalid` is true.

Monaco's internal background remains transparent so the wrapper owns the control appearance.

## JsonEditor

Create a reusable dashboard component above `CodeEditor` with no provider, TanStack Form, or Zod dependency.

Its public behavior is:

- accepts a JSON value or `undefined`;
- accepts an optional ordinary JSON Schema;
- emits parsed value changes only for valid JSON or empty content;
- emits validation state containing syntax and schema errors and warnings; and
- retains its raw text draft while the user temporarily types invalid JSON.

The component synchronously parses content changes so syntax failure invalidates the form immediately. Monaco's `onValidate` supplies asynchronous JSON Schema markers. Syntax or schema errors make the editor invalid; warnings do not.

Each editor receives a stable, unique Monaco model URI. Monaco JSON diagnostics configuration is global, so a module-level registry tracks every mounted editor's schema URI and model URI. Registration, schema updates, and unmounting rebuild the combined diagnostics configuration so multiple editors cannot overwrite each other.

`JsonEditor` respects the supplied schema without changing unknown-property behavior. Schema normalization belongs to the npm extractor.

## Provider Form Integration

Replace `ProviderOptionsTextarea` with a provider-specific adapter around `JsonEditor`.

The adapter:

- binds to the TanStack Form `options` field;
- serializes the initial options with two-space indentation;
- requires a non-array object when content is present;
- exposes validity to the page's save button;
- renders `FieldError` for syntax, root-value, and loaded-schema errors;
- renders schema loading, unavailable, and warning states using i18n copy; and
- never sends current options to package status or schema endpoints.

The package-name field performs only local name-shape checks while typing. Blur and Enter start the server workflow. A package-name change clears the active schema and invalidates any older request token immediately, but leaves the editor draft untouched.

Trusted packages proceed automatically. Untrusted packages display the appropriate explicit action and confirmation dialog. A stale response for an older package name is ignored.

## Failure Behavior

Schema support must never make a previously valid JSON provider impossible to configure merely because metadata is unavailable.

| Failure | Dashboard behavior | Save behavior |
| --- | --- | --- |
| Invalid JSON | Show syntax error | Blocked |
| JSON root is not an object | Show provider options error | Blocked |
| Loaded schema error | Show Monaco marker and field error | Blocked |
| Loaded schema warning | Show marker/status warning | Allowed |
| Install/import/declaration/extraction failure | Show schema unavailable status | Allowed for valid object JSON |
| Optional unsupported field | Omit field and list warning path | Allowed |
| Required unsupported field | Mark schema unavailable | Allowed for valid object JSON |

## Security

- Package names use the existing strict npm-name validation.
- All declaration and entrypoint paths remain under the installed package directory.
- Status requests never install or import packages.
- Automatic side effects apply only to the server-owned `@ai-sdk/**` allowlist and only on blur or Enter.
- Untrusted installation and execution require explicit confirmation.
- Declaration traversal is bounded by file count/depth/bytes and protects against cycles.
- Schema requests contain only package names; provider option values and secrets never participate.

## Testing

### Core

- Resolve `exports.types`, `types`, and `typings` while rejecting path escapes.
- Prove runtime loading and schema extraction choose the same factory.
- Parse relative imports/re-exports and terminate cycles.
- Convert nested objects, arrays, records, literal unions, required fields, and optional fields.
- Preserve declaration and property JSDoc as schema descriptions.
- Allow unknown properties on generated objects.
- Drop optional unresolved/non-JSON fields with warning paths.
- Reject schemas containing required unresolved/non-JSON fields.
- Enforce traversal limits and version-aware cache keys.
- Smoke-test every bundled provider declaration, including required `name` and `baseURL` for `@ai-sdk/openai-compatible`.

### Server

- Return trusted/bundled/installed/missing package status without executing module code.
- Automatically install and execute a matching `@ai-sdk/**` fixture after the committed trigger.
- Reject unconfirmed untrusted install or execution.
- Install and load an untrusted fixture after confirmation.
- Return stable controlled errors for install, import, factory, declaration, and extraction failures.
- Use a top-level side-effect sentinel to prove status requests do not import packages.

### Dashboard

- Unit-test JSON parsing, empty-versus-null behavior, and provider root-object validation as pure functions.
- Test Monaco schema registry registration, replacement, and unmount behavior.
- Test provider form wiring and stale-response guards using the repository's existing source/component test style.
- Build the dashboard successfully.

### Browser QA

- CodeEditor focus and invalid rings visually match Input.
- JSON completion, type/required/enum diagnostics, and JSDoc hover work.
- Schema errors disable Save; warnings do not.
- Schema unavailable falls back to valid object JSON.
- Trusted packages act only after blur or Enter.
- Untrusted packages do not execute before explicit confirmation.
- Switching package names preserves options and removes the previous schema immediately.

## Verification

Run the relevant core, server, and dashboard unit tests, the dashboard build, and the repository check command. Perform the browser QA flow against the real dashboard server. Do not claim completion unless all automated verification and the required interaction checks pass.
