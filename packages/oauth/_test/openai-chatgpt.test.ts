import { describe, expect, test } from "bun:test";
import { extractAccountId } from "../src/openai-chatgpt/jwt";

describe("extractAccountId", () => {
  test("extractAccountId prefers top-level claim", () => {
    const token = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "nested-account" },
      chatgpt_account_id: "top-account",
      organizations: [{ id: "org-account" }],
    });

    expect(extractAccountId(token)).toBe("top-account");
  });

  test("extractAccountId reads nested auth claim", () => {
    const token = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "nested-account" },
    });

    expect(extractAccountId(token)).toBe("nested-account");
  });

  test("extractAccountId ignores flat nested-looking auth key", () => {
    const token = buildJwt({
      "https://api.openai.com/auth.chatgpt_account_id": "wrong-account",
    });

    expect(extractAccountId(token)).toBeUndefined();
  });

  test("extractAccountId reads first organization id", () => {
    const token = buildJwt({
      organizations: [{ id: "org-account" }, { id: "other-account" }],
    });

    expect(extractAccountId(token)).toBe("org-account");
  });

  test("extractAccountId returns undefined for malformed token", () => {
    expect(extractAccountId("not-a-jwt")).toBeUndefined();
    expect(extractAccountId("header.not-base64url.signature")).toBeUndefined();
  });
});

function buildJwt(payload: Record<string, unknown>): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
