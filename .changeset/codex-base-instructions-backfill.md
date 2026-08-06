---
'aio-proxy': patch
'@aio-proxy/server': patch
---

Fix empty Codex model picker for gpt-5.6 aliases. The `/v1/models` Case A passthrough now guarantees the Codex client reads a non-empty prompt: it resolves one non-empty instruction text (existing `model_messages.instructions_template`, else `base_instructions`, else the bundled template) and writes it back to `base_instructions`, also replacing a present-but-empty `instructions_template` (which the client prefers verbatim). Codex client 0.146.0 treats `base_instructions` as required and prefers `instructions_template` whenever present, so upstream rows that omit `base_instructions` (gpt-5.6-sol/terra/luna) previously failed catalog deserialization and emptied the picker.
