import { expect, test } from "@rstest/core";
import { type OAuthProviderEditValues, oauthProviderEditAction } from "./oauth-provider-edit";

const values: OAuthProviderEditValues = {
  id: "person",
  name: "Personal",
  enabled: true,
  weight: 2,
  alias: { chat: { model: "model-2", preserve: false } },
  publicValues: { tenant: "work" },
  secrets: {},
  clearSecrets: [],
};

test("common-only OAuth edits use the normal provider update", () => {
  expect(oauthProviderEditAction(values, { tenant: "work" })).toEqual({
    kind: "update",
    body: {
      kind: "oauth",
      id: "person",
      name: "Personal",
      enabled: true,
      weight: 2,
      alias: { chat: { model: "model-2", preserve: false } },
    },
  });
});

test("account edits start locked reauthorization and omit blank replacement secrets", () => {
  expect(
    oauthProviderEditAction(
      {
        ...values,
        publicValues: { tenant: "personal" },
        secrets: { token: "", refreshToken: "replacement" },
        clearSecrets: ["legacyToken"],
      },
      { tenant: "work" },
    ),
  ).toEqual({
    kind: "reauthorize",
    input: {
      targetProviderId: "person",
      publicValues: { tenant: "personal" },
      secrets: { refreshToken: "replacement" },
      clearSecrets: ["legacyToken"],
      providerPatch: {
        name: "Personal",
        enabled: true,
        weight: 2,
        alias: { chat: { model: "model-2", preserve: false } },
      },
    },
  });
});

test("explicit reauthorization keeps the current draft atomic", () => {
  expect(oauthProviderEditAction(values, { tenant: "work" }, true).kind).toBe("reauthorize");
});
