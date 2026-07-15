import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  readonly state?:
    | { readonly status: "ready"; readonly catalog?: "fresh" | "stale" }
    | {
        readonly status: "unavailable";
        readonly diagnostic: {
          readonly code: string;
          readonly summary: string;
          readonly retryable: boolean;
          readonly occurredAt: string;
          readonly suggestedCommand?: string;
        };
      };
  readonly plugin?: string;
  readonly capability?: string;
  readonly accountLabel?: string;
  readonly expiresAt?: number;
  readonly catalogLastSuccessAt?: string;
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
          clientModels: [],
          state: { status: "ready" },
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
  test("provider login exposes an optional capability and explicit provider target", () => {
    const result = runCli(["provider", "login", "--help"]);

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("[capability]");
    expect(stdout).toContain("--provider <id>");
  });

  test("provider list prints packages installed in the runtime cache", () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-cli-home-"));
    const packageDir = join(home, "packages", "aio-proxy-cli-provider", "node_modules", "aio-proxy-cli-provider");
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
      const result = runCli(["provider", "list", "--installed"], { AIO_PROXY_HOME: home });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("aio-proxy-cli-provider 1.0.0");
      expect(result.stdout.toString()).toContain(packageDir);
    } finally {
      rmSync(home, { recursive: true, force: true });
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

  test("provider list prints availability metadata and a provider-targeted credential recovery command", async () => {
    await withFakeDashboard(
      [
        {
          id: "copilot-octocat",
          kind: "oauth",
          enabled: true,
          passthrough: false,
          last_status: "unknown",
          last_latency: null,
          state: { status: "ready", catalog: "stale" },
          plugin: "@aio-proxy/plugin-github-copilot",
          capability: "default",
          accountLabel: "octocat",
          expiresAt: 1_900_000_000_000,
          catalogLastSuccessAt: "2026-07-14T00:00:00.000Z",
        },
        {
          id: "chatgpt-personal",
          kind: "oauth",
          enabled: true,
          passthrough: false,
          last_status: "unknown",
          last_latency: null,
          state: {
            status: "unavailable",
            diagnostic: {
              code: "CREDENTIAL_REFRESH_FAILED",
              summary: "Credential refresh failed.",
              retryable: true,
              occurredAt: "2026-07-14T00:00:00.000Z",
              suggestedCommand: "aio-proxy provider login default",
            },
          },
          plugin: "@aio-proxy/plugin-openai-chatgpt",
          capability: "default",
        },
      ],
      async (url) => {
        const result = await runCliAsync(["provider", "list", "--url", url]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ready");
        expect(result.stdout).toContain("stale");
        expect(result.stdout).toContain("@aio-proxy/plugin-github-copilot");
        expect(result.stdout).toContain("default");
        expect(result.stdout).toContain("octocat");
        expect(result.stdout).toContain("2026-07-14T00:00:00.000Z");
        expect(result.stdout).toContain("unavailable");
        expect(result.stdout).toContain("Credential refresh failed.");
        expect(result.stdout).toContain("aio-proxy provider login --provider chatgpt-personal");
        expect(result.stdout).not.toContain("aio-proxy provider login default");
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
        { AIO_PROXY_HOME: dir },
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
        AIO_PROXY_HOME: dir,
      });

      // Then
      expect(result.exitCode).toBe(1);
      expect(output(result)).toContain("requires --yes");
      expect(existsSync(join(dir, "packages"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
