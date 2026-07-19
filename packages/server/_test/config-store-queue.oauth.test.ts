import { ConfigSchema } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfigStore } from "../src/config-store";
import { createServerState } from "../src/server-state";

describe("createConfigStore OAuth queue", () => {
  test("a config mutation and concurrent reload share one FIFO without lock inversion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-lock-order-"));
    const configPath = join(dir, "config.json");
    const input = {
      providers: {
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(input));
    const state = await createServerState({
      config: ConfigSchema.parse(input),
      configPath,
      watchConfig: false,
      dbHome: dir,
    });
    let concurrentReload: ReturnType<typeof state.reload> | undefined;

    try {
      const mutation = state.configStore.mutateProviders((providers) => {
        concurrentReload = state.reload();
        return providers;
      });
      const outcome = await Promise.race([
        mutation
          .then(async () => concurrentReload)
          .then(async (reload) => ({ kind: "completed" as const, reload: await reload })),
        Bun.sleep(2_000).then(() => ({ kind: "timeout" as const })),
      ]);

      expect(outcome).toMatchObject({ kind: "completed", reload: { ok: true } });
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes every mutation in invocation order before entering AtomicConfigFile", async () => {
    let transactionCalls = 0;
    let releaseFirst = () => {};
    const firstMayEnter = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const file = {
      async transaction(
        mutate: (current: Record<string, unknown>) => Promise<{
          readonly next: Record<string, unknown>;
          readonly result: unknown;
        }>,
        options: { readonly verify?: (candidate: Record<string, unknown>) => Promise<void> } = {},
      ) {
        transactionCalls++;
        if (transactionCalls === 1) await firstMayEnter;
        const result = await mutate({ providers: { seed: { kind: "api" } } });
        await options.verify?.(result.next);
        return result.result;
      },
    };
    const store = createConfigStore({
      getConfigPath: () => undefined,
      file,
      verify: async () => undefined,
    } as never);

    const first = store.mutateProviders((record) => {
      order.push("first");
      return record;
    });
    const second = store.mutateProviders((record) => {
      order.push("second");
      return record;
    });

    try {
      await Bun.sleep(0);
      expect(transactionCalls).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
  });
});
