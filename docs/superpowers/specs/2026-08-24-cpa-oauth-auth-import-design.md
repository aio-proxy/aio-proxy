# CPA OAuth Auth File Import

## Goal

Add a non-interactive CLI command that copies supported CLIProxyAPI (CPA) OAuth auth files into aio-proxy accounts:

```bash
aio-proxy provider import [path]
```

The import is a one-time copy. aio-proxy owns the imported account after the command succeeds; it does not synchronize with, rewrite, move, or delete the CPA source file.

## Command behavior

- Omitted `path` means `process.cwd()`.
- A supplied path that does not exist is an error. It must never fall back to the current directory.
- A file path imports that exact file, regardless of its filename extension.
- A directory path reads only immediate regular files whose names end in `.json`.
- Directory traversal is non-recursive.
- Directory entries are processed in ascending filename order.
- Files are processed sequentially so account creation and output ordering are deterministic.
- An empty directory prints an all-zero summary and exits successfully.

The command detects the CPA provider from the trimmed top-level `type` string. There is no separate `cpa` positional argument or provider selector.

Supported CPA types:

| CPA `type` | aio-proxy plugin | OAuth capability |
|---|---|---|
| `codex` | `@aio-proxy/plugin-openai-chatgpt` | `default` |
| `antigravity` | `@aio-proxy/plugin-google-antigravity` | `default` |
| `kimi` | `@aio-proxy/plugin-kimi-code` | `default` |
| `xai` | `@aio-proxy/plugin-xai-grok` | `default` |

The CLI does not hardcode that table. Each OAuth plugin declares the CPA `type` values it owns, and core resolves the registered importer.

## Per-file outcomes

Each selected file produces exactly one result:

- **imported**: a new aio-proxy provider account was committed; print the source path and created Provider ID.
- **duplicate**: the same plugin/capability fingerprint already exists; print the source path and existing Provider ID, and leave the existing account unchanged.
- **skipped**: the top-level `type` is syntactically valid but no loaded OAuth plugin claims it.
- **failed**: the file cannot be read or parsed, lacks a valid top-level `type`, fails plugin validation/conversion, or the account transaction fails.

After all selected files, print counts for `imported`, `duplicate`, `skipped`, and `failed`.

- Exit `0` when `failed === 0`; duplicates and unsupported types are not command failures.
- Exit `1` after printing the summary when `failed > 0`.
- Root path inspection failure is a command error before account dependencies are opened.
- Never print raw JSON, access tokens, refresh tokens, ID tokens, or credential objects.

## SDK and ownership boundary

Extend `OAuthAdapter` with an optional plugin-owned CPA credential importer:

```ts
export type OAuthCredentialImportContext = {
  readonly progress: (message: LocalizedText) => void;
  readonly signal: AbortSignal;
  readonly fetch?: RuntimeFetch;
};

export type OAuthCredentialImporter<AccountOptions, Credential> = {
  readonly types: readonly [string, ...string[]];
  readonly import: (
    context: OAuthCredentialImportContext,
    options: AccountOptions,
    raw: unknown,
  ) => Promise<OAuthLoginResult<Credential>>;
};

// Add this property to OAuthAdapter<AccountOptions, Credential>:
readonly credentialImports?: {
  readonly cpa?: OAuthCredentialImporter<AccountOptions, Credential>;
};
```

Registry validation must:

- reject blank or whitespace-padded declared type strings;
- reject duplicate declared types within one importer;
- reject a CPA type already claimed by another registered adapter;
- preserve method receivers by binding `import` to its importer object, matching existing adapter/catalog/quota behavior.

Core adds `importOAuthAccount()`. Browser login and file import differ only in how they obtain an `OAuthLoginResult`; both then use the existing account-option validation, login-result validation, fingerprint duplicate detection, in-memory credential port, catalog discovery/fallback, staged repository/config transaction, rollback/compensation, and alias handling.

CPA import always creates a new account. It does not accept a target Provider ID and does not update or re-login an existing provider.

## Credential conversion

All importers must parse `raw` as untrusted input, require non-empty tokens needed by aio-proxy, ignore arbitrary CPA metadata, and return only allowlisted normalized credential fields.

Expiry conversion for an `expired` field is:

```ts
const parsed = typeof expired === 'string' ? Date.parse(expired) : Number.NaN;
const expiresAt = Number.isFinite(parsed) ? parsed : 0;
```

`0` deliberately makes the normal runtime refresh path treat the access token as expired. Antigravity may use finite `timestamp + expires_in * 1000` as a fallback when `expired` is absent or invalid.

### Codex

- Require `access_token` and `refresh_token`.
- Map `access_token` to `accessToken` and `refresh_token` to `refreshToken`.
- Map `account_id` to `accountId`; when absent, reuse the existing JWT `chatgpt_account_id` extraction from `access_token`.
- Map `expired` to `expiresAt`.
- Keep the existing ChatGPT fingerprint and suggested Provider ID rules: fingerprint `accountId`, suggested key `chatgpt-${accountId}`.
- Do not persist CPA `id_token`, `email`, `last_refresh`, or arbitrary metadata.

### Antigravity

- Require `access_token`, `refresh_token`, and `email`.
- Map `project_id` when present.
- Resolve expiry from `expired`, then finite `timestamp + expires_in * 1000`, then `0`.
- If `project_id` is absent and the imported access token is expired or has unknown expiry, reuse the existing Google refresh exchange before project initialization.
- If `project_id` is absent, reuse `initializeAntigravityProject()` with the effective access token and parsed account options.
- Keep the existing fingerprint and suggested key rules: fingerprint `email`, suggested key `antigravity-${email}`.
- Persist only normalized token, expiry, email, project ID, and optional token type/scope fields.

### Kimi

- Require `access_token` and `refresh_token`.
- Map `device_id` to `deviceId`; when absent, generate `crypto.randomUUID().replaceAll('-', '')`, the same rule as native login.
- Map `expired` to `expiresAt`.
- Reuse one shared Kimi login-result helper so native login and import both fingerprint the refresh token with SHA-256 and suggest `kimi-${fingerprint.slice(0, 12)}`.
- Do not persist CPA `token_type`, `scope`, or arbitrary metadata because the aio-proxy credential schema does not use them.

### xAI

- Require `access_token` and `refresh_token`.
- Map `email` when present and CPA `sub` to credential `subject` when present.
- Map `expired` to `expiresAt`.
- Reuse one shared xAI login-result helper so native login and import use the same identity precedence: subject, then lower-cased email, then refresh token; fingerprint remains `sha256:<digest>`.
- Do not persist CPA `id_token`, endpoint/base URL fields, redirect URI, auth kind, or arbitrary metadata.

## Scope and non-goals

In scope:

- SDK importer contract and registry validation.
- Core account import orchestration.
- CPA importers for the four built-in OAuth plugins.
- CLI path discovery, sequential batch processing, localized output, tests, and release notes.

Not in scope:

- Dashboard upload/import UI.
- Recursive traversal, glob syntax, stdin, archives, or watching directories.
- Synchronization with CPA after import.
- Moving, deleting, renaming, or rewriting CPA files.
- Importing non-OAuth CPA providers.
- Database migrations or new dependencies.
- A generic mapping/configuration language for arbitrary auth-file formats.

## Verification

- SDK type tests compile importer declarations and reject invalid type usage.
- Registry tests cover malformed importer declarations, duplicate CPA ownership, and class method receiver preservation.
- Core tests prove imported results use the same persistence, discovery, duplicate, and compensation path as login.
- Each plugin test locks its CPA field mapping and native fingerprint parity.
- CLI unit tests cover omitted path, exact file import, non-recursive sorted directory import, duplicates, unsupported types, invalid files, summaries, exit status, and source-file preservation.
- CLI integration tests cover command help and a supplied nonexistent path.
- `bun run preflight` passes.
