import { m } from "@aio-proxy/i18n";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../server-state";
import { createDashboardRoutes } from "./config";

const waitFor = async <T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for OAuth session");
};

test("dashboard device-code session can be resumed by id and creates an OAuth provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-oauth-login-"));
  const configPath = join(dir, "config.json");
  let now = 0;
  writeFileSync(configPath, JSON.stringify({ plugins: ["@example/oauth"], providers: {} }));
  let finishLogin = () => {};
  const loginReleased = new Promise<void>((resolve) => {
    finishLogin = resolve;
  });
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example OAuth",
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login({ authorization }) {
        await authorization.presentDeviceCode({
          url: "https://example.com/device",
          userCode: "ABCD-EFGH",
          instructions: "Enter the code",
        });
        await loginReleased;
        return { fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "hidden" } };
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          return {
            language: [{ id: "example-model" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          };
        },
      },
      async createRuntime() {
        return { models: {} };
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({ plugins: ["@example/oauth"], providers: {} }),
    configPath,
    dbHome: dir,
    watchConfig: false,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    __test: { oauthSessionNow: () => now, oauthSessionTtlMs: 5 },
  });
  const routes = createDashboardRoutes(state);

  try {
    const started = await routes.request("/oauth/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: { plugin: "@example/oauth", capability: "default" },
        publicValues: {},
        secrets: {},
        clearSecrets: [],
      }),
    });
    expect(started.status).toBe(202);
    const { session } = (await started.json()) as { session: { id: string } };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/u);

    const device = await waitFor(
      async () => {
        const response = await routes.request(`/oauth/sessions/${session.id}`);
        return (await response.json()) as { session: { status: string; url?: string; userCode?: string } };
      },
      (value) => value.session.status === "device_code",
    );
    expect(device.session).toMatchObject({
      status: "device_code",
      url: "https://example.com/device",
      userCode: "ABCD-EFGH",
    });

    finishLogin();
    const completed = await waitFor(
      async () => {
        const response = await routes.request(`/oauth/sessions/${session.id}`);
        return (await response.json()) as { session: { status: string; providerId?: string } };
      },
      (value) => value.session.status === "succeeded",
    );
    expect(completed.session).toMatchObject({ status: "succeeded", providerId: "person" });
    expect(state.currentConfig().providers).toContainEqual(
      expect.objectContaining({ id: "person", kind: "oauth", plugin: "@example/oauth", capability: "default" }),
    );
    expect(JSON.stringify(completed)).not.toContain("hidden");

    const lateCallback = await routes.request(`/oauth/sessions/${session.id}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackUrl: "http://127.0.0.1/callback?code=hidden" }),
    });
    expect(lateCallback.status).toBe(400);
    expect(await lateCallback.json()).toEqual({ error: "CALLBACK_NOT_EXPECTED" });
    now = 6;
    expect((await routes.request(`/oauth/sessions/${session.id}`)).status).toBe(404);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard loopback session rejects a mismatched callback and accepts a valid manual callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-oauth-loopback-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ plugins: ["@example/loopback"], providers: {} }));
  let finishDiscovery = () => {};
  const discoveryReleased = new Promise<void>((resolve) => {
    finishDiscovery = resolve;
  });
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example Loopback",
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login({ authorization }) {
        const { code } = await authorization.loopback({
          state: "expected-state",
          redirect: { hostname: "127.0.0.1", port: "dynamic", path: "/oauth-callback" },
          authorizationUrl: ({ redirectUri }) => {
            const url = new URL("https://example.com/authorize");
            url.searchParams.set("redirect_uri", redirectUri);
            url.searchParams.set("state", "expected-state");
            return url.href;
          },
          allowManualCallbackUrl: true,
        });
        return { fingerprint: "loopback@example.com", suggestedKey: "loopback", credentials: { token: code } };
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          await discoveryReleased;
          return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
        },
      },
      async createRuntime() {
        throw new Error("not used");
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({ plugins: ["@example/loopback"], providers: {} }),
    configPath,
    dbHome: dir,
    watchConfig: false,
    builtIns: [{ packageName: "@example/loopback", version: "1.0.0", descriptor }],
  });
  const routes = createDashboardRoutes(state);

  try {
    const started = await routes.request("/oauth/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: { plugin: "@example/loopback", capability: "default" },
        publicValues: {},
        secrets: {},
        clearSecrets: [],
      }),
    });
    const { session } = (await started.json()) as { session: { id: string } };
    const loopback = await waitFor(
      async () => {
        const response = await routes.request(`/oauth/sessions/${session.id}`);
        return (await response.json()) as {
          session: { status: string; authorizationUrl?: string; allowManualCallback?: boolean };
        };
      },
      (value) => value.session.status === "loopback",
    );
    const authorizationUrl = new URL(loopback.session.authorizationUrl as string);
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri") as string;
    expect(loopback.session.allowManualCallback).toBe(true);

    const redirect = new URL(redirectUri);
    const missing = await fetch(new URL("/missing", redirect.origin));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(m.cli_oauth_callback_not_found());

    const invalidHttp = await fetch(`${redirectUri}?code=do-not-log&state=wrong-state`);
    expect(invalidHttp.status).toBe(400);
    expect(await invalidHttp.text()).toBe(m.cli_oauth_invalid_callback_response());

    const invalid = await routes.request(`/oauth/sessions/${session.id}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackUrl: `${redirectUri}?code=do-not-log&state=wrong-state` }),
    });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await invalid.json())).not.toContain("do-not-log");

    const accepted = await routes.request(`/oauth/sessions/${session.id}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackUrl: `${redirectUri}?code=valid-code&state=expected-state` }),
    });
    expect(accepted.status).toBe(200);
    const discovering = await waitFor(
      async () => {
        const response = await routes.request(`/oauth/sessions/${session.id}`);
        return (await response.json()) as { session: { status: string } };
      },
      (value) => value.session.status === "discovering",
    );
    expect(discovering.session.status).toBe("discovering");
    finishDiscovery();
    const completed = await waitFor(
      async () => {
        const response = await routes.request(`/oauth/sessions/${session.id}`);
        return (await response.json()) as { session: { status: string; providerId?: string } };
      },
      (value) => value.session.status === "succeeded",
    );
    expect(completed.session).toMatchObject({ status: "succeeded", providerId: "loopback" });
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
