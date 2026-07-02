import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  cliServeArgs,
  freePort,
  output,
  repoCwd,
  runCli,
  waitForOk,
} from "./cli-test-helpers";

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
    const server = Bun.spawn(cliServeArgs(configPath, port), {
      cwd: repoCwd,
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdout = new Response(server.stdout).text();

    try {
      // When
      const response = await waitForOk(
        `http://127.0.0.1:${port}/health`,
        1_000,
      );

      // Then
      expect(response.status).toBe(200);
      expect(existsSync(configPath)).toBe(true);
      expect(await readFile(configPath, "utf8")).toContain("providers");
      server.kill();
      await server.exited;
      const outputText = await stdout;
      expect(outputText).toContain(`http://127.0.0.1:${port}/dashboard`);
      if (port !== 22_078) {
        expect(outputText).not.toContain("http://127.0.0.1:22078/dashboard");
      }
    } finally {
      server.kill();
      await server.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
