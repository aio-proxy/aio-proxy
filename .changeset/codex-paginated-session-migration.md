---
'@aio-proxy/cli': patch
'aio-proxy': patch
---

Fix Codex history migration so existing JSONL threads keep working after `aiop agent configure codex`. Desktop sessions stored as paginated history, including those still labeled `newapi`, are rewritten to the managed provider instead of being skipped.
