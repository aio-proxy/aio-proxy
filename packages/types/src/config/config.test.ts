import { expect, test } from "bun:test";

import {
  ConfigAuthoringSchema,
  ConfigSchema,
  ProviderKind,
  ProviderMutationAuthoringBodySchema,
  ProviderMutationBodySchema,
} from "..";

test("preserves an exact non-empty dashboard password", () => {
  expect(ConfigSchema.parse({ server: { password: "  " }, providers: {} }).server.password).toBe("  ");
  expect(ConfigAuthoringSchema.safeParse({ server: { password: "" }, providers: {} }).success).toBe(false);
});

test.each(["0.0.0.0", "192.168.1.20", "example.test"])("rejects non-loopback host %s", (host) => {
  expect(() => ConfigSchema.parse({ server: { host }, providers: {} })).toThrow();
});

test.each(["127.0.0.1", "::1", "localhost"])("accepts loopback host %s", (host) => {
  expect(ConfigSchema.parse({ server: { host }, providers: {} }).server.host).toBe(host);
});

test("normalizes plugin enablements while degrading legacy OAuth provider config", () => {
  const config = ConfigSchema.parse({
    plugins: [["@example/enterprise", { baseURL: "https://example.test" }]],
    providers: {
      legacyDuringScaffolding: { kind: "oauth", vendor: "legacy-provider" },
    },
  });

  expect(config.plugins).toEqual([
    { packageName: "@example/enterprise", options: { baseURL: "https://example.test" } },
  ]);
  expect(config.providers).toEqual([]);
  expect(config.invalidProviders).toEqual([
    {
      id: "legacyDuringScaffolding",
      kind: ProviderKind.OAuth,
      code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
      issuePaths: [["vendor"]],
    },
  ]);
});

test("degrades invalid and legacy provider entries independently", () => {
  const config = ConfigSchema.parse({
    plugins: [],
    providers: {
      valid: {
        kind: "api",
        protocol: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      },
      legacy: { kind: "oauth", vendor: "legacy-provider" },
      broken: {
        kind: "oauth",
        plugin: "@example/oauth",
        capability: "",
      },
    },
  });

  expect(config.providers.map((provider) => provider.id)).toEqual(["valid"]);
  expect(config.invalidProviders).toEqual([
    {
      id: "legacy",
      kind: ProviderKind.OAuth,
      code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
      issuePaths: [["vendor"]],
    },
    {
      id: "broken",
      kind: ProviderKind.OAuth,
      code: "PROVIDER_CONFIG_INVALID",
      issuePaths: [["capability"]],
    },
  ]);
  expect(JSON.stringify(config)).not.toContain("legacy-provider");
  expect(JSON.stringify(config)).not.toContain("@example/oauth");
});

test("keeps authoring schema strict and documents the structured oauth shape", () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      providers: { legacy: { kind: "oauth", vendor: "legacy-provider" } },
    }).success,
  ).toBe(false);
  expect(
    ConfigAuthoringSchema.safeParse({
      providers: {
        copilot: {
          kind: "oauth",
          plugin: "@aio-proxy/plugin-github-copilot",
          capability: "default",
        },
      },
    }).success,
  ).toBe(true);
});

test.each([
  { server: { port: 0 }, plugins: [], providers: {} },
  { server: {}, plugins: ["NOT A PACKAGE"], providers: {} },
  { server: {}, plugins: [], providers: [] },
])("rejects an invalid operational config envelope", (input) => {
  expect(ConfigSchema.safeParse(input).success).toBe(false);
});

test("rejects duplicate plugin enablements", () => {
  expect(() =>
    ConfigSchema.parse({
      plugins: ["@example/duplicate", "@example/duplicate"],
      providers: {},
    }),
  ).toThrow("Duplicate plugin @example/duplicate");
});

test("resolves top-level and per-provider proxy plus API headers on the runtime config", () => {
  const runtime = ConfigSchema.parse({
    proxy: "https://proxy.example:8443",
    providers: {
      api: {
        kind: "api",
        protocol: "openai-response",
        baseURL: "https://api.example/v1",
        proxy: false,
        headers: { Authorization: "Bearer upstream", "X-Tenant": "team-a" },
      },
      sdk: {
        kind: "ai-sdk",
        packageName: "@ai-sdk/anthropic",
        proxy: "http://provider-proxy.example:8080",
      },
    },
  });

  expect(runtime.proxy).toBe("https://proxy.example:8443");
  expect(runtime.providers[0]).toMatchObject({ proxy: false, headers: { "X-Tenant": "team-a" } });
  expect(runtime.providers[1]).toMatchObject({ proxy: "http://provider-proxy.example:8080" });
});

test("rejects a non-HTTP(S) top-level proxy scheme", () => {
  expect(ConfigSchema.safeParse({ proxy: "socks5://localhost:1080", providers: {} }).success).toBe(false);
});

test("degrades an API provider with an invalid header name instead of failing the whole config", () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        kind: "api",
        protocol: "openai-response",
        baseURL: "https://api.example/v1",
        headers: { "Bad\nName": "value" },
      },
    },
  });

  expect(config.providers).toEqual([]);
  expect(config.invalidProviders).toEqual([
    { id: "api", kind: ProviderKind.Api, code: "PROVIDER_CONFIG_INVALID", issuePaths: [["headers"]] },
  ]);
});

test("accepts config templates for top-level proxy, provider base URL, and header values in the authoring schema", () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      proxy: "{{env.PROXY_URL}}",
      providers: {
        api: {
          kind: "api",
          protocol: "openai-response",
          baseURL: "{{env.API_BASE_URL}}",
          headers: { Authorization: "Bearer {{env.API_TOKEN}}" },
        },
      },
    }).success,
  ).toBe(true);
});

test("authoring schema accepts templates on constrained string leaves", () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      server: { host: "{{env.HOST}}" },
      plugins: ["{{env.PLUGIN_PACKAGE}}"],
      providers: {
        api: {
          kind: "api",
          protocol: "{{env.PROTOCOL}}",
          baseURL: "https://api.example/v1",
        },
        sdk: {
          kind: "ai-sdk",
          packageName: "{{env.SDK_PACKAGE}}",
        },
        oauth: {
          kind: "oauth",
          plugin: "{{env.OAUTH_PLUGIN}}",
          capability: "{{env.OAUTH_CAPABILITY}}",
        },
      },
    }).success,
  ).toBe(true);
});

test("provider mutation authoring accepts proxy templates and API headers", () => {
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: "api",
      id: "openai",
      protocol: "openai-response",
      baseURL: "{{env.API_BASE_URL}}",
      proxy: "{{env.PROVIDER_PROXY}}",
      headers: { Authorization: "Bearer {{env.API_TOKEN}}" },
    }).success,
  ).toBe(true);
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: "ai-sdk",
      id: "anthropic",
      packageName: "@ai-sdk/anthropic",
      proxy: "{{env.PROVIDER_PROXY}}",
    }).success,
  ).toBe(true);
});

test("provider mutation authoring accepts protocol and packageName templates", () => {
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: "api",
      id: "openai",
      protocol: "{{env.PROTOCOL}}",
      baseURL: "https://api.example/v1",
    }).success,
  ).toBe(true);
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: "ai-sdk",
      id: "anthropic",
      packageName: "{{env.SDK_PACKAGE}}",
    }).success,
  ).toBe(true);
});

test("provider mutation body accepts API headers", () => {
  expect(
    ProviderMutationBodySchema.safeParse({
      kind: "api",
      id: "openai",
      protocol: "openai-response",
      baseURL: "https://api.example/v1",
      headers: { Authorization: "Bearer upstream" },
    }).success,
  ).toBe(true);
});

test("provider mutation body rejects unresolved proxy and base URL templates", () => {
  expect(
    ProviderMutationBodySchema.safeParse({
      kind: "api",
      id: "openai",
      protocol: "openai-response",
      baseURL: "{{env.API_BASE_URL}}",
      proxy: "{{env.PROVIDER_PROXY}}",
    }).success,
  ).toBe(false);
});
