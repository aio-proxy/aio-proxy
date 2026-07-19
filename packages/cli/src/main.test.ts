import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderAccountAlreadyExistsError } from "@aio-proxy/core";
import { getLocale, setLocale } from "@aio-proxy/i18n";
import { cliServeArgs, freePort, output, repoCwd, runCli, waitForOk } from "../_test/cli-test-helpers";
import packageJson from "../package.json" with { type: "json" };
import { formatCliError } from "./main";
import { LoopbackPortUnavailableError } from "./plugin-commands/loopback";
import { ProviderCapabilityNotFoundError } from "./plugin-commands/provider-login";

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

  test("reports serve port conflicts with the bound address", () => {
    // Given
    const blocker = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });

    try {
      // When
      const result = runCli(["serve", "--port", String(blocker.port)]);

      // Then
      expect(result.exitCode).toBe(1);
      expect(output(result)).toContain(`127.0.0.1:${blocker.port}`);
      expect(output(result)).not.toContain("Unexpected internal error");
    } finally {
      blocker.stop(true);
    }
  });

  test("bootstraps missing non-tty config path and serves health", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-"));
    const home = join(dir, "nested");
    const configFile = join(home, "config.jsonc");
    const port = freePort();
    const server = Bun.spawn(cliServeArgs(port), {
      cwd: repoCwd,
      env: { ...process.env, AIO_PROXY_HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdout = new Response(server.stdout).text();

    try {
      // When
      const response = await waitForOk(`http://127.0.0.1:${port}/health`, {
        probeTimeoutMs: 1_000,
        readinessTimeoutMs: 5_000,
      });

      // Then
      expect(response.status).toBe(200);
      expect(existsSync(configFile)).toBe(true);
      expect(await readFile(configFile, "utf8")).toContain("providers");
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

  test("serve --help advertises --open and drops --config and --dashboard", () => {
    // Given / When
    const result = runCli(["serve", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    const help = result.stdout.toString();
    expect(help).toContain("--open");
    expect(help).not.toContain("config");
    expect(help).not.toContain("--dashboard");
  });

  test("provider subcommands expose unified argument placeholders", () => {
    // Given / When
    const install = runCli(["provider", "install", "--help"]).stdout.toString();
    const login = runCli(["provider", "login", "--help"]).stdout.toString();
    const probe = runCli(["provider", "test", "--help"]).stdout.toString();

    // Then
    expect(install).toContain("<package>");
    expect(install).not.toContain("<pkg>");
    expect(login).toContain("[capability]");
    expect(login).toContain("--provider <id>");
    expect(login).toContain("Re-login an existing OAuth provider by id.");
    expect(probe).toContain("<provider-id>");
    expect(probe).not.toContain("<id>");
  });

  test("top-level rendering rejects raw provider-login errors and preserves loopback errors", async () => {
    const originalLocale = getLocale();
    await setLocale("en");
    try {
      const missing = formatCliError(new ProviderCapabilityNotFoundError("missing"), "en");
      const loopback = formatCliError(new LoopbackPortUnavailableError(1455), "en");
      const unknown = formatCliError(new Error("unknown plugin secret"), "en");

      expect(missing.message).toBe("Unexpected internal error.");
      expect(loopback.message).toBe("The local callback listener could not use port 1455.");
      expect(unknown.message).toBe("Unexpected internal error.");
      expect(unknown.message).not.toContain("unknown plugin secret");
    } finally {
      await setLocale(originalLocale);
    }
  });

  test("top-level rendering rejects forged mutable core provider errors", () => {
    const forged = new ProviderAccountAlreadyExistsError("existing");
    Object.defineProperties(forged, {
      existingProviderId: { value: "\u001b]8;;https://attacker.invalid\u0007stolen", configurable: true },
      suggestedCommand: { value: "secret extension command", configurable: true },
    });
    forged.message = "secret extension message";

    const formatted = formatCliError(forged, "en");

    expect(formatted.message).toBe("Unexpected internal error.");
    expect(formatted.message).not.toContain("secret");
    expect(formatted.message).not.toContain("attacker.invalid");
  });

  test("dashboard command reports not-yet-implemented on stderr and exits 2", () => {
    // Given / When
    const result = runCli(["dashboard"]);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("not yet implemented");
    expect(result.stdout.toString()).not.toContain("not yet implemented");
  });
});
