import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../server";
import { loopbackServer } from "./test-support";

const origin = "http://127.0.0.1:22078";

async function login(app: Awaited<ReturnType<typeof createServer>>, password: string): Promise<Response> {
  return app.request(
    "/dashboard/api/auth/login",
    {
      body: JSON.stringify({ password }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    },
    loopbackServer,
  );
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("missing session cookie");
  return setCookie.split(";", 1)[0] ?? "";
}

describe("Dashboard password config lifecycle", () => {
  test("hashes a plaintext file password before serving Dashboard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-dashboard-password-"));
    const configPath = join(dir, "config.jsonc");
    const input = { server: { password: "  file password  " }, providers: {} };
    writeFileSync(configPath, JSON.stringify(input));

    try {
      const app = await createServer({ config: input, configPath, watchConfig: false });
      const stored = JSON.parse(readFileSync(configPath, "utf8")) as { server: { password: string } };

      expect(stored.server.password).toStartWith("$argon2id$");
      expect(await Bun.password.verify("  file password  ", stored.server.password)).toBe(true);
      expect((await login(app, "  file password  ")).status).toBe(200);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("hashes a hot password change and invalidates the old session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-dashboard-password-"));
    const configPath = join(dir, "config.jsonc");
    const oldHash = await Bun.password.hash("old password");
    const initial = { server: { password: oldHash }, providers: {} };
    writeFileSync(configPath, JSON.stringify(initial));

    try {
      const app = await createServer({ config: initial, configPath, watchConfig: false });
      const oldCookie = cookieFrom(await login(app, "old password"));
      writeFileSync(configPath, JSON.stringify({ server: { password: "new password" }, providers: {} }));

      const stream = await app.request("/dashboard/api/events", { headers: { cookie: oldCookie } }, loopbackServer);
      const reader = stream.body?.getReader();
      if (reader === undefined) throw new Error("dashboard event stream body is missing");
      const reload = await app.request(
        "/dashboard/api/reload",
        {
          headers: { cookie: oldCookie, origin },
          method: "POST",
        },
        loopbackServer,
      );
      const stored = JSON.parse(readFileSync(configPath, "utf8")) as { server: { password: string } };
      const event = await reader.read();

      expect(reload.status).toBe(200);
      expect(event.done).toBe(true);
      expect(stored.server.password).toStartWith("$argon2id$");
      expect(await Bun.password.verify("new password", stored.server.password)).toBe(true);
      expect(
        (await app.request("/dashboard/api/config", { headers: { cookie: oldCookie } }, loopbackServer)).status,
      ).toBe(401);
      expect((await login(app, "new password")).status).toBe(200);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("keeps model APIs available when the startup password hash is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-dashboard-password-"));
    const configPath = join(dir, "config.jsonc");
    const input = { server: { password: "$argon2id$broken" }, providers: {} };
    const logs: unknown[] = [];
    writeFileSync(configPath, JSON.stringify(input));

    try {
      const app = await createServer({
        config: input,
        configPath,
        logger: (entry) => logs.push(entry),
        watchConfig: false,
      });

      expect((await app.request("/v1/models")).status).toBe(200);
      expect(await (await app.request("/dashboard/api/auth/session", undefined, loopbackServer)).json()).toEqual({
        status: "unavailable",
      });
      expect((await app.request("/dashboard/api/config", undefined, loopbackServer)).status).toBe(503);
      expect(logs).toContainEqual({
        error: "Invalid Argon2id password hash",
        errorType: "Error",
        event: "dashboard.auth_unavailable",
      });
      expect(JSON.stringify(logs)).not.toContain("$argon2id$broken");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("fails Dashboard closed after an invalid reload and recovers after a valid reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-dashboard-password-"));
    const configPath = join(dir, "config.jsonc");
    const oldHash = await Bun.password.hash("old password");
    const logs: unknown[] = [];
    writeFileSync(configPath, JSON.stringify({ server: { password: oldHash }, providers: {} }));

    try {
      const app = await createServer({
        config: { server: { password: oldHash }, providers: {} },
        configPath,
        logger: (entry) => logs.push(entry),
        watchConfig: true,
      });
      await Bun.sleep(50);
      writeFileSync(configPath, JSON.stringify({ server: { password: "$argon2id$broken" }, providers: {} }));

      await waitForLogCount(logs, 1);
      expect(await waitForSessionStatus(app, "unavailable")).toBe("unavailable");
      expect((await app.request("/v1/models")).status).toBe(200);
      expect((await app.request("/dashboard/api/config", undefined, loopbackServer)).status).toBe(503);

      writeFileSync(configPath, JSON.stringify({ server: { password: "new password" }, providers: [] }));

      await waitForLogCount(logs, 2);
      expect(await waitForSessionStatus(app, "unavailable")).toBe("unavailable");

      writeFileSync(configPath, JSON.stringify({ server: { password: "new password" }, providers: {} }));

      expect(await waitForSessionStatus(app, "unauthenticated")).toBe("unauthenticated");
      expect((await login(app, "new password")).status).toBe(200);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

async function waitForSessionStatus(
  app: Awaited<ReturnType<typeof createServer>>,
  expected: "unauthenticated" | "unavailable",
): Promise<string> {
  const deadline = performance.now() + 2_000;
  let status = "";
  while (performance.now() < deadline) {
    const response = await app.request("/dashboard/api/auth/session", undefined, loopbackServer);
    status = ((await response.json()) as { status: string }).status;
    if (status === expected) return status;
    await Bun.sleep(10);
  }
  return status;
}

async function waitForLogCount(logs: readonly unknown[], count: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (logs.length < count) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for reload log");
    await Bun.sleep(10);
  }
}
