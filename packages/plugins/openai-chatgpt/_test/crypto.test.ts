import { describe, expect, test } from "bun:test";
import { extractAccountId } from "../src/jwt";
import { base64url, generatePKCE, generateState } from "../src/pkce";
import { tokenResponseSchema } from "../src/schema";

describe("extractAccountId", () => {
  test("prefers the top-level ChatGPT account claim", () => {
    const token = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "nested-account" },
      chatgpt_account_id: "top-account",
      organizations: [{ id: "org-account" }],
    });

    expect(extractAccountId(token)).toBe("top-account");
  });

  test("reads the nested auth claim", () => {
    expect(
      extractAccountId(
        buildJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "nested-account" },
        }),
      ),
    ).toBe("nested-account");
  });

  test("ignores flat nested-looking auth keys", () => {
    expect(
      extractAccountId(
        buildJwt({
          "https://api.openai.com/auth.chatgpt_account_id": "wrong-account",
        }),
      ),
    ).toBeUndefined();
  });

  test("reads the first organization id", () => {
    expect(extractAccountId(buildJwt({ organizations: [{ id: "org-account" }, { id: "other-account" }] }))).toBe(
      "org-account",
    );
  });

  test("returns undefined for malformed tokens", () => {
    expect(extractAccountId("not-a-jwt")).toBeUndefined();
    expect(extractAccountId("header.not-base64url.signature")).toBeUndefined();
  });
});

describe("PKCE and state", () => {
  test("generates a valid PKCE verifier and challenge", async () => {
    const { challenge, verifier } = await generatePKCE();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
    expect(challenge).toBe(base64url(new Uint8Array(digest)));
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(challenge).not.toContain("=");
  });

  test("base64url strips padding", () => {
    expect(base64url(new Uint8Array([0xff]))).toBe("_w");
  });

  test("generates URL-safe state", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });
});

describe("tokenResponseSchema", () => {
  test("parses a valid authorization response", () => {
    expect(
      tokenResponseSchema.parse({
        access_token: "access-token",
        expires_in: 3_600,
        id_token: "id-token",
        refresh_token: "refresh-token",
        scope: "chatgpt",
      }),
    ).toEqual({
      access_token: "access-token",
      expires_in: 3_600,
      id_token: "id-token",
      refresh_token: "refresh-token",
      scope: "chatgpt",
    });
  });

  test("requires access and refresh tokens", () => {
    expect(() => tokenResponseSchema.parse({ refresh_token: "refresh-token" })).toThrow();
    expect(() => tokenResponseSchema.parse({ access_token: "access-token" })).toThrow();
  });
});

function buildJwt(payload: Record<string, unknown>): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

function encodeBase64Url(input: string): string {
  return base64url(new TextEncoder().encode(input));
}
