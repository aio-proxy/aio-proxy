import { writeFileSync } from "node:fs";
import type { PluginRepository } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";

export const configWithProvider = (id: string, baseURL: string) => ({
  providers: {
    [id]: {
      kind: "api" as const,
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL,
      models: [`${id}-model`],
      alias: { [`${id}-model`]: { model: `${id}-model`, preserve: false } },
    },
  },
});

export const writeConfig = (path: string, config: unknown): void => {
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

export const settleWatcher = () => Bun.sleep(50);

export function seedOAuthAccount(repository: PluginRepository): void {
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog: {
        kind: "replace",
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}
