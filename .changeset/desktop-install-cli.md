---
'aio-proxy': minor
---

The macOS app's menu offers Install aiop command when your shell cannot find `aiop` and the app is in `/Applications`. After the system password prompt it adds `aiop` to `/usr/local/bin`, plus `aio-proxy` when your shell has none, both pointing at the CLI inside the app so they keep working across app updates. A command already installed there by something else is never replaced.
