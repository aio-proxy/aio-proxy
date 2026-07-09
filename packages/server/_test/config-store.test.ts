import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "../src/config-store";

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
});
