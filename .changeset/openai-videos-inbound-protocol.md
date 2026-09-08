---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/plugin-sdk': minor
---

Add official OpenAI Videos job ports as a raw-only `openai-video` protocol: create, retrieve, content, delete, remix, edits, and extensions. Omitted `model` defaults to `sora-2`; a pinned edit or extension keeps the source model unless the client sets one, and stays on the creating provider. Convert is not implemented. Edits and extensions accept JSON only; a missing prompt or illegal video id is rejected before invoke. Follow-ups use an in-process pin (`404` after restart). `GET /v1/videos` and character ports answer `501`; `/v1/videos/generations` is not registered. The API table also lists shipped Codex Live/Realtime signaling ports (media is not relayed). Reported JSON `usage` tokens are recorded; seconds and file size are not estimated. Official Sora shutdown is 2026-09-24; the `/v1/videos` wire remains for compatible gateways.
