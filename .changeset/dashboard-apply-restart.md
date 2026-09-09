---
'@aio-proxy/cli': patch
'aio-proxy': patch
---

Updating from the dashboard now always restarts the service after a successful install. The install
step first asked over HTTP whether a daemon was running, even though it was running inside that very
daemon, so a busy server, a slow answer, or a `server.host` that is not locally reachable made it
conclude there was nothing to restart. The new version was installed and then never started, with no
error to explain why.
