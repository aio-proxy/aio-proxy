import type { GoogleAntigravityCredential } from "../schema";

import { ANTIGRAVITY_GOOGLE_API_CLIENT, antigravityUserAgent } from "./hub-version";

export function createCcaHeaders(
  credential: Pick<GoogleAntigravityCredential, "accessToken">,
  stream: boolean,
): Headers {
  return new Headers({
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": antigravityUserAgent(),
    "X-Goog-Api-Client": ANTIGRAVITY_GOOGLE_API_CLIENT,
  });
}
