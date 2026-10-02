---
'aio-proxy': patch
'@aio-proxy/dashboard': patch
---

The dashboard protocol pickers now offer OpenAI Images, Audio, and Videos endpoints, so media providers can be configured and their traces filtered without editing the config file. Protocols are also labelled by their official API name (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini generateContent, Gemini Interactions) instead of the ambiguous "Gemini" and "OpenAI Compatible".
