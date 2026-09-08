---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/plugin-sdk': minor
---

Add official OpenAI Videos job ports as a raw-only `openai-video` protocol: create, retrieve, content, delete, remix, edits, and extensions. Omitted `model` defaults to `sora-2`; convert is not implemented. Edits and extensions accept JSON only. A missing prompt or illegal video id is rejected before a pinned invoke. Retrieve and other follow-ups use an in-process pin and return `404` after restart. `GET /v1/videos` and character ports answer `501`; `/v1/videos/generations` is not registered. The API table now also lists the shipped Codex Live/Realtime signaling ports; media is not relayed. Official Sora shutdown is 2026-09-24; the `/v1/videos` wire remains for compatible gateways.
