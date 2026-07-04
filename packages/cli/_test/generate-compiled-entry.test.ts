import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAssetPaths, renderCompiledEntry } from "../scripts/generate-compiled-entry";

describe("listAssetPaths", () => {
  test("Given nested dist When listing Then returns sorted slash-separated relative paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-gen-"));
    mkdirSync(join(dir, "static", "js"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "x");
    writeFileSync(join(dir, "static", "js", "app.js"), "x");
    try {
      expect(listAssetPaths(dir)).toEqual(["index.html", "static/js/app.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderCompiledEntry", () => {
  test("Given asset paths When rendering Then emits file-type imports and the asset map", () => {
    const code = renderCompiledEntry(["index.html", "static/js/app.js"]);
    expect(code).toContain('import asset0 from "@aio-proxy/dashboard/dist/index.html" with { type: "file" };');
    expect(code).toContain('import asset1 from "@aio-proxy/dashboard/dist/static/js/app.js" with { type: "file" };');
    expect(code).toContain('"static/js/app.js": asset1,');
    expect(code).toContain('import { embeddedDashboardAssets } from "./dashboard-assets";');
    expect(code).toContain('import { main } from "./main";');
    expect(code).toContain("await main({ dashboardAssets: () => embeddedDashboardAssets(files) });");
  });
});
