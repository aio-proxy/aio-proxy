import { expect, test } from "bun:test";

import { parseRuntimeConfig } from "./parse-runtime-config";

test("expands env templates before URL and header validation runs", () => {
  const raw = {
    proxy: "{{env.PROXY_URL}}",
    providers: {
      api: {
        kind: "api",
        protocol: "openai-response",
        baseURL: "{{env.API_BASE_URL}}",
        headers: { Authorization: "Bearer {{env.API_TOKEN}}" },
      },
    },
  };
  const env = {
    PROXY_URL: "https://proxy.example:8443",
    API_BASE_URL: "https://api.example.test/v1",
    API_TOKEN: "secret-token",
  };

  const config = parseRuntimeConfig(raw, env);

  expect(config.invalidProviders).toEqual([]);
  expect(config.proxy).toBe("https://proxy.example:8443");
  expect(config.providers[0]).toMatchObject({
    baseURL: "https://api.example.test/v1",
    headers: { Authorization: "Bearer secret-token" },
  });
});

test("degrades a provider whose template resolves to an invalid base URL", () => {
  const config = parseRuntimeConfig(
    {
      providers: {
        api: { kind: "api", protocol: "openai-response", baseURL: "{{env.API_BASE_URL}}" },
      },
    },
    { API_BASE_URL: "not-a-url" },
  );

  expect(config.providers).toEqual([]);
  expect(config.invalidProviders).toEqual([
    { id: "api", kind: "api", code: "PROVIDER_CONFIG_INVALID", issuePaths: [["baseURL"]] },
  ]);
});

test("leaves the raw config record byte-for-byte unchanged", () => {
  const raw = {
    proxy: "{{env.PROXY_URL}}",
    providers: {
      api: { kind: "api", protocol: "openai-response", baseURL: "{{env.API_BASE_URL}}" },
    },
  };
  const snapshot = structuredClone(raw);

  parseRuntimeConfig(raw, { PROXY_URL: "https://proxy.example:8443", API_BASE_URL: "https://api.example.test/v1" });

  expect(structuredClone(raw)).toEqual(snapshot);
});
