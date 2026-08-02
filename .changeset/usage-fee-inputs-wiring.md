---
'aio-proxy': minor
'@aio-proxy/types': minor
'@aio-proxy/server': minor
---

feat: meter image, web-search, and audio usage for per-event and audio fees

The proxy now counts generated images and web-search invocations from served
responses (OpenAI Responses output items and streamed AI SDK file/tool-call
parts) and reads audio token counts from OpenAI-compatible usage. These flow
into the configured `cost` fields (`image`, `webSearch`, `inputAudio`,
`outputAudio`), which previously had no effect because nothing produced the
counts. Requests without such events are unaffected.
