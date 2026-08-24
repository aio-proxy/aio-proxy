# CPA OAuth Auth File Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts without browser login.

**Architecture:** OAuth plugins own CPA parsing and return the existing `OAuthLoginResult`; core resolves the importer and feeds that result into the same validated discovery/staging/compensation pipeline used by browser login. The CLI owns path resolution, immediate-directory enumeration, sequential processing, per-file presentation, and the final summary. No Dashboard path, synchronization loop, migration, or new dependency is added.

**Tech Stack:** TypeScript 7, Bun 1.4 APIs and test runner, Commander 15, Zod 4 through `@aio-proxy/plugin-sdk`, Paraglide i18n, existing SQLite/config account repository.

**Spec:** [docs/superpowers/specs/2026-08-24-cpa-oauth-auth-import-design.md](../specs/2026-08-24-cpa-oauth-auth-import-design.md)

## Global Constraints

- Command is exactly `aio-proxy provider import [path]`; omitted `path` means `process.cwd()`.
- A supplied nonexistent path errors and never falls back to the current directory.
- A file path imports exactly that file; a directory imports only immediate `.json` regular files in ascending filename order, without recursion.
- Process files sequentially and print one outcome per selected file plus imported/duplicate/skipped/failed counts.
- Exit `0` when `failed === 0`; exit `1` after the summary when any selected file failed.
- Auto-detect CPA from the trimmed top-level `type`; do not add a `cpa` or provider positional argument.
- Supported types are `codex`, `antigravity`, `kimi`, and `xai`, owned by their OAuth plugins rather than hardcoded in CLI/core.
- Import is create-only and one-time; never modify, move, rename, or delete source files.
- Never print raw JSON or credential/token values.
- Preserve existing fingerprint, Provider ID suggestion, discovery/fallback, alias, transaction, and compensation behavior.
- No Dashboard UI, recursion, globbing, stdin, archive support, synchronization, database migration, or new dependency.
- User-visible release changes use `minor` Changesets. The Changeset must include product packages `aio-proxy` and `@aio-proxy/plugin-sdk` plus all affected internal packages at the same level.
- Workspace is already an isolated git worktree. Do not create or switch worktrees.
- Prefix every shell command with `rtk`.

---

## File map

- `packages/plugin-sdk/src/oauth.ts` — public importer context/type and optional `OAuthAdapter.credentialImports.cpa` contract.
- `packages/plugin-sdk/src/oauth.types.ts` — compile-time contract examples for plugin authors.
- `packages/core/src/plugins/registry.ts` — validate, bind, preserve, and uniquely register CPA importer types.
- `packages/core/src/plugins/registry.test.ts` — receiver preservation and cross-adapter ownership tests.
- `packages/core/src/plugins/registry-adapter-validation.test.ts` — malformed importer declaration tests.
- `packages/core/src/plugins/account-login/login.ts` — add create-only `importOAuthAccount()` and share post-acquisition persistence with login.
- `packages/core/src/plugins/account-login/errors.ts` — unsupported importer error.
- `packages/core/src/plugins/account-login/create.test.ts` — imported account persistence, duplicate, unsupported, and acquisition-boundary tests.
- `packages/core/src/plugins/account-login/test-support.ts` — test adapter importer controls and import option fixture.
- `packages/core/src/plugins/account-login/index.ts` — public core exports.
- `packages/plugins/openai-chatgpt/src/plugin.ts` and `packages/plugins/openai-chatgpt/__tests__/adapter.test.ts` — CPA `codex` conversion.
- `packages/plugins/google-antigravity/src/oauth/refresh.ts`, its test, `plugin.ts`, and `plugin.test.ts` — reusable refresh exchange and CPA `antigravity` conversion/project recovery.
- `packages/plugins/kimi-code/src/oauth.ts`, `oauth.test.ts`, `plugin.ts`, and `plugin.test.ts` — shared Kimi result identity and CPA `kimi` conversion.
- `packages/plugins/xai-grok/src/oauth.ts`, `oauth.login.test.ts`, `plugin.ts`, and `plugin.test.ts` — shared xAI result identity and CPA `xai` conversion.
- `packages/cli/src/plugin-commands/provider-import/index.ts` — export-only entry point.
- `packages/cli/src/plugin-commands/provider-import/provider-import.ts` — path discovery, parsing, sequential orchestration, classification, summary, and default dependencies.
- `packages/cli/src/plugin-commands/provider-import/provider-import.test.ts` — CLI module behavior using temporary files and injected account import.
- `packages/cli/src/provider-commands.ts` and `packages/cli/src/main.ts` — public command façade and Commander registration.
- `packages/cli/__tests__/provider-commands.test.ts` — CLI help and nonexistent-path integration coverage.
- `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json` — command and result copy.
- `.changeset/cpa-oauth-auth-import.md` — lockstep minor release note.

---

### Task 1: Publish the plugin-owned credential importer contract

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.types.ts:1-105`
- Modify: `packages/plugin-sdk/src/oauth.ts:71-84` and `:161-177`
- Include in first commit: `docs/superpowers/specs/2026-08-24-cpa-oauth-auth-import-design.md`
- Include in first commit: `docs/superpowers/plans/2026-08-24-cpa-oauth-auth-import.md`

**Interfaces:**
- Consumes: `LocalizedText`, `RuntimeFetch`, and `OAuthLoginResult<Credential>` already defined in `oauth.ts`.
- Produces: `OAuthCredentialImportContext`, `OAuthCredentialImporter<AccountOptions, Credential>`, and optional `OAuthAdapter.credentialImports.cpa`.

- [ ] **Step 1: Add a failing SDK type assertion**

Extend the import list in `packages/plugin-sdk/src/oauth.types.ts` with `OAuthCredentialImportContext` and `OAuthCredentialImporter`, then add:

```ts
declare const importContext: OAuthCredentialImportContext;

const cpaImporter: OAuthCredentialImporter<MyOptions, MyCredential> = {
  types: ['example'],
  async import(context, options, raw) {
    const input: unknown = raw;
    context.progress(`Importing ${options.baseURL}`);
    context.signal.throwIfAborted();
    await context.fetch?.('https://provider.example/import');
    void input;
    return { fingerprint: 'account', suggestedKey: 'account', credentials: { accessToken: 'token' } };
  },
};

const importerAdapter: OAuthAdapter<MyOptions, MyCredential> = {
  ...quotaAdapter,
  id: 'importer',
  credentialImports: { cpa: cpaImporter },
};

void cpaImporter.import(importContext, { baseURL: 'https://provider.example' }, {});
api.oauth.register(importerAdapter);

// @ts-expect-error an importer must claim at least one type
const emptyImporter: OAuthCredentialImporter<MyOptions, MyCredential> = { types: [], import: cpaImporter.import };
void emptyImporter;
```

- [ ] **Step 2: Run the type test and confirm the new names are missing**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test:types
```

Expected: FAIL because `OAuthCredentialImportContext`, `OAuthCredentialImporter`, and `credentialImports` do not exist.

- [ ] **Step 3: Add the public types**

Insert after `OAuthLoginResult` in `packages/plugin-sdk/src/oauth.ts`:

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
```

Add this optional property after `login` in `OAuthAdapter`:

```ts
readonly credentialImports?: {
  readonly cpa?: OAuthCredentialImporter<AccountOptions, Credential>;
};
```

- [ ] **Step 4: Verify the complete SDK package**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test
```

Expected: unit and type tests PASS.

- [ ] **Step 5: Commit the SDK contract and planning documents**

```bash
rtk git add \
  packages/plugin-sdk/src/oauth.ts \
  packages/plugin-sdk/src/oauth.types.ts \
  docs/superpowers/specs/2026-08-24-cpa-oauth-auth-import-design.md \
  docs/superpowers/plans/2026-08-24-cpa-oauth-auth-import.md

rtk git commit -m "$(cat <<'EOF'
feat(plugin-sdk): define OAuth credential importers

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 2: Validate and bind CPA importers in the plugin registry

**Files:**
- Modify: `packages/core/src/plugins/registry-adapter-validation.test.ts:45-107`
- Modify: `packages/core/src/plugins/registry.test.ts:103-191`
- Modify: `packages/core/src/plugins/registry.ts:25-119` and `:136-179`

**Interfaces:**
- Consumes: `OAuthAdapter['credentialImports']` from Task 1.
- Produces: registered adapters whose CPA importer has validated unique type strings and a bound `import` method; globally unique CPA type ownership across committed adapters.

- [ ] **Step 1: Add malformed declaration tests**

Add these cases to the parameterized array in `registry-adapter-validation.test.ts`:

```ts
['null credential imports', fakeAdapter('imports-null', { credentialImports: null })],
['array credential imports', fakeAdapter('imports-array', { credentialImports: [] })],
['missing CPA import method', fakeAdapter('imports-method', {
  credentialImports: { cpa: { types: ['codex'] } },
})],
['blank CPA type', fakeAdapter('imports-blank', {
  credentialImports: { cpa: { types: [' '], async import() {} } },
})],
['whitespace-padded CPA type', fakeAdapter('imports-padded', {
  credentialImports: { cpa: { types: [' codex'], async import() {} } },
})],
['duplicate CPA type', fakeAdapter('imports-duplicate', {
  credentialImports: { cpa: { types: ['codex', 'codex'], async import() {} } },
})],
```

Use `async import() { return { fingerprint: 'x', suggestedKey: 'x', credentials: { token: 'x' } }; }` in the three cases whose method must be valid so the declared type is the only rejection reason.

- [ ] **Step 2: Add ownership and receiver tests**

In `registry.test.ts`, add one test that registers two adapters claiming `codex` and expects the second plugin to fail atomically with no committed capabilities from that plugin.

Extend the existing class receiver test with this class member:

```ts
readonly credentialImports = {
  cpa: new (class {
    readonly types = ['class-auth'] as const;
    readonly #token = 'private-import-token';

    async import() {
      return {
        fingerprint: 'class-import',
        suggestedKey: 'class-import',
        credentials: { token: this.#token },
      };
    }
  })(),
};
```

Then assert:

```ts
await expect(
  resolved.credentialImports?.cpa?.import(
    { progress: () => {}, signal: new AbortController().signal },
    {},
    {},
  ),
).resolves.toMatchObject({ credentials: { token: 'private-import-token' } });
```

- [ ] **Step 3: Run the focused tests and confirm they fail**

```bash
rtk bun test packages/core/src/plugins/registry-adapter-validation.test.ts packages/core/src/plugins/registry.test.ts
```

Expected: FAIL because invalid declarations are accepted, duplicate ownership is not rejected, and the importer is not preserved.

- [ ] **Step 4: Validate and bind the importer**

Add this helper beside `validateQuota()` in `registry.ts`:

```ts
function validateCredentialImports(value: unknown): OAuthAdapter['credentialImports'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Invalid OAuth adapter');
  const cpa = value['cpa'];
  if (cpa === undefined) return {};
  if (!isRecord(cpa)) throw new Error('Invalid OAuth adapter');
  const types = cpa['types'];
  const importCredential = cpa['import'];
  if (!Array.isArray(types) || types.length === 0 || typeof importCredential !== 'function') {
    throw new Error('Invalid OAuth adapter');
  }
  const validatedTypes: string[] = [];
  for (const type of types) {
    if (typeof type !== 'string' || type === '' || type !== type.trim() || validatedTypes.includes(type)) {
      throw new Error('Invalid OAuth adapter');
    }
    validatedTypes.push(type);
  }
  return {
    cpa: {
      types: validatedTypes as [string, ...string[]],
      import: importCredential.bind(cpa) as NonNullable<
        NonNullable<OAuthAdapter['credentialImports']>['cpa']
      >['import'],
    },
  };
}
```

Destructure `credentialImports` in `validateAdapter()`, call the helper, and preserve it in the returned adapter only when defined:

```ts
const validatedCredentialImports = validateCredentialImports(credentialImports);
```

```ts
...(validatedCredentialImports === undefined ? {} : { credentialImports: validatedCredentialImports }),
```

- [ ] **Step 5: Enforce global CPA type ownership during staging**

Inside `createPluginRegistryHost()`, add:

```ts
const committedCpaTypes = new Map<string, string>();
```

Inside each `stage()` call, add:

```ts
const stagedCpaTypes = new Set<string>();
```

After `validateAdapter(value)` and before `staged.set(...)`, check every declared type:

```ts
for (const type of adapter.credentialImports?.cpa?.types ?? []) {
  if (stagedCpaTypes.has(type) || committedCpaTypes.has(type)) {
    throw new Error(`Duplicate OAuth credential import type: ${type}`);
  }
  stagedCpaTypes.add(type);
}
```

In `commit()`, after storing each capability, record its types:

```ts
for (const type of capability.adapter.credentialImports?.cpa?.types ?? []) {
  committedCpaTypes.set(type, `${plugin}#${capability.capability}`);
}
```

- [ ] **Step 6: Re-run registry and full core tests**

```bash
rtk bun test packages/core/src/plugins/registry-adapter-validation.test.ts packages/core/src/plugins/registry.test.ts
rtk bun run --filter @aio-proxy/core test:unit
```

Expected: all tests PASS.

- [ ] **Step 7: Commit registry support**

```bash
rtk git add \
  packages/core/src/plugins/registry.ts \
  packages/core/src/plugins/registry.test.ts \
  packages/core/src/plugins/registry-adapter-validation.test.ts

rtk git commit -m "$(cat <<'EOF'
feat(core): register OAuth credential importers

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 3: Feed imported credentials through the existing account transaction

**Files:**
- Modify: `packages/core/src/plugins/account-login/errors.ts:1-80`
- Modify: `packages/core/src/plugins/account-login/test-support.ts:80-205`
- Modify: `packages/core/src/plugins/account-login/create.test.ts`
- Modify: `packages/core/src/plugins/account-login/login.ts:1-215`
- Modify: `packages/core/src/plugins/account-login/login/preflight.ts:1-55`
- Modify: `packages/core/src/plugins/account-login/login/discovery.ts:1-65`
- Modify: `packages/core/src/plugins/account-login/login/stage.ts:1-139`
- Modify: `packages/core/src/plugins/account-login/index.ts:1-30`

**Interfaces:**
- Consumes: registered `credentialImports.cpa` from Task 2 and `OAuthLoginResult` validation already in core.
- Produces: `ImportOAuthAccountOptions`, `ImportOAuthAccountResult`, and `importOAuthAccount(options)` exported from `@aio-proxy/core`.

- [ ] **Step 1: Extend the account-login fixture with a CPA importer**

Add to `AdapterControls` in `test-support.ts`:

```ts
credentialImport?: NonNullable<
  NonNullable<OAuthAdapter<Record<string, unknown>, { token: string; refresh?: string }>['credentialImports']>['cpa']
>;
```

Preserve it when building the test adapter:

```ts
...(controls.credentialImport === undefined
  ? {}
  : { credentialImports: { cpa: controls.credentialImport } }),
```

Add an `importOptions()` fixture that copies only the common config/repository/registry/diagnostics/logger/fetch/signal/clock fields from `options()`, replaces the test adapter account schema with `zod.object({})`, and supplies:

```ts
source: 'cpa',
type: 'example',
raw: { type: 'example', token: 'imported' },
```

- [ ] **Step 2: Add failing core behavior tests**

Append these tests to `create.test.ts`:

```ts
test('imports a plugin-produced login result through normal account persistence', async () => {
  const state = fixture();
  const raw = { type: 'example', token: 'imported' };
  let seen: unknown;
  const result = await importOAuthAccount(
    importOptions(state, {
      raw,
      registry: registry({
        credentialImport: {
          types: ['example'],
          async import(context, accountOptions, input) {
            seen = { context, accountOptions, input };
            return {
              fingerprint: 'imported@example.com',
              suggestedKey: 'imported',
              accountLabel: 'Imported account',
              credentials: { token: 'imported' },
              expiresAt: 123,
            };
          },
        },
      }),
    }),
  );

  expect(result).toEqual({ providerId: 'imported' });
  expect(seen).toMatchObject({ accountOptions: {}, input: raw });
  expect(state.repository.readAccount('imported')).toMatchObject({
    fingerprint: 'imported@example.com',
    label: 'Imported account',
    credential: { token: 'imported' },
    expiresAt: 123,
  });
  expect(configOf(state)['providers']).toMatchObject({
    imported: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', enabled: true },
  });
});

test('reports an imported fingerprint duplicate without changing the account', async () => {
  const state = fixture();
  await createAccount(state);
  await expect(
    importOAuthAccount(
      importOptions(state, {
        registry: registry({
          credentialImport: {
            types: ['example'],
            async import() {
              return {
                fingerprint: 'person@example.com',
                suggestedKey: 'person',
                credentials: { token: 'ignored' },
              };
            },
          },
        }),
      }),
    ),
  ).rejects.toMatchObject({ name: 'ProviderAccountAlreadyExistsError', existingProviderId: 'person' });
  expect(state.repository.readAccount('person')?.credential).toEqual({ token: 'new' });
});

test('rejects a CPA type with no registered importer', async () => {
  const state = fixture();
  await expect(importOAuthAccount(importOptions(state, { type: 'unknown' }))).rejects.toMatchObject({
    name: 'OAuthCredentialImportUnsupportedError',
    source: 'cpa',
    type: 'unknown',
  });
});
```

- [ ] **Step 3: Run the focused tests and confirm the API is missing**

```bash
rtk bun test packages/core/src/plugins/account-login/create.test.ts
```

Expected: FAIL because `importOAuthAccount`, `importOptions`, and the unsupported error do not exist.

- [ ] **Step 4: Add the unsupported-import error**

Add to `errors.ts` and export it from `account-login/index.ts`:

```ts
export class OAuthCredentialImportUnsupportedError extends Error {
  override readonly name = 'OAuthCredentialImportUnsupportedError';
  constructor(
    readonly source: 'cpa',
    readonly type: string,
  ) {
    super('OAUTH_CREDENTIAL_IMPORT_UNSUPPORTED');
  }
}
```

- [ ] **Step 5: Separate shared account-write options from browser-only acquisition**

In `login.ts`, rename the current common option fields to this exported internal type:

```ts
export type OAuthAccountWriteOptions = {
  readonly targetProviderId?: string;
  readonly capability?: OAuthCapabilityReference;
  readonly providerPatch?: OAuthProviderPatch;
  readonly registry: PluginRegistry;
  readonly repository: PluginRepository;
  readonly config: AtomicConfigFile;
  readonly fetch?: RuntimeFetch;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly coordinateProviderCommit?: <T>(capability: OAuthCapabilityReference, commit: () => Promise<T>) => Promise<T>;
  readonly validateProviderCommit?: (
    capability: OAuthCapabilityReference,
    current: Readonly<Record<string, unknown>>,
  ) => Promise<void> | void;
  readonly progress?: (message: LocalizedText) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
};

export type LoginOAuthAccountOptions = OAuthAccountWriteOptions & {
  readonly renderAccountOptions: RenderAccountOptions;
  readonly createAuthorization: (signal: AbortSignal) => AuthorizationPort;
  readonly onAuthorized?: () => void;
};

export type ImportOAuthAccountOptions = Omit<
  OAuthAccountWriteOptions,
  'targetProviderId' | 'capability' | 'providerPatch'
> & {
  readonly source: 'cpa';
  readonly type: string;
  readonly raw: unknown;
};

export type ImportOAuthAccountResult = LoginOAuthAccountResult;
```

Change the internal types imported by `preflight.ts`, `discovery.ts`, and `stage.ts` from `LoginOAuthAccountOptions` to `OAuthAccountWriteOptions`. Their runtime behavior stays unchanged.

- [ ] **Step 6: Extract the common post-acquisition pipeline**

In `login.ts`, keep preflight, adapter resolution, account-option rendering, protected browser authorization, and `onAuthorized` in `loginOAuthAccount()`. Move the current code beginning with `validatedLoginResult(...)` through the final `{ providerId }` return into:

```ts
async function persistOAuthAccount(input: {
  readonly options: OAuthAccountWriteOptions;
  readonly initial: Awaited<ReturnType<typeof preflight>>;
  readonly adapter: OAuthAdapter;
  readonly rendered: { readonly publicValues: Record<string, unknown>; readonly secrets: Record<string, unknown> };
  readonly parsedOptions: unknown;
  readonly rawResult: OAuthLoginResult<unknown>;
  readonly deadline: ReturnType<typeof deadlineController>;
  readonly afterValidation?: () => void;
}): Promise<LoginOAuthAccountResult> {
  const { options, initial, adapter, rendered, parsedOptions, rawResult, deadline } = input;
  const validated = await validatedLoginResult(adapter, rawResult, deadline.signal);
  if (initial.fingerprint !== undefined && validated.fingerprint !== initial.fingerprint) {
    throw new ProviderFingerprintMismatchError(options.targetProviderId as string);
  }
  input.afterValidation?.();
  const metadata: { accountLabel?: string; expiresAt?: number } = {
    ...(validated.accountLabel === undefined ? {} : { accountLabel: validated.accountLabel }),
    ...(validated.expiresAt === undefined ? {} : { expiresAt: validated.expiresAt }),
  };
}
```

After the metadata declaration, paste verbatim the current concrete statements from `const discoveryDeadline = childDeadline(...)` through `return { providerId: staged.providerId }`. In `loginOAuthAccount()`, pass `afterValidation: options.onAuthorized`; `importOAuthAccount()` omits the property, so file import never invokes the browser-authorization callback.

- [ ] **Step 7: Implement create-only CPA import acquisition**

Add to `login.ts`:

```ts
export async function importOAuthAccount(options: ImportOAuthAccountOptions): Promise<ImportOAuthAccountResult> {
  const deadline = deadlineController(options.signal);
  try {
    const type = options.type.trim();
    const capability = options.registry.oauthCapabilities().find(({ adapter }) =>
      adapter.credentialImports?.cpa?.types.includes(type),
    );
    const importer = capability?.adapter.credentialImports?.cpa;
    if (capability === undefined || importer === undefined) {
      throw new OAuthCredentialImportUnsupportedError(options.source, type);
    }
    const writeOptions: OAuthAccountWriteOptions = {
      ...options,
      capability: { plugin: capability.plugin, capability: capability.capability },
    };
    const initial = await preflight(writeOptions, deadline.signal);
    if (capability.adapter.supportsProxy === false && initial.hasEffectiveProxy) {
      throw new OAuthProxyUnsupportedError(capability.plugin, capability.capability);
    }
    const rendered = { publicValues: {}, secrets: {} };
    const parsedOptions = await validatedAccountOptions(capability.adapter, rendered, deadline.signal);
    const rawResult = await withAbort(deadline.signal, () =>
      importer.import(
        {
          progress: options.progress ?? (() => {}),
          signal: deadline.signal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        },
        parsedOptions.value,
        options.raw,
      ),
    );
    return await persistOAuthAccount({
      options: writeOptions,
      initial,
      adapter: capability.adapter,
      rendered,
      parsedOptions: parsedOptions.value,
      rawResult,
      deadline,
    });
  } finally {
    deadline.close();
  }
}
```

Export the new option/result types and function from `account-login/index.ts`; `packages/core/src/plugins/index.ts` and `packages/core/src/index.ts` already re-export the account-login barrel.

- [ ] **Step 8: Run focused and regression tests**

```bash
rtk bun test packages/core/src/plugins/account-login/create.test.ts
rtk bun run --filter @aio-proxy/core test:unit
```

Expected: imported account, duplicate, unsupported type, existing login, compensation, abort, and recovery tests all PASS.

- [ ] **Step 9: Commit the shared core pipeline**

```bash
rtk git add packages/core/src/plugins/account-login

rtk git commit -m "$(cat <<'EOF'
feat(core): import OAuth account credentials

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 4: Convert CPA Codex files in the ChatGPT plugin

**Files:**
- Modify: `packages/plugins/openai-chatgpt/__tests__/adapter.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/plugin.ts:1-113`

**Interfaces:**
- Consumes: `OAuthAdapter.credentialImports.cpa`, existing `extractAccountId()`, `ChatGPTAccountIdMissingError`, and `ChatGPTCredential`.
- Produces: CPA type `codex` returning the same fingerprint/suggested key shape as native ChatGPT login.

- [ ] **Step 1: Add failing importer tests**

In `adapter.test.ts`, add:

```ts
test('imports a CPA Codex auth file with native account identity', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const accessToken = buildJwt({ chatgpt_account_id: 'account-123' });

  await expect(
    importer.import(
      { progress: () => {}, signal: new AbortController().signal },
      {},
      {
        type: 'codex',
        access_token: accessToken,
        refresh_token: 'refresh-123',
        expired: '2026-08-24T12:00:00Z',
        email: 'ignored@example.com',
        id_token: 'ignored-id-token',
      },
    ),
  ).resolves.toEqual({
    fingerprint: 'account-123',
    suggestedKey: 'chatgpt-account-123',
    accountLabel: 'account-123',
    credentials: {
      accessToken,
      accountId: 'account-123',
      refreshToken: 'refresh-123',
      expiresAt: Date.parse('2026-08-24T12:00:00Z'),
    },
    expiresAt: Date.parse('2026-08-24T12:00:00Z'),
  });
});

test('uses explicit CPA account_id and treats invalid expiry as expired', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const result = await importer.import(
    { progress: () => {}, signal: new AbortController().signal },
    {},
    {
      type: 'codex',
      access_token: 'opaque-access',
      refresh_token: 'refresh-123',
      account_id: 'explicit-account',
      expired: 'invalid',
    },
  );
  expect(result).toMatchObject({ fingerprint: 'explicit-account', expiresAt: 0 });
  expect(result.credentials).not.toHaveProperty('idToken');
});
```

- [ ] **Step 2: Run the test and confirm no importer is registered**

```bash
rtk bun test packages/plugins/openai-chatgpt/__tests__/adapter.test.ts
```

Expected: FAIL with `CPA importer not registered`.

- [ ] **Step 3: Add the Codex schema and converter**

In `plugin.ts`, import `extractAccountId` and `ChatGPTAccountIdMissingError`, then add:

```ts
const cpaCodexSchema = zod
  .object({
    type: zod.literal('codex'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    account_id: zod.string().trim().min(1).optional(),
    expired: zod.unknown().optional(),
  })
  .loose();

function cpaExpiresAt(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
```

Add this property beside `login` on the adapter:

```ts
credentialImports: {
  cpa: {
    types: ['codex'],
    async import(_context, options, raw) {
      await accountOptions.schema.parseAsync(options);
      const source = cpaCodexSchema.parse(raw);
      const accountId = source.account_id ?? extractAccountId(source.access_token);
      if (accountId === undefined) throw new ChatGPTAccountIdMissingError();
      const expiresAt = cpaExpiresAt(source.expired);
      return {
        fingerprint: accountId,
        suggestedKey: `chatgpt-${accountId}`,
        accountLabel: accountId,
        credentials: {
          accessToken: source.access_token,
          accountId,
          expiresAt,
          refreshToken: source.refresh_token,
        },
        expiresAt,
      };
    },
  },
},
```

- [ ] **Step 4: Run plugin tests**

```bash
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
```

Expected: native loopback and CPA import tests PASS.

- [ ] **Step 5: Commit Codex import**

```bash
rtk git add packages/plugins/openai-chatgpt

rtk git commit -m "$(cat <<'EOF'
feat(openai-chatgpt): import CPA Codex credentials

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 5: Convert CPA Antigravity files and recover missing project IDs

**Files:**
- Modify: `packages/plugins/google-antigravity/src/oauth/refresh.test.ts`
- Modify: `packages/plugins/google-antigravity/src/oauth/refresh.ts:1-75`
- Modify: `packages/plugins/google-antigravity/src/plugin.test.ts`
- Modify: `packages/plugins/google-antigravity/src/plugin.ts:1-140`

**Interfaces:**
- Consumes: Task 1 importer contract, `initializeAntigravityProject()`, Google account options, and current refresh HTTP behavior.
- Produces: `exchangeGoogleRefreshToken()` used by runtime refresh and importer; CPA type `antigravity`.

- [ ] **Step 1: Lock a token-only refresh exchange**

In `oauth/refresh.test.ts`, add a test that calls the new function with a prior refresh token/type/scope, returns an upstream access token without a rotated refresh token, and expects:

```ts
{
  accessToken: 'new-access',
  refreshToken: 'refresh-1',
  expiresAt: 1_700_003_600_000,
  tokenType: 'Bearer',
  scope: 'scope-1',
}
```

Also assert the request keeps `aioProxy.traffic === 'control'` and carries the supplied abort signal.

- [ ] **Step 2: Add failing CPA plugin tests**

Add one test to `plugin.test.ts` with an expired CPA file missing `project_id`. Inject fetch responses for token refresh and project load, invoke `adapter.credentialImports.cpa.import(...)`, and assert the request order is token endpoint then project load and the result is:

```ts
{
  fingerprint: 'person@example.com',
  suggestedKey: 'antigravity-person@example.com',
  accountLabel: 'person@example.com',
  credentials: {
    accessToken: 'fresh-access',
    refreshToken: 'refresh-1',
    expiresAt: 1_700_003_600_000,
    email: 'person@example.com',
    projectId: 'project-1',
  },
  expiresAt: 1_700_003_600_000,
}
```

Add a second assertion that a valid `project_id` and `expired` value require no project-initialization request.

- [ ] **Step 3: Run focused tests and confirm the new function/importer are absent**

```bash
rtk bun test \
  packages/plugins/google-antigravity/src/oauth/refresh.test.ts \
  packages/plugins/google-antigravity/src/plugin.test.ts
```

Expected: FAIL because `exchangeGoogleRefreshToken` and the CPA importer do not exist.

- [ ] **Step 4: Extract the existing refresh exchange**

In `oauth/refresh.ts`, add:

```ts
export type GoogleTokenRefreshInput = Pick<GoogleAntigravityCredential, 'refreshToken' | 'tokenType' | 'scope'>;

export type GoogleTokenRefreshResult = Pick<
  GoogleAntigravityCredential,
  'accessToken' | 'refreshToken' | 'expiresAt' | 'tokenType' | 'scope'
>;

export async function exchangeGoogleRefreshToken(
  current: GoogleTokenRefreshInput,
  options: OAuthHttpOptions = {},
): Promise<GoogleTokenRefreshResult> {
  const fetcher: RuntimeFetch = options.fetch ?? globalThis.fetch;
  const response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: current.refreshToken,
      grant_type: 'refresh_token',
    }),
    aioProxy: { traffic: 'control' },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw classifyResponse(response.status, await readErrorPayload(response));
  const payload = await readPayload(response);
  const accessToken = readString(payload, 'access_token');
  const expiresIn = payload['expires_in'];
  if (accessToken === undefined || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 0) {
    throw refreshError(false, 'invalid_payload');
  }
  const refreshToken = readString(payload, 'refresh_token') ?? current.refreshToken;
  const tokenType = readString(payload, 'token_type') ?? current.tokenType;
  const scope = readString(payload, 'scope') ?? current.scope;
  return {
    accessToken,
    refreshToken,
    expiresAt: (options.now ?? Date.now)() + expiresIn * 1_000,
    ...(tokenType === undefined ? {} : { tokenType }),
    ...(scope === undefined ? {} : { scope }),
  };
}
```

Keep the current network-error classification by wrapping the fetch exactly as `refreshGoogleCredential()` currently does. Replace the body of `refreshGoogleCredential()` with a call to `exchangeGoogleRefreshToken()` and merge the result over the original credential so email/project identity remain unchanged.

- [ ] **Step 5: Add the Antigravity CPA importer**

Import `zod` and `exchangeGoogleRefreshToken` in `plugin.ts`. Add:

```ts
const cpaAntigravitySchema = zod
  .object({
    type: zod.literal('antigravity'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    email: zod.email(),
    project_id: zod.string().trim().min(1).optional(),
    expired: zod.unknown().optional(),
    timestamp: zod.number().finite().optional(),
    expires_in: zod.number().finite().nonnegative().optional(),
    token_type: zod.string().trim().min(1).optional(),
    scope: zod.string().trim().min(1).optional(),
  })
  .loose();

function antigravityExpiry(source: zod.infer<typeof cpaAntigravitySchema>): number {
  const parsed = typeof source.expired === 'string' ? Date.parse(source.expired) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (source.timestamp !== undefined && source.expires_in !== undefined) {
    const fallback = source.timestamp + source.expires_in * 1_000;
    return Number.isFinite(fallback) ? fallback : 0;
  }
  return 0;
}
```

Register `types: ['antigravity']`. Its `import` method must parse options/raw, calculate expiry, refresh only when `project_id` is absent and `expiresAt <= now()`, initialize the missing project, and return only normalized fields:

```ts
const parsedOptions = await accountOptions.schema.parseAsync(options);
const source = cpaAntigravitySchema.parse(raw);
const now = dependencies.now ?? Date.now;
let token = {
  accessToken: source.access_token,
  refreshToken: source.refresh_token,
  expiresAt: antigravityExpiry(source),
  ...(source.token_type === undefined ? {} : { tokenType: source.token_type }),
  ...(source.scope === undefined ? {} : { scope: source.scope }),
};
if (source.project_id === undefined && token.expiresAt <= now()) {
  token = await exchangeGoogleRefreshToken(token, {
    fetch: dependencies.fetch ?? context.fetch,
    now: dependencies.now,
    signal: context.signal,
  });
}
const projectId =
  source.project_id ??
  (await initializeAntigravityProject(token.accessToken, parsedOptions, {
    fetch: dependencies.fetch ?? context.fetch,
    sleep: dependencies.sleep,
    signal: context.signal,
  }));
return {
  fingerprint: source.email,
  suggestedKey: `antigravity-${source.email}`,
  accountLabel: source.email,
  credentials: { ...token, email: source.email, projectId },
  expiresAt: token.expiresAt,
};
```

- [ ] **Step 6: Run all Antigravity tests**

```bash
rtk bun run --filter @aio-proxy/plugin-google-antigravity test:unit
```

Expected: refresh, native login, project initialization, and CPA import tests PASS.

- [ ] **Step 7: Commit Antigravity import**

```bash
rtk git add packages/plugins/google-antigravity

rtk git commit -m "$(cat <<'EOF'
feat(google-antigravity): import CPA credentials

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 6: Convert CPA Kimi files with native device/fingerprint rules

**Files:**
- Modify: `packages/plugins/kimi-code/src/oauth.test.ts`
- Modify: `packages/plugins/kimi-code/src/oauth.ts:1-220`
- Modify: `packages/plugins/kimi-code/src/plugin.test.ts`
- Modify: `packages/plugins/kimi-code/src/plugin.ts:1-120`

**Interfaces:**
- Consumes: Kimi credential shape and Task 1 importer contract.
- Produces: `kimiLoginResult(credential)` shared by native login/import and CPA type `kimi`.

- [ ] **Step 1: Add a shared-result regression test**

In `oauth.test.ts`, import `kimiLoginResult` and assert:

```ts
const result = await kimiLoginResult({
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 123,
  deviceId: 'device-1',
});
expect(result).toMatchObject({
  fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
  suggestedKey: expect.stringMatching(/^kimi-[a-f0-9]{12}$/u),
  accountLabel: 'Kimi Code',
  expiresAt: 123,
});
```

- [ ] **Step 2: Add failing CPA importer tests**

In `plugin.test.ts`, create a plugin with `deviceId: () => 'generated-device'`. Invoke the CPA importer once without `device_id` and invalid expiry, and once with an explicit device ID. Assert the first result has `deviceId: 'generated-device'`, `expiresAt: 0`, and a fingerprint equal to `kimiLoginResult()` for the same refresh token; assert the second preserves the explicit ID.

- [ ] **Step 3: Run focused tests and confirm the helper/importer are absent**

```bash
rtk bun test packages/plugins/kimi-code/src/oauth.test.ts packages/plugins/kimi-code/src/plugin.test.ts
```

Expected: FAIL because `kimiLoginResult` and the CPA importer do not exist.

- [ ] **Step 4: Share the native Kimi result constructor**

In `oauth.ts`, add:

```ts
export async function kimiLoginResult(credential: KimiCredential) {
  const fingerprint = await sha256(credential.refreshToken);
  return {
    fingerprint,
    suggestedKey: `kimi-${fingerprint.slice(0, 12)}`,
    accountLabel: 'Kimi Code',
    credentials: credential,
    expiresAt: credential.expiresAt,
  };
}
```

Replace the native login block that separately computes fingerprint and returns the result with:

```ts
return await kimiLoginResult(completeCredential(token, deviceId, now()));
```

- [ ] **Step 5: Add the Kimi CPA importer**

In `plugin.ts`, add:

```ts
const cpaKimiSchema = zod
  .object({
    type: zod.literal('kimi'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    device_id: zod.string().trim().min(1).optional(),
    expired: zod.unknown().optional(),
  })
  .loose();

function cpaExpiresAt(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
```

Import `kimiLoginResult` and register:

```ts
credentialImports: {
  cpa: {
    types: ['kimi'],
    async import(_context, options, raw) {
      await accountOptions.schema.parseAsync(options);
      const source = cpaKimiSchema.parse(raw);
      return await kimiLoginResult({
        accessToken: source.access_token,
        refreshToken: source.refresh_token,
        expiresAt: cpaExpiresAt(source.expired),
        deviceId: source.device_id ?? dependencies.deviceId?.() ?? crypto.randomUUID().replaceAll('-', ''),
      });
    },
  },
},
```

- [ ] **Step 6: Run all Kimi tests**

```bash
rtk bun run --filter @aio-proxy/plugin-kimi-code test:unit
```

Expected: native device login, refresh, runtime, quota, and CPA import tests PASS.

- [ ] **Step 7: Commit Kimi import**

```bash
rtk git add packages/plugins/kimi-code

rtk git commit -m "$(cat <<'EOF'
feat(kimi-code): import CPA credentials

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 7: Convert CPA xAI files with native identity precedence

**Files:**
- Modify: `packages/plugins/xai-grok/src/oauth.login.test.ts`
- Modify: `packages/plugins/xai-grok/src/oauth.ts:1-290`
- Modify: `packages/plugins/xai-grok/src/plugin.test.ts`
- Modify: `packages/plugins/xai-grok/src/plugin.ts:1-105`

**Interfaces:**
- Consumes: `XAIGrokCredential` and Task 1 importer contract.
- Produces: `xaiLoginResult(credential)` shared by native login/import and CPA type `xai`.

- [ ] **Step 1: Add a native identity helper regression test**

In `oauth.login.test.ts`, import `xaiLoginResult` and assert that a credential containing both `email: 'Person@Example.com'` and `subject: 'subject-1'` produces the same fingerprint/suggested key as native device login, labels the account with the email, and preserves the credential.

- [ ] **Step 2: Add failing CPA importer tests**

In `plugin.test.ts`, invoke the importer with:

```ts
{
  type: 'xai',
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expired: '2026-08-24T12:00:00Z',
  email: 'Person@Example.com',
  sub: 'subject-1',
  id_token: 'must-not-persist',
  base_url: 'must-not-persist',
}
```

Assert the credential contains only `accessToken`, `refreshToken`, `expiresAt`, `email`, and `subject`; compare fingerprint/suggested key with `xaiLoginResult()` for the same normalized credential. Add an invalid-expiry case expecting `expiresAt: 0`.

- [ ] **Step 3: Run focused tests and confirm the helper/importer are absent**

```bash
rtk bun test packages/plugins/xai-grok/src/oauth.login.test.ts packages/plugins/xai-grok/src/plugin.test.ts
```

Expected: FAIL because `xaiLoginResult` and the CPA importer do not exist.

- [ ] **Step 4: Share the xAI identity/result constructor**

Replace the private `loginResult` identity block in `oauth.ts` with:

```ts
export function xaiLoginResult(credentials: XAIGrokCredential) {
  let identity = `refresh:${credentials.refreshToken}`;
  if (credentials.email !== undefined) identity = `email:${credentials.email.toLowerCase()}`;
  if (credentials.subject !== undefined) identity = `sub:${credentials.subject}`;
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `grok-${digest.slice(0, 12)}`,
    accountLabel: credentials.email ?? credentials.subject ?? 'xAI Grok',
    credentials,
    expiresAt: credentials.expiresAt,
  };
}
```

Keep token-response validation and claim extraction in the native flow, build `XAIGrokCredential`, then return `xaiLoginResult(credentials)`.

- [ ] **Step 5: Add the xAI CPA importer**

In `plugin.ts`, add:

```ts
const cpaXAISchema = zod
  .object({
    type: zod.literal('xai'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    expired: zod.unknown().optional(),
    email: zod.string().trim().min(1).optional(),
    sub: zod.string().trim().min(1).optional(),
  })
  .loose();

function cpaExpiresAt(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
```

Import `xaiLoginResult` and register:

```ts
credentialImports: {
  cpa: {
    types: ['xai'],
    async import(_context, options, raw) {
      await accountOptions.schema.parseAsync(options);
      const source = cpaXAISchema.parse(raw);
      return xaiLoginResult({
        accessToken: source.access_token,
        refreshToken: source.refresh_token,
        expiresAt: cpaExpiresAt(source.expired),
        ...(source.email === undefined ? {} : { email: source.email }),
        ...(source.sub === undefined ? {} : { subject: source.sub }),
      });
    },
  },
},
```

- [ ] **Step 6: Run all xAI tests**

```bash
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
```

Expected: native device login, refresh, catalog, quota, runtime, and CPA import tests PASS.

- [ ] **Step 7: Commit xAI import**

```bash
rtk git add packages/plugins/xai-grok

rtk git commit -m "$(cat <<'EOF'
feat(xai-grok): import CPA credentials

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 8: Implement deterministic CLI file discovery and batch presentation

**Files:**
- Create: `packages/cli/src/plugin-commands/provider-import/index.ts`
- Create: `packages/cli/src/plugin-commands/provider-import/provider-import.ts`
- Create: `packages/cli/src/plugin-commands/provider-import/provider-import.test.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`

**Interfaces:**
- Consumes: `importOAuthAccount()`, `ProviderAccountAlreadyExistsError`, `OAuthCredentialImportUnsupportedError`, `recoverPendingAccountOperations()`, and the reusable default dependencies from provider login.
- Produces: `providerImport(pathInput?: string, injected?: ProviderImportDeps): Promise<void>` and localized per-file/summary output.

- [ ] **Step 1: Add the CLI module tests first**

Create `provider-import.test.ts` using `mkdtempSync`, `mkdirSync`, `writeFileSync`, and cleanup in `afterEach`. Cover these exact behaviors:

1. Omitted path calls injected `cwd()` and imports immediate `a.json`, then `b.json`; nested `nested/c.json` and `ignored.txt` are untouched and not passed to `importAccount`.
2. A supplied file named `auth.data` is imported even without `.json`.
3. A supplied missing path throws `CliExit` code `1` and does not call the dependency factory/importer.
4. Imported, duplicate, unsupported, invalid JSON, and missing-type files each increment only their own category; final failure count throws an empty-message `CliExit` after the summary.
5. Read every source file again after the command and assert byte-for-byte equality.

Use this injected outcome stub:

```ts
importAccount: async ({ type }) => {
  if (type === 'duplicate') throw new ProviderAccountAlreadyExistsError('existing-provider');
  if (type === 'unsupported') throw new OAuthCredentialImportUnsupportedError('cpa', type);
  if (type === 'broken') throw new Error('credential conversion failed');
  return { providerId: `provider-${type}` };
},
```

- [ ] **Step 2: Run the new test and confirm the module is missing**

```bash
rtk bun test packages/cli/src/plugin-commands/provider-import/provider-import.test.ts
```

Expected: FAIL because the provider-import module does not exist.

- [ ] **Step 3: Add exact localized copy to all five catalogs**

Insert an `import` object beside `login`, `list`, and `test` under `cli.provider`.

`en.json`:

```json
"import": {
  "description": "Import CPA OAuth auth files from a file or directory",
  "error_path_not_found": "Import path does not exist: {path}",
  "error_path_kind": "Import path is not a regular file or directory: {path}",
  "status_imported": "Imported {path} as provider {provider}",
  "status_duplicate": "Skipped duplicate {path}; provider {provider} already exists",
  "status_skipped": "Skipped {path}: unsupported auth type {type}",
  "status_failed": "Failed {path}: {reason}",
  "reason_invalid_json": "invalid JSON",
  "reason_invalid_type": "missing or invalid top-level type",
  "reason_unknown": "credential import failed",
  "summary": "Import summary: imported {imported}, duplicate {duplicate}, skipped {skipped}, failed {failed}"
}
```

`zh-Hans.json`:

```json
"import": {
  "description": "从文件或目录导入 CPA OAuth 认证文件",
  "error_path_not_found": "导入路径不存在：{path}",
  "error_path_kind": "导入路径不是普通文件或目录：{path}",
  "status_imported": "已从 {path} 导入提供商 {provider}",
  "status_duplicate": "已跳过重复文件 {path}；提供商 {provider} 已存在",
  "status_skipped": "已跳过 {path}：不支持认证类型 {type}",
  "status_failed": "导入 {path} 失败：{reason}",
  "reason_invalid_json": "JSON 无效",
  "reason_invalid_type": "缺少有效的顶层 type 字段",
  "reason_unknown": "凭证导入失败",
  "summary": "导入汇总：成功 {imported}，重复 {duplicate}，跳过 {skipped}，失败 {failed}"
}
```

`zh-Hant.json`:

```json
"import": {
  "description": "從檔案或目錄匯入 CPA OAuth 驗證檔案",
  "error_path_not_found": "匯入路徑不存在：{path}",
  "error_path_kind": "匯入路徑不是一般檔案或目錄：{path}",
  "status_imported": "已從 {path} 匯入提供者 {provider}",
  "status_duplicate": "已略過重複檔案 {path}；提供者 {provider} 已存在",
  "status_skipped": "已略過 {path}：不支援驗證類型 {type}",
  "status_failed": "匯入 {path} 失敗：{reason}",
  "reason_invalid_json": "JSON 無效",
  "reason_invalid_type": "缺少有效的頂層 type 欄位",
  "reason_unknown": "憑證匯入失敗",
  "summary": "匯入摘要：成功 {imported}，重複 {duplicate}，略過 {skipped}，失敗 {failed}"
}
```

`ja.json`:

```json
"import": {
  "description": "ファイルまたはディレクトリから CPA OAuth 認証ファイルをインポート",
  "error_path_not_found": "インポートパスが存在しません: {path}",
  "error_path_kind": "インポートパスは通常ファイルでもディレクトリでもありません: {path}",
  "status_imported": "{path} をプロバイダー {provider} としてインポートしました",
  "status_duplicate": "重複する {path} をスキップしました。プロバイダー {provider} は既に存在します",
  "status_skipped": "{path} をスキップしました: 未対応の認証タイプ {type}",
  "status_failed": "{path} のインポートに失敗しました: {reason}",
  "reason_invalid_json": "無効な JSON",
  "reason_invalid_type": "有効なトップレベル type がありません",
  "reason_unknown": "認証情報のインポートに失敗しました",
  "summary": "インポート結果: 成功 {imported}、重複 {duplicate}、スキップ {skipped}、失敗 {failed}"
}
```

`ko.json`:

```json
"import": {
  "description": "파일 또는 디렉터리에서 CPA OAuth 인증 파일 가져오기",
  "error_path_not_found": "가져오기 경로가 없습니다: {path}",
  "error_path_kind": "가져오기 경로가 일반 파일 또는 디렉터리가 아닙니다: {path}",
  "status_imported": "{path} 파일을 공급자 {provider}(으)로 가져왔습니다",
  "status_duplicate": "중복 파일 {path}을(를) 건너뛰었습니다. 공급자 {provider}이(가) 이미 있습니다",
  "status_skipped": "{path}을(를) 건너뛰었습니다: 지원하지 않는 인증 유형 {type}",
  "status_failed": "{path} 가져오기 실패: {reason}",
  "reason_invalid_json": "잘못된 JSON",
  "reason_invalid_type": "유효한 최상위 type 필드가 없습니다",
  "reason_unknown": "자격 증명 가져오기에 실패했습니다",
  "summary": "가져오기 요약: 성공 {imported}, 중복 {duplicate}, 건너뜀 {skipped}, 실패 {failed}"
}
```

Compile generated Paraglide accessors before importing these keys from TypeScript:

```bash
rtk bun run i18n:compile
```

- [ ] **Step 4: Implement path discovery**

In `provider-import.ts`, use `resolve()` only after distinguishing an omitted argument:

```ts
async function importFiles(pathInput: string | undefined, cwd: () => string): Promise<readonly string[]> {
  const root = resolve(pathInput === undefined ? cwd() : pathInput);
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new CliExit(EXIT.unrecoverable, m['cli.provider.import.error_path_not_found']({ path: root }));
    }
    throw error;
  }
  if (info.isFile()) return [root];
  if (!info.isDirectory()) {
    throw new CliExit(EXIT.unrecoverable, m['cli.provider.import.error_path_kind']({ path: root }));
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => join(root, entry.name));
}
```

Add a local `isErrnoException()` type guard that checks `error instanceof Error && 'code' in error`; do not add a utility package.

- [ ] **Step 5: Implement sequential classification and summary**

Define:

```ts
export type ProviderImportDeps = {
  readonly config: AtomicConfigFile;
  readonly repository: PluginRepository;
  readonly registry: PluginRegistry;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly recover: typeof recoverPendingAccountOperations;
  readonly importAccount: typeof importOAuthAccount;
  readonly cwd: () => string;
  readonly print: (line: string) => void;
  readonly close?: () => void;
};

type ImportCounts = { imported: number; duplicate: number; skipped: number; failed: number };
```

Build defaults by adapting the existing provider-login dependency constructor instead of duplicating config/database/plugin loading:

```ts
async function createProviderImportDefaultDeps(): Promise<ProviderImportDeps> {
  const deps = await createProviderLoginDefaultDeps();
  return {
    config: deps.config,
    repository: deps.repository,
    registry: deps.registry,
    diagnostics: deps.diagnostics,
    logger: deps.logger,
    recover: recoverPendingAccountOperations,
    importAccount: importOAuthAccount,
    cwd: () => process.cwd(),
    print: deps.print,
    close: deps.close,
  };
}
```

Implement `providerImport()` so it resolves files before opening default DB dependencies and recovers pending operations once. Process `for (const file of files)` sequentially. Read with `await Bun.file(file).text()`, classify a `SyntaxError` from `JSON.parse(text)` as `reason_invalid_json`, and classify a file-read rejection with `safeReason(error)`. Validate the top-level `type` with a local record guard and `trim()` before calling core.

Use these catch branches:

```ts
if (error instanceof ProviderAccountAlreadyExistsError) {
  counts.duplicate += 1;
  deps.print(m['cli.provider.import.status_duplicate']({ path: file, provider: error.existingProviderId }));
  continue;
}
if (error instanceof OAuthCredentialImportUnsupportedError) {
  counts.skipped += 1;
  deps.print(m['cli.provider.import.status_skipped']({ path: file, type: JSON.stringify(error.type) }));
  continue;
}
counts.failed += 1;
deps.print(m['cli.provider.import.status_failed']({ path: file, reason: safeReason(error) }));
```

Classify missing/blank/non-string top-level `type` as `reason_invalid_type`. `safeReason()` returns a non-empty `Error.message` or `m['cli.provider.import.reason_unknown']()`; it never stringifies the raw file or error object.

After the loop:

```ts
deps.print(m['cli.provider.import.summary'](counts));
if (counts.failed > 0) throw new CliExit(EXIT.unrecoverable, '');
```

Always close only dependencies created by the module in `finally`. The injected test dependency is caller-owned.

Create `index.ts` with exports only:

```ts
export { providerImport, type ProviderImportDeps } from './provider-import';
```

- [ ] **Step 6: Re-run i18n and CLI module tests**

```bash
rtk bun run --filter @aio-proxy/i18n test:unit
rtk bun test packages/cli/src/plugin-commands/provider-import/provider-import.test.ts
```

Expected: locale parity and all path/outcome/source-preservation tests PASS.

- [ ] **Step 7: Commit the CLI import module and copy**

```bash
rtk git add \
  packages/cli/src/plugin-commands/provider-import \
  packages/i18n/messages/en.json \
  packages/i18n/messages/zh-Hans.json \
  packages/i18n/messages/zh-Hant.json \
  packages/i18n/messages/ja.json \
  packages/i18n/messages/ko.json

rtk git commit -m "$(cat <<'EOF'
feat(cli): import CPA auth files

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 9: Register the command, add release notes, and verify end to end

**Files:**
- Modify: `packages/cli/src/provider-commands.ts:1-45`
- Modify: `packages/cli/src/main.ts:1-130`
- Modify: `packages/cli/__tests__/provider-commands.test.ts:1-70`
- Create: `.changeset/cpa-oauth-auth-import.md`

**Interfaces:**
- Consumes: `providerImport(pathInput?: string)` from Task 8 and `cli.provider.import.description` from i18n.
- Produces: public `aio-proxy provider import [path]` command and lockstep minor release note.

- [ ] **Step 1: Add failing command integration tests**

Append to `provider-commands.test.ts`:

```ts
test('provider import exposes an optional path', () => {
  const result = runCli(['provider', 'import', '--help']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('[path]');
  expect(result.stdout.toString()).toContain('Import CPA OAuth auth files');
});

test('provider import rejects a supplied nonexistent path', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-import-'));
  try {
    const missing = join(root, 'missing');
    const result = runCli(['provider', 'import', missing]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`Import path does not exist: ${missing}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the integration test and confirm the command is unknown**

```bash
rtk bun test packages/cli/__tests__/provider-commands.test.ts
```

Expected: FAIL because `provider import` is not registered.

- [ ] **Step 3: Wire the façade and Commander command**

In `provider-commands.ts`, import the module and add:

```ts
import { providerImport as pluginProviderImport } from './plugin-commands/provider-import';
```

```ts
export async function providerImport(path: string | undefined): Promise<void> {
  await pluginProviderImport(path);
}
```

In `main.ts`, include `providerImport` in the provider-command import and register it between `login` and `test`:

```ts
provider
  .command('import [path]')
  .description(m['cli.provider.import.description']())
  .action((path) => providerImport(path));
```

- [ ] **Step 4: Add the lockstep minor Changeset**

Create `.changeset/cpa-oauth-auth-import.md`:

```md
---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/cli': minor
'@aio-proxy/i18n': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-xai-grok': minor
---

Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.
```

- [ ] **Step 5: Run focused package verification**

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
rtk bun run --filter @aio-proxy/plugin-google-antigravity test:unit
rtk bun run --filter @aio-proxy/plugin-kimi-code test:unit
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
rtk bun run --filter @aio-proxy/i18n test:unit
rtk bun run --filter @aio-proxy/cli test:unit
```

Expected: every command exits `0`.

- [ ] **Step 6: Run repository checks and full preflight**

```bash
rtk bun run check
rtk bun run preflight
```

Expected: lint, type-aware lint, format check, unit tests, and artifact tests exit `0`.

- [ ] **Step 7: Inspect the final diff for scope and source safety**

```bash
rtk git diff --check
rtk git status --short
rtk git diff --stat
rtk rg -n "unlink|rmSync|rename|writeFile|writeText" packages/cli/src/plugin-commands/provider-import
```

Expected:

- `git diff --check` exits `0`.
- Only the planned files and Changeset are present.
- The provider-import production module has no source deletion, rename, or write call.
- No Dashboard, migration, lockfile, or dependency file changed.

- [ ] **Step 8: Commit command wiring and release note**

```bash
rtk git add \
  packages/cli/src/provider-commands.ts \
  packages/cli/src/main.ts \
  packages/cli/__tests__/provider-commands.test.ts \
  .changeset/cpa-oauth-auth-import.md

rtk git commit -m "$(cat <<'EOF'
feat(cli): expose CPA provider import

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

## Self-review

1. **Spec coverage:** Tasks 1-3 define plugin ownership and reuse the account transaction; Tasks 4-7 cover all four CPA types and exact normalization rules; Task 8 covers omitted/exact-file/directory paths, non-recursive sorting, sequential outcomes, exit behavior, localization, and source preservation; Task 9 covers command exposure, release notes, and full verification.
2. **Placeholder scan:** The plan contains concrete signatures, test cases, message catalogs, commands, and expected results. Task 3 identifies the exact current statement range that moves into the shared function; no unresolved implementation marker belongs in source.
3. **Type consistency:** `OAuthCredentialImporter.import()` returns `OAuthLoginResult<Credential>`; registry preserves that shape; `importOAuthAccount()` returns the existing `{ providerId: string }`; CLI catches the existing duplicate error and the new unsupported-import error.
4. **Boundary consistency:** CLI never maps vendor types, plugins never inspect filesystem paths, core never parses CPA vendor fields, and source files remain read-only.
5. **Release consistency:** The Changeset includes both product packages and every affected internal package at `minor`, satisfying the fixed-version release rules.
