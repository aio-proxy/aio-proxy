# @aio-proxy/plugin-sdk

Public contracts for extending aio-proxy with provider and OAuth plugins.

## Runtime compatibility

Plugin runtime hooks execute inside the aio-proxy Bun host. Bun `>=1.4.0` is the v1 runtime compatibility
target. Plugin authors may use Node-based tooling for development and type checking, but execution under Node
or undici is not part of the v1 compatibility promise.

## Catalog model metadata

`ModelDescriptor.modelMetadata` reports typed model information that the host can merge into its upstream
metadata layer. Its `DescriptorModelMetadata` type is a subset of the published `@aio-proxy/types`
`ModelMetadataInput`: `name`, `description`, `limit`, `capabilities`, and `cost`. `extend` remains a user-config
feature and is not available to plugins. Unknown keys are stripped; an invalid `modelMetadata` value is dropped
fail-soft so the rest of the descriptor and catalog remain usable.

```ts
import type { ModelCatalog } from '@aio-proxy/plugin-sdk';

const catalog: ModelCatalog = {
  language: [
    {
      id: 'upstream-model-id',
      displayName: 'Upstream Model',
      modelMetadata: {
        limit: { context: 200_000, output: 32_000 },
        capabilities: { reasoning: true, toolCall: true },
        cost: { input: 1, output: 4 },
      },
      extra: { wireFamily: 'example-v2' },
    },
  ],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
  extra: { catalogRevision: 2 },
};
```

`extra` is opaque, plugin-private JSON data. It replaces the former free-form `metadata` field on
`ModelDescriptor` and `ModelCatalog`, and the raw resolver input now provides `extra` instead of `metadata`.
Use `modelMetadata` only for host-consumed model metadata and `extra` for wire hints or other plugin state.
