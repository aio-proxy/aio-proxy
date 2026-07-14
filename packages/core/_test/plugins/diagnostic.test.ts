import { describe, expect, test } from "bun:test";
import { redactPluginError } from "../../src/plugins/diagnostic";

describe("redactPluginError", () => {
  test("removes OAuth material, URLs, causes, stacks, and arbitrary third-party secrets", () => {
    const thirdPartySecret = "third-party-secret-value";
    const error = new Error(
      `Bearer bearer-value access_token=access-value refresh_token=refresh-value authorization_code=auth-code code=callback-code code_verifier=verifier-value state=oauth-state accessToken=camel-access refreshToken=camel-refresh https://example.test/callback?code=query-code raw=https://example.test/callback?state=query-state ${thirdPartySecret}`,
      { cause: new Error("raw cause") },
    );
    error.stack = `Error: ${error.message}\n at plugin (${thirdPartySecret})`;

    const redacted = redactPluginError(error, { secretValues: [thirdPartySecret] });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "bearer-value",
      "access-value",
      "refresh-value",
      "auth-code",
      "callback-code",
      "verifier-value",
      "oauth-state",
      "camel-access",
      "camel-refresh",
      "query-code",
      "query-state",
      thirdPartySecret,
      "raw cause",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(redacted.name).toBe("Error");
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.stack).toContain("[REDACTED]");
    expect(redacted).not.toHaveProperty("cause");
  });
});
