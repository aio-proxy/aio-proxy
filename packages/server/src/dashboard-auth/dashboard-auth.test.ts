import { describe, expect, test } from "bun:test";

import { createServer } from "../server";
import { loopbackServer } from "./test-support";

const origin = "http://127.0.0.1:22078";

async function login(
  app: Awaited<ReturnType<typeof createServer>>,
  password: string,
  requestOrigin = origin,
): Promise<Response> {
  return app.request(
    "/dashboard/api/auth/login",
    {
      body: JSON.stringify({ password }),
      headers: { "content-type": "application/json", origin: requestOrigin },
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

describe("dashboard authentication", () => {
  test("protects Dashboard APIs and accepts a password session", async () => {
    const hash = await Bun.password.hash("correct horse");
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });

    const sessionBefore = await app.request("/dashboard/api/auth/session", undefined, loopbackServer);
    const protectedBefore = await app.request("/dashboard/api/config", undefined, loopbackServer);
    const wrong = await login(app, "wrong");
    const correct = await login(app, "correct horse");
    const cookie = cookieFrom(correct);
    const protectedAfter = await app.request("/dashboard/api/config", { headers: { cookie } }, loopbackServer);

    expect(sessionBefore.status).toBe(200);
    expect(await sessionBefore.json()).toEqual({ status: "unauthenticated" });
    expect(protectedBefore.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(correct.status).toBe(200);
    expect(correct.headers.get("set-cookie")).toContain("HttpOnly");
    expect(correct.headers.get("set-cookie")).toContain("Max-Age=604800");
    expect(correct.headers.get("set-cookie")).toContain("Path=/dashboard");
    expect(correct.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(protectedAfter.status).toBe(200);
    expect(await protectedAfter.json()).toMatchObject({ server: { password: "****" } });
  });

  test("accepts a session after recreating the server with the same hash", async () => {
    const hash = await Bun.password.hash("restart-safe");
    const first = await createServer({ config: { server: { password: hash }, providers: {} } });
    const cookie = cookieFrom(await login(first, "restart-safe"));
    const second = await createServer({ config: { server: { password: hash }, providers: {} } });

    expect((await second.request("/dashboard/api/config", { headers: { cookie } }, loopbackServer)).status).toBe(200);
  });

  test("clears only the current browser cookie on logout", async () => {
    const hash = await Bun.password.hash("logout");
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });
    const cookie = cookieFrom(await login(app, "logout"));

    const response = await app.request(
      "/dashboard/api/auth/logout",
      {
        headers: { cookie, origin },
        method: "POST",
      },
      loopbackServer,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("accepts login from the IPv6 loopback Dashboard origin", async () => {
    const hash = await Bun.password.hash("ipv6-loopback");
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });

    expect((await login(app, "ipv6-loopback", "http://[::1]:22078")).status).toBe(200);
  });

  test("rejects remote Dashboard API clients without blocking model APIs", async () => {
    const app = await createServer({
      config: { providers: {} },
      dashboardAssets: async (path) => (path === "index.html" ? new Response("Dashboard") : undefined),
    });
    const remote = { requestIP: () => ({ address: "192.168.1.20" }) };

    expect((await app.request("/dashboard/api/auth/session", undefined, remote)).status).toBe(404);
    expect((await app.request("/dashboard", undefined, remote)).status).toBe(404);
    expect((await app.request("/dashboard/api/auth/session")).status).toBe(404);
    expect((await app.request("/dashboard")).status).toBe(404);
    expect((await app.request("/dashboard", undefined, loopbackServer)).status).toBe(200);
    expect((await app.request("/v1/models", undefined, remote)).status).toBe(200);
  });

  test("rate limits all attempts after five failures", async () => {
    const hash = await Bun.password.hash("eventually-correct");
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(app, "wrong")).status).toBe(401);
    }
    const blocked = await login(app, "eventually-correct");

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });
});
