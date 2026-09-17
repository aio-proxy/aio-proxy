---
'@aio-proxy/plugin-cursor': patch
'aio-proxy': patch
---

Fixed Cursor multimodal follow-up requests failing after an inline image moved into conversation history, including pending tool resumes, without dropping Cursor-owned conversation turns.
