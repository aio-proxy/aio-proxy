---
'@aio-proxy/cli': patch
'aio-proxy': patch
---

Fix `aio-proxy upgrade` on a Homebrew install reached through a launcher outside the Homebrew prefix,
such as a hand-made `/usr/local/bin/aio-proxy` symlink into `/opt/homebrew/Cellar`. Detection looked
for `brew` beside that launcher and failed when it was not there, even though the resolved Cellar
path already named the prefix that has it.
