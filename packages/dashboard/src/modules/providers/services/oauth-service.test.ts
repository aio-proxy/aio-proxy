import { expect, test } from "@rstest/core";

import { oauthSessionQueryOptions } from "./oauth-service";

test("OAuth session polling stops after the query enters an error state", () => {
  const options = oauthSessionQueryOptions("0198bfc4-239e-7d62-bcb0-a9e0849cabaf");
  const interval = options.refetchInterval as (query: { state: { status: string } }) => number | false | undefined;

  expect(interval({ state: { status: "error" } })).toBe(false);
});
