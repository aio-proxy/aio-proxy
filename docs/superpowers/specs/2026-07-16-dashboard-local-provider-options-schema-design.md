# Dashboard Local Provider Options Schema Design

## Goal

Resolve AI SDK provider options JSON Schemas in the dashboard from `@aio-proxy/provider-schemas` directly. Remove `GET /dashboard/api/providers/options-schema`. Packages without a catalog schema must not restrict options content beyond “valid JSON object”.

## Problem

Today the dashboard fetches options schemas through the server, which only wraps the published `@aio-proxy/provider-schemas` lookup. That adds a network round-trip and a failure mode (`schema_error`) for static data.

Separately, when no schema is available, `JsonEditor` still runs Monaco schema validation. Stale diagnostics from a previous package can mark the editor invalid and block save, even though product copy for `schema_unavailable` says valid object JSON may still be saved.

## Dependency boundary

- `packages/dashboard` declares an exact dependency on `@aio-proxy/provider-schemas@0.1.1` (same pin as `packages/server`).
- Dashboard imports only the main entry: `providerOptionsSchema`, `hasProviderOptionsSchema`, and related types. Do not use `@aio-proxy/provider-schemas/zod`.
- After removing the options-schema route and `schemaAvailable`, drop `@aio-proxy/provider-schemas` from `packages/server` if no other server import remains. Do not keep the dependency only to re-export or proxy schemas.

## Schema resolution

For a committed `packageName`:

1. If `hasProviderOptionsSchema(npm)` is false, or `providerOptionsSchema(npm)` has no usable `schema`, resolve to `schema_unavailable` with `schema = undefined`.
2. Otherwise resolve to `ready` with that entry’s `schema` and `warnings`.

Schema lookup is synchronous and local. Remove dashboard phases and paths that exist only for the HTTP schema fetch: `loading_schema`, `schema_error`, and the options-schema query/refetch.

`package-status` and `install` remain server-mediated (bundled / installed / missing, trust, confirm-install).

## package-status payload

Remove `schemaAvailable` from the package-status response. Schema presence is determined only by `@aio-proxy/provider-schemas` in the dashboard so the two sources cannot disagree.

## JsonEditor: no schema means no schema constraints

When `schema === undefined`:

- Do not call `registerJsonSchema`.
- Do not call `validateJsonModel`.
- Complete validation immediately with `pending: false` and empty markers.

Validity without a schema is only:

- draft parses as JSON (or empty → `undefined`);
- root value is `undefined` or a plain object.

When switching from a package with a schema to one without:

- unregister the previous Monaco schema registration;
- clear markers so prior schema diagnostics cannot block save.

When a schema is present, behavior stays schema-gated (Monaco registration + worker validation + required-root checks).

## Validity and install workflow

- `schema_unavailable`: allow save when options are a valid object JSON (or empty/`undefined` when nothing is required).
- `ready`: keep schema validation as today.
- Install phases (`install_required`, `install_deferred`, `installing`, `install_error`, etc.) stay about package presence/trust. Missing schema must not invent field restrictions. Existing rules about whether the overall form can submit while install is incomplete are unchanged unless a later change explicitly revisits them.

## API and code removals

Delete:

- Route `GET /dashboard/api/providers/options-schema`
- `providerPackageOptionsSchema` and its response type
- `schemaAvailable` on package-status
- Dashboard `providerOptionsSchemaQueryOptions` and schema HTTP error handling tied to that route
- Server/dashboard tests that assert the options-schema endpoint

Update package-status tests and the provider-options schema workflow tests for local resolution and no-schema editor behavior.

## Verification

- Catalog package (e.g. `@ai-sdk/openai-compatible`): options editor still validates against the published schema.
- Non-catalog package: any syntactically valid object JSON is accepted; no schema error markers; save is not blocked for schema mismatch.
- Switch catalog → non-catalog: no leftover Monaco schema diagnostics.
- `GET /dashboard/api/providers/options-schema` is gone; package-status no longer returns `schemaAvailable`.
- Dashboard and server unit tests for the touched paths pass.

## Constraints

- Do not reintroduce a server proxy for static provider option schemas.
- Do not pull the Zod subpath into the dashboard bundle for this feature.
- Do not commit or push unless explicitly requested.
