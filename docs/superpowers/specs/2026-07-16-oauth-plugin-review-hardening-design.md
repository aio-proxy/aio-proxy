# OAuth Plugin Review Hardening Design

## Status

Approved in conversation on 2026-07-16. This document amends
`2026-07-14-oauth-plugin-system-design.md`; unchanged decisions in the original
spec remain binding.

## Goal

Close the actionable findings from the post-implementation Claude Code review,
make the two built-in OAuth plugins truly embedded product features, and add a
host-neutral localization contract for third-party plugin copy.

## Distribution boundary

`@aio-proxy/plugin-github-copilot` and
`@aio-proxy/plugin-openai-chatgpt` remain separate workspace packages so they
exercise the same descriptor and capability interfaces as third-party plugins.
They are private implementation packages, are never published to npm, and are
statically imported by `@aio-proxy/core`. The compiled aio-proxy binary must
contain both descriptors and expose them without package installation,
`node_modules`, or an existing `AIO_PROXY_HOME`.

`@aio-proxy/plugin-sdk` remains a public npm package. Its release artifact is
the exact tarball produced by `bun pm pack`, not a later `npm publish` of the
workspace directory. Release verification must inspect the packed manifest and
reject any remaining `workspace:` or `catalog:` dependency protocol before the
tarball is published.

Changesets remains the version source, but public publication uses an explicit,
idempotent publish script with a deterministic order. Built-in plugin packages
are excluded from public release entries.

## Localized plugin copy

The SDK owns a host-neutral, JSON-serializable copy type:

```ts
export type LocaleTextMap = Readonly<
  { readonly default: string } & Readonly<Record<string, string>>
>;

export type LocalizedText = string | LocaleTextMap;
```

Map keys other than `default` are canonical BCP 47 language tags. Every value
is non-empty after trimming. `default` is required so a plugin always supplies
a deterministic fallback that does not depend on host locale support or object
iteration order.

The SDK exports a pure resolver:

```ts
export function resolveLocalizedText(text: LocalizedText, locale: string): string;
```

Resolution order is canonical exact locale, language-script candidate when
present, base language, then `default`. A plain string is returned unchanged.
Invalid host locale input skips locale-specific candidates and returns
`default`.

The following display-copy fields accept `LocalizedText`:

- plugin metadata label and description;
- OAuth adapter label and description;
- ConfigSpec field label, description, and placeholder;
- select-option label and description;
- device-code instructions;
- OAuth progress messages.

Account identity data remains a plain string. In particular,
`OAuthLoginResult.label`, credential metadata label, model identifiers, and
upstream account names are not localized copy.

The host validates locale maps into inert plain JSON data and rejects accessors,
symbols, cycles, empty values, non-canonical tags, and duplicate canonical
aliases. The SDK does not proxy Zod schemas or descriptor objects. CLI resolves
copy immediately before rendering. Dashboard endpoints carry validated locale
maps and the browser resolves them with its current locale, so changing the UI
language does not require plugin reload.

Built-in plugins carry the same locale maps as third-party plugins. Core no
longer injects already-resolved strings into built-in descriptor factories.

## Failure isolation

A plugin-scoped secret read or decode failure is part of that plugin's loading
attempt. It must produce a failed plugin state and unavailable diagnostics for
providers that reference the plugin while healthy plugins and non-plugin
providers still form the candidate snapshot. Repository corruption is never
silently interpreted as an absent secret.

A credential schema contract error is isolated to the affected provider.
Ordinary credential validation failure remains
`CREDENTIALS_MISSING_OR_INVALID`; a validator that throws or violates the SDK
schema contract becomes a plugin/provider contract diagnostic without a
misleading login recommendation.

## Credential refresh safety

Refresh commit requires both the expected account credential revision and the
current SQLite refresh lease owner in the same transaction. A pre-check followed
by CAS is forbidden because it leaves a TOCTOU window.

Diagnostic persistence is best-effort and cannot replace the primary refresh
error. If an account is concurrently deleted, diagnostic insertion performs no
write and no diagnostic callback.

Dynamic log redaction includes credential string leaves, account-secret string
leaves, and plugin-secret string leaves available to the materialized runtime.

An unclassified refresh failure is terminal and requires re-login. Its
diagnostic is not marked retryable. The host does not automatically retry an
ambiguous rotating-token exchange because the upstream may already have
consumed the old token. Future transparent recovery requires an explicit SDK
error classification such as `safe-to-retry`; it is outside this revision.

When refresh returns account metadata, successful CAS persists it and causes
provider summaries to converge without rebuilding the ProviderV4 runtime.
OpenAI ChatGPT refresh returns the new `expiresAt` metadata.

## Account deletion lifecycle

Pending account operations use named domain outcomes; raw `Error` conflicts do
not cross dashboard or watcher seams. Dashboard conflicts return 409.

Re-adding a provider supersedes or cancels its stale delete marker before the
new routed incarnation becomes current. A later delete receives a new marker
bound to the later snapshot lifecycle. Physical account deletion is serialized
through the server FIFO and must re-check both raw config absence and
`snapshotManager.canDeleteAccount(providerId)` immediately before the database
transaction. If either predicate fails, the marker is retained and recovery is
rescheduled.

The required adversarial sequence is delete, re-add, delete while an earlier
snapshot lease remains held. At no point may a current Router refer to a
physically deleted account.

## CLI and loopback safety

All destructive or trust-bearing interactive confirmations default to No,
including plugin trust, remove, purge, prune, and any manual authorization
fallback. `--yes` remains the only explicit non-interactive bypass.

Expected provider-login and loopback failures cross the top-level CLI seam as a
small safe user-error family and keep their localized messages. Unknown plugin
or internal errors remain redacted as `Unexpected internal error`.

A fixed callback port bind failure aborts authorization. The host must not open
the same redirect URI after another process has bound it, because code and state
would be disclosed to that process even if PKCE later prevents redemption.

Provider target errors distinguish missing provider, invalid/non-OAuth target,
and genuine cleanup-pending state. Windows browser opening passes the complete
OAuth URL as a single quoted argument so shell metacharacters such as `&` are
not interpreted.

The `--provider` option has localized help copy. Dashboard account expiry and
catalog timestamps are rendered with the current browser locale rather than as
raw ISO strings.

## Build and runtime reliability

Because the project has not been released, migration history is squashed into
one Drizzle-generated baseline. Its SQL, journal, and snapshot are committed.
CI reruns `drizzle-kit generate` and requires the migration directory to remain
clean. Migration SQL is fixed to LF through `.gitattributes`, and the redundant
non-unique index duplicating `UNIQUE(plugin, capability, fingerprint)` is
removed before release.

Config lock release failures are observable and cannot report a successful
transaction while leaving a live-owner lock behind. Recovery-marker content
changes use the same conservative fence interpretation in config and npm lock
implementations; the larger shared-lock refactor remains follow-up work.

After server close, diagnostic callbacks cannot enqueue or execute snapshot
rebuilds. Copilot credential validation rejects invalid base URLs and its model
request restores `Accept: application/json`.

Secret form fields do not overload `placeholder` as a masking policy. Masking
and hint copy are separate semantics, or v1 omits secret placeholder entirely.

The public SDK documentation states that plugin code executes inside the Bun
host even when a plugin author uses Node-based tooling for development and type
checking.

## Explicit non-goals

- Automatic retry of ambiguous rotating refresh-token failures.
- Node/undici runtime support; plugins execute in the Bun host. The SDK may be
  consumed by Node-based development tools, but runtime execution support is
  Bun `>=1.3.14`.
- Deep-freezing trusted plugin descriptors or Zod schemas.
- Permitting duplicate root `plugins` entries; they remain a structural config
  error because options have no deterministic winner.
- Garbage-collecting empty npm lifecycle-lock directories.
- Refactoring the two lock implementations into a shared module in this PR.
- Supporting old and new aio-proxy processes concurrently during the clean-break
  upgrade. Operators must stop old processes before upgrading.

## Verification

The revision is complete only when focused RED/GREEN tests cover every changed
behavior, the full check/unit/API e2e/build suites pass, an SDK tarball installs
in an empty npm project, and a compiled binary lists both built-in plugins in an
empty runtime environment.
