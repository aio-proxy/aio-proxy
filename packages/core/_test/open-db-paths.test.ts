import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

test("Given options.home When openDb is called Then the database is created at <home>/aio-proxy.db", () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-open-db-"));
  const handle = openDb({ home });
  try {
    expect(handle.path).toBe(join(home, "aio-proxy.db"));
    expect(existsSync(handle.path)).toBe(true);
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
