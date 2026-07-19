import { expect, test } from "bun:test";
import {
  GOOGLE_ANTIGRAVITY_SCOPES,
  GOOGLE_CLIENT_ID,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
} from "./constants";
import { buildGoogleAuthorizationUrl, exchangeAuthorizationCode } from "./flow";
import { fetchGoogleEmail } from "./userinfo";

test("builds the fixed Google authorization request without PKCE", () => {
  const url = new URL(buildGoogleAuthorizationUrl("state-1", "http://localhost:51121/oauth-callback"));
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("state")).toBe("state-1");
  expect(url.searchParams.has("code_challenge")).toBe(false);
  expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_ANTIGRAVITY_SCOPES);
});

test("exchanges the authorization code as form data", async () => {
  const requests: Request[] = [];
  const token = await exchangeAuthorizationCode("authorization-code", "http://localhost:51121/oauth-callback", {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "scope-1",
      });
    },
    now: () => 1_700_000_000_000,
  });

  expect(token).toEqual({
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_700_003_600_000,
    tokenType: "Bearer",
    scope: "scope-1",
  });
  expect(requests[0]?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
  expect(requests[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  const body = new URLSearchParams(await requests[0]?.clone().text());
  expect(body.get("code")).toBe("authorization-code");
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
});

test("fetches and trims the Google account email", async () => {
  const requests: Request[] = [];
  const email = await fetchGoogleEmail("access-1", {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ email: " person@example.com " });
    },
  });

  expect(email).toBe("person@example.com");
  expect(requests[0]?.url).toBe(GOOGLE_USERINFO_ENDPOINT);
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer access-1");
});

test("token exchange failures never expose the code, callback query, or raw response", async () => {
  const error = await rejected(
    exchangeAuthorizationCode(
      "authorization-code-secret",
      "http://localhost:51121/oauth-callback?callback-query-secret=1",
      {
        fetch: async () =>
          Response.json(
            {
              error: "invalid_grant",
              access_token: "raw-access-secret",
              refresh_token: "raw-refresh-secret",
            },
            { status: 400 },
          ),
      },
    ),
  );

  expect(error.message).toContain("Google authorization code exchange failed");
  expect(errorSurface(error)).not.toMatch(
    /authorization-code-secret|callback-query-secret|raw-access-secret|raw-refresh-secret|invalid_grant/u,
  );
});

test("userinfo failures never expose the access token, email, or raw response", async () => {
  const error = await rejected(
    fetchGoogleEmail("userinfo-access-secret", {
      fetch: async () =>
        Response.json({ email: "private@example.com", detail: "raw-userinfo-secret" }, { status: 403 }),
    }),
  );

  expect(error.message).toContain("Google userinfo request failed");
  expect(errorSurface(error)).not.toMatch(/userinfo-access-secret|private@example.com|raw-userinfo-secret/u);
});

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected promise to reject");
}

function errorSurface(error: Error): string {
  return [error.message, ...Object.values(error), JSON.stringify(error)].join(" ");
}
