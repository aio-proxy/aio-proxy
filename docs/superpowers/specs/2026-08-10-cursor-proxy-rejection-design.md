# Cursor Proxy Rejection and Generation Warnings Design

## Goal

Prevent Cursor from silently bypassing an effective HTTP(S) provider proxy until bidirectional proxy transport is implemented, and report every standard generation setting that Cursor currently ignores.

## Scope

- This is the temporary option C selected for PR #119.
- Direct Cursor connections remain unchanged when no effective proxy is configured.
- Cursor becomes explicitly unavailable when a global or provider-level proxy applies.
- `proxy: false` continues to disable an inherited global proxy and therefore keeps Cursor available.
- No HTTP CONNECT tunnel, raw socket API, or host HTTP/2 capability is added in this change.
- Real proxy support remains a later replacement for this rejection path.

## Proxy Capability Contract

Add optional `supportsProxy?: boolean` metadata to `OAuthAdapter`. Existing adapters keep current behavior when the field is absent. Cursor declares `supportsProxy: false`.

The plugin registry validates that the field is either absent or boolean and preserves it on the bound adapter. The server and account-login orchestration own enforcement; Cursor must not receive proxy URLs or credentials merely to reject them.

## Effective Proxy Resolution

The login preflight resolves the same effective provider proxy semantics used by runtime materialization:

1. A provider-level URL wins over the top-level proxy.
2. An omitted provider proxy inherits the top-level proxy.
3. `proxy: false` disables inheritance.
4. A mutation value of `null` clears the provider override and resumes inheritance.

Preflight records only whether an effective proxy exists. It does not expose the URL to the adapter.

Before OAuth authorization or catalog discovery starts, account login rejects an adapter with `supportsProxy: false` when an effective proxy exists. This prevents login, refresh, or catalog control traffic from silently going direct.

Runtime materialization performs the same check using its already-resolved `effectiveProxy` input before creating a catalog job or calling `createRuntime`. This covers existing providers, config reloads, and a proxy added after login.

## Error and Diagnostic Behavior

Add the stable diagnostic/error code `PROXY_UNSUPPORTED`.

- CLI login presents a localized message that the selected capability does not support the configured proxy.
- Dashboard OAuth sessions return `PROXY_UNSUPPORTED` before authorization starts.
- Existing configured providers materialize as `unavailable` with a non-retryable `PROXY_UNSUPPORTED` diagnostic.
- Logs and diagnostics contain provider/plugin identifiers only; no proxy URL or credentials are emitted.

The error is configuration-dependent and non-retryable until the proxy is disabled or real proxy support is implemented.

## Cursor Generation Warnings

Cursor continues to support prompt content, tools, supported `toolChoice` values, provider options, and abort signals as today. It emits `SharedV4Warning` entries for supplied standard generation controls that are not mapped to the Cursor protobuf request:

- `maxOutputTokens`
- `temperature`
- `stopSequences`
- `topP`
- `topK`
- `presencePenalty`
- `frequencyPenalty`
- `seed`
- JSON `responseFormat`
- non-default `reasoning`

The existing `toolChoice: required` warning remains. Text response format and `reasoning: provider-default` do not warn because they preserve the current default behavior. This change reports ignored settings; it does not emulate or translate them.

## Tests

Behavior-level regressions will cover:

1. Registry validation and preservation of `supportsProxy: false`.
2. Login rejection before authorization/catalog for global and provider proxies.
3. `proxy: false` allowing Cursor under a global proxy.
4. Runtime materialization returning non-retryable `PROXY_UNSUPPORTED` without calling catalog discovery or runtime creation.
5. Cursor declaring proxy unsupported.
6. Streaming and generated calls returning the exact unsupported-setting warnings while still completing normally.

Each production behavior follows RED then GREEN. After focused tests, run Cursor unit/build, affected core/server/CLI tests, repository check, and the complete unit suite.

## Release Note

Update the PR's existing user-facing changeset note to state that Cursor refuses configured proxies instead of bypassing them and reports ignored generation controls. No separate changeset is added because this PR already carries the lockstep minor release for `aio-proxy`, `@aio-proxy/plugin-sdk`, core/server, CLI, and Cursor.

## Deferred Work

Real proxy support will replace `supportsProxy: false` with a proxy-aware bidirectional HTTP CONNECT + TLS ALPN `h2` transport once the implementation is selected and validated. The temporary rejection must be removed in the same future change.
