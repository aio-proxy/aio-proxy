import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigReloadRejectedError, createConfigStore } from "../src/config-store";

describe("createConfigStore mutex", () => {
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

  test("a rejected write does not poison later mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: {} }, null, 2));

    let reloads = 0;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      verify: async () => {
        reloads += 1;
      },
    });

    await expect(
      store.mutateProviders(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await store.mutateProviders((record) => ({ ...record, added: { kind: "api" } }));

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(onDisk.providers.added).toEqual({ kind: "api" });
    expect(reloads).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects and rolls back to the prior config when reload reports failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-"));
    const configPath = join(dir, "config.json");
    const original = JSON.stringify({ providers: { a: { kind: "api" } } }, null, 2);
    writeFileSync(configPath, original);

    const store = createConfigStore({
      getConfigPath: () => configPath,
      verify: async () => {
        throw new Error("invalid alias target");
      },
    });

    await expect(store.mutateProviders((record) => ({ ...record, b: { kind: "api" } }))).rejects.toThrow(
      ConfigReloadRejectedError,
    );

    expect(readFileSync(configPath, "utf8")).toBe(original);

    rmSync(dir, { recursive: true, force: true });
  });

  test("Given a restrictive config mode When providers are mutated Then the rewritten file preserves it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: {} }, null, 2));
    chmodSync(configPath, 0o600);
    const store = createConfigStore({
      getConfigPath: () => configPath,
      verify: async () => undefined,
    });

    await store.mutateProviders((record) => ({ ...record, added: { kind: "api" } }));

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
