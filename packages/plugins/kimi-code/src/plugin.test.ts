import { expect, test } from "bun:test";
import type { AccountContext, OAuthAdapter, OAuthLoginContext, PluginDescriptor } from "@aio-proxy/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import kimiCodePlugin, { createKimiCodePlugin, KIMI_CODE_PLUGIN_VERSION } from ".";
import { KIMI_CATALOG_TTL_MS, staticKimiCatalog } from "./catalog";
import type { KimiCredential } from "./oauth";

test("exports a versioned default descriptor with the complete OAuth adapter contract", async () => {
  const adapter = await adapterFrom(kimiCodePlugin);

  expect(adapter.id).toBe("default");
  expect(adapter.icon).toBe("moonshot");
  expect(adapter.account.options.form).toEqual([]);
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
  expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: KIMI_CATALOG_TTL_MS });
  expect(adapter.catalog.initialFallback?.(new Error("offline"))).toEqual(staticKimiCatalog());
  expect(adapter.catalog.initialFallback?.(new DOMException("cancelled", "AbortError"))).toBeUndefined();
  expect(adapter.quota?.reset).toBeUndefined();
  expect(KIMI_CODE_PLUGIN_VERSION).toBe(packageJson.version);
});

test("preserves localized login and quota presentation values", async () => {
  const instructions = { default: "Enter localized code", "zh-Hans": "输入本地化代码" } as const;
  const waiting = { default: "Waiting locally", "zh-Hans": "正在本地等待" } as const;
  let tokenPolls = 0;
  const adapter = await adapterFrom(
    createKimiCodePlugin(
      {
        adapterLabel: { default: "Localized login", "zh-Hans": "本地化登录" },
        deviceInstructions: instructions,
        waitingForAuthorization: waiting,
      },
      {
        deviceId: () => "device-1",
        now: () => 0,
        sleep: async () => {},
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/device_authorization")) {
            return Response.json({
              device_code: "device-code",
              user_code: "ABCD",
              verification_uri: "https://kimi.test/device",
              expires_in: 900,
              interval: 1,
            });
          }
          if (url.endsWith("/token")) {
            tokenPolls += 1;
            return tokenPolls === 1
              ? Response.json({ error: "authorization_pending" }, { status: 400 })
              : Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
          }
          if (url.endsWith("/usages")) return Response.json({ usage: { limit: 100, remaining: 75 } });
          throw new Error(`Unexpected fetch: ${url}`);
        },
      },
    ),
  );
  const presented: Parameters<OAuthLoginContext["authorization"]["presentDeviceCode"]>[0][] = [];
  const progress: unknown[] = [];

  await adapter.login(loginContext(presented, progress), {});
  const quota = await adapter.quota?.read(accountContext());

  expect(adapter.label).toEqual({ default: "Localized login", "zh-Hans": "本地化登录" });
  expect(presented[0]?.instructions).toEqual({
    default: "Enter localized code\n\nABCD",
    "zh-Hans": "输入本地化代码\n\nABCD",
  });
  expect(progress).toEqual([waiting]);
  expect(quota?.items[0]?.label).toEqual({ default: "Weekly quota", "zh-Hans": "周配额" });
});

function loginContext(
  presented: Parameters<OAuthLoginContext["authorization"]["presentDeviceCode"]>[0][],
  progress: unknown[],
): OAuthLoginContext {
  return {
    signal: new AbortController().signal,
    progress: (message) => progress.push(message),
    authorization: {
      presentDeviceCode: async (input) => presented.push(input),
      loopback: async () => {
        throw new Error("Unexpected loopback login");
      },
    },
  };
}

function accountContext(): AccountContext<KimiCredential, Record<string, never>> {
  const credential: KimiCredential = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Number.MAX_SAFE_INTEGER,
    deviceId: "device-1",
  };
  return {
    credentials: {
      read: async () => ({ value: credential, revision: 1 }),
      refresh: async () => ({ status: "superseded", snapshot: { value: credential, revision: 1 } }),
    },
    options: {},
    signal: new AbortController().signal,
  };
}

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, KimiCredential>> {
  let registered: OAuthAdapter<Record<string, never>, KimiCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as OAuthAdapter<Record<string, never>, KimiCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error("Kimi Code OAuth adapter was not registered");
  return registered;
}
