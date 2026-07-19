import type { OAuthHttpOptions } from "./flow";

import { antigravityUserAgent } from "../runtime/hub-version";
import { GOOGLE_USERINFO_ENDPOINT } from "./constants";

export async function fetchGoogleEmail(accessToken: string, options: OAuthHttpOptions = {}): Promise<string> {
  if (accessToken.trim() === "") throw new Error("Google userinfo request failed: access token is missing");
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": antigravityUserAgent() },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new Error("Google userinfo request failed");
  }
  if (!response.ok) throw new Error(`Google userinfo request failed (HTTP ${response.status})`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Google userinfo request failed: invalid response");
  }
  const email = readEmail(payload);
  if (email === undefined) throw new Error("Google userinfo response is missing email");
  return email;
}

function readEmail(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = Reflect.get(payload, "email");
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}
