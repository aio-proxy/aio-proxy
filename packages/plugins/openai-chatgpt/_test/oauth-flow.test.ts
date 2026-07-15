import { describe, expect, test } from "bun:test";
import { ChatGPTTokenExchangeError, exchangeCodeForTokens, refreshAccessToken } from "../src/oauth-flow";
import { base64url } from "../src/pkce";

type TokenFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe("OpenAI ChatGPT OAuth flow", () => {
  test("posts the host-selected redirect URI during authorization code exchange", async () => {
    const redirectUri = "http://localhost:43123/auth/callback";
    const response = await exchangeCodeForTokens("code-123", "verifier-123", {
      fetch: createTokenFetchMock(
        {
          access_token: buildJwt({ chatgpt_account_id: "access-account" }),
          expires_in: 900,
          id_token: buildJwt({ chatgpt_account_id: "id-account" }),
          refresh_token: "refresh-123",
        },
        new URLSearchParams({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          code: "code-123",
          code_verifier: "verifier-123",
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      ),
      now: () => 1_700_000_000_000,
      redirectUri,
    });

    expect(response).toEqual({
      accessToken: buildJwt({ chatgpt_account_id: "access-account" }),
      accountId: "access-account",
      expiresAt: 1_700_000_900_000,
      refreshToken: "refresh-123",
    });
  });

  test("keeps the previous rotating refresh token when upstream omits one", async () => {
    const response = await refreshAccessToken("refresh-123", {
      fetch: createTokenFetchMock(
        {
          access_token: buildJwt({ chatgpt_account_id: "access-account" }),
          expires_in: 3_600,
        },
        refreshBody("refresh-123"),
      ),
    });

    expect(response.refreshToken).toBe("refresh-123");
  });

  test("stores a rotated refresh token supplied by upstream", async () => {
    const response = await refreshAccessToken("refresh-123", {
      fetch: createTokenFetchMock(
        {
          access_token: buildJwt({ chatgpt_account_id: "access-account" }),
          refresh_token: "refresh-456",
        },
        refreshBody("refresh-123"),
      ),
    });

    expect(response.refreshToken).toBe("refresh-456");
  });

  test("propagates the abort signal to the token endpoint", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;

    await exchangeCodeForTokens("code-123", "verifier-123", {
      fetch: async (_input, init) => {
        observedSignal = init?.signal;
        return Response.json({
          access_token: buildJwt({ chatgpt_account_id: "account" }),
          refresh_token: "refresh",
        });
      },
      redirectUri: "http://localhost:1455/auth/callback",
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
  });

  test("surfaces non-successful token responses without leaking tokens", async () => {
    const fetchMock: TokenFetch = async () => new Response("bad request", { status: 400 });
    const exchange = exchangeCodeForTokens("secret-code", "secret-verifier", {
      fetch: fetchMock,
      redirectUri: "http://localhost:1455/auth/callback",
    });

    await expect(exchange).rejects.toBeInstanceOf(ChatGPTTokenExchangeError);
    await expect(exchange).rejects.toMatchObject({ status: 400 });
    await expect(exchange).rejects.not.toThrow(/secret-code|secret-verifier/);
  });
});

function refreshBody(refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "openid profile email",
  });
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

function encodeBase64Url(input: string): string {
  return base64url(new TextEncoder().encode(input));
}

function createTokenFetchMock(responseBody: Record<string, unknown>, expectedBody: URLSearchParams): TokenFetch {
  return async (input, init) => {
    expect(input).toBe("https://auth.openai.com/oauth/token");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(init?.body)).toBe(expectedBody.toString());
    return Response.json(responseBody);
  };
}
