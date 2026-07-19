import {
  GOOGLE_ANTIGRAVITY_SCOPES,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_TOKEN_ENDPOINT,
} from "./constants";

export type GoogleToken = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly tokenType?: string;
  readonly scope?: string;
};

export type OAuthHttpOptions = {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
};

export function buildGoogleAuthorizationUrl(state: string, redirectUri: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  options: OAuthHttpOptions = {},
): Promise<GoogleToken> {
  if (code.trim() === "") throw new Error("Google authorization code is missing");
  const response = await requestToken(
    new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    options,
  );
  if (!response.ok) throw new Error(`Google authorization code exchange failed (HTTP ${response.status})`);
  const payload = await readTokenPayload(response);
  const accessToken = requiredString(payload, "access_token", "access token");
  const refreshToken = requiredString(payload, "refresh_token", "refresh token");
  const expiresIn = requiredNumber(payload, "expires_in");
  const tokenType = optionalString(payload, "token_type");
  const scope = optionalString(payload, "scope");
  return {
    accessToken,
    refreshToken,
    expiresAt: (options.now ?? Date.now)() + expiresIn * 1_000,
    ...(tokenType === undefined ? {} : { tokenType }),
    ...(scope === undefined ? {} : { scope }),
  };
}

async function requestToken(body: URLSearchParams, options: OAuthHttpOptions): Promise<Response> {
  try {
    return await (options.fetch ?? globalThis.fetch)(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new Error("Google authorization code exchange failed");
  }
}

async function readTokenPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new Error("Google authorization code exchange failed: invalid token response");
  }
}

function requiredString(payload: Record<string, unknown>, key: string, label: string): string {
  const value = optionalString(payload, key);
  if (value === undefined) throw new Error(`Google authorization code exchange failed: response missing ${label}`);
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function requiredNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Google authorization code exchange failed: invalid token response");
  }
  return value;
}
