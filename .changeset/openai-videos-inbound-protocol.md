---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/plugin-sdk': minor
---

Add official OpenAI Videos ports: create, retrieve, content, delete, remix, edits, and extensions.
Omitted `model` defaults to `sora-2`; convert is not implemented. Follow-ups stay on the creating
provider (`404` after restart). Edits/extensions are JSON only; list and character ports are `501`;
generations is not registered. The API table also lists shipped Codex Live/Realtime signaling
ports (media is not relayed).
