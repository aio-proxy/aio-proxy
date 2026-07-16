import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zod } from "@aio-proxy/plugin-sdk";
import { type Diagnostic, providerLoginCommand } from "@aio-proxy/types";
import { type OpenDbHandle, openDb } from "../../src/db";
import {
  CredentialRefreshLeaseLostError,
  CredentialRefreshTimeoutError,
  CredentialValidationError,
  createCredentialPort,
} from "../../src/plugins/credential-port";
import type { DiagnosticFactory, PluginLogSink } from "../../src/plugins/diagnostic";
import { type AccountWrite, createPluginRepository, type PluginRepository } from "../../src/plugins/repository";

const childPath = fileURLToPath(new URL("./refresh-lease-child.ts", import.meta.url));
const homes: string[] = [];

afterEach(() => {
  jest.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function account(providerId: string, credential: unknown = { token: "initial-secret" }): AccountWrite {
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

function createAccount(repository: PluginRepository, value: AccountWrite): void {
  const pending = repository.stageAccountOperation({ kind: "create", targetDigest: "create", account: value });
  repository.completeAccountOperation(pending.operationId);
}

function refreshCredential(repository: PluginRepository, expectedRevision: number, credential: unknown): void {
  const owner = crypto.randomUUID();
  const now = Date.now();
  if (!repository.tryAcquireRefreshLease("provider-1", owner, now, now + 60_000)) throw new Error("lease unavailable");
  try {
    repository.compareAndSwapCredential("provider-1", expectedRevision, owner, credential);
  } finally {
    repository.releaseRefreshLease("provider-1", owner);
  }
}

function openFixture(providerIds: readonly string[] = ["provider-1"]): {
  readonly home: string;
  readonly handle: OpenDbHandle;
  readonly repository: PluginRepository;
} {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-credential-port-"));
  homes.push(home);
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  for (const providerId of providerIds) createAccount(repository, account(providerId));
  return { home, handle, repository };
}

function diagnosticFactory(): DiagnosticFactory {
  return (code, options): Diagnostic => ({
    code,
    summary: "Credential refresh failed",
    retryable: options.retryable,
    occurredAt: "2026-07-15T00:00:00.000Z",
    ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
  });
}

function port(
  repository: PluginRepository,
  providerId = "provider-1",
  overrides: {
    readonly schema?: Parameters<typeof createCredentialPort>[0]["schema"];
    readonly diagnostics?: DiagnosticFactory;
    readonly logger?: PluginLogSink;
    readonly onDiagnosticChanged?: () => void;
    readonly onCredentialChanged?: () => void;
    readonly pluginSecrets?: unknown;
  } = {},
) {
  return createCredentialPort({
    providerId,
    schema: overrides.schema ?? zod.object({ token: zod.string() }),
    repository,
    diagnostics: overrides.diagnostics ?? diagnosticFactory(),
    logger: overrides.logger ?? (() => {}),
    onDiagnosticChanged: overrides.onDiagnosticChanged ?? (() => {}),
    onCredentialChanged: overrides.onCredentialChanged ?? (() => {}),
    pluginSecrets: overrides.pluginSecrets,
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function childOutput(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const [output, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`child failed (${exitCode}): ${stderr}`);
  return output;
}

async function waitForLine(child: Bun.Subprocess<"ignore", "pipe", "pipe">, expected: string): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(expected)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`child exited before printing ${expected}`);
    output += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
}

describe("credential refresh coordination", () => {
  test("deduplicates concurrent refresh calls for one provider in one process", async () => {
    const { handle, repository } = openFixture();
    try {
      const credentials = port(repository);
      const first = await credentials.read();
      const gate = deferred();
      let exchanges = 0;
      const exchange = async () => {
        exchanges += 1;
        await gate.promise;
        return { value: { token: "next-secret" } };
      };

      const leftPromise = credentials.refresh(first.revision, exchange);
      const rightPromise = port(repository).refresh(first.revision, exchange);
      await Promise.resolve();
      gate.resolve();
      const [left, right] = await Promise.all([leftPromise, rightPromise]);

      expect(exchanges).toBe(1);
      expect(left).toEqual(right);
      expect(left.status).toBe("updated");
    } finally {
      handle.close();
    }
  });

  test("does not share a refresh flight across repositories with the same provider id", async () => {
    const firstFixture = openFixture();
    const secondFixture = openFixture();
    const firstGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    try {
      const first = port(firstFixture.repository);
      const second = port(secondFixture.repository);
      const firstSnapshot = await first.read();
      const secondSnapshot = await second.read();
      const firstRefresh = first.refresh(firstSnapshot.revision, async () => {
        firstStarted.resolve();
        await firstGate.promise;
        return { value: { token: "first-repository-token" } };
      });
      await firstStarted.promise;

      const secondRefresh = second.refresh(secondSnapshot.revision, async () => {
        secondStarted.resolve();
        return { value: { token: "second-repository-token" } };
      });

      expect(await Promise.race([secondStarted.promise.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
      expect(await secondRefresh).toMatchObject({
        status: "updated",
        snapshot: { value: { token: "second-repository-token" } },
      });
      firstGate.resolve();
      await firstRefresh;
    } finally {
      firstGate.resolve();
      firstFixture.handle.close();
      secondFixture.handle.close();
    }
  });

  test("does not serialize refresh exchanges for different providers", async () => {
    const { handle, repository } = openFixture(["provider-1", "provider-2"]);
    try {
      const firstGate = deferred();
      const firstStarted = deferred();
      const first = port(repository, "provider-1");
      const second = port(repository, "provider-2");
      const firstSnapshot = await first.read();
      const secondSnapshot = await second.read();
      const blocked = first.refresh(firstSnapshot.revision, async () => {
        firstStarted.resolve();
        await firstGate.promise;
        return { value: { token: "first-next" } };
      });
      await firstStarted.promise;

      const independent = await second.refresh(secondSnapshot.revision, async () => ({
        value: { token: "second-next" },
      }));

      expect(independent.status).toBe("updated");
      firstGate.resolve();
      await blocked;
    } finally {
      handle.close();
    }
  });

  test("allows exactly one exchange across two processes sharing one SQLite database", async () => {
    const { home, handle, repository } = openFixture();
    const expectedRevision = repository.readAccount("provider-1")?.revision;
    if (expectedRevision === undefined) throw new Error("missing fixture account");
    handle.close();
    const spawn = () =>
      Bun.spawn([process.execPath, childPath, "refresh", home, "provider-1", String(expectedRevision)], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });

    const outputs = await Promise.all([childOutput(spawn()), childOutput(spawn())]);

    expect(outputs.join("").match(/^exchange$/gim)).toHaveLength(1);
    expect(outputs.join("").match(new RegExp(`^expected:${expectedRevision}$`, "gim"))).toHaveLength(2);
    expect(outputs.join("").match(/^updated$/gim)).toHaveLength(1);
    expect(outputs.join("").match(/^superseded$/gim)).toHaveLength(1);
  });

  test("takes over an expired lease after its owner process is killed", async () => {
    const { home, handle, repository } = openFixture();
    const owner = Bun.spawn([process.execPath, childPath, "hold", home, "provider-1", "150"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(owner, "acquired");
    owner.kill();
    await owner.exited;

    try {
      const credentials = port(repository);
      const current = await credentials.read();
      const result = await credentials.refresh(current.revision, async () => ({ value: { token: "after-kill" } }));
      expect(result.status).toBe("updated");
    } finally {
      handle.close();
    }
  });

  test("returns superseded without exchange when the revision changes while waiting for a lease", async () => {
    const { handle, repository } = openFixture();
    try {
      const credentials = port(repository);
      const current = await credentials.read();
      expect(repository.tryAcquireRefreshLease("provider-1", "other-owner", Date.now(), Date.now() + 5_000)).toBe(true);
      let exchanges = 0;
      const refreshing = credentials.refresh(current.revision, async () => {
        exchanges += 1;
        return { value: { token: "must-not-run" } };
      });
      await Bun.sleep(20);
      repository.compareAndSwapCredential("provider-1", current.revision, "other-owner", { token: "new-login" });
      repository.releaseRefreshLease("provider-1", "other-owner");

      const result = await refreshing;
      expect(result).toMatchObject({ status: "superseded", snapshot: { value: { token: "new-login" } } });
      expect(exchanges).toBe(0);
    } finally {
      handle.close();
    }
  });

  test("rejects terminally when an exchanged rotating token loses its lease without a revision winner", async () => {
    const { home, handle, repository } = openFixture();
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

  test("validates exchanged credentials before CAS and never puts credentials or original errors in diagnostics", async () => {
    const { handle, repository } = openFixture();
    const logs: Parameters<PluginLogSink>[0][] = [];
    let notifications = 0;
    let diagnosticSummary = "Credential refresh failed";
    try {
      refreshCredential(repository, 1, { token: "valid-initial-secret" });
      const credentials = port(repository, "provider-1", {
        schema: zod.object({ token: zod.string().startsWith("valid-") }),
        diagnostics: (code, options) => ({
          code,
          summary: diagnosticSummary,
          retryable: options.retryable,
          occurredAt: "2026-07-15T00:00:00.000Z",
        }),
        logger: (entry) => logs.push(entry),
        onDiagnosticChanged: () => {
          notifications += 1;
        },
      });
      const current = await credentials.read();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          credentials.refresh(current.revision, async () => ({ value: { token: "invalid-refreshed-secret" } })),
        ).rejects.toBeInstanceOf(CredentialValidationError);
      }
      expect(notifications).toBe(1);

      diagnosticSummary = "Credential refresh failed again";
      await expect(
        credentials.refresh(current.revision, async () => ({ value: { token: "invalid-refreshed-secret" } })),
      ).rejects.toBeInstanceOf(CredentialValidationError);

      expect(repository.readAccount("provider-1")).toMatchObject({
        credential: { token: "valid-initial-secret" },
        revision: 2,
      });
      expect(repository.readDiagnostics("provider-1")).toHaveLength(1);
      expect(repository.readDiagnostics("provider-1")[0]?.summary).toBe("Credential refresh failed again");
      expect(JSON.stringify(repository.readDiagnostics("provider-1"))).not.toMatch(
        /valid-initial-secret|invalid-refreshed-secret/,
      );
      expect(notifications).toBe(2);
      expect(logs).toHaveLength(3);
    } finally {
      handle.close();
    }
  });

  test("preserves the exchange error when the account is concurrently deleted before diagnostic persistence", async () => {
    const { handle, repository } = openFixture();
    try {
      const credentials = port(repository);
      const current = await credentials.read();
      const primary = new Error("upstream rejected the rotating refresh token");

      await expect(
        credentials.refresh(current.revision, async () => {
          repository.deleteAccount("provider-1");
          throw primary;
        }),
      ).rejects.toBe(primary);
    } finally {
      handle.close();
    }
  });

  test("redacts credential, account, and plugin secrets and records terminal re-login guidance", async () => {
    const { handle, repository } = openFixture();
    const logs: Parameters<PluginLogSink>[0][] = [];
    try {
      const credentials = port(repository, "provider-1", {
        logger: (entry) => logs.push(entry),
        pluginSecrets: { apiKey: "plugin-secret" },
      });
      const current = await credentials.read();
      const failure = new Error("initial-secret account-secret plugin-secret");
      failure.stack = `Error: initial-secret account-secret plugin-secret\n at refresh`;

      await expect(credentials.refresh(current.revision, async () => Promise.reject(failure))).rejects.toBe(failure);

      const serializedLog = JSON.stringify(logs);
      expect(serializedLog).not.toMatch(/initial-secret|account-secret|plugin-secret/u);
      expect(serializedLog.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(3);
      expect(repository.readDiagnostics("provider-1")).toEqual([
        expect.objectContaining({
          code: "CREDENTIAL_REFRESH_FAILED",
          retryable: false,
          suggestedCommand: providerLoginCommand("provider-1"),
        }),
      ]);
    } finally {
      handle.close();
    }
  });

  test("returns superseded when re-login wins during exchange and leaves its runtime revision unchanged", async () => {
    const { handle, repository } = openFixture();
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
    const { handle, repository } = openFixture();
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

  async function expectRenewalFailure(renewRefreshLease: PluginRepository["renewRefreshLease"]): Promise<void> {
    const { handle, repository } = openFixture();
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

  test("aborts and rejects refresh immediately when lease renewal loses ownership", async () => {
    await expectRenewalFailure(() => false);
  });

  test("aborts and rejects refresh immediately when lease renewal throws", async () => {
    await expectRenewalFailure(() => {
      throw new Error("database unavailable");
    });
  });

  async function expectCurrentValidationRenewalFailure(
    renewRefreshLease: PluginRepository["renewRefreshLease"],
    rejectLateValidation = false,
  ): Promise<void> {
    const { handle, repository } = openFixture();
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

  test("rejects before exchange when lease renewal loses ownership during current credential validation", async () => {
    await expectCurrentValidationRenewalFailure(() => false);
  });

  test("contains renewal and late validation errors before exchange when current credential validation is slow", async () => {
    await expectCurrentValidationRenewalFailure(() => {
      throw new Error("database unavailable");
    }, true);
  });

  test("rejects without CAS when the lease is lost during refreshed credential validation", async () => {
    const { handle, repository } = openFixture();
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

  test("refresh changes only credential revision and notifies once when clearing an existing diagnostic", async () => {
    const { handle, repository } = openFixture();
    let notifications = 0;
    try {
      repository.writeDiagnostic("provider-1", diagnosticFactory()("CREDENTIAL_REFRESH_FAILED", { retryable: true }));
      const credentials = port(repository, "provider-1", {
        onDiagnosticChanged: () => {
          notifications += 1;
        },
      });
      const before = repository.readAccount("provider-1");
      if (before === null) throw new Error("missing fixture account");

      const result = await credentials.refresh(before.revision, async () => ({
        value: { token: "valid-next" },
        metadata: { label: "Rotated", expiresAt: 2 },
      }));

      expect(result.status).toBe("updated");
      expect(repository.readAccount("provider-1")).toMatchObject({
        revision: before.revision + 1,
        runtimeRevision: before.runtimeRevision,
        label: "Rotated",
        expiresAt: 2,
      });
      expect(repository.readDiagnostics("provider-1")).toEqual([]);
      expect(notifications).toBe(1);
    } finally {
      handle.close();
    }
  });
});
