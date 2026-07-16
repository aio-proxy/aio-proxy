import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPublishableManifest } from "../publish-public-packages";

for (const dependency of ["catalog:", "workspace:*"]) {
  test(`rejects ${dependency} dependencies from packed manifests`, () => {
    const packageDir = mkdtempSync(join(tmpdir(), "aio-proxy-publish-manifest-"));
    const manifestPath = join(packageDir, "package.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "publish-boundary-test",
        version: "1.0.0",
        dependencies: { zod: dependency },
      }),
    );

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(() => assertPublishableManifest(manifest)).toThrow(/unsupported dependency protocol/);
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });
}
