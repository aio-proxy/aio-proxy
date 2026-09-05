---
'@aio-proxy/plugin-openai-chatgpt': patch
'aio-proxy': patch
---

Drop reasoning item ids the ChatGPT Codex backend never persisted.

A turn served through the AI SDK model path leaves the proxy's own synthetic
"rs_..." id on the reasoning item, and the client replays that id in the next
turn's input. This runtime forces store: false, so the upstream never persisted
it and the lookup failed with "Item with id 'rs_...' not found. Items are not
persisted when store is set to false." Reasoning items that carry no
encrypted_content now forward without the id and are re-sent as new content;
the summary is kept. The invalid_encrypted_content retry replays through the
same rewrite, so an item that just lost its unusable blob also loses the id.
