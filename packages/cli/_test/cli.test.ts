import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const cli = ["bun", "run", "packages/cli/src/main.ts"] as const;

const runCli = (
  args: readonly string[],
  env: Record<string, string | undefined> = {},
) =>
  Bun.spawnSync([...cli, ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });

const output = (result: Bun.SpawnSyncReturns<Uint8Array>) =>
  `${result.stdout.toString()}${result.stderr.toString()}`;

const freePort = () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
};

describe("cli", () => {
  test("prints package version when requested", () => {
    // Given / When
    const result = runCli(["--version"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(packageJson.version);
  });

  test("localizes help when --lang overrides environment", () => {
    // Given / When
    const english = runCli(["--help"], { LANG: "en_US.UTF-8" });
    const chinese = runCli(["--lang", "zh-CN", "--help"], {
      LANG: "en_US.UTF-8",
    });

    // Then
    expect(english.exitCode).toBe(0);
    expect(chinese.exitCode).toBe(0);
    expect(english.stdout.toString()).toContain("AIO Proxy command line");
    expect(chinese.stdout.toString()).toContain("AIO Proxy 命令行界面");
  });

  test("rejects out-of-range serve ports", () => {
    // Given / When
    const result = runCli(["--port", "99999"]);

    // Then
    expect(result.exitCode).toBe(1);
    expect(output(result)).toContain("Port 99999 is out of range");
  });

  test("bootstraps missing non-tty config path and serves health", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-"));
    const configPath = join(dir, "nested", "config.jsonc");
    const port = freePort();
    const server = Bun.spawn(
      [...cli, "serve", "--config", configPath, "--port", String(port)],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: process.env,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    try {
      // When
      let response: Response | undefined;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          response = await fetch(`http://127.0.0.1:${port}/health`);
          break;
        } catch (err) {
          if (!(err instanceof Error)) {
            throw err;
          }
          await Bun.sleep(40);
        }
      }

      // Then
      expect(response?.status).toBe(200);
      expect(existsSync(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain("providers");
    } finally {
      server.kill();
      await server.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
