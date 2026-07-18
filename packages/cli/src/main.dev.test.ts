import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, repoCwd, waitForOk } from "../_test/cli-test-helpers";

test("development entry advertises the Rsbuild Dashboard", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-cli-dev-"));
  const port = freePort();
  const child = Bun.spawn([process.execPath, "run", "packages/cli/src/main.dev.ts", "serve", "--port", String(port)], {
    cwd: repoCwd,
    env: { ...process.env, AIO_PROXY_HOME: home },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  try {
    await waitForOk(`http://127.0.0.1:${port}/health`, {
      probeTimeoutMs: 1_000,
      readinessTimeoutMs: 5_000,
    });
    child.kill();
    await child.exited;
    expect(`${await stdout}${await stderr}`).toContain("http://127.0.0.1:3000/dashboard/");
  } finally {
    child.kill();
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
});
