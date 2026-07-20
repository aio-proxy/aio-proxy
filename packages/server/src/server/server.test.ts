import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("importing the server module does not initialize server state", () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-server-import-"));
  try {
    const result = Bun.spawnSync([process.execPath, "-e", 'await import("./src/server")'], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, AIO_PROXY_HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
