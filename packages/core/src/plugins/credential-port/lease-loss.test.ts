import { zod } from "@aio-proxy/plugin-sdk";
import { providerLoginCommand } from "@aio-proxy/types";
import { afterEach, expect, jest, test } from "bun:test";

import { openDb } from "../../db";
import { CredentialRefreshLeaseLostError, CredentialRefreshTimeoutError } from "../index";
import { type AccountWrite, createPluginRepository, type PluginRepository } from "../repository/index";
import { createFixtureScope, deferred, port } from "./test-support";

const fixtures = createFixtureScope();

afterEach(() => {
  jest.useRealTimers();
  fixtures.cleanup();
});

function account(providerId: string, credential: unknown): AccountWrite {
  return {
    providerId,
    plugin: "@aio-proxy/example",
    capability: "oauth",
    fingerprint: `${providerId}-fingerprint`,
    options: {},
    secrets: { clientSecret: "account-secret" },
    credential,
    label: "Example",
    expiresAt: 1,
    catalog: {
      kind: "replace",
      value: {
        catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
        refreshedAt: 1,
      },
    },
  };
}

async function expectRenewalFailure(renewRefreshLease: PluginRepository["renewRefreshLease"]): Promise<void> {
  const { handle, repository } = fixtures.open();
  const exchangeGate = deferred();
  let signal: AbortSignal | undefined;
  try {
    const credentials = port({ ...repository, renewRefreshLease });
    const current = await credentials.read();
    jest.useFakeTimers();
    const refreshing = credentials.refresh(current.revision, async (_snapshot, deadlineSignal) => {
      signal = deadlineSignal;
      await exchangeGate.promise;
      return { value: { token: "must-not-be-written" } };
    });
    let rejection: unknown;
    void refreshing.catch((error: unknown) => {
      rejection = error;
    });
    jest.advanceTimersByTime(0);
    for (let index = 0; index < 50 && signal === undefined; index++) await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(15_000);
    for (let index = 0; index < 20 && rejection === undefined; index++) await Promise.resolve();
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("refresh lease");
    expect(signal?.aborted).toBe(true);
    expect(repository.readAccount("provider-1")).toMatchObject({
      credential: { token: "initial-secret" },
      revision: current.revision,
    });
    expect(repository.tryAcquireRefreshLease("provider-1", "next-owner", Date.now(), Date.now() + 1_000)).toBe(true);
  } finally {
    exchangeGate.resolve();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    handle.close();
  }
}

async function expectCurrentValidationRenewalFailure(
  renewRefreshLease: PluginRepository["renewRefreshLease"],
  rejectLateValidation = false,
): Promise<void> {
  const { handle, repository } = fixtures.open();
  const validationGate = deferred();
  let validationStarted = false;
  let exchanges = 0;
  const schema = zod.object({ token: zod.string() }).superRefine(async () => {
    validationStarted = true;
    await validationGate.promise;
    if (rejectLateValidation) throw new Error("late current validation failure");
  });
  const current = repository.readAccount("provider-1");
  if (current === null) throw new Error("missing fixture account");
  jest.useFakeTimers();
  const refreshing = port({ ...repository, renewRefreshLease }, "provider-1", { schema }).refresh(
    current.revision,
    async () => {
      exchanges += 1;
      return { value: { token: "must-not-exchange" } };
    },
  );
  let rejection: unknown;
  void refreshing.catch((error: unknown) => {
    rejection = error;
  });
  try {
    jest.advanceTimersByTime(0);
    for (let index = 0; index < 50 && !validationStarted; index++) await Promise.resolve();
    expect(validationStarted).toBe(true);
    jest.advanceTimersByTime(15_000);
    for (let index = 0; index < 20 && rejection === undefined; index++) await Promise.resolve();
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("refresh lease");
    expect(exchanges).toBe(0);
    expect(repository.readAccount("provider-1")).toMatchObject({
      credential: { token: "initial-secret" },
      revision: current.revision,
    });
    expect(repository.tryAcquireRefreshLease("provider-1", "next-owner", Date.now(), Date.now() + 1_000)).toBe(true);
  } finally {
    validationGate.resolve();
    await refreshing.catch(() => {});
    for (let index = 0; index < 10; index++) await Promise.resolve();
    handle.close();
  }
}

test("rejects terminally when an exchanged rotating token loses its lease without a revision winner", async () => {
  const { home, handle, repository } = fixtures.open();
  const competingHandle = openDb({ home });
  const competing = createPluginRepository(competingHandle.sqlite);
  let exchanges = 0;
  try {
    const credentials = port(repository);
    const current = await credentials.read();
    const refreshing = credentials.refresh(current.revision, async () => {
      exchanges += 1;
      competingHandle.sqlite
        .query("UPDATE oauth_refresh_lease SET expires_at = 0 WHERE provider_id = ?")
        .run("provider-1");
      const now = Date.now();
      expect(competing.tryAcquireRefreshLease("provider-1", "winner", now, now + 60_000)).toBe(true);
      return { value: { token: "consumed-rotating-token" } };
    });

    await expect(refreshing).rejects.toBeInstanceOf(CredentialRefreshLeaseLostError);
    expect(exchanges).toBe(1);
    expect(repository.readAccount("provider-1")).toMatchObject({
      credential: { token: "initial-secret" },
      revision: current.revision,
    });
    expect(repository.readDiagnostics("provider-1")).toEqual([
      expect.objectContaining({
        code: "CREDENTIAL_REFRESH_FAILED",
        retryable: false,
        suggestedCommand: providerLoginCommand("provider-1"),
      }),
    ]);
  } finally {
    competing.releaseRefreshLease("provider-1", "winner");
    competingHandle.close();
    handle.close();
  }
});

test("returns superseded when re-login wins during exchange and leaves its runtime revision unchanged", async () => {
  const { handle, repository } = fixtures.open();
  try {
    const credentials = port(repository);
    const current = await credentials.read();
    const exchangeStarted = deferred();
    const exchangeGate = deferred();
    const refreshing = credentials.refresh(current.revision, async () => {
      exchangeStarted.resolve();
      await exchangeGate.promise;
      return { value: { token: "stale-refresh" } };
    });
    await exchangeStarted.promise;
    const relogin = repository.stageAccountOperation({
      kind: "update",
      targetDigest: "re-login",
      expectedRuntimeRevision: 1,
      account: account("provider-1", { token: "re-login-winner" }),
    });
    repository.completeAccountOperation(relogin.operationId);
    exchangeGate.resolve();

    const result = await refreshing;
    expect(result).toMatchObject({
      status: "superseded",
      snapshot: { value: { token: "re-login-winner" }, revision: 2 },
    });
    expect(repository.readAccount("provider-1")?.runtimeRevision).toBe(2);
  } finally {
    handle.close();
  }
});

test("aborts at the 30 second deadline and releases the lease even when exchange ignores abort", async () => {
  const { handle, repository } = fixtures.open();
  let signal: AbortSignal | undefined;
  try {
    const credentials = port(repository);
    const current = await credentials.read();
    jest.useFakeTimers();
    const refreshing = credentials.refresh(current.revision, async (_snapshot, deadlineSignal) => {
      signal = deadlineSignal;
      return new Promise(() => {});
    });
    jest.advanceTimersByTime(0);
    for (let index = 0; index < 50 && signal === undefined; index++) await Promise.resolve();
    expect(signal?.aborted).toBe(false);

    jest.advanceTimersByTime(30_000);
    for (let index = 0; index < 10; index++) await Promise.resolve();

    await expect(refreshing).rejects.toBeInstanceOf(CredentialRefreshTimeoutError);
    expect(signal?.aborted).toBe(true);
    expect(repository.tryAcquireRefreshLease("provider-1", "next-owner", Date.now(), Date.now() + 1_000)).toBe(true);
  } finally {
    handle.close();
  }
});

test("aborts and rejects refresh immediately when lease renewal loses ownership", async () => {
  await expectRenewalFailure(() => false);
});

test("aborts and rejects refresh immediately when lease renewal throws", async () => {
  await expectRenewalFailure(() => {
    throw new Error("database unavailable");
  });
});

test("rejects before exchange when lease renewal loses ownership during current credential validation", async () => {
  await expectCurrentValidationRenewalFailure(() => false);
});

test("contains renewal and late validation errors before exchange when current credential validation is slow", async () => {
  await expectCurrentValidationRenewalFailure(() => {
    throw new Error("database unavailable");
  }, true);
});

test("rejects without CAS when the lease is lost during refreshed credential validation", async () => {
  const { handle, repository } = fixtures.open();
  const validationGate = deferred();
  let validationCount = 0;
  let refreshedValidationStarted = false;
  let exchangeSignal: AbortSignal | undefined;
  let exchanges = 0;
  const schema = zod.object({ token: zod.string() }).superRefine(async () => {
    validationCount += 1;
    if (validationCount === 2) {
      refreshedValidationStarted = true;
      await validationGate.promise;
    }
  });
  const current = repository.readAccount("provider-1");
  if (current === null) throw new Error("missing fixture account");
  jest.useFakeTimers();
  const refreshing = port({ ...repository, renewRefreshLease: () => false }, "provider-1", { schema }).refresh(
    current.revision,
    async (_snapshot, signal) => {
      exchanges += 1;
      exchangeSignal = signal;
      return { value: { token: "must-not-be-written" } };
    },
  );
  let rejection: unknown;
  void refreshing.catch((error: unknown) => {
    rejection = error;
  });

  try {
    jest.advanceTimersByTime(0);
    for (let index = 0; index < 100 && !refreshedValidationStarted; index++) await Promise.resolve();
    expect(refreshedValidationStarted).toBe(true);
    expect(exchanges).toBe(1);
    expect(exchangeSignal?.aborted).toBe(false);

    jest.advanceTimersByTime(15_000);
    for (let index = 0; index < 20 && rejection === undefined; index++) await Promise.resolve();

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("refresh lease");
    expect(exchangeSignal?.aborted).toBe(true);
    expect(repository.readAccount("provider-1")).toMatchObject({
      credential: { token: "initial-secret" },
      revision: current.revision,
    });
    expect(repository.tryAcquireRefreshLease("provider-1", "next-owner", Date.now(), Date.now() + 1_000)).toBe(true);
  } finally {
    validationGate.resolve();
    await refreshing.catch(() => {});
    for (let index = 0; index < 10; index++) await Promise.resolve();
    handle.close();
  }
});
