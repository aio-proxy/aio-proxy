import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../src/index";

// aio-proxy.json holds real credentials and is gitignored, so it is only present
// on a configured machine. Run the checks where it exists; skip cleanly in CI.
const exampleConfigPath = join(import.meta.dir, "../../../aio-proxy.json");
const runTest = existsSync(exampleConfigPath) ? test : test.skip;

describe("example config (aio-proxy.json)", () => {
  runTest("parses under ConfigSchema with alias-based exposure", () => {
    const raw: unknown = JSON.parse(readFileSync(exampleConfigPath, "utf8"));
    const config = ConfigSchema.parse(raw);

    expect(config.plugins).toEqual([]);
    expect(config.providers.length).toBeGreaterThan(0);

    // OAuth providers sync their model list from the vendor at login time, so the
    // config must not carry a models key; Zod strips any legacy one at parse time.
    const oauth = config.providers.find((provider) => provider.kind === "oauth");
    expect(oauth).toBeDefined();
    expect(oauth).not.toHaveProperty("models");
  });
});
