import {
  ABSENT_PROVIDER_DIGEST,
  configOf,
  createAccount,
  deleteOAuthAccount,
  expect,
  fixture,
  LOGIN_TIMEOUT_MS,
  OAuthLoginResultValidationError,
  ORPHAN_ACCOUNT_GRACE_MS,
  PENDING_OPERATION_TTL_MS,
  ProviderAccountAlreadyExistsError,
  RECOVERY_DRAIN_RETRY_MS,
  registry,
  test,
} from './test-support';
import { providerEntry, validateStagedOAuthWrite } from './validation';

test('exports the specified constants', () => {
  expect(LOGIN_TIMEOUT_MS).toBe(20 * 60_000);
  expect(PENDING_OPERATION_TTL_MS).toBe(30 * 60_000);
  expect(ORPHAN_ACCOUNT_GRACE_MS).toBe(30 * 60_000);
  expect(RECOVERY_DRAIN_RETRY_MS).toBe(5_000);
  expect(ABSENT_PROVIDER_DIGEST).toBe('absent');
});

test('credential schema failure and malformed login metadata perform no write', async () => {
  for (const result of [
    { fingerprint: 'person@example.com', suggestedKey: 'person', credentials: { nope: true } },
    { fingerprint: ' ', suggestedKey: 'person', credentials: { token: 'new' } },
    { fingerprint: 42, suggestedKey: 'person', credentials: { token: 'new' } },
    { fingerprint: 'person@example.com', suggestedKey: 42, credentials: { token: 'new' } },
    { fingerprint: 'person@example.com', suggestedKey: 'person', accountLabel: 42, credentials: { token: 'new' } },
    { fingerprint: 'person@example.com', suggestedKey: 'person', expiresAt: Infinity, credentials: { token: 'new' } },
  ]) {
    const state = fixture();
    await expect(
      createAccount(state, { registry: registry({ login: async () => result as never }) }),
    ).rejects.toBeInstanceOf(OAuthLoginResultValidationError);
    expect(state.repository.listAccounts()).toHaveLength(0);
    expect(configOf(state)).toEqual({ plugins: [], providers: {} });
  }
});

test('malformed providers config is not overwritten during login', async () => {
  const state = fixture({ plugins: [], providers: 'malformed' });
  await expect(createAccount(state)).rejects.toThrow();
  expect(configOf(state)).toEqual({ plugins: [], providers: 'malformed' });
  expect(state.repository.listAccounts()).toHaveLength(0);
});

test('malformed providers config prevents delete staging', async () => {
  const state = fixture({ plugins: [], providers: 'malformed' });
  await expect(
    deleteOAuthAccount({ providerId: 'person', config: state.config, repository: state.repository }),
  ).rejects.toThrow();
  expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
  expect(configOf(state)).toEqual({ plugins: [], providers: 'malformed' });
});

// A hand-edited `models` on an oauth provider became both active and validated on this branch, so the
// rejection a user hits must name what to go fix. The bare schema throw said `["models", 0]` and never
// said which provider, which is unactionable in a config with several.
test('a rejected staged oauth write names the offending provider id and field', () => {
  const candidate = {
    plugins: [],
    providers: {
      'my-claude': { kind: 'oauth', plugin: '@example/oauth', capability: 'default', models: [''] },
    },
  };
  expect(() => validateStagedOAuthWrite(candidate)).toThrow(/my-claude/u);
  expect(() => validateStagedOAuthWrite(candidate)).toThrow(/models/u);
});

test('typed duplicate error contains only canonical guidance', () => {
  expect(new ProviderAccountAlreadyExistsError('provider-1')).toMatchObject({
    existingProviderId: 'provider-1',
    suggestedCommand: 'aio-proxy provider login --provider provider-1',
  });
  expect(new ProviderAccountAlreadyExistsError('provider; echo unsafe')).toMatchObject({
    existingProviderId: 'provider; echo unsafe',
    suggestedCommand: "aio-proxy provider login --provider 'provider; echo unsafe'",
  });
});

test('providerEntry keeps the existing models whitelist and lets the patch replace it', () => {
  const existing = { kind: 'oauth', plugin: 'p', capability: 'c', enabled: true, models: ['a'] };
  expect(providerEntry('p', 'c', {}, existing, undefined, undefined)['models']).toEqual(['a']);
  const patch = { name: undefined, enabled: true, weight: undefined, alias: undefined, models: ['b'] };
  expect(providerEntry('p', 'c', {}, existing, undefined, patch)['models']).toEqual(['b']);
  // An empty whitelist is the editor's "expose the whole upstream catalog", so it must survive as `[]`
  // and not be confused with the omitted-field case below.
  expect(providerEntry('p', 'c', {}, existing, undefined, { ...patch, models: [] })['models']).toEqual([]);
});

// Kills the mutant that restores any of these to `patch === undefined ? existing?.[k] : patch.k`,
// under which a patch that omits the field erases a value the user authored.
test('providerEntry retains every stored field a patch does not mention', () => {
  const existing = {
    kind: 'oauth',
    plugin: 'p',
    capability: 'c',
    enabled: false,
    weight: 7,
    name: 'Personal',
    alias: { chat: { model: 'a' } },
    models: ['a'],
    proxy: 'http://proxy.example:8080',
    transforms: [{ kind: 'drop-empty-text' }],
    metadata: { a: { name: 'A' } },
  };
  // The shape a partial surface sends: enabled only, every optional field absent.
  const entry = providerEntry('p', 'c', {}, existing, undefined, { enabled: false } as never);
  expect(entry).toMatchObject({
    name: 'Personal',
    alias: { chat: { model: 'a' } },
    models: ['a'],
    proxy: 'http://proxy.example:8080',
    transforms: [{ kind: 'drop-empty-text' }],
    metadata: { a: { name: 'A' } },
  });
});

// `''` is what the editor's optional display-name input sends when a user clears it (D-F5), and it is
// the only "clear" signal that survives JSON — an omitted key now means "retain". So it must drop the
// key rather than write an empty string into the user's config file.
test('providerEntry treats a blank patched display name as clearing it', () => {
  const existing = { kind: 'oauth', plugin: 'p', capability: 'c', enabled: true, name: 'Personal' };
  const patch = { name: '', enabled: true, weight: undefined, alias: undefined } as never;
  expect('name' in providerEntry('p', 'c', {}, existing, undefined, patch)).toBe(false);
});

// Weight deliberately keeps the clobbering idiom: `{ weight: undefined }` is `{}` after JSON, so an
// omitted key is the only "absent" signal the editor's number input has. Retaining here would make a
// cleared weight unreachable over the wire.
test('providerEntry lets a patch clear a stored weight', () => {
  const existing = { kind: 'oauth', plugin: 'p', capability: 'c', enabled: true, weight: 7 };
  const patch = { name: undefined, enabled: true, weight: undefined, alias: undefined };
  expect('weight' in providerEntry('p', 'c', {}, existing, undefined, patch)).toBe(false);
  expect(providerEntry('p', 'c', {}, existing, undefined, { ...patch, weight: 3 })['weight']).toBe(3);
});
