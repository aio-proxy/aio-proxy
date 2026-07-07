import { describe, expect, test } from "bun:test";

import { ChatGPTTokenExchangeError, exchangeCodeForTokens, refreshAccessToken } from "../src/openai-chatgpt/oauth-flow";
import { base64url } from "../src/openai-chatgpt/pkce";

type TokenFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe("openai-chatgpt oauth flow", () => {
  test("exchangeCodeForTokens posts x-www-form-urlencoded", async () => {
    const now = () => 1_700_000_000_000;
    const response = await exchangeCodeForTokens("code-123", "verifier-123", {
      fetch: createTokenFetchMock(
        {
          access_token: buildJwt({ chatgpt_account_id: "access-account" }),
          expires_in: 900,
          id_token: buildJwt({ chatgpt_account_id: "id-account" }),
          refresh_token: "refresh-123",
        },
        {
          body: new URLSearchParams({
            client_id: "Iv1.b507a08c87ecfe98",
            code: "code-123",
            code_verifier: "verifier-123",
            grant_type: "authorization_code",
            redirect_uri: "http://localhost:1455/auth/callback",
          }),
        },
      ),
      now,
    });

    expect(response).toEqual({
      access: buildJwt({ chatgpt_account_id: "access-account" }),
      accountId: "access-account",
      expires: 1_700_000_900_000,
      refresh: "refresh-123",
    });
  });

  test("refreshAccessToken updates access and expires", async () => {
    const now = () => 1_700_000_000_000;
    const response = await refreshAccessToken("refresh-123", {
      fetch: createTokenFetchMock(
        {
          access_token: buildJwt({}),
          expires_in: 3_600,
          id_token: buildJwt({ chatgpt_account_id: "id-account" }),
        },
        {
          body: new URLSearchParams({
            client_id: "Iv1.b507a08c87ecfe98",
            grant_type: "refresh_token",
            refresh_token: "refresh-123",
          }),
        },
      ),
      now,
    });

    expect(response).toEqual({
      access: buildJwt({}),
      accountId: "id-account",
      expires: 1_700_003_600_000,
      refresh: "refresh-123",
    });
  });

  test("refreshAccessToken falls back to the original refresh token", async () => {
    const response = await refreshAccessToken("refresh-123", {
      fetch: createTokenFetchMock(
        {
          access_token: buildJwt({ chatgpt_account_id: "access-account" }),
          expires_in: 3_600,
        },
        {
          body: new URLSearchParams({
            client_id: "Iv1.b507a08c87ecfe98",
            grant_type: "refresh_token",
            refresh_token: "refresh-123",
          }),
        },
      ),
    });

    expect(response.refresh).toBe("refresh-123");
  });

  test("exchangeCodeForTokens throws on 400", async () => {
    const fetchMock: TokenFetch = async () => new Response("bad request", { status: 400 });

    await expect(
      exchangeCodeForTokens("code-123", "verifier-123", {
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(ChatGPTTokenExchangeError);

    await expect(
      exchangeCodeForTokens("code-123", "verifier-123", {
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("exchangeCodeForTokens rejects missing refresh_token", async () => {
    await expect(
      exchangeCodeForTokens("code-123", "verifier-123", {
        fetch: createTokenFetchMock(
          {
            access_token: buildJwt({ chatgpt_account_id: "access-account" }),
            expires_in: 3_600,
          },
          {
            body: new URLSearchParams({
              client_id: "Iv1.b507a08c87ecfe98",
              code: "code-123",
              code_verifier: "verifier-123",
              grant_type: "authorization_code",
              redirect_uri: "http://localhost:1455/auth/callback",
            }),
          },
        ),
      }),
    ).rejects.toThrow();
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

function createTokenFetchMock(
  responseBody: Record<string, unknown>,
  expectations: { readonly body: URLSearchParams },
): TokenFetch {
  return async (input, init) => {
    expect(input).toBe("https://auth.openai.com/oauth/token");
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(init?.body)).toBe(expectations.body.toString());

    return new Response(JSON.stringify(responseBody), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
}
