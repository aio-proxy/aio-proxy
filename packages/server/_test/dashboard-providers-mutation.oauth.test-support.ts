import type { PluginRepository } from "@aio-proxy/core";

export function seedOAuthAccount(
  repository: PluginRepository,
  plugin = "@example/oauth",
  capability = "default",
): void {
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin,
      capability,
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog: {
        kind: "replace",
        value: {
          catalog: {
            language: [{ id: "model" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
  repository.writeDiagnostic("person", {
    code: "CREDENTIALS_MISSING_OR_INVALID",
    summary: "credential unavailable",
    retryable: false,
    occurredAt: new Date(0).toISOString(),
  });
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}
