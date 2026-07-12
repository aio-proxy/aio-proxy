import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProviderSchemaEntries } from "../scripts/provider-schemas-build";
import { PROVIDER_SCHEMA_ALLOWLIST } from "../src/allowlist";

test("generates the full provider catalog from public npm latest", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "provider-schema-live-catalog-"));
  try {
    const generated = await generateProviderSchemaEntries({ cacheRoot, refreshLatest: true });
    expect(Object.keys(generated.entries)).toEqual(PROVIDER_SCHEMA_ALLOWLIST.map(({ packageName }) => packageName));
    for (const { packageName, factoryName } of PROVIDER_SCHEMA_ALLOWLIST) {
      const entry = generated.entries[packageName];
      expect(entry.packageName).toBe(packageName);
      expect(entry.factoryName).toBe(factoryName);
      expect(entry.packageVersion.length).toBeGreaterThan(0);
      expect(entry.schema).not.toBeNull();
    }
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}, 180_000);
