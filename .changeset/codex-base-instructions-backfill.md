---
'aio-proxy': patch
'@aio-proxy/server': patch
---

Fix empty Codex model picker for gpt-5.6 aliases. The `/v1/models` Case A passthrough now guarantees a non-empty `base_instructions`, backfilling from the upstream row's `model_messages.instructions_template` (then the bundled template). Codex client 0.146.0 treats `base_instructions` as required, so upstream rows that omit it (gpt-5.6-sol/terra/luna) previously failed catalog deserialization and emptied the picker.
