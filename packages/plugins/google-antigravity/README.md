# Google Antigravity

Use a Google Antigravity account to access Cloud Code Assist models through aio-proxy.

## Login

Run:

```sh
aio-proxy provider login @aio-proxy/plugin-google-antigravity
```

The browser flow returns to `http://localhost:51121/oauth-callback`. If that address cannot reach the CLI, such as from a remote browser, paste the complete callback URL into the interactive prompt.

The account form also exposes an optional advanced `baseURL`. Leave it empty for the default Antigravity endpoints. When set, project initialization, model discovery, inference, and token counting use only the normalized custom HTTP(S) URL.

## Models and aliases

The plugin dynamically discovers the models available to the account. A non-empty valid discovery result is authoritative. On the first login only, a retryable discovery failure may use the bundled verified snapshot; authorization failures and valid empty catalogs do not. Later refresh failures keep the last-known-good catalog marked stale.

Default client aliases are suggested only when a new account is created and every target exists in its initial catalog. Re-login and later catalog refreshes never rewrite those aliases, so an existing alias remains the attempted route even if its target later disappears from the catalog.

Gemini requests use same-protocol raw transport when available. Other inbound protocols, and Gemini calls without raw support, use the plugin's model capability through the normal Provider weight and fallback pipeline.

## Non-goals

- Credits or quota dashboards, quota-aware routing, account pools, and credential cooldown scheduling.
- Image generation; supported models may still accept image input.
- HTTP, TLS, JA3, or browser fingerprint simulation.
- Session-based Provider affinity; selection remains model-first with Provider weight and fallback.
- Exposing the added web-search tool surface through OpenAI Responses.
