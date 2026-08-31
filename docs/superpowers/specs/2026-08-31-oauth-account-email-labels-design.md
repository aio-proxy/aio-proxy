# OAuth Account Email Labels

**Status:** Approved for implementation planning

## Goal

Make the account shown for every built-in OAuth Provider use the connected account's normalized email address when that provider exposes one. Missing email data must not invalidate an otherwise usable login or imported credential.

This is a presentation change only. Provider identity, duplicate detection, generated Provider IDs, authorization, and routing must remain unchanged.

## Current Behavior

The Dashboard already renders the stored OAuth `accountLabel`. The inconsistency originates in plugin login and refresh results, not in the Dashboard:

| Plugin | Current label source | Email source already available |
| --- | --- | --- |
| OpenAI ChatGPT | ChatGPT account ID | OAuth `id_token` email, as used by CLIProxyAPI (CPA) |
| Cursor | Constant `Cursor` | Access-token JWT `email` claim |
| Kimi Code | Constant `Kimi Code` | Access- or refresh-token JWT `email` claim |
| GitHub Copilot | GitHub login | GitHub primary verified email API with an added OAuth scope |
| Google Antigravity | Google userinfo email | Already used |
| xAI Grok | ID/access-token email, then subject/service fallback | Already used when present |

## Decision

Keep email extraction and normalization inside each OAuth plugin. Plugins understand their own token claims, userinfo endpoints, refresh behavior, and fallback identity. The existing `OAuthLoginResult.accountLabel` and credential-refresh metadata remain the only host-facing presentation contract.

Do not add an `email` field to the public plugin SDK. Do not make Server or Dashboard code inspect plugin-private credential shapes. Those alternatives would either expand a display fix into a public API change or couple the host to secret plugin payloads.

### Identity and presentation boundaries

The three OAuth identity outputs retain separate responsibilities:

- `fingerprint` is the stable duplicate-detection identity and does not change.
- `suggestedKey` continues to generate the initial Provider ID and does not change.
- `accountLabel` becomes the normalized email when available, otherwise the plugin's current fallback label.

An email is normalized by trimming surrounding whitespace and converting it to lowercase. An empty result is treated as missing. Normalization applies to presentation and optional stored email fields. When an existing plugin uses the provider-returned email directly as its fingerprint or suggested-key input, it must retain that existing identity input and derive a separate normalized presentation email. Plugins may implement this with a small local function or an existing plugin-local claim reader; this change does not introduce a cross-plugin utility.

## Data Flow

### Login and CPA import

Each plugin extracts and normalizes email after it has validated the provider's OAuth response. It returns:

```text
fingerprint: unchanged stable identity
suggestedKey: unchanged generated key
accountLabel: normalized email ?? current fallback label
credentials: current credential plus optional normalized email where refresh needs it
```

CPA importers use the same plugin-local mapping as native login. Imported top-level email fields are parsed as untrusted input and used only after schema validation and normalization.

### Refresh

Plugins that refresh credentials follow this precedence:

1. normalized email from the refreshed token or provider response;
2. normalized email already stored in the current credential;
3. no email metadata update.

When an email is available, refresh returns it in the updated credential and sets refresh metadata `accountLabel` to that email. When no email is available, refresh must not overwrite an existing email label with a service name or opaque identifier.

## Plugin Behavior

### OpenAI ChatGPT

Follow CPA's Codex OAuth behavior by decoding the email claim from the token exchange `id_token`. The native login priority is:

1. `id_token.email`;
2. access-token `email`;
3. ChatGPT account ID as the existing fallback.

Add an optional normalized `email` to `ChatGPTCredential`. This keeps existing stored credentials valid. Refresh parses a newly returned ID/access token email and otherwise retains the current credential email; refresh metadata updates `accountLabel` only when the resulting credential has email.

The CPA importer accepts its validated top-level `email`, then falls back to the imported `id_token` and access token. It still derives `fingerprint` and `suggestedKey` from the ChatGPT account ID. It does not persist the raw ID token.

### Cursor

Use the normalized JWT email already extracted by `cursorIdentity` as the label. `cursorIdentity.label` becomes `email ?? 'Cursor'`; its subject/email fingerprint calculation and generated key remain unchanged.

Add refresh handling that extracts email from the new access token when present and otherwise retains the current credential email. Refresh metadata uses the resulting email. When neither the refreshed nor current credential contains one, it omits `accountLabel` so the host retains the existing label.

Cursor has no stable userinfo endpoint. The JWT claim remains the only email source.

### Kimi Code

Decode Kimi access and refresh JWT payloads and read their `email` claim, preferring access-token email and then refresh-token email. Store the normalized result as an optional field on `KimiCredential`.

Native login, CPA import, and refresh use the same token mapping. `kimiLoginResult` returns `email ?? 'Kimi Code'` as its account label. Refresh retains the current email when rotated tokens omit it and updates account-label metadata when an email is available.

The existing Kimi fingerprint algorithm is outside this change and remains untouched.

### GitHub Copilot

Request `read:user user:email` during the GitHub device flow. After obtaining the GitHub token, fetch the authenticated user as today for the stable numeric fingerprint, then query `${apiBase}/user/emails`.

Validate the email response as a list and select an entry only when both `primary` and `verified` are true. Normalize that email and use it as `accountLabel`. If the endpoint is unavailable, returns an invalid response, or has no primary verified email, retain the current GitHub login label. This fallback covers GitHub Enterprise instances that do not expose the endpoint consistently.

The numeric GitHub user ID remains the fingerprint and suggested-key source.

### Google Antigravity

Keep the existing strict Google userinfo flow: a missing email remains a login error. Preserve the existing trimmed provider email as the fingerprint and suggested-key suffix so identity behavior does not change. Derive a separate normalized copy for the account label and credential email for native login and CPA import.

Refresh continues to use credential email for account-label metadata, now guaranteed to use the normalized form for newly logged-in or imported accounts.

### xAI Grok

Keep the existing claim precedence and fallback behavior. Normalize email claims and CPA-imported email before storing them. Native login and imports continue to use `email ?? subject ?? 'xAI Grok'` for account presentation and the existing normalized identity calculation for fingerprinting.

## Error Handling and Security

- Email extraction is presentation-only. An unverified JWT payload must never authorize a request or replace the plugin's stable fingerprint identity.
- JWT parsing failures, missing email claims, and blank email values use the plugin's documented fallback rather than failing an otherwise valid OAuth login or import.
- GitHub email lookup failures are isolated from the required GitHub user lookup. The latter must still succeed because its numeric ID supplies the stable fingerprint.
- Google Antigravity preserves its existing stricter contract because its granted scopes and userinfo endpoint are expected to return an email.
- Raw tokens, raw token responses, and GitHub email response bodies must not enter errors, logs, diagnostics, labels, or generated Provider IDs.
- Refresh never downgrades an already known email label merely because a rotated token omitted the claim.

## Existing Accounts

Credential schema additions are optional, so existing records remain readable without a database migration.

- Existing Cursor, Kimi Code, and ChatGPT accounts can acquire an email label on a later successful credential refresh when the refreshed tokens expose email.
- Existing GitHub Copilot accounts require reauthorization because their current long-lived credential has neither the additional email scope nor stored email metadata.
- Existing Antigravity and Grok accounts already use email in normal operation.

No generic migration will decrypt and reinterpret plugin-private credentials. Users who want immediate consistency can reauthorize the affected Provider.

## Testing

Behavior-level tests remain with their existing plugin modules:

- **OpenAI ChatGPT:** ID-token email extraction and normalization; access-token fallback; native login label; CPA top-level/token email priority; refresh update and preservation; unchanged account-ID fingerprint/key.
- **Cursor:** email label from JWT; service-label fallback; refresh email update/preservation and metadata; unchanged fingerprint/key.
- **Kimi Code:** access/refresh JWT email priority; native login and CPA import labels; refresh update/preservation and metadata; unchanged fingerprint/key behavior.
- **GitHub Copilot:** requested scopes; `/user/emails` request; primary verified selection and normalization; no-match, invalid-response, request-failure, and Enterprise fallback; unchanged numeric fingerprint/key.
- **Google Antigravity:** normalized native and CPA labels/credentials while preserving the current fingerprint/key input and missing-email failure.
- **xAI Grok:** native and CPA normalization plus existing subject/service fallbacks.

No Dashboard test is required because its API and rendering behavior do not change.

Implementation follows test-driven development: add the smallest behavior tests that fail under current code, implement the plugin-local changes, then run affected package tests, `bun run check`, and, when practical, the repository-wide `bun run preflight`.

## Release

Add one patch changeset that targets `aio-proxy` and every built-in plugin package materially changed by the implementation. The user-facing note states that OAuth-connected accounts now prefer normalized email addresses for display. The changeset must not target only internal plugin packages, and this change does not require a plugin SDK changelog entry.

## Non-goals

- Changing Provider IDs, fingerprints, duplicate detection, routing, or session behavior.
- Defining a public plugin SDK email identity contract.
- Reading plugin-private credentials in Server or Dashboard code.
- Adding a database migration for existing labels.
- Guaranteeing that providers which do not return email can display one.
- Changing Kimi's current fingerprint algorithm.
