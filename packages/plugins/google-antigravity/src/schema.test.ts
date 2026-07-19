import { expect, test } from "bun:test";

import { accountOptionsSchema, credentialSchema, normalizeBaseURL } from "./schema";

test("normalizes an optional custom Antigravity base URL", () => {
  expect(accountOptionsSchema.parse({ baseURL: " https://proxy.example.test/root/ " })).toEqual({
    baseURL: "https://proxy.example.test/root",
  });
  expect(accountOptionsSchema.parse({})).toEqual({});
  expect(normalizeBaseURL("   ")).toBeUndefined();
});

test("rejects non-HTTP Antigravity base URLs", () => {
  expect(() => accountOptionsSchema.parse({ baseURL: "file:///tmp/socket" })).toThrow("HTTP(S)");
});

test.each(["https://proxy.example.test/root?tenant=secret", "https://proxy.example.test/root#fragment"])(
  "rejects Antigravity base URLs with query or fragment components",
  (baseURL) => {
    expect(() => accountOptionsSchema.parse({ baseURL })).toThrow("query or fragment");
  },
);

test("requires every stable Google account identity field", () => {
  expect(() =>
    credentialSchema.parse({
      accessToken: "access",
      refreshToken: "",
      expiresAt: 1,
      email: "person@example.com",
      projectId: "project-1",
    }),
  ).toThrow();
});
