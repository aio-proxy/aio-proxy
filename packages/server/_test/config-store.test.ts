import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigReloadRejectedError, createConfigStore } from "../src/config-store";

describe("createConfigStore mutex", () => {
  test("a rejected write does not poison later mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: {} }, null, 2));

    let reloads = 0;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      reload: async () => {
        reloads += 1;
        return { ok: true as const };
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
      reload: async () => ({ ok: false as const, error: "invalid alias target" }),
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
      reload: async () => ({ ok: true as const }),
    });

    await store.mutateProviders((record) => ({ ...record, added: { kind: "api" } }));

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
