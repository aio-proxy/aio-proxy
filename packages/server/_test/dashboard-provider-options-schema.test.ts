import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_PROVIDER_VERSIONS, npmPackageCacheDir } from "@aio-proxy/core";
import { createServer as createBaseServer } from "@aio-proxy/server";

const installRequest = (body: Record<string, unknown>) => ({
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    Origin: "http://127.0.0.1:22078",
  },
  method: "POST",
});

describe("dashboard provider package metadata", () => {
  let home: string;
  let previousHome: string | undefined;
  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: home });

  beforeEach(() => {
    previousHome = process.env.AIO_PROXY_HOME;
    home = mkdtempSync(join(tmpdir(), "aio-proxy-provider-schema-"));
    process.env.AIO_PROXY_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.AIO_PROXY_HOME;
    } else {
      process.env.AIO_PROXY_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("package status returns runtime fields only", async () => {
    const app = await createServer({ config: { providers: {} } });
    const response = await app.request("/dashboard/api/providers/package-status?npm=%40ai-sdk%2Fopenai-compatible");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      npm: "@ai-sdk/openai-compatible",
      trusted: true,
      state: "bundled",
      version: BUNDLED_PROVIDER_VERSIONS["@ai-sdk/openai-compatible"],
    });
  });

  test("package status reports installed and missing runtime states independently of schemas", async () => {
    const installedPackage = "@vendor/installed-provider";
    const packageDir = join(npmPackageCacheDir(installedPackage), "node_modules", "@vendor", "installed-provider");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const app = await createServer({ config: { providers: {} } });

    const installed = await app.request("/dashboard/api/providers/package-status?npm=%40vendor%2Finstalled-provider");
    const missing = await app.request("/dashboard/api/providers/package-status?npm=%40ai-sdk%2Fmissing-provider");

    expect(await installed.json()).toEqual({
      npm: installedPackage,
      trusted: false,
      state: "installed",
      version: "1.2.3",
    });
    expect(await missing.json()).toEqual({
      npm: "@ai-sdk/missing-provider",
      trusted: true,
      state: "missing",
    });
  });
  test("invalid package names return a stable code", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request("/dashboard/api/providers/package-status?npm=..%2Fbad");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_package_name",
      error: "Invalid npm package name: ../bad",
    });
  });

  test("trusted packages may install without confirmation", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      "/dashboard/api/providers/install",
      installRequest({ npm: "@ai-sdk/aio-proxy-missing-provider", registry: "http://127.0.0.1:9" }),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("Runtime install failed");
  });

  test("trusted packages may install with explicit false confirmation", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      "/dashboard/api/providers/install",
      installRequest({
        npm: "@ai-sdk/aio-proxy-missing-provider",
        confirmed: false,
        registry: "http://127.0.0.1:9",
      }),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("Runtime install failed");
  });

  test("untrusted packages require explicit confirmation", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      "/dashboard/api/providers/install",
      installRequest({ npm: "aio-proxy-missing-provider" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "confirmation_required",
      error: "provider install requires confirmation",
    });
  });

  test("untrusted packages reject explicit false confirmation", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      "/dashboard/api/providers/install",
      installRequest({ npm: "aio-proxy-missing-provider", confirmed: false }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "confirmation_required",
      error: "provider install requires confirmation",
    });
  });
});
