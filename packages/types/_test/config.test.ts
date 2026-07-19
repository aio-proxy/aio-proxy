import { expect, test } from "bun:test";

import { ConfigAuthoringSchema, ConfigSchema, ProviderKind } from "../src/index";

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
