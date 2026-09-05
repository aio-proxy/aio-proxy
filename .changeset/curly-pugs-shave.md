---
'@aio-proxy/server': patch
'aio-proxy': patch
---

Hide non-text models from the Codex model picker

The Codex client catalog (`/v1/models?client_version=...`) listed every routable model, including image and video generators such as `gpt-image-2` and the `grok-imagine-*` family. Codex calls whatever it lists as a text chat model, so those rows were unselectable in practice.

The catalog now only lists models whose resolved `capabilities.modalities.output` includes `text`. Models whose output modality no metadata layer declares are hidden too — declare it under `router.models.<slug>.metadata.capabilities.modalities.output` (or `metadata.extend`) to bring one back.
