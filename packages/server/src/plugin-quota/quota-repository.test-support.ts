import { createPluginRepository, type DiagnosticFactory, type PluginRepository } from "@aio-proxy/core";
import { type OpenDbHandle, openDb } from "@aio-proxy/core/db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "person";
export const PLUGIN = "@example/oauth";
export const CAPABILITY = "default";

export type QuotaAccountFixtureState = "ready" | "missing" | "mismatch" | "invalid-options" | "invalid-credential";

export const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  summary: code,
  retryable: options.retryable,
  occurredAt: new Date(0).toISOString(),
});

const handles: OpenDbHandle[] = [];
const homes: string[] = [];

export function cleanupQuotaRepositories(): void {
  for (const handle of handles.splice(0)) handle.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

export function createQuotaRepository(
  accountState: QuotaAccountFixtureState = "ready",
  providerIds: readonly string[] = [PROVIDER_ID],
): PluginRepository {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-quota-"));
  homes.push(home);
  const handle = openDb({ home });
  handles.push(handle);
  const repository = createPluginRepository(handle.sqlite);
  for (const providerId of providerIds) {
    const operation = repository.stageAccountOperation({
      kind: "create",
      targetDigest: `quota-read:${providerId}`,
      account: {
        providerId,
        plugin: PLUGIN,
        capability: CAPABILITY,
        fingerprint: `${providerId}@example.com`,
        options: {},
        secrets: { clientSecret: "account-secret" },
        credential: { token: "credential-secret" },
        catalog: {
          kind: "missing",
          diagnostic: diagnostics("CATALOG_UNAVAILABLE", { providerId, retryable: true }),
        },
      },
    });
    repository.completeAccountOperation(operation.operationId);
  }
  repository.writePluginSecret(PLUGIN, null, { apiKey: "plugin-secret" });
  if (accountState === "ready") return repository;
  return {
    ...repository,
    readAccount(providerId) {
      const account = repository.readAccount(providerId);
      if (accountState === "missing" || account === null) return null;
      if (accountState === "mismatch") return { ...account, capability: "other" };
      if (accountState === "invalid-options") return { ...account, secrets: [] };
      return { ...account, credential: { token: 42 } };
    },
  };
}
