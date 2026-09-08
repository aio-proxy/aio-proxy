---
'@aio-proxy/core': patch
'aio-proxy': patch
---

core: stop downgrading a `max` reasoning effort on providers that support it. Because `max` sits above the highest level the model call can express, it was folded down before per-candidate clamping ran, so a provider advertising `max` received `high` instead. The level you asked for is now preserved end to end and only clamped when the chosen provider genuinely cannot serve it.
