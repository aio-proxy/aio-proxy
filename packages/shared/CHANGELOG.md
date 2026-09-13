# @aio-proxy/shared

## 0.22.0

No changes in this release.

## 0.21.0

No changes in this release.

## 0.20.5

No changes in this release.

## 0.20.4

No changes in this release.

## 0.20.3

No changes in this release.

## 0.20.2

No changes in this release.

## 0.20.1

No changes in this release.

## 0.20.0

### Minor Changes

- [#303](https://github.com/aio-proxy/aio-proxy/pull/303) [`84b206c`](https://github.com/aio-proxy/aio-proxy/commit/84b206c1d2f296748d2b86cedf0ef97c2b65d8e2) Thanks [@baranwang](https://github.com/baranwang)! - Add a built-in OpenRouter OAuth plugin that signs in with PKCE, mints a durable user-controlled API key, discovers models, and reads remaining key credits. Loopback parse now requires callback `state` only when the opened authorize URL sent `state`, so OpenRouter (no state echo) can finish without weakening ChatGPT or Antigravity CSRF.

## 0.19.2

No changes in this release.

## 0.19.1

No changes in this release.

## 0.19.0

## 0.18.1

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.3

## 0.12.2

## 0.12.1

## 0.12.0

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
