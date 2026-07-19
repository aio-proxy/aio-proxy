import { expect, test } from "bun:test";

import { OAuthQuotaResetError, OAuthQuotaResetUnavailableError, OAuthQuotaResetUnsupportedError } from "./errors";

test.each([
  [OAuthQuotaResetUnsupportedError, "OAuth quota reset is unsupported", "OAUTH_QUOTA_RESET_UNSUPPORTED"],
  [OAuthQuotaResetUnavailableError, "OAuth quota reset is unavailable", "OAUTH_QUOTA_RESET_UNAVAILABLE"],
  [OAuthQuotaResetError, "OAuth quota reset failed", "OAUTH_QUOTA_RESET_FAILED"],
] as const)("defines the stable %s contract before reset behavior", (ErrorType, message, code) => {
  const error = new ErrorType();
  expect(error).toMatchObject({ name: ErrorType.name, message, code });
  expect(error).not.toHaveProperty("cause");
});
