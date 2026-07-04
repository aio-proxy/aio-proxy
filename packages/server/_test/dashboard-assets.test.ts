import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryDashboardAssets } from "@aio-proxy/server";

describe("directoryDashboardAssets", () => {
  test("Given a dist dir When known and unknown paths are requested Then files are served and misses return null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-assets-"));
    mkdirSync(join(dir, "static"));
    writeFileSync(join(dir, "index.html"), "<html>ok</html>");
    writeFileSync(join(dir, "static", "app.js"), "console.log(1);");
    const assets = directoryDashboardAssets(dir);

    try {
      const index = await assets("index.html");
      expect(index).not.toBeNull();
      expect(index?.headers.get("content-type")).toContain("text/html");
      expect(await index?.text()).toContain("ok");

      const nested = await assets("static/app.js");
      expect(nested).not.toBeNull();

      expect(await assets("missing.js")).toBeNull();
      expect(await assets("../secret.txt")).toBeNull();
      expect(await assets("static/../../secret.txt")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
