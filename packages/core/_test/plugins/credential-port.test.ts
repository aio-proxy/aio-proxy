import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zod } from "@aio-proxy/plugin-sdk";
import type { Diagnostic } from "@aio-proxy/types";
import { type OpenDbHandle, openDb } from "../../src/db";
import {
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
    secrets: {},
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
  } = {},
) {
  return createCredentialPort({
    providerId,
    schema: overrides.schema ?? zod.object({ token: zod.string() }),
    repository,
    diagnostics: overrides.diagnostics ?? diagnosticFactory(),
    logger: overrides.logger ?? (() => {}),
    onDiagnosticChanged: overrides.onDiagnosticChanged ?? (() => {}),
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
      repository.compareAndSwapCredential("provider-1", current.revision, { token: "new-login" });
      repository.releaseRefreshLease("provider-1", "other-owner");

      const result = await refreshing;
      expect(result).toMatchObject({ status: "superseded", snapshot: { value: { token: "new-login" } } });
      expect(exchanges).toBe(0);
    } finally {
      handle.close();
    }
  });

  test("validates exchanged credentials before CAS and never puts credentials or original errors in diagnostics", async () => {
    const { handle, repository } = openFixture();
    const logs: Parameters<PluginLogSink>[0][] = [];
    let notifications = 0;
    let diagnosticSummary = "Credential refresh failed";
    try {
      repository.compareAndSwapCredential("provider-1", 1, { token: "valid-initial-secret" });
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
