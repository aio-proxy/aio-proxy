# @aio-proxy/i18n

## 0.7.0

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

### Patch Changes

- [#138](https://github.com/aio-proxy/aio-proxy/pull/138) [`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7) Thanks [@baranwang](https://github.com/baranwang)! - Add the Rspress documentation site and its shared UI foundation.

## 0.6.0

## 0.5.2

### Patch Changes

- [#133](https://github.com/aio-proxy/aio-proxy/pull/133) [`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95) Thanks [@baranwang](https://github.com/baranwang)! - Fix Docker release build failure by building `@aio-proxy/i18n` with rslib

  The `@aio-proxy/i18n` package built its declarations with `tsc -b`, unlike every other referenced workspace package (which use rslib). Because `paraglide-js compile` regenerates `src/paraglide/**` on every build, fresh/concurrent builds (such as the multi-arch Docker release) could see i18n's emitted `dist` as stale relative to its regenerated sources, so `@aio-proxy/core`'s declaration generation failed the composite project-reference check with `TS6305: Output file '.../i18n/dist/index.d.ts' has not been built from source file '.../i18n/src/index.ts'`.

  i18n now compiles messages and then builds with rslib like the other packages, emitting its declarations through the same pipeline and eliminating the fragile cross-package staleness check.

## 0.5.1

## 0.5.0

## 0.4.0

### Minor Changes

- [#124](https://github.com/aio-proxy/aio-proxy/pull/124) [`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282) Thanks [@baranwang](https://github.com/baranwang)! - i18n: restructure message keys into nested namespaces and add Traditional Chinese (zh-Hant), Japanese (ja), and Korean (ko) locales

  - Flat `cli_*`/`common_*`/`error_*`/`wizard_*` keys are now nested, dot-layered namespaces (e.g. `cli.provider.login.unknown_vendor`); dashboard/oauth/brand keys are regrouped under the same scheme.
  - Added `zh-Hant`, `ja`, and `ko` locales; `resolveLocale` now maps `zh-hant`/`zh-tw`/`zh-hk`/`zh-mo`, `ja`/`ja-*`, and `ko`/`ko-*` tags to them.
  - Removed keys that did not need translation (protocol acronyms, `N/A`, `API Key`, and similar) and inlined them at their call sites.
  - Stripped trailing sentence periods from all message values across every locale.

## 0.3.0

## 0.2.1

## 0.2.0
