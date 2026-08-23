---
'@aio-proxy/core': patch
'aio-proxy': patch
---

An OAuth provider's `models` whitelist is now read and validated from the config file, where it was
previously ignored. If you had hand-written a `models` key on an OAuth provider it now takes effect and
restricts which models that provider exposes. A malformed value — an empty model id, or a bare string
instead of a list — is reported instead of being silently dropped: that one provider is marked invalid
and unavailable in the Dashboard while the proxy and every other provider start normally. A re-login is
now validated the same way before its config is written: a staged `models` whitelist that is malformed is
rejected rather than persisted, so a re-login can no longer leave a working provider with a whitelist the
next start refuses to read.
