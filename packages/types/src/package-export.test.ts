import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("package root resolves to the built entry", () => {
  const resolved = fileURLToPath(import.meta.resolve("@aio-proxy/types"));
  expect(resolved).toEndWith(join("packages", "types", "dist", "index.js"));
});
