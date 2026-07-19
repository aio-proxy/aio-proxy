import { expect, test } from "bun:test";

import { ConfigSchema } from "./config";

test("applies server logging defaults", () => {
  expect(ConfigSchema.parse({ server: { logging: {} }, providers: {} }).server.logging).toEqual({
    enabled: false,
    retentionDays: 14,
    level: "info",
  });
});

test.each([{ level: "verbose" }, { retentionDays: 0 }])("rejects invalid server logging config %o", (logging) => {
  expect(ConfigSchema.safeParse({ server: { logging }, providers: {} }).success).toBe(false);
});
