import { readFile } from "node:fs/promises";
import { expect, test } from "@rstest/core";

test("reuses the dashboard Rsbuild configuration", async () => {
  const source = await readFile(new URL("./rstest.config.ts", import.meta.url), "utf8");

  expect(source).toContain('from "@rstest/adapter-rsbuild"');
  expect(source).toContain("extends: withRsbuildConfig()");
  expect(source).not.toContain("pluginReact(");
});
