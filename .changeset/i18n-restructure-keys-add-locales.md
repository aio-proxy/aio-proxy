---
'@aio-proxy/i18n': minor
'aio-proxy': minor
---

i18n: restructure message keys into nested namespaces and add Traditional Chinese (zh-Hant), Japanese (ja), and Korean (ko) locales

- Flat `cli_*`/`common_*`/`error_*`/`wizard_*` keys are now nested, dot-layered namespaces (e.g. `cli.provider.login.unknown_vendor`); dashboard/oauth/brand keys are regrouped under the same scheme.
- Added `zh-Hant`, `ja`, and `ko` locales; `resolveLocale` now maps `zh-hant`/`zh-tw`/`zh-hk`/`zh-mo`, `ja`/`ja-*`, and `ko`/`ko-*` tags to them.
- Removed keys that did not need translation (protocol acronyms, `N/A`, `API Key`, and similar) and inlined them at their call sites.
- Stripped trailing sentence periods from all message values across every locale.
