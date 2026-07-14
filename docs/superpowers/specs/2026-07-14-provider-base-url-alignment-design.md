# Provider Base URL Alignment Design

## Context

API providers currently expose their upstream endpoint as `baseUrl`, while AI SDK provider options use `baseURL`. The mismatch adds a casing conversion at the API-to-AI-SDK bridge and makes the two provider configuration interfaces unnecessarily different.

The project has not been released, so the API provider field can be renamed without carrying a compatibility alias. At the same time, direct `@ai-sdk/openai-compatible` providers currently fail at runtime when `options.name` is omitted, even though the dashboard provider schema allows that omission. API providers bridged to the same package already use the Provider ID as the name.

## Goals

- Use `baseURL` as the single API provider field name from configuration input through runtime dispatch.
- Reject the old `baseUrl` field instead of maintaining a compatibility branch.
- Default an OpenAI-compatible AI SDK provider's missing `options.name` to its Provider ID.
- Keep explicit `options.name` values working.
- Preserve the semantics of unrelated OAuth payloads and AI SDK provider packages.

## Non-goals

- Renaming `baseUrl` fields in GitHub Copilot OAuth payloads or other internal transport data.
- Changing URL normalization, path rewriting, credential handling, provider selection, or fallback behavior.
- Supporting both `baseUrl` and `baseURL` in API provider configuration.
- Adding a general option-defaulting framework for arbitrary AI SDK packages.

## Interface decisions

### API provider base URL

`ProviderKind.Api` uses `baseURL` everywhere in its public and runtime interface:

- user configuration;
- `ApiProviderSchema` and `ApiProviderMutationBodySchema`;
- generated configuration JSON Schema;
- parsed `ApiProvider` and runtime `ApiProviderInstance` types;
- dashboard create/edit forms and mutation bodies;
- dashboard configuration persistence;
- raw HTTP passthrough;
- API-to-AI-SDK bridge;
- provider probes and test fixtures.

The removed `baseUrl` key is not transformed or aliased. Inputs that only contain `baseUrl` fail validation at the `baseURL` field. Dashboard and server responses emit only `baseURL`.

This keeps one deep interface for API provider endpoint configuration instead of introducing a shallow mapping seam between persisted configuration and runtime providers.

### OpenAI-compatible provider name

When materializing a direct AI SDK provider whose package is `@ai-sdk/openai-compatible`, runtime load options are resolved as follows:

1. Start with `name: provider.id`.
2. Overlay `provider.options`.
3. Pass the resulting options to the existing AI SDK provider loader.

An explicit `provider.options.name` therefore overrides the default. Other AI SDK packages receive their options unchanged.

The default belongs in provider materialization, where both the Provider ID and package name are available. The generic package loader remains independent of aio-proxy configuration identity.

## Data flow

### Raw API passthrough

1. Configuration parsing requires `baseURL` for an API provider.
2. Runtime materialization preserves `baseURL` on the API provider instance.
3. Raw dispatch constructs the upstream URL from `provider.baseURL` and the inbound request path/query.

### Cross-protocol API dispatch

1. The API provider bridge reads `provider.baseURL`.
2. The bridge passes it directly as the AI SDK package option `baseURL`.
3. For the OpenAI-compatible adapter, the bridge continues to use the Provider ID as `name`.

### Direct AI SDK dispatch

1. Runtime materialization inspects the configured package name.
2. For `@ai-sdk/openai-compatible`, a missing `options.name` is defaulted to the Provider ID.
3. The existing loader validates `name` and `baseURL`, then constructs the upstream provider.

## Error handling and migration

- API provider configuration containing only `baseUrl` fails schema validation because `baseURL` is missing.
- No deprecation warning or dual-field conflict rule is added.
- The repository's local development configuration is migrated from `baseUrl` to `baseURL` without modifying credential values. This ignored local file is not part of the committed product interface.
- Missing `baseURL` for `@ai-sdk/openai-compatible` remains an error; only `name` gains a default.

## Testing

### Types and generated schema

- Parse an API provider with `baseURL` successfully.
- Reject an API provider that supplies only `baseUrl`.
- Report missing endpoint errors at `providers.<id>.baseURL` and mutation-body `baseURL`.
- Verify the generated configuration schema requires `baseURL` and contains no `baseUrl` API provider property.

### Core providers

- Exercise raw passthrough with `baseURL` and preserve existing URL rewrite behavior.
- Verify the API bridge passes `baseURL` without a casing conversion and keeps `name: provider.id` for OpenAI-compatible providers.
- Verify a direct OpenAI-compatible provider defaults a missing `options.name` to the Provider ID.
- Verify an explicit `options.name` wins over the default.
- Verify non-OpenAI-compatible packages receive no injected `name`.

### Server and dashboard

- Update provider routing, probing, reload, and capability fixtures to use `baseURL`.
- Verify dashboard create and update mutations accept and persist `baseURL`.
- Verify malformed mutation bodies missing `baseURL` return the expected validation error.
- Verify edit data and on-disk configuration expose only `baseURL`.

### Local regression

- Retry the original OpenAI-compatible request after the development server reloads.
- Confirm the failure `@ai-sdk/openai-compatible requires name and baseURL` no longer occurs.
- Confirm the request reaches the configured upstream; any later upstream response is evaluated separately from this configuration regression.

## Rejected alternatives

### Accept both field spellings temporarily

This would require precedence and conflict rules, complicate generated schemas and dashboard persistence, and leave migration code to remove after release. There is no released compatibility contract that justifies the extra interface.

### Rename only the persisted field

Mapping persisted `baseURL` back to runtime `baseUrl` would preserve inconsistent terminology inside the codebase and retain the exact conversion this change is intended to remove.

### Require users to configure `options.name`

The Provider ID is already a stable, unique routing identity and the API bridge already uses it for the same AI SDK package. Requiring a second identity field would enlarge the interface without adding necessary behavior.
