import type { DashboardOAuthFormField } from "@aio-proxy/types";

import { expect, test } from "@rstest/core";

import { oauthAccountSubmission } from "./oauth-account-submission";

const fields: readonly DashboardOAuthFormField[] = [
  { type: "select", key: "mode", label: "Mode", options: [{ value: "basic", label: "Basic" }] },
  { type: "text", key: "tenant", label: "Tenant", when: { key: "mode", equals: "enterprise" } },
  { type: "secret", key: "token", label: "Token", configured: true, when: { key: "mode", equals: "enterprise" } },
];

test("OAuth submission removes stale values for hidden conditional fields", () => {
  expect(
    oauthAccountSubmission(fields, {
      publicValues: { mode: "basic", tenant: "stale" },
      secrets: { token: "stale-secret" },
      clearSecrets: ["token"],
    }),
  ).toEqual({ publicValues: { mode: "basic" }, secrets: {}, clearSecrets: [] });
});
