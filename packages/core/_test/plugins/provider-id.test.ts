import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { normalizeSuggestedKey, ProviderIdCollisionError, resolveProviderId } from "../../src/plugins/provider-id";

const identity = {
  plugin: "@example/oauth",
  capability: "default",
  fingerprint: "account@example.com",
};

function digest(): string {
  return createHash("sha256")
    .update(`${identity.plugin}\0${identity.capability}\0${identity.fingerprint}`)
    .digest("hex");
}

describe("resolveProviderId", () => {
  test("uses a free normalized suggested key directly", () => {
    expect(resolveProviderId({ ...identity, suggestedKey: "  Work Account ", providerIds: [], accounts: [] })).toEqual({
      status: "new",
      providerId: "work-account",
    });
  });

  test("returns the canonical Provider ID for an existing namespaced fingerprint", () => {
    expect(
      resolveProviderId({
        ...identity,
        suggestedKey: "ignored",
        providerIds: ["existing"],
        accounts: [{ providerId: "existing", ...identity }],
      }),
    ).toEqual({ status: "existing", providerId: "existing" });
  });

  test("uses the first eight digest characters after a key collision", () => {
    expect(resolveProviderId({ ...identity, suggestedKey: "work", providerIds: ["work"], accounts: [] })).toEqual({
      status: "new",
      providerId: `work-${digest().slice(0, 8)}`,
    });
  });

  test("treats orphan account Provider IDs as occupied", () => {
    expect(
      resolveProviderId({
        ...identity,
        suggestedKey: "work",
        providerIds: [],
        accounts: [
          {
            providerId: "work",
            plugin: identity.plugin,
            capability: identity.capability,
            fingerprint: "different-account",
          },
        ],
      }),
    ).toEqual({ status: "new", providerId: `work-${digest().slice(0, 8)}` });
  });

  test("extends injected prefix collisions through 12, 16, and 20 characters", () => {
    const hash = digest();
    const providerIds = ["work", 8, 12, 16].map((value) =>
      typeof value === "string" ? value : `work-${hash.slice(0, value)}`,
    );
    expect(resolveProviderId({ ...identity, suggestedKey: "work", providerIds, accounts: [] })).toEqual({
      status: "new",
      providerId: `work-${hash.slice(0, 20)}`,
    });
  });

  test("is independent of provider and account iteration order", () => {
    const input = {
      ...identity,
      suggestedKey: "work",
      providerIds: ["z", "work", "a"],
      accounts: [
        { providerId: "z", plugin: "@example/other", capability: "default", fingerprint: "z" },
        { providerId: "a", plugin: "@example/other", capability: "default", fingerprint: "a" },
      ],
    };
    expect(resolveProviderId(input)).toEqual(
      resolveProviderId({
        ...input,
        providerIds: [...input.providerIds].reverse(),
        accounts: [...input.accounts].reverse(),
      }),
    );
  });

  test.each(["", "  ", "---", "🎉", " / "])("normalizes blank or invalid %j to oauth", (value) => {
    expect(normalizeSuggestedKey(value)).toBe("oauth");
    expect(resolveProviderId({ ...identity, suggestedKey: value, providerIds: [], accounts: [] })).toEqual({
      status: "new",
      providerId: "oauth",
    });
  });

  test("throws a typed error only when the full digest candidate is occupied", () => {
    const hash = digest();
    const providerIds = ["work", ...Array.from({ length: 15 }, (_, index) => `work-${hash.slice(0, 8 + index * 4)}`)];
    expect(() => resolveProviderId({ ...identity, suggestedKey: "work", providerIds, accounts: [] })).toThrow(
      ProviderIdCollisionError,
    );
  });
});
