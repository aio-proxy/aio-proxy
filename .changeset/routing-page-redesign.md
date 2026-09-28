---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
---

The routing page groups models by vendor and lists each model's failover tiers as T1, T2, … with every Provider's share of its tier, drift from the configured split, and Providers left out with the reason. A model's page shows everything at once: the route, traffic, and model info and pricing that follow a matched reference model unless overridden, with per-Provider prices and limits in a side panel and one save bar for it all. Default routing on the Providers page uses the same tier layout: weights are typed or stepped instead of set with share sliders (0 parks a Provider), and moving a Provider between tiers keeps every weight.
