---
'@aio-proxy/dashboard': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

Make the Provider editor's catalog button actually re-fetch an OAuth Provider's model list. It only ever re-read the persisted catalog, so until the plugin's TTL expired — six hours for ChatGPT — the button silently redrew the same rows. It now forces a rediscovery upstream, waits for the new catalog to be readable, and reports failures instead of looking like a success. Disabled OAuth Providers can be refreshed this way too; they are still never rediscovered on a timer.
