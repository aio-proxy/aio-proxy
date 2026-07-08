import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "@aio-proxy/oauth";
import { output, runCli, runCliAsync } from "./cli-test-helpers";

const jsonHeaders = { "content-type": "application/json" } as const;

type FakeDashboardProvider = {
  readonly id: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly passthrough: boolean;
  readonly last_status: string;
  readonly last_latency: number | null;
  readonly probe?: "OK" | "FAIL";
};

const withFakeDashboard = async (providers: readonly FakeDashboardProvider[], run: (url: string) => Promise<void>) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/dashboard/api/providers") {
        return new Response("not found", { status: 404 });
      }

      const filter = url.searchParams.get("filter");
      const probe = url.searchParams.get("probe") === "true";
      const rows = providers
        .filter((provider) => filter === null || provider.id === filter)
        .map((provider) => ({
          ...provider,
          ...(probe ? { probe: provider.probe ?? "OK" } : {}),
        }));
      return Response.json({ providers: rows }, { headers: jsonHeaders });
    },
  });

  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
};

describe("provider commands", () => {
  test("provider login copilot writes provider config returned by login service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-login-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: {} }));

    try {
      const result = await runCliAsync(["provider", "login", "copilot", "--config", configPath], {
        AIO_PROXY_HOME: dir,
        AIO_PROXY_TEST_COPILOT_LOGIN: JSON.stringify({
          providerId: "copilot-12345",
          payload: {
            access: "copilot-token",
            refresh: "github-token",
            expires: Date.now() + 60_000,
            baseUrl: "https://api.individual.githubcopilot.com",
            models: [{ id: "gpt-5-mini", transport: "chat" }],
          },
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("copilot-12345");
      expect(await Bun.file(configPath).json()).toEqual({
        providers: {
          "copilot-12345": {
            kind: "oauth",
            vendor: "github-copilot",
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider login chatgpt writes oauth config and stores auth payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-login-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    const providerId = "chatgpt-account-123";
    const payload = {
      access: "chatgpt-access",
      accountId: "account-123",
      expires: Date.now() + 60_000,
      refresh: "chatgpt-refresh",
      models: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
    };
    const previousHome = process.env.AIO_PROXY_HOME;
    process.env.AIO_PROXY_HOME = dir;

    try {
      const result = await runCliAsync(["provider", "login", "chatgpt", "--config", configPath], {
        AIO_PROXY_HOME: dir,
        AIO_PROXY_TEST_CHATGPT_LOGIN: JSON.stringify({
          providerId,
          payload,
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(providerId);
      expect(Auth.get("openai-chatgpt", providerId)?.payload).toEqual(payload);

      expect(await Bun.file(configPath).json()).toEqual({
        providers: {
          [providerId]: {
            kind: "oauth",
            vendor: "openai-chatgpt",
          },
        },
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.AIO_PROXY_HOME;
      } else {
        process.env.AIO_PROXY_HOME = previousHome;
      }
      Auth.del("openai-chatgpt", providerId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider list prints packages installed in the runtime cache", () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-home-"));
    const packageDir = join(
      dir,
      ".config",
      "aio-proxy",
      "cache",
      "packages",
      "aio-proxy-cli-provider",
      "node_modules",
      "aio-proxy-cli-provider",
    );
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "aio-proxy-cli-provider",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    writeFileSync(join(packageDir, "index.js"), "export const ok = true;\n");

    try {
      // When
      const result = runCli(["provider", "list", "--installed"], { HOME: dir });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("aio-proxy-cli-provider 1.0.0");
      expect(result.stdout.toString()).toContain(packageDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider list reads dashboard providers and probes filtered provider", async () => {
    // Given
    await withFakeDashboard(
      [
        {
          id: "openai",
          kind: "api",
          enabled: true,
          passthrough: true,
          last_status: "unknown",
          last_latency: null,
          probe: "OK",
        },
        {
          id: "slow-ai",
          kind: "ai-sdk",
          enabled: true,
          passthrough: false,
          last_status: "unknown",
          last_latency: null,
          probe: "FAIL",
        },
      ],
      async (url) => {
        // When
        const list = await runCliAsync(["provider", "list", "--url", url]);
        const testProvider = await runCliAsync(["provider", "test", "openai", "--url", url]);
        const failedProvider = await runCliAsync(["provider", "test", "slow-ai", "--url", url]);

        // Then
        expect(list.exitCode).toBe(0);
        expect(list.stdout).toContain("id | kind | enabled | passthrough | last_status | last_latency");
        expect(list.stdout).toContain("openai | api | true | true | unknown | -");
        expect(testProvider.exitCode).toBe(0);
        expect(testProvider.stdout).toContain("openai");
        expect(testProvider.stdout).toContain("OK");
        expect(testProvider.stdout).not.toContain("slow-ai");
        expect(failedProvider.exitCode).toBe(0);
        expect(failedProvider.stdout).toContain("slow-ai");
        expect(failedProvider.stdout).toContain("FAIL");
        expect(failedProvider.stdout).not.toContain("openai");
      },
    );
  });

  test("provider install reports a failed explicit install", () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-home-"));

    try {
      // When
      const result = runCli(
        ["provider", "install", "aio-proxy-missing-package", "--yes", "--registry", "http://127.0.0.1:9"],
        { HOME: dir },
      );

      // Then
      expect(result.exitCode).toBe(1);
      expect(output(result)).toContain("aio-proxy-missing-package");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider install requires explicit confirmation before installing", () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-cli-home-"));

    try {
      // When
      const result = runCli(["provider", "install", "aio-proxy-missing-package", "--registry", "http://127.0.0.1:9"], {
        HOME: dir,
      });

      // Then
      expect(result.exitCode).toBe(1);
      expect(output(result)).toContain("requires --yes");
      expect(existsSync(join(dir, ".config", "aio-proxy", "cache"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
