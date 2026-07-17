import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zod } from "@aio-proxy/plugin-sdk";
import type { Diagnostic } from "@aio-proxy/types";
import { type OpenDbHandle, openDb } from "../../db";
import type { DiagnosticFactory, PluginLogSink } from "../diagnostic";
import { createCredentialPort } from "../index";
import { type AccountWrite, createPluginRepository, type PluginRepository } from "../repository";

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

export { deferred, openFixture, port };
