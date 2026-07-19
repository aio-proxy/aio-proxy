import { afterEach, expect, test } from "bun:test";
import { CredentialRefreshError, zod } from "@aio-proxy/plugin-sdk";
import { providerLoginCommand } from "@aio-proxy/types";
import type { PluginLogSink } from "../diagnostic";
import { CredentialValidationError } from "../index";
import type { PluginRepository } from "../repository/index";
import { createFixtureScope, port } from "./test-support";

const fixtures = createFixtureScope();

afterEach(() => fixtures.cleanup());

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

test("validates exchanged credentials before CAS and never puts credentials or original errors in diagnostics", async () => {
  const { handle, repository } = fixtures.open();
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
  const { handle, repository } = fixtures.open();
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
  const { handle, repository } = fixtures.open();
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

test("confirmed invalid_grant preserves the old credential and records permanent re-login guidance", async () => {
  const { handle, repository } = fixtures.open();
  try {
    const credentials = port(repository);
    const current = await credentials.read();
    await expect(
      credentials.refresh(current.revision, async () => {
        throw new CredentialRefreshError("Google token refresh failed", {
          retryable: false,
          reason: "invalid_grant",
          status: 400,
        });
      }),
    ).rejects.toThrow("Google token refresh failed");

    expect(await credentials.read()).toEqual(current);
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

test("refresh failure redaction skips hostile nested plugin secret properties and collects later array values", async () => {
  const { handle, repository } = fixtures.open();
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "blocked", {
    enumerable: true,
    get() {
      throw new Error("blocked getter");
    },
  });
  const tokens = ["refresh-array-secret", ""];
  Object.assign(nested, { tokens, cycle: nested });
  const logs: Parameters<PluginLogSink>[0][] = [];
  try {
    const credentials = port(repository, "provider-1", {
      logger: (entry) => logs.push(entry),
      pluginSecrets: { nested },
    });
    tokens.push("later-runtime-secret");
    const current = await credentials.read();
    const failure = new Error("refresh-array-secret later-runtime-secret");

    await expect(credentials.refresh(current.revision, async () => Promise.reject(failure))).rejects.toBe(failure);

    expect(JSON.stringify(logs)).not.toContain("refresh-array-secret");
    expect(JSON.stringify(logs)).not.toContain("later-runtime-secret");
  } finally {
    handle.close();
  }
});
