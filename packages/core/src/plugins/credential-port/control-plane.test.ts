import { afterEach, expect, test } from "bun:test";
import type { PluginLogSink } from "../diagnostic";
import { createFixtureScope, port } from "./test-support";

const scope = createFixtureScope();

afterEach(scope.cleanup);

test("control-plane refresh logs failures without persisting routing diagnostics or callbacks", async () => {
  const { repository } = scope.open();
  const logs: Parameters<PluginLogSink>[0][] = [];
  let diagnosticChanges = 0;
  let credentialChanges = 0;
  const credentials = port(repository, "provider-1", {
    logger: (entry) => logs.push(entry),
    mode: "control-plane",
    onDiagnosticChanged: () => diagnosticChanges++,
    onCredentialChanged: () => credentialChanges++,
    additionalSecretValues: ["plugin-secret"],
  });
  const before = repository.readDiagnostics("provider-1");
  const current = await credentials.read();

  await expect(
    credentials.refresh(current.revision, async () => {
      throw new Error("refresh failed with plugin-secret");
    }),
  ).rejects.toThrow("refresh failed with plugin-secret");

  expect(logs).toHaveLength(1);
  expect(logs[0]?.code).toBe("CREDENTIAL_REFRESH_FAILED");
  expect(logs[0]?.error.message).toBe("refresh failed with [REDACTED]");
  expect(repository.readDiagnostics("provider-1")).toEqual(before);
  expect(diagnosticChanges).toBe(0);
  expect(credentialChanges).toBe(0);
});

test("control-plane refresh preserves an existing diagnostic while retaining CAS metadata and result semantics", async () => {
  const { repository } = scope.open();
  repository.writeDiagnostic("provider-1", {
    code: "CREDENTIAL_REFRESH_FAILED",
    summary: "existing",
    retryable: false,
    occurredAt: new Date(0).toISOString(),
  });
  let diagnosticChanges = 0;
  let credentialChanges = 0;
  const credentials = port(repository, "provider-1", {
    mode: "control-plane",
    onDiagnosticChanged: () => diagnosticChanges++,
    onCredentialChanged: () => credentialChanges++,
  });
  const before = repository.readDiagnostics("provider-1");
  const current = await credentials.read();

  await expect(
    credentials.refresh(current.revision, async () => ({
      value: { token: "refreshed-secret" },
      metadata: { label: "Refreshed", expiresAt: 42 },
    })),
  ).resolves.toEqual({
    status: "updated",
    snapshot: { value: { token: "refreshed-secret" }, revision: current.revision + 1 },
  });

  expect(repository.readDiagnostics("provider-1")).toEqual(before);
  expect(repository.readAccount("provider-1")).toMatchObject({
    credential: { token: "refreshed-secret" },
    label: "Refreshed",
    expiresAt: 42,
  });
  expect(diagnosticChanges).toBe(0);
  expect(credentialChanges).toBe(0);
});
