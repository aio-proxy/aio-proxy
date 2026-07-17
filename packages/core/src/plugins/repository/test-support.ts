import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { Diagnostic, DiagnosticCode } from "@aio-proxy/types";
import { type OpenDbHandle, openDb } from "../../db";
import { type AccountWrite, createPluginRepository, type PluginRepository } from ".";

const homes: string[] = [];

function openRepository(): {
  readonly home: string;
  readonly handle: OpenDbHandle;
  readonly repository: PluginRepository;
} {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-repository-"));
  homes.push(home);
  const handle = openDb({ home });
  return { home, handle, repository: createPluginRepository(handle.sqlite) };
}

function catalog(id = "model-1"): ModelCatalog {
  return {
    language: [{ id }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function diagnostic(code: DiagnosticCode, summary: string = code): Diagnostic {
  return { code, summary, retryable: true, occurredAt: "2026-07-14T00:00:00.000Z" };
}

function account(providerId: string, overrides: Partial<AccountWrite> = {}): AccountWrite {
  return {
    providerId,
    plugin: "@aio-proxy/example",
    capability: "oauth",
    fingerprint: `${providerId}-fingerprint`,
    options: { tenant: "public", nested: [1, true, null] },
    secrets: { clientSecret: "account-secret" },
    credential: { accessToken: "credential-secret", refreshToken: "refresh-secret" },
    label: "Example account",
    expiresAt: 123_456,
    catalog: { kind: "replace", value: { catalog: catalog(), refreshedAt: 100 } },
    ...overrides,
  };
}

function createAccount(repository: PluginRepository, value: AccountWrite = account("provider-1")): void {
  const pending = repository.stageAccountOperation({ kind: "create", targetDigest: "digest:create", account: value });
  repository.completeAccountOperation(pending.operationId);
}

function refreshCredential(
  repository: PluginRepository,
  providerId: string,
  expectedRevision: number,
  credential: unknown,
  metadata?: { readonly label?: string; readonly expiresAt?: number },
) {
  const owner = crypto.randomUUID();
  const now = Date.now();
  if (!repository.tryAcquireRefreshLease(providerId, owner, now, now + 60_000)) throw new Error("lease unavailable");
  try {
    return repository.compareAndSwapCredential(providerId, expectedRevision, owner, credential, metadata);
  } finally {
    repository.releaseRefreshLease(providerId, owner);
  }
}

export type { AccountWrite, PluginRepository };
export {
  account,
  catalog,
  createAccount,
  createPluginRepository,
  diagnostic,
  expect,
  openDb,
  openRepository,
  refreshCredential,
  test,
};
