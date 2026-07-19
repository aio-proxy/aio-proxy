import type { ZodType } from "zod";

import { expect, test } from "bun:test";

import * as dashboard from "./dashboard-oauth";

test("dashboard OAuth capability schema accepts safe form metadata and rejects secret values", () => {
  expect(dashboard).toHaveProperty("DashboardOAuthCapabilitySchema");
  const schema = Reflect.get(dashboard, "DashboardOAuthCapabilitySchema") as ZodType;
  const capability = {
    plugin: "@example/oauth",
    capability: "default",
    label: { default: "Example OAuth", "zh-Hans": "示例 OAuth" },
    description: "Example account",
    icon: "openai",
    defaults: { deploymentType: "github.com" },
    form: [
      {
        type: "select",
        key: "deploymentType",
        label: "Deployment",
        options: [{ value: "github.com", label: "GitHub.com" }],
      },
      { type: "secret", key: "token", label: "Token", configured: false },
    ],
  };

  expect(schema.parse(capability)).toEqual(capability);
  expect(() =>
    schema.parse({
      ...capability,
      form: [{ type: "secret", key: "token", label: "Token", configured: false, value: "secret" }],
    }),
  ).toThrow();
});

test("dashboard OAuth session schema exposes only safe authorization state", () => {
  expect(dashboard).toHaveProperty("DashboardOAuthSessionSchema");
  const schema = Reflect.get(dashboard, "DashboardOAuthSessionSchema") as ZodType;
  const session = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    status: "device_code",
    url: "https://example.com/device",
    userCode: "ABCD-EFGH",
    instructions: "Enter the code",
  };

  expect(schema.parse(session)).toEqual(session);
  expect(schema.parse({ id: session.id, status: "discovering" })).toEqual({
    id: session.id,
    status: "discovering",
  });
  expect(() => schema.parse({ ...session, credential: "secret" })).toThrow();
});

test("dashboard OAuth session start accepts a complete routing patch without identity fields", () => {
  expect(dashboard).toHaveProperty("DashboardOAuthSessionStartSchema");
  const schema = Reflect.get(dashboard, "DashboardOAuthSessionStartSchema") as ZodType;
  const request = {
    targetProviderId: "person",
    publicValues: { tenant: "enterprise" },
    secrets: {},
    clearSecrets: [],
    providerPatch: {
      name: "Work",
      enabled: false,
      weight: 7,
      alias: { chat: { model: "model-1" } },
    },
  };

  expect(schema.parse(request)).toMatchObject(request);
  expect(() =>
    schema.parse({ ...request, providerPatch: { ...request.providerPatch, plugin: "@example/other" } }),
  ).toThrow();
});
