import { expect, test } from "bun:test";
import { ConfigSchema } from "../src/index";

test.each(["0.0.0.0", "192.168.1.20", "example.test"])("rejects non-loopback host %s", (host) => {
  expect(() => ConfigSchema.parse({ server: { host }, providers: {} })).toThrow();
});

test.each(["127.0.0.1", "::1", "localhost"])("accepts loopback host %s", (host) => {
  expect(ConfigSchema.parse({ server: { host }, providers: {} }).server.host).toBe(host);
});

test("normalizes plugin enablements while retaining legacy OAuth provider config", () => {
  const config = ConfigSchema.parse({
    plugins: [["@example/enterprise", { baseURL: "https://example.test" }]],
    providers: {
      legacyDuringScaffolding: { kind: "oauth", vendor: "github-copilot" },
    },
  });

  expect(config.plugins).toEqual([
    { packageName: "@example/enterprise", options: { baseURL: "https://example.test" } },
  ]);
  expect(config.providers[0]).toMatchObject({
    id: "legacyDuringScaffolding",
    kind: "oauth",
    vendor: "github-copilot",
  });
});

test("rejects duplicate plugin enablements", () => {
  expect(() =>
    ConfigSchema.parse({
      plugins: ["@example/duplicate", "@example/duplicate"],
      providers: {},
    }),
  ).toThrow("Duplicate plugin @example/duplicate");
});
