---
'@aio-proxy/plugin-cursor': minor
'@aio-proxy/plugin-github-copilot': minor
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-xai-grok': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/i18n': minor
'aio-proxy': minor
---

Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

OAuth Providers whose plugin supports it gain a "Refresh Credential" entry in the card's ⋯ menu that
forces an upstream token exchange even when the current credential has not expired, clears a stale
`CREDENTIAL_REFRESH_FAILED` diagnostic on success, and reloads the Provider list so the account label
and expiry reflect the new credential. A refresh the plugin reports as permanently failed — a revoked
refresh token, for example — records the same reauthentication diagnostic the automatic refresh path
does, so the card tells you to re-login instead of continuing to report the Provider as ready. A
transient failure leaves the Provider untouched. The entry is hidden — not
disabled — for plugins without the capability, which Provider summaries now report as
`canRefreshCredential`. All six bundled OAuth plugins support it.

`OAuthAdapter` gains an optional `refreshCredential`, exported alongside the new
`OAuthCredentialRefreshContext` and `OAuthCredentialRefreshResult` types. It is a pure exchange: the
framework owns the lease, single-flight dedupe, revision compare-and-swap, and persistence, and calls
the adapter unconditionally rather than only past expiry. Adapter registration previously dropped
fields outside its closed list, so an adapter declaring `refreshCredential` would have lost it.
