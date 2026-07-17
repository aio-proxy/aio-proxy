import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zod } from "@aio-proxy/plugin-sdk";
import { type Diagnostic, providerLoginCommand } from "@aio-proxy/types";
import { type OpenDbHandle, openDb } from "../../db";
import type { DiagnosticFactory, PluginLogSink } from "../diagnostic";
import {
  CredentialRefreshLeaseLostError,
  CredentialRefreshTimeoutError,
  CredentialValidationError,
  createCredentialPort,
} from "../index";
import { type AccountWrite, createPluginRepository, type PluginRepository } from "../repository";

const childPath = fileURLToPath(new URL("../../../_test/plugins/refresh-lease-child.ts", import.meta.url));
const homes: string[] = [];

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

export type { PluginLogSink, PluginRepository };
export {
  account,
  afterEach,
  CredentialRefreshLeaseLostError,
  CredentialRefreshTimeoutError,
  CredentialValidationError,
  childOutput,
  childPath,
  createAccount,
  createCredentialPort,
  createPluginRepository,
  deferred,
  diagnosticFactory,
  expect,
  expectCurrentValidationRenewalFailure,
  expectRenewalFailure,
  jest,
  openDb,
  openFixture,
  port,
  providerLoginCommand,
  refreshCredential,
  test,
  waitForLine,
  zod,
};
