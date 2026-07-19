import { expect, test } from "bun:test";
import { OAuthCallbackError, parseOAuthCallback } from "./callback";

test("manual OAuth callback validates redirect and state without exposing the raw callback", () => {
  const expected = "http://127.0.0.1:1455/auth/callback";
  expect(parseOAuthCallback(`${expected}?code=accepted&state=expected`, expected, "expected")).toEqual({
    code: "accepted",
  });

  for (const raw of [
    `${expected}?code=secret-code&state=wrong`,
    "http://127.0.0.1:9999/auth/callback?code=secret-code&state=expected",
  ]) {
    try {
      parseOAuthCallback(raw, expected, "expected");
      throw new Error("expected callback rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthCallbackError);
      expect(String(error)).not.toContain("secret-code");
    }
  }
});
