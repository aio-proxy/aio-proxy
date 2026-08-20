# Runtime Fetch Traffic Design

**Date:** 2026-07-31

**Status:** Approved for implementation planning

## Context

OAuth plugin runtimes currently receive two optional fetch functions:

- `context.fetch` for credential refresh and other control traffic;
- `context.modelFetch` for model traffic that must pass through host observation and provider request transforms.

The functions have the same JavaScript signature and differ only by convention. A plugin can therefore route model traffic through `context.fetch` without a type error. Google Antigravity currently does this, so its inference, raw, and token-count requests bypass provider request transforms.

The public API should retain the ergonomics of the standard Fetch API. Plugins should not have to learn, select, and fallback between two sibling fetch functions for ordinary model calls.

## Goals

- Expose one `context.fetch` function to runtime plugins.
- Keep `context.fetch` directly usable anywhere a standard fetch function is accepted.
- Route unannotated calls through the model request pipeline by default.
- Let the minority of control-plane calls opt out explicitly at the call site.
- Keep control traffic outside model request transforms and model-request observation, including when credential refresh happens inside a provider attempt.
- Give future response transforms the same model/control boundary without another plugin API change.
- Return the plugin descriptor API to a single version, `apiVersion: 1`.

## Non-goals

- Support descriptors authored as `apiVersion: 2`, or plugins built against the dual-fetch `RuntimeContext` contract. No third-party plugins depend on that rejected contract.
- Infer request purpose from URLs, headers, or provider attempt context.
- Apply provider transforms to OAuth refresh, account, catalog, quota, or auxiliary repair requests.
- Add additional traffic classes beyond `model` and `control`.

## Public API

The plugin SDK extends `RequestInit` with an aio-proxy namespace, following the same general shape as frameworks that add namespaced fetch options while preserving the standard call signature.

```ts
export type RuntimeFetchTraffic = 'model' | 'control';

export type RuntimeRequestInit = RequestInit & {
  readonly aioProxy?: {
    readonly traffic?: RuntimeFetchTraffic;
  };
};

export type RuntimeFetch = typeof globalThis.fetch & {
  (
    input: RequestInfo | URL,
    init?: RuntimeRequestInit,
  ): Promise<Response>;
};

export type RuntimeContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly catalog: ModelCatalog;
  readonly fetch: RuntimeFetch;
};
```

The exact callable type may be adjusted during implementation to preserve the repository's Bun and DOM fetch typings, but it must remain assignable to `typeof globalThis.fetch` and must accept `RuntimeRequestInit` at direct call sites.

### Semantics

```ts
await context.fetch(modelUrl, modelInit);
```

An omitted, `undefined`, or `null` `aioProxy.traffic` defaults to `model`. The call passes through provider request transforms, model-request observation, and future policies attached to model traffic.

```ts
await context.fetch(refreshUrl, {
  ...refreshInit,
  aioProxy: { traffic: 'control' },
});
```

An explicit `control` value bypasses the model pipeline and uses the host's control fetch directly.

Explicit `traffic: 'model'` is accepted and behaves like the default. Any runtime value other than `model`, `control`, `undefined`, or `null` throws a `TypeError` before a network request is issued.

The `aioProxy` member is host-only metadata. The runtime fetch wrapper copies the provided init, removes `aioProxy`, and forwards all standard and Bun-supported fetch fields without mutating the caller's object.

## Host Architecture

The host continues to build separate internal control and model fetch pipelines:

```ts
const controlFetch = globalThis.fetch;
const modelFetch = createProviderRequestTransformFetch(
  provider,
  createObservedFetch(controlFetch),
);

const runtimeFetch = createRuntimeFetch({
  control: controlFetch,
  model: modelFetch,
});
```

`createRuntimeFetch` is the only traffic classifier. It selects the model pipeline for missing or explicit `model` metadata, selects the control pipeline for `control`, strips the host metadata, and invokes the selected fetch.

`MaterializePluginProviderOptions` exposes only `runtimeFetch`. `runtimeModelFetch` and `RuntimeContext.modelFetch` are removed.

This design deliberately does not rely on async provider-attempt context to classify traffic. Credential refresh can happen while a provider attempt is active, so context inference would incorrectly classify nested control traffic as model traffic.

## Plugin Migration

Built-in plugins follow these rules:

- AI SDK providers, raw transports, inference calls, and token-count model calls receive `context.fetch` directly.
- Control requests issued through `RuntimeContext.fetch`, including credential refresh and auxiliary URL repair, add `aioProxy: { traffic: 'control' }` where they issue the request.
- Login, catalog, and quota callbacks do not receive `RuntimeContext.fetch`; they continue using their existing dedicated dependencies outside provider-attempt execution and require no traffic annotation.
- A control-plane library that only accepts a standard fetch callback receives a small adapter that adds the control annotation. This exception stays local to that integration; runtime entry points no longer maintain general `controlFetch` and `modelFetch` variables.
- Test dependency injection may still replace network fetches, but production routing must use `context.fetch`.

Google Antigravity specifically routes its shared inference/raw/token-count transport through the default model path. Credential refresh and grounding URL repair use explicit control traffic.

## Plugin API Version

The plugin descriptor contract is unified on version 1:

- `PLUGIN_API_VERSION` is `1`;
- the supported-version list contains only `1`;
- descriptor validation accepts only `apiVersion: 1`;
- built-in descriptors generated by `definePlugin` use version 1.

Compatibility with the previously published version-2 descriptor is intentionally out of scope because there are no external plugin consumers to preserve. Plugins built against that early contract must be rebuilt.

## Error Handling

- Invalid `aioProxy.traffic` values fail before dispatch with `TypeError`.
- Model pipeline errors retain their existing provider-transform and observation behavior.
- Control pipeline errors are returned or thrown directly by the control fetch.
- The wrapper never silently falls back from a requested control path to the model path or vice versa.
- The caller's `RequestInit` object is not mutated.

## Testing

### Plugin SDK type contract

- `RuntimeFetch` is assignable where `typeof globalThis.fetch` is required.
- Direct calls accept `aioProxy.traffic` values `model` and `control`.
- Type tests reject unsupported traffic values.
- `RuntimeContext.fetch` is required and `modelFetch` is absent.

### Runtime fetch classifier

- Missing traffic selects the model fetch.
- Explicit `model` selects the model fetch.
- Explicit `control` selects the control fetch, including inside a provider attempt.
- Invalid runtime traffic throws before either downstream fetch is called.
- The downstream fetch does not receive `aioProxy`.
- The wrapper preserves request fields and does not mutate the original init object.

### Server integration

- One captured `context.fetch` sends an unannotated request through request transforms and upstream request logging.
- The same fetch sends an explicitly annotated control request unchanged and excludes its body from model-request logs.
- Provider transform changes still invalidate the affected OAuth runtime cache identity.

### Built-in plugins

- Each OAuth plugin's final model request uses the default model path.
- Expired credential refresh uses the explicit control path.
- Google Antigravity inference and raw requests are transformed, while credential refresh and grounding repair are not.
- Plugin descriptor tests generate and accept only API version 1.

### Verification

Run focused SDK, server runtime, and built-in plugin tests first, then `bun run check` and the repository's full `bun run preflight` command.

## Rejected Alternatives

### Two sibling fetch fields

Keeping `fetch` and `modelFetch` makes the common model path require plugin-specific knowledge and permits silent misrouting because both fields have identical types.

### Callable fetch with a `.control` member

This keeps a single context field but introduces a nonstandard function-object API. Extending `RequestInit` is closer to established Fetch API extension patterns and keeps traffic intent at the request call site.

### `transforms: false`

This names the current implementation rather than the semantic boundary. Model/control classification also governs observation and future response transforms.

### Automatic context or URL inference

Provider attempt context misclassifies nested credential refresh, while URL matching is provider-specific and brittle. Explicit control annotation is deterministic.
