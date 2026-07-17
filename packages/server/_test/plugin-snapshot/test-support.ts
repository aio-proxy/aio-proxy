import { jest } from "bun:test";
import { type PluginRepository, Router } from "@aio-proxy/core";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";

export const emptyPlugins = {
  plugins: new Map(),
  registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] },
};

export function cleanup(): void {
  jest.useRealTimers();
}

export function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

export function createManualRecoveryScheduler(startAt: number) {
  type Scheduled = { readonly callback: () => void; readonly runAt: number; cleared: boolean };
  let now = startAt;
  const scheduled = new Set<Scheduled>();
  return {
    hooks: {
      now: () => now,
      setTimeout(callback: () => void, delayMs: number) {
        const timer: Scheduled = { callback, runAt: now + delayMs, cleared: false };
        scheduled.add(timer);
        return {
          clear() {
            timer.cleared = true;
            scheduled.delete(timer);
          },
        };
      },
    },
    advanceTo(target: number) {
      if (target < now) throw new Error("cannot move the recovery clock backwards");
      now = target;
      const due = [...scheduled]
        .filter((timer) => !timer.cleared && timer.runAt <= now)
        .sort((left, right) => left.runAt - right.runAt);
      for (const timer of due) {
        scheduled.delete(timer);
        if (!timer.cleared) timer.callback();
      }
    },
    nextRunAt: () =>
      [...scheduled]
        .filter((timer) => !timer.cleared)
        .reduce<number | undefined>(
          (earliest, timer) => (earliest === undefined ? timer.runAt : Math.min(earliest, timer.runAt)),
          undefined,
        ),
  };
}

export const snapshot = (id: string) => ({
  plugins: emptyPlugins,
  providers: [{ id, kind: "api", enabled: true, models: ["model"] }] as never,
  router: new Router([{ id, enabled: true, models: ["model"] }]),
});

export function seedOAuthAccount(
  repository: PluginRepository,
  catalog: "missing" | "ready" = "ready",
  providerId = "person",
): void {
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId,
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: `${providerId}@example.com`,
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog:
        catalog === "ready"
          ? {
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
                refreshedAt: Date.now(),
              },
            }
          : {
              kind: "missing",
              diagnostic: {
                code: "CATALOG_UNAVAILABLE",
                summary: "catalog unavailable",
                retryable: true,
                occurredAt: new Date(0).toISOString(),
              },
            },
    },
  });
  repository.completeAccountOperation(operation.operationId);
}

export function routedOAuthDescriptor(onCreateRuntime: () => void | Promise<void> = () => {}) {
  return definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example",
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error("not called");
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          throw new Error("stored catalog should be used");
        },
      },
      async createRuntime() {
        await onCreateRuntime();
        return {
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
        } as never;
      },
    });
  });
}
