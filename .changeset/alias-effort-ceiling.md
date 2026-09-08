---
'@aio-proxy/types': patch
'aio-proxy': patch
---

Fix alias routing for reasoning efforts above everything an alias declares. A request for `xhigh` or `max` against an alias whose variants stop at `high` used to silently fall back to the alias base model, which is usually a lower tier, so asking for more effort could get you less. Such requests now route to the alias's highest declared variant instead. Efforts that fall in a gap between variants, and aliases whose highest variant is below `medium`, still use the alias base as before.
