import { describe, expect, spyOn, test } from "bun:test";

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

  test("rejects a valid Argon2id PHC with weak parameters before verification", async () => {
    const hash = (await Bun.password.hash("secret")).replace(/m=\d+,t=\d+,p=\d+/u, "m=1024,t=1,p=1");
    const verify = spyOn(Bun.password, "verify").mockResolvedValue(true);

    try {
      await expect(normalizeDashboardPassword({ server: { password: hash }, providers: {} })).rejects.toThrow(
        "Invalid Argon2id password hash",
      );
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });

  test("rejects a valid Argon2id PHC with excessive parameters before verification", async () => {
    const hash = (await Bun.password.hash("secret")).replace(/m=\d+,t=\d+,p=\d+/u, "m=262145,t=2,p=1");
    const verify = spyOn(Bun.password, "verify").mockResolvedValue(true);

    try {
      await expect(normalizeDashboardPassword({ server: { password: hash }, providers: {} })).rejects.toThrow(
        "Invalid Argon2id password hash",
      );
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });

  test("keeps config without a password", async () => {
    const input = { server: {}, providers: {} };
    expect(await normalizeDashboardPassword(input)).toBe(input);
  });
});
