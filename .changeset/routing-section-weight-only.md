---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Reduce the provider editor's Routing section to priority and weight number inputs. The attempt-order
preview is gone, as is the provider-level enabled switch; a provider is enabled or disabled from the
providers list. Creating an API or AI SDK provider now writes an explicit weight of `1` and priority
of `0`, matching the router defaults.
