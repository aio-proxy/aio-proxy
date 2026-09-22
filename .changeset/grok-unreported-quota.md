---
'@aio-proxy/plugin-xai-grok': patch
'aio-proxy': patch
---

Grok quota treats an omitted usage figure as 0% used, so an unused window stays fully available instead of disappearing. Banked usage-limit resets can be redeemed from the quota dialog.
