---
'aio-proxy': patch
'@aio-proxy/plugin-openai-chatgpt': patch
---

Guardian System One approvals now evaluate the supplied review policy, including custom rules, without falling back just because its wording or formatting changed. Incompatible requests, unusable results, and failed evaluations retain the original-model fallback with diagnostic reason codes.
