import { describe, expect, test } from "bun:test";

import { normalizeDashboardPassword } from "./password";

describe("normalizeDashboardPassword", () => {
  test("hashes an exact plaintext password with Bun Argon2id", async () => {
    const input = { server: { password: "  exact password  " }, providers: {} };

    const result = await normalizeDashboardPassword(input);
    const password = (result["server"] as Record<string, unknown>)["password"];

    expect(password).toBeString();
    expect(password).toStartWith("$argon2id$");
    expect(await Bun.password.verify("  exact password  ", password as string)).toBe(true);
  });

  test("keeps an existing valid Argon2id hash", async () => {
    const hash = await Bun.password.hash("secret");
    const input = { server: { password: hash }, providers: {} };

    expect(await normalizeDashboardPassword(input)).toBe(input);
  });

  test("rejects a malformed Argon2id hash", async () => {
    await expect(
      normalizeDashboardPassword({ server: { password: "$argon2id$broken" }, providers: {} }),
    ).rejects.toThrow("Invalid Argon2id password hash");
  });

  test("rejects an Argon2id PHC with unsafe parameters", async () => {
    await expect(
      normalizeDashboardPassword({
        server: { password: "$argon2id$v=19$m=1,t=1,p=1$AA$AA" },
        providers: {},
      }),
    ).rejects.toThrow("Invalid Argon2id password hash");
  });

  test("keeps config without a password", async () => {
    const input = { server: {}, providers: {} };
    expect(await normalizeDashboardPassword(input)).toBe(input);
  });
});
