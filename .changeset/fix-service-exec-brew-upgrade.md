---
'@aio-proxy/cli': patch
'aio-proxy': patch
---

cli: bake the stable PATH launcher into the service unit instead of the version-pinned binary path, so `service restart` keeps working after `brew upgrade` retargets its symlink (previously the managed daemon pointed at the deleted old Cellar path and became unreachable until reinstall)
