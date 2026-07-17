import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigAuthoringSchema, ConfigSchema } from "../src/index";

// aio-proxy.json holds real credentials and is gitignored, so it is only present
// on a configured machine. Run the checks where it exists; skip cleanly in CI.
const exampleConfigPath = join(import.meta.dir, "../../../aio-proxy.json");
const runTest = existsSync(exampleConfigPath) ? test : test.skip;

describe("example config (aio-proxy.json)", () => {
  runTest("parses under the strict authoring and tolerant operational schemas", () => {
    const raw: unknown = JSON.parse(readFileSync(exampleConfigPath, "utf8"));
    ConfigAuthoringSchema.parse(raw);
    const config = ConfigSchema.parse(raw);

    expect(config.providers.length).toBeGreaterThan(0);
    expect(config.invalidProviders).toEqual([]);

    // OAuth providers sync their model list from the vendor at login time, so the
    // config must not carry a models key; Zod strips any legacy one at parse time.
    const oauth = config.providers.find((provider) => provider.kind === "oauth");
    expect(oauth).toBeDefined();
    expect(oauth).not.toHaveProperty("models");
  });
});
