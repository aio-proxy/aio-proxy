# OAuth Account Email Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every built-in OAuth Provider show a normalized email as its account label when the provider exposes one, without changing identity, routing, or login success.

**Architecture:** Keep extraction, normalization, fallback, and refresh preservation inside each OAuth plugin. `accountLabel` becomes `normalizedEmail ?? currentFallback`. Fingerprints, suggested keys, Provider IDs, and host contracts stay unchanged. No SDK, Server, or Dashboard change.

**Tech Stack:** TypeScript 7, Bun 1.4, `bun:test`, existing plugin-local JWT/userinfo parsers, Changesets.

**Spec:** [docs/superpowers/specs/2026-08-31-oauth-account-email-labels-design.md](../specs/2026-08-31-oauth-account-email-labels-design.md)

## Global Constraints

- Email extraction is presentation-only. Missing or invalid email must not fail an otherwise valid login or import, except Google Antigravity which already requires userinfo email.
- Normalize emails with `trim()` then `toLowerCase()`. Treat an empty result as missing.
- Do not change `fingerprint`, `suggestedKey`, Provider IDs, duplicate detection, authorization, or routing.
- Do not add a public SDK `email` field. Do not inspect plugin-private credentials from Server or Dashboard.
- Do not add a cross-plugin email utility. Each plugin keeps a local normalizer or claim reader.
- When a plugin already uses provider-returned email as fingerprint/key input, keep that original identity input and derive a separate normalized presentation email.
- Refresh precedence: refreshed token/userinfo email, then current credential email, then omit `accountLabel` so the host keeps the existing label. Never overwrite a known email with a service name or opaque ID.
- Raw tokens, token responses, and GitHub email bodies must not enter errors, logs, diagnostics, labels, or generated Provider IDs.
- No database migration. Credential email fields are optional.
- Do not change Kimi's fingerprint algorithm.
- Workspace is already an isolated git worktree. Do not create or switch worktrees.
- Prefix every shell command with `rtk`.
- Every commit must end with `Co-authored-by: Codex <noreply@openai.com>`.
- User-visible release note is a patch changeset targeting `aio-proxy` plus every materially changed plugin package, at the same patch level. Do not target only internal plugin packages. Do not add a plugin-sdk changelog entry.

---

## File map

- `packages/plugins/openai-chatgpt/src/jwt.ts` — ChatGPT JWT email extraction and local normalization.
- `packages/plugins/openai-chatgpt/src/schema.ts` — optional credential `email`.
- `packages/plugins/openai-chatgpt/src/oauth-flow.ts` — persist email from `id_token` then access token; refresh preserves prior email.
- `packages/plugins/openai-chatgpt/src/plugin.ts` — native/CPA labels and optional stored email.
- `packages/plugins/openai-chatgpt/src/runtime/runtime.ts` — refresh metadata uses email when present.
- `packages/plugins/cursor/src/jwt/jwt.ts` — label becomes email fallback `Cursor`.
- `packages/plugins/cursor/src/oauth/credential.ts` — refresh email update/preservation and metadata.
- `packages/plugins/kimi-code/src/oauth.ts` — JWT email extraction, optional credential email, login/CPA label.
- `packages/plugins/kimi-code/src/plugin.ts` — optional credential schema email.
- `packages/plugins/kimi-code/src/oauth/credential.ts` — refresh email update/preservation and metadata.
- `packages/plugins/github-copilot/src/schema.ts` — GitHub emails list schema.
- `packages/plugins/github-copilot/src/github-api/login.ts` — request `user:email`, select primary verified email.
- `packages/plugins/github-copilot/__tests__/test-support.ts` — mock `/user/emails`.
- `packages/plugins/google-antigravity/src/plugin.ts` — normalized presentation email, unchanged identity input.
- `packages/plugins/xai-grok/src/oauth.ts` — normalize stored/display email before identity presentation.
- `.changeset/oauth-account-email-labels.md` — patch release note.

---

### Task 1: Extract and persist ChatGPT email from tokens

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/jwt.ts`
- Modify: `packages/plugins/openai-chatgpt/__tests__/crypto.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/schema.ts`
- Modify: `packages/plugins/openai-chatgpt/src/oauth-flow.ts`
- Modify: `packages/plugins/openai-chatgpt/src/oauth-flow.test.ts`

**Interfaces:**
- Consumes: existing `decodeJwt` / `extractAccountId` token parsing.
- Produces: `normalizeChatGPTEmail(value: string | undefined): string | undefined`; `extractEmail(token: string): string | undefined`; optional `ChatGPTCredential.email`; `refreshAccessToken(refreshToken, options)` retains `options.email` when rotated tokens omit email.

- [ ] **Step 1: Write failing JWT and token-exchange tests**

Add to `packages/plugins/openai-chatgpt/__tests__/crypto.test.ts` after the `extractAccountId` describe:

```ts
describe('extractEmail', () => {
  test('normalizes a JWT email claim', () => {
    expect(extractEmail(buildJwt({ email: '  Person@Example.COM ' }))).toBe('person@example.com');
  });

  test('treats blank and malformed tokens as missing', () => {
    expect(extractEmail(buildJwt({ email: '   ' }))).toBeUndefined();
    expect(extractEmail('not-a-jwt')).toBeUndefined();
  });
});
```

Import `extractEmail` from `../src/jwt`.

In `packages/plugins/openai-chatgpt/src/oauth-flow.test.ts`, add:

```ts
test('prefers id_token email over access-token email and normalizes it', async () => {
  const response = await exchangeCodeForTokens('code-123', 'verifier-123', {
    fetch: createTokenFetchMock(
      {
        access_token: buildJwt({ chatgpt_account_id: 'access-account', email: 'access@example.com' }),
        expires_in: 900,
        id_token: buildJwt({ chatgpt_account_id: 'id-account', email: '  Person@Example.COM ' }),
        refresh_token: 'refresh-123',
      },
      new URLSearchParams({
        client_id: CHATGPT_CLIENT_ID,
        code: 'code-123',
        code_verifier: 'verifier-123',
        grant_type: 'authorization_code',
        redirect_uri: 'http://localhost:1455/auth/callback',
      }),
    ),
    now: () => 1_700_000_000_000,
    redirectUri: 'http://localhost:1455/auth/callback',
  });

  expect(response.email).toBe('person@example.com');
  expect(response.accountId).toBe('access-account');
});

test('falls back to access-token email when id_token has none', async () => {
  const response = await exchangeCodeForTokens('code-123', 'verifier-123', {
    fetch: createTokenFetchMock(
      {
        access_token: buildJwt({ chatgpt_account_id: 'access-account', email: 'Access@Example.com' }),
        refresh_token: 'refresh-123',
      },
      new URLSearchParams({
        client_id: CHATGPT_CLIENT_ID,
        code: 'code-123',
        code_verifier: 'verifier-123',
        grant_type: 'authorization_code',
        redirect_uri: 'http://localhost:1455/auth/callback',
      }),
    ),
    redirectUri: 'http://localhost:1455/auth/callback',
  });

  expect(response.email).toBe('access@example.com');
});

test('keeps the previous credential email when refresh tokens omit one', async () => {
  const response = await refreshAccessToken('refresh-123', {
    email: 'stored@example.com',
    fetch: createTokenFetchMock(
      {
        access_token: buildJwt({ chatgpt_account_id: 'access-account' }),
        expires_in: 3_600,
      },
      refreshBody('refresh-123'),
    ),
  });

  expect(response.email).toBe('stored@example.com');
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
rtk bun test packages/plugins/openai-chatgpt/__tests__/crypto.test.ts packages/plugins/openai-chatgpt/src/oauth-flow.test.ts
```

Expected: FAIL because `extractEmail` does not exist and credentials have no email.

- [ ] **Step 3: Implement ChatGPT email extraction and credential persistence**

In `packages/plugins/openai-chatgpt/src/jwt.ts`, add:

```ts
export function normalizeChatGPTEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export function extractEmail(token: string): string | undefined {
  let payload: JwtPayload;
  try {
    payload = decodeJwt(token);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }

  const email = Reflect.get(payload, 'email');
  return normalizeChatGPTEmail(typeof email === 'string' ? email : undefined);
}
```

In `schema.ts`, add optional `email?: string` to `ChatGPTCredential`.

In `oauth-flow.ts`, import `extractEmail`. Extend `ChatGPTTokenExchangeOptions` with `readonly email?: string`. Change `toCredential` to:

```ts
function toCredential(
  body: OpenAITokenResponse,
  now: (() => number) | undefined,
  fallbackRefreshToken?: string,
  previousEmail?: string,
): ChatGPTCredential {
  const accountId =
    extractAccountId(body.access_token) ?? (body.id_token === undefined ? undefined : extractAccountId(body.id_token));
  if (accountId === undefined) throw new ChatGPTAccountIdMissingError();

  const refreshToken = body.refresh_token ?? fallbackRefreshToken;
  if (refreshToken === undefined) throw new ChatGPTRefreshTokenMissingError();

  const email =
    (body.id_token === undefined ? undefined : extractEmail(body.id_token)) ??
    extractEmail(body.access_token) ??
    previousEmail;

  return {
    accessToken: body.access_token,
    accountId,
    expiresAt: (now ?? Date.now)() + (body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1_000,
    refreshToken,
    ...(email === undefined ? {} : { email }),
  };
}
```

Pass `options.email` into `toCredential` from `refreshAccessToken`. Native `exchangeCodeForTokens` continues to omit previous email.

- [ ] **Step 4: Re-run the ChatGPT token tests**

Run:

```bash
rtk bun test packages/plugins/openai-chatgpt/__tests__/crypto.test.ts packages/plugins/openai-chatgpt/src/oauth-flow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  packages/plugins/openai-chatgpt/src/jwt.ts \
  packages/plugins/openai-chatgpt/src/schema.ts \
  packages/plugins/openai-chatgpt/src/oauth-flow.ts \
  packages/plugins/openai-chatgpt/src/oauth-flow.test.ts \
  packages/plugins/openai-chatgpt/__tests__/crypto.test.ts

rtk git commit -m "$(cat <<'EOF'
feat(openai-chatgpt): persist normalized OAuth email

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 2: Show ChatGPT email on login, CPA import, and refresh

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/plugin.ts`
- Modify: `packages/plugins/openai-chatgpt/__tests__/adapter.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`

**Interfaces:**
- Consumes: `ChatGPTCredential.email`, `extractEmail`, `normalizeChatGPTEmail` from Task 1.
- Produces: native/CPA `accountLabel: email ?? accountId`; CPA priority `top-level email`, then `id_token`, then access token; refresh metadata `accountLabel` only when the resulting credential has email.

- [ ] **Step 1: Write failing adapter and runtime tests**

In `adapter.test.ts`, keep the existing no-email native login as the account-id fallback. Add:

```ts
test('uses normalized id_token email as the ChatGPT account label', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const redirectUri = 'http://localhost:43123/auth/callback';
  globalThis.fetch = async () =>
    Response.json({
      access_token: buildJwt({ chatgpt_account_id: 'account-123' }),
      id_token: buildJwt({ email: '  Person@Example.COM ' }),
      expires_in: 900,
      refresh_token: 'refresh-token',
    });

  const result = await adapter.login(
    loginContext({
      loopback: async () => ({ code: 'auth-code', redirectUri }),
    }),
    {},
  );

  expect(result.accountLabel).toBe('person@example.com');
  expect(result.fingerprint).toBe('account-123');
  expect(result.suggestedKey).toBe('chatgpt-account-123');
  expect(result.credentials).toMatchObject({ accountId: 'account-123', email: 'person@example.com' });
});
```

Replace the CPA import test that currently ignores `email: 'ignored@example.com'` with:

```ts
test('imports CPA Codex email from the validated top-level field first', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const accessToken = buildJwt({ chatgpt_account_id: 'account-123', email: 'token@example.com' });

  await expect(
    importer.import(
      { progress: () => {}, signal: new AbortController().signal },
      {},
      {
        type: 'codex',
        access_token: accessToken,
        refresh_token: 'refresh-123',
        expired: '2026-08-24T12:00:00Z',
        email: '  Person@Example.COM ',
        id_token: buildJwt({ email: 'id@example.com' }),
      },
    ),
  ).resolves.toEqual({
    fingerprint: 'account-123',
    suggestedKey: 'chatgpt-account-123',
    accountLabel: 'person@example.com',
    credentials: {
      accessToken,
      accountId: 'account-123',
      refreshToken: 'refresh-123',
      expiresAt: Date.parse('2026-08-24T12:00:00Z'),
      email: 'person@example.com',
    },
    expiresAt: Date.parse('2026-08-24T12:00:00Z'),
  });
});

test('imports CPA Codex email from id_token then access token', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const accessToken = buildJwt({ chatgpt_account_id: 'account-123', email: 'access@example.com' });
  const result = await importer.import(
    { progress: () => {}, signal: new AbortController().signal },
    {},
    {
      type: 'codex',
      access_token: accessToken,
      refresh_token: 'refresh-123',
      id_token: buildJwt({ email: 'ID@example.com' }),
    },
  );
  expect(result.accountLabel).toBe('id@example.com');
  expect(result.credentials).not.toHaveProperty('idToken');
});
```

In `runtime.test.ts`, add:

```ts
test('refresh metadata uses stored email when rotated tokens omit one', async () => {
  const originalFetch = globalThis.fetch;
  let metadata: { readonly accountLabel?: string; readonly expiresAt?: number } | undefined;
  const expired = credential({ accessToken: 'expired', expiresAt: 0, email: 'stored@example.com' });
  const credentials: CredentialPort<ChatGPTCredential> = {
    read: async () => ({ revision: 3, value: expired }),
    refresh: async (revision, exchange) => {
      const exchanged = await exchange({ revision, value: expired }, new AbortController().signal);
      metadata = exchanged.metadata;
      return { status: 'updated', snapshot: { revision: revision + 1, value: exchanged.value } };
    },
  };
  globalThis.fetch = async () =>
    Response.json({ access_token: buildJwt({ chatgpt_account_id: 'acct-refreshed' }), expires_in: 60 });

  try {
    const refreshed = await currentCredential(credentials);
    expect(refreshed.email).toBe('stored@example.com');
    expect(metadata).toEqual({ accountLabel: 'stored@example.com', expiresAt: refreshed.expiresAt });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run the adapter and runtime tests and confirm they fail**

Run:

```bash
rtk bun test packages/plugins/openai-chatgpt/__tests__/adapter.test.ts packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts
```

Expected: FAIL on accountLabel/email assertions.

- [ ] **Step 3: Implement ChatGPT presentation mapping**

In `plugin.ts`:

- Add `email: zod.string().optional()` to `adapter.credentials`.
- Native login: `accountLabel: token.email ?? token.accountId`.
- CPA schema: add optional `email: zod.string().optional()` and `id_token: zod.string().optional()`.
- CPA mapping:

```ts
const email =
  normalizeChatGPTEmail(source.email) ??
  (source.id_token === undefined ? undefined : extractEmail(source.id_token)) ??
  extractEmail(source.access_token);
return {
  fingerprint: accountId,
  suggestedKey: `chatgpt-${accountId}`,
  accountLabel: email ?? accountId,
  credentials: {
    accessToken: source.access_token,
    accountId,
    expiresAt,
    refreshToken: source.refresh_token,
    ...(email === undefined ? {} : { email }),
  },
  expiresAt,
};
```

Do not persist `id_token`.

In `runtime.ts` `currentCredential` refresh callback:

```ts
const refreshed = await refreshAccessToken(value.refreshToken, {
  fetch: fetcher,
  signal,
  ...(value.email === undefined ? {} : { email: value.email }),
});
return {
  value: refreshed,
  metadata: {
    expiresAt: refreshed.expiresAt,
    ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
  },
};
```

- [ ] **Step 4: Re-run ChatGPT presentation tests**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  packages/plugins/openai-chatgpt/src/plugin.ts \
  packages/plugins/openai-chatgpt/__tests__/adapter.test.ts \
  packages/plugins/openai-chatgpt/src/runtime/runtime.ts \
  packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts

rtk git commit -m "$(cat <<'EOF'
feat(openai-chatgpt): display OAuth email as account label

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 3: Use Cursor JWT email as the account label

**Files:**
- Modify: `packages/plugins/cursor/src/jwt/jwt.ts`
- Modify: `packages/plugins/cursor/src/jwt/jwt.test.ts`
- Modify: `packages/plugins/cursor/src/oauth/credential.ts`
- Modify: `packages/plugins/cursor/src/oauth/oauth.login.test.ts`
- Modify: `packages/plugins/cursor/src/oauth/oauth.refresh.test.ts`

**Interfaces:**
- Consumes: existing `cursorIdentity` JWT email claim.
- Produces: `cursorIdentity.label = email ?? 'Cursor'`; refresh stores `identityEmail ?? current.email`; refresh metadata includes `accountLabel` only when that email exists.

- [ ] **Step 1: Write failing Cursor identity and refresh tests**

In `jwt.test.ts`, add:

```ts
test('uses normalized JWT email as the Cursor account label', () => {
  const identity = cursorIdentity({ accessToken: jwt({ sub: 'user-1', email: 'A@B.com' }) });
  expect(identity.label).toBe('a@b.com');
});

test('falls back to Cursor when the JWT has a subject but no email', () => {
  expect(cursorIdentity({ accessToken: jwt({ sub: 'user-1' }) }).label).toBe('Cursor');
});
```

Keep the existing login test with `{ sub: 'u1', exp: 4_000 }` expecting `accountLabel: 'Cursor'`. Add:

```ts
test('returns the JWT email as the Cursor account label', async () => {
  const { ctx } = context();
  const result = await loginCursor(
    ctx,
    { waiting: 'Waiting' },
    {
      now: () => 0,
      sleep: async () => {},
      uuid: () => 'uuid-1',
      fetch: async () =>
        new Response(
          JSON.stringify({ accessToken: jwt({ sub: 'u1', email: 'A@B.com', exp: 4_000 }), refreshToken: 'r1' }),
          { status: 200 },
        ),
    },
  );
  expect(result.accountLabel).toBe('a@b.com');
  expect(result.credentials.email).toBe('a@b.com');
  expect(result.fingerprint.startsWith('sha256:')).toBe(true);
});
```

In `oauth.refresh.test.ts`, replace the metadata expectation that currently hardcodes `accountLabel: 'Cursor'`. Add:

```ts
test('refresh keeps the current Cursor email when the new token omits one', async () => {
  const next = await refreshCursorCredential(
    { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 0, email: 'stored@example.com' },
    { now: () => 0, fetch: async () => okResponse({ accessToken: jwt({ exp: 4_000, sub: 'u1' }) }) },
  );
  expect(next.email).toBe('stored@example.com');
});

test('refresh metadata omits accountLabel when no email is available', async () => {
  const stale = { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000 };
  const rotated = jwt({ sub: 'u1', exp: 10_000 });
  let metadata: { accountLabel?: string; expiresAt?: number } | undefined;
  const port = {
    read: async () => ({ value: stale, revision: 7 }),
    refresh: async (
      expectedRevision: number,
      exchange: (
        current: { value: typeof stale; revision: number },
        signal: AbortSignal,
      ) => Promise<{ value: { accessToken: string; refreshToken: string; expiresAt: number; email?: string } }>,
    ) => {
      expect(expectedRevision).toBe(7);
      const result = await exchange({ value: stale, revision: 7 }, new AbortController().signal);
      metadata = Reflect.get(result, 'metadata');
      return { status: 'updated' as const, snapshot: { value: result.value, revision: 8 } };
    },
  };
  await currentCursorCredential(port, {
    now: () => 5_000,
    fetch: async () => okResponse({ accessToken: rotated }),
  });
  expect(metadata).toEqual({ expiresAt: 10_000 * 1000 - 5 * 60_000 });
});
```

Update the existing `currentCursorCredential refreshes through the port` test: if the rotated JWT has no email, metadata must not include `accountLabel: 'Cursor'`.

- [ ] **Step 2: Run Cursor tests and confirm they fail**

Run:

```bash
rtk bun test packages/plugins/cursor/src/jwt/jwt.test.ts packages/plugins/cursor/src/oauth/oauth.login.test.ts packages/plugins/cursor/src/oauth/oauth.refresh.test.ts
```

Expected: FAIL because `label` is still `'Cursor'` and refresh metadata still hardcodes that service name.

- [ ] **Step 3: Implement Cursor label and refresh preservation**

In `jwt.ts`, change `label: 'Cursor'` to `label: email ?? 'Cursor'`. Do not change fingerprint/key calculation.

Export a non-throwing email reader:

```ts
export function cursorIdentityEmail(accessToken: string): string | undefined {
  return readClaim(readCursorClaims(accessToken), 'email')?.toLowerCase();
}
```

Do not call `cursorIdentity()` during refresh; that function throws when both subject and email are missing.

In `credential.ts` `refreshCursorCredential`:

```ts
const email = cursorIdentityEmail(token.accessToken) ?? current.email;
return {
  ...current,
  accessToken: token.accessToken,
  refreshToken: token.refreshToken ?? current.refreshToken,
  expiresAt: cursorTokenExpiry(token.accessToken, now()),
  ...(email === undefined ? {} : { email }),
};
```

In `currentCursorCredential` metadata:

```ts
return {
  value: refreshed,
  metadata: {
    expiresAt: refreshed.expiresAt,
    ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
  },
};
```

- [ ] **Step 4: Re-run Cursor OAuth tests**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-cursor test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  packages/plugins/cursor/src/jwt/jwt.ts \
  packages/plugins/cursor/src/jwt/jwt.test.ts \
  packages/plugins/cursor/src/oauth/credential.ts \
  packages/plugins/cursor/src/oauth/oauth.login.test.ts \
  packages/plugins/cursor/src/oauth/oauth.refresh.test.ts

rtk git commit -m "$(cat <<'EOF'
feat(cursor): display JWT email as OAuth account label

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 4: Use Kimi JWT email as the account label

**Files:**
- Modify: `packages/plugins/kimi-code/src/oauth.ts`
- Modify: `packages/plugins/kimi-code/src/oauth.test.ts`
- Modify: `packages/plugins/kimi-code/src/plugin.ts`
- Modify: `packages/plugins/kimi-code/src/plugin.test.ts`
- Modify: `packages/plugins/kimi-code/src/oauth/credential.ts`

**Interfaces:**
- Consumes: Kimi access/refresh JWT payloads.
- Produces: optional `KimiCredential.email`; `kimiLoginResult.accountLabel = email ?? 'Kimi Code'`; refresh preserves/updates email and sets metadata `accountLabel` when email exists. Fingerprint remains `sha256(refreshToken)`.

- [ ] **Step 1: Write failing Kimi login, CPA, and refresh tests**

Add this helper to `oauth.test.ts`:

```ts
function kimiJwt(payload: object): string {
  return ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');
}
```

Replace the shared result test coverage with:

```ts
test('uses access-token JWT email as the Kimi account label', async () => {
  const result = await kimiLoginResult({
    accessToken: kimiJwt({ email: '  Person@Example.COM ' }),
    refreshToken: 'refresh',
    expiresAt: 123,
    deviceId: 'device-1',
  });
  expect(result.accountLabel).toBe('person@example.com');
  expect(result.credentials.email).toBe('person@example.com');
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
});

test('falls back to refresh-token JWT email then Kimi Code', async () => {
  const fromRefresh = await kimiLoginResult({
    accessToken: 'opaque-access',
    refreshToken: kimiJwt({ email: 'Refresh@Example.com' }),
    expiresAt: 123,
    deviceId: 'device-1',
  });
  expect(fromRefresh.accountLabel).toBe('refresh@example.com');

  const fallback = await kimiLoginResult({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 123,
    deviceId: 'device-1',
  });
  expect(fallback.accountLabel).toBe('Kimi Code');
});
```

Update login polling success to use JWT access/refresh tokens and expect the email label. Keep fingerprint derived only from refresh token.

Add:

```ts
test('refresh keeps the current Kimi email when rotated tokens omit one', async () => {
  const current: KimiCredential = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: 0,
    deviceId: 'device-1',
    email: 'stored@example.com',
  };
  const refreshed = await refreshKimiCredential(current, {
    now: () => 1_000,
    fetch: sequence([Response.json({ access_token: 'new-access', expires_in: 60 })]),
  });
  expect(refreshed.email).toBe('stored@example.com');
});
```

Update `currentKimiCredential` metadata assertion from `{ expiresAt: 500_000 }` to include `accountLabel` when the new or current credential has email.

In `plugin.test.ts`, assert CPA import of JWT tokens sets `accountLabel` from email and still matches `kimiLoginResult(...).fingerprint`.

- [ ] **Step 2: Run Kimi tests and confirm they fail**

Run:

```bash
rtk bun test packages/plugins/kimi-code/src/oauth.test.ts packages/plugins/kimi-code/src/plugin.test.ts
```

Expected: FAIL because `accountLabel` is still `'Kimi Code'`.

- [ ] **Step 3: Implement Kimi JWT email mapping**

In `oauth.ts`, extend `KimiCredential` with `readonly email?: string`. Add local helpers:

```ts
function normalizeKimiEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

function readKimiJwtEmail(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    const value: unknown = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    if (!isPlainObject(value)) return undefined;
    const email = value['email'];
    return normalizeKimiEmail(typeof email === 'string' ? email : undefined);
  } catch {
    return undefined;
  }
}

function kimiCredentialEmail(accessToken: string, refreshToken: string, previous?: string): string | undefined {
  return readKimiJwtEmail(accessToken) ?? readKimiJwtEmail(refreshToken) ?? previous;
}
```

`kimiLoginResult`:

```ts
export async function kimiLoginResult(credential: KimiCredential) {
  const email = kimiCredentialEmail(credential.accessToken, credential.refreshToken, credential.email);
  const credentials = email === undefined ? credential : { ...credential, email };
  const fingerprint = await sha256(credentials.refreshToken);
  return {
    fingerprint,
    suggestedKey: `kimi-${fingerprint.slice(0, 12)}`,
    accountLabel: email ?? 'Kimi Code',
    credentials,
    expiresAt: credentials.expiresAt,
  };
}
```

`completeCredential` should include email from the issued tokens. `refreshKimiCredential` must copy `deviceId`, rotate tokens, and set `email: kimiCredentialEmail(token.accessToken, token.refreshToken ?? current.refreshToken, current.email)`.

In `currentKimiCredential` metadata:

```ts
metadata: {
  expiresAt: refreshed.expiresAt,
  ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
},
```

In `plugin.ts`, add `email: zod.string().optional()` to `adapter.credentials`.

- [ ] **Step 4: Re-run Kimi tests**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-kimi-code test:unit
```

Expected: PASS. Fingerprint tests still hash the refresh token only.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  packages/plugins/kimi-code/src/oauth.ts \
  packages/plugins/kimi-code/src/oauth.test.ts \
  packages/plugins/kimi-code/src/plugin.ts \
  packages/plugins/kimi-code/src/plugin.test.ts \
  packages/plugins/kimi-code/src/oauth/credential.ts

rtk git commit -m "$(cat <<'EOF'
feat(kimi-code): display JWT email as OAuth account label

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 5: Use GitHub Copilot primary verified email as the account label

**Files:**
- Modify: `packages/plugins/github-copilot/src/schema.ts`
- Modify: `packages/plugins/github-copilot/src/github-api/login.ts`
- Modify: `packages/plugins/github-copilot/src/github-api/login.test.ts`
- Modify: `packages/plugins/github-copilot/__tests__/test-support.ts`

**Interfaces:**
- Consumes: existing GitHub user lookup for numeric fingerprint.
- Produces: device-code scope `read:user user:email`; `accountLabel` from primary+verified `/user/emails`, else GitHub login; unchanged `fingerprint`/`suggestedKey` from numeric user id.

- [ ] **Step 1: Write failing GitHub email tests**

Update `deviceFlowFetch` so `/user/emails` can be customized:

```ts
export function deviceFlowFetch(
  options: {
    readonly expiresIn?: number;
    readonly interval?: number;
    readonly tokenResponses?: readonly Record<string, string>[];
    readonly emails?: unknown;
    readonly emailsStatus?: number;
    readonly onRequest?: (url: URL) => void;
    readonly onTokenPoll?: () => void;
  } = {},
): typeof fetch {
  const tokenResponses = [...(options.tokenResponses ?? [{ access_token: 'github-token' }])];
  return async (input) => {
    const url = new URL(input.toString());
    options.onRequest?.(url);
    if (url.pathname === '/login/device/code') {
      return Response.json({
        device_code: 'device',
        user_code: 'ABCD',
        verification_uri: 'https://github.com/login/device',
        verification_uri_complete: 'https://github.com/login/device?user_code=ABCD',
        interval: options.interval ?? 0,
        expires_in: options.expiresIn ?? 600,
      });
    }
    if (url.pathname === '/login/oauth/access_token') {
      options.onTokenPoll?.();
      return Response.json(tokenResponses.shift() ?? tokenResponses.at(-1) ?? { error: 'authorization_pending' });
    }
    if (url.pathname === '/copilot_internal/v2/token') {
      return Response.json({
        token: 'tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;',
        expires_at: 9_999_999_999,
      });
    }
    if (url.pathname === '/user') return Response.json({ id: 12345, login: 'octocat' });
    if (url.pathname === '/user/emails') {
      if (options.emailsStatus !== undefined) return new Response('unavailable', { status: options.emailsStatus });
      return Response.json(options.emails ?? [{ email: '  Octocat@GitHub.com ', primary: true, verified: true }]);
    }
    return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
  };
}
```

In `login.test.ts`, update the persistence-free login assertion:

- `accountLabel: 'octocat@github.com'`
- requested paths include `/user/emails` after `/user`
- fingerprint remains `'12345'`

Add:

```ts
test('requests the GitHub email scope during device authorization', async () => {
  const bodies: string[] = [];
  await withFetchMock(
    async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === '/login/device/code') bodies.push(String(init?.body));
      return deviceFlowFetch()(input, init);
    },
    () => loginToGitHubCopilot(loginContext(), { deploymentType: 'github.com' }),
  );
  expect(bodies[0]).toContain('read:user user:email');
});

test('falls back to GitHub login when emails are unavailable or unverified', async () => {
  const missing = await withFetchMock(deviceFlowFetch({ emailsStatus: 404 }), () =>
    loginToGitHubCopilot(loginContext(), { deploymentType: 'github.com' }),
  );
  expect(missing.accountLabel).toBe('octocat');
  expect(missing.fingerprint).toBe('12345');

  const unverified = await withFetchMock(
    deviceFlowFetch({ emails: [{ email: 'hidden@example.com', primary: true, verified: false }] }),
    () => loginToGitHubCopilot(loginContext(), { deploymentType: 'github.com' }),
  );
  expect(unverified.accountLabel).toBe('octocat');

  const invalid = await withFetchMock(deviceFlowFetch({ emails: { email: 'nope@example.com' } }), () =>
    loginToGitHubCopilot(loginContext(), { deploymentType: 'github.com' }),
  );
  expect(invalid.accountLabel).toBe('octocat');
});
```

- [ ] **Step 2: Run GitHub login tests and confirm they fail**

Run:

```bash
rtk bun test packages/plugins/github-copilot/src/github-api/login.test.ts packages/plugins/github-copilot/src/plugin.test.ts
```

Expected: FAIL because scope is still `read:user` and label is still `octocat`.

- [ ] **Step 3: Implement GitHub email lookup**

In `schema.ts`:

```ts
export const githubEmailsResponseSchema = zod.array(
  zod
    .object({
      email: zod.string(),
      primary: zod.boolean().optional(),
      verified: zod.boolean().optional(),
    })
    .loose(),
);
```

In `login.ts`, change device-code scope to `'read:user user:email'`. After `fetchGitHubUser`, call a new helper that never throws into login:

```ts
async function fetchGitHubPrimaryEmail(
  apiBase: string,
  githubToken: string,
  signal: AbortSignal,
  fetcher: RuntimeFetch,
): Promise<string | undefined> {
  try {
    const emails = await fetchJson(
      `${apiBase}/user/emails`,
      { headers: authHeaders(githubToken), signal },
      githubEmailsResponseSchema,
      fetcher,
    );
    const match = emails.find((entry) => entry.primary === true && entry.verified === true);
    const email = match?.email.trim().toLowerCase();
    return email === undefined || email === '' ? undefined : email;
  } catch {
    return undefined;
  }
}
```

Label mapping:

```ts
const email = await fetchGitHubPrimaryEmail(apiBase, githubToken, context.signal, fetcher);
const accountLabel = email ?? user.login;
return {
  fingerprint: user.id,
  suggestedKey: `copilot-${user.id}`,
  ...(accountLabel === undefined ? {} : { accountLabel }),
  credentials: { ... },
  expiresAt: copilot.expires,
};
```

Keep `/user` required and failing when the numeric id cannot be read.

- [ ] **Step 4: Re-run GitHub Copilot tests**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  packages/plugins/github-copilot/src/schema.ts \
  packages/plugins/github-copilot/src/github-api/login.ts \
  packages/plugins/github-copilot/src/github-api/login.test.ts \
  packages/plugins/github-copilot/__tests__/test-support.ts \
  packages/plugins/github-copilot/src/plugin.test.ts

rtk git commit -m "$(cat <<'EOF'
feat(github-copilot): display primary verified GitHub email

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 6: Normalize Antigravity presentation email without changing identity

**Files:**
- Modify: `packages/plugins/google-antigravity/src/plugin.ts`
- Modify: `packages/plugins/google-antigravity/src/plugin.test.ts`

**Interfaces:**
- Consumes: existing trimmed Google userinfo/CPA email.
- Produces: `fingerprint`/`suggestedKey` from the existing trimmed identity email; `accountLabel` and `credentials.email` from a separately normalized copy. Missing email remains a login error.

- [ ] **Step 1: Write failing Antigravity normalization tests**

Add to `plugin.test.ts`:

```ts
test('normalizes Antigravity account labels without changing identity input', async () => {
  const adapter = await adapterFrom(
    createGoogleAntigravityPlugin(undefined, {
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
        if (url.includes('oauth2/v2/userinfo')) return Response.json({ email: '  Person@Example.COM ' });
        return Response.json({ cloudaicompanionProject: 'project-1' });
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    }),
  );

  const result = await adapter.login(loginContext(), {});
  expect(result.fingerprint).toBe('Person@Example.COM');
  expect(result.suggestedKey).toBe('antigravity-Person@Example.COM');
  expect(result.accountLabel).toBe('person@example.com');
  expect(result.credentials.email).toBe('person@example.com');
});

test('normalizes CPA Antigravity presentation email without changing identity', async () => {
  const adapter = await adapterFrom(createGoogleAntigravityPlugin());
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const result = await importer.import(
    { progress: () => {}, signal: new AbortController().signal },
    {},
    {
      type: 'antigravity',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      email: 'Person@Example.COM',
      project_id: 'project-1',
      expired: '2026-08-24T12:00:00.000Z',
    },
  );
  expect(result.fingerprint).toBe('Person@Example.COM');
  expect(result.suggestedKey).toBe('antigravity-Person@Example.COM');
  expect(result.accountLabel).toBe('person@example.com');
  expect(result.credentials.email).toBe('person@example.com');
});
```

Keep the existing missing-email rejection test.

- [ ] **Step 2: Run Antigravity plugin tests and confirm they fail**

Run:

```bash
rtk bun test packages/plugins/google-antigravity/src/plugin.test.ts
```

Expected: FAIL because fingerprint currently uses the same string as the label.

- [ ] **Step 3: Implement presentation-only normalization**

Add a local helper in `plugin.ts`:

```ts
function normalizeAntigravityEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}
```

Native login keeps throwing on missing/blank userinfo email. Then:

```ts
const identityEmail = email.trim();
const presentationEmail = normalizeAntigravityEmail(identityEmail) ?? identityEmail;
return {
  fingerprint: identityEmail,
  suggestedKey: `antigravity-${identityEmail}`,
  accountLabel: presentationEmail,
  credentials: { ...token, email: presentationEmail, projectId },
  expiresAt: token.expiresAt,
};
```

CPA import uses `source.email` as `identityEmail` (already schema-validated) and the same presentation copy. Do not change project recovery or refresh token exchange. Existing refresh already uses `value.email` for metadata; newly stored credentials will therefore refresh with the normalized label.

- [ ] **Step 4: Re-run Antigravity tests**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-google-antigravity test:unit
```

Expected: PASS, including missing-email login failure.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  packages/plugins/google-antigravity/src/plugin.ts \
  packages/plugins/google-antigravity/src/plugin.test.ts

rtk git commit -m "$(cat <<'EOF'
feat(google-antigravity): normalize OAuth account email labels

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 7: Normalize xAI Grok email labels

**Files:**
- Modify: `packages/plugins/xai-grok/src/oauth.ts`
- Modify: `packages/plugins/xai-grok/src/oauth.login.test.ts`
- Modify: `packages/plugins/xai-grok/src/plugin.test.ts`

**Interfaces:**
- Consumes: existing claim precedence `email ?? subject ?? 'xAI Grok'`.
- Produces: stored and displayed email after trim/lowercase; unchanged fingerprint algorithm.

- [ ] **Step 1: Write failing Grok normalization tests**

Update `oauth.login.test.ts` successful login expectation from `accountLabel: 'Person@Example.com'` / `email: 'Person@Example.com'` to:

```ts
accountLabel: 'person@example.com',
credentials: expect.objectContaining({ email: 'person@example.com', subject: 'subject-1' }),
```

Update the shared identity test:

```ts
test('shares native identity precedence with CPA import', () => {
  const credentials = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_700_003_600_000,
    email: 'Person@Example.com',
    subject: 'subject-1',
  };
  const digest = new Bun.CryptoHasher('sha256').update('sub:subject-1').digest('hex');
  expect(xaiLoginResult(credentials)).toEqual({
    fingerprint: `sha256:${digest}`,
    suggestedKey: `grok-${digest.slice(0, 12)}`,
    accountLabel: 'person@example.com',
    credentials: { ...credentials, email: 'person@example.com' },
    expiresAt: 1_700_003_600_000,
  });
});
```

Add a fallback case:

```ts
test('falls back to subject then xAI Grok when email is missing', () => {
  expect(xaiLoginResult({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1,
    subject: 'subject-1',
  }).accountLabel).toBe('subject-1');
  expect(xaiLoginResult({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1,
  }).accountLabel).toBe('xAI Grok');
});
```

Update `plugin.test.ts` CPA import to expect normalized email in both `accountLabel` and `credentials.email`.

- [ ] **Step 2: Run Grok tests and confirm they fail**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/oauth.login.test.ts packages/plugins/xai-grok/src/plugin.test.ts
```

Expected: FAIL because labels still preserve original email case.

- [ ] **Step 3: Normalize inside `xaiLoginResult`**

```ts
function normalizeXAIGrokEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export function xaiLoginResult(credentials: XAIGrokCredential) {
  const email = normalizeXAIGrokEmail(credentials.email);
  const normalized = email === undefined ? credentials : { ...credentials, email };
  let identity = `refresh:${normalized.refreshToken}`;
  if (normalized.email !== undefined) identity = `email:${normalized.email}`;
  if (normalized.subject !== undefined) identity = `sub:${normalized.subject}`;
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `grok-${digest.slice(0, 12)}`,
    accountLabel: normalized.email ?? normalized.subject ?? 'xAI Grok',
    credentials: normalized,
    expiresAt: normalized.expiresAt,
  };
}
```

Keep `loginResult()` claim precedence. Do not change refresh fingerprint behavior. If refresh later stores email through `...credential`, the normalized value already on the credential remains.

- [ ] **Step 4: Re-run Grok tests**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  packages/plugins/xai-grok/src/oauth.ts \
  packages/plugins/xai-grok/src/oauth.login.test.ts \
  packages/plugins/xai-grok/src/plugin.test.ts

rtk git commit -m "$(cat <<'EOF'
feat(xai-grok): normalize OAuth account email labels

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 8: Add the patch changeset and verify affected packages

**Files:**
- Create: `.changeset/oauth-account-email-labels.md`

**Interfaces:**
- Consumes: user-visible behavior from Tasks 1–7.
- Produces: one patch changeset targeting `aio-proxy` and every changed plugin package.

- [ ] **Step 1: Add the changeset**

Create `.changeset/oauth-account-email-labels.md`:

```md
---
'@aio-proxy/plugin-openai-chatgpt': patch
'@aio-proxy/plugin-cursor': patch
'@aio-proxy/plugin-kimi-code': patch
'@aio-proxy/plugin-github-copilot': patch
'@aio-proxy/plugin-google-antigravity': patch
'@aio-proxy/plugin-xai-grok': patch
'aio-proxy': patch
---

oauth: show normalized account emails for connected OAuth providers
```

- [ ] **Step 2: Run affected package tests and repo checks**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt --filter @aio-proxy/plugin-cursor --filter @aio-proxy/plugin-kimi-code --filter @aio-proxy/plugin-github-copilot --filter @aio-proxy/plugin-google-antigravity --filter @aio-proxy/plugin-xai-grok test:unit
```

Expected: PASS.

Then:

```bash
rtk bun run check
```

Expected: PASS. If practical in this worktree, also run `rtk bun run preflight`.

- [ ] **Step 3: Commit**

```bash
rtk git add .changeset/oauth-account-email-labels.md

rtk git commit -m "$(cat <<'EOF'
chore: note OAuth account email labels

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

## Self-review

1. Spec coverage: ChatGPT CPA/id_token/access/refresh, Cursor JWT/refresh, Kimi JWT/CPA/refresh, Copilot scope+emails+fallback, Antigravity identity-vs-label split, Grok normalization, no SDK/host change, no migration, patch changeset.
2. Placeholder scan: none; each task includes tests, commands, and code.
3. Type consistency: optional plugin-local `email` fields; `accountLabel` remains `string`; fingerprints unchanged.
