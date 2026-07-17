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
} from "./test-support";

test("exports the specified constants", () => {
  expect(LOGIN_TIMEOUT_MS).toBe(20 * 60_000);
  expect(PENDING_OPERATION_TTL_MS).toBe(30 * 60_000);
  expect(ORPHAN_ACCOUNT_GRACE_MS).toBe(30 * 60_000);
  expect(RECOVERY_DRAIN_RETRY_MS).toBe(5_000);
  expect(ABSENT_PROVIDER_DIGEST).toBe("absent");
});

test("credential schema failure and malformed login metadata perform no write", async () => {
  for (const result of [
    { fingerprint: "person@example.com", suggestedKey: "person", credentials: { nope: true } },
    { fingerprint: " ", suggestedKey: "person", credentials: { token: "new" } },
    { fingerprint: 42, suggestedKey: "person", credentials: { token: "new" } },
    { fingerprint: "person@example.com", suggestedKey: 42, credentials: { token: "new" } },
    { fingerprint: "person@example.com", suggestedKey: "person", label: 42, credentials: { token: "new" } },
    { fingerprint: "person@example.com", suggestedKey: "person", expiresAt: Infinity, credentials: { token: "new" } },
  ]) {
    const state = fixture();
    await expect(
      createAccount(state, { registry: registry({ login: async () => result as never }) }),
    ).rejects.toBeInstanceOf(OAuthLoginResultValidationError);
    expect(state.repository.listAccounts()).toHaveLength(0);
    expect(configOf(state)).toEqual({ plugins: [], providers: {} });
  }
});

test("malformed providers config is not overwritten during login", async () => {
  const state = fixture({ plugins: [], providers: "malformed" });
  await expect(createAccount(state)).rejects.toThrow();
  expect(configOf(state)).toEqual({ plugins: [], providers: "malformed" });
  expect(state.repository.listAccounts()).toHaveLength(0);
});

test("malformed providers config prevents delete staging", async () => {
  const state = fixture({ plugins: [], providers: "malformed" });
  await expect(
    deleteOAuthAccount({ providerId: "person", config: state.config, repository: state.repository }),
  ).rejects.toThrow();
  expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
  expect(configOf(state)).toEqual({ plugins: [], providers: "malformed" });
});

test("typed duplicate error contains only canonical guidance", () => {
  expect(new ProviderAccountAlreadyExistsError("provider-1")).toMatchObject({
    existingProviderId: "provider-1",
    suggestedCommand: "aio-proxy provider login --provider provider-1",
  });
  expect(new ProviderAccountAlreadyExistsError("provider; echo unsafe")).toMatchObject({
    existingProviderId: "provider; echo unsafe",
    suggestedCommand: "aio-proxy provider login --provider 'provider; echo unsafe'",
  });
});
