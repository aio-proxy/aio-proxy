import { randomBytes } from "node:crypto";

export type PKCE = {
  readonly challenge: string;
  readonly verifier: string;
};

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export async function generatePKCE(): Promise<PKCE> {
  const verifier = randomBytes(32).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    challenge: base64url(new Uint8Array(digest)),
    verifier,
  };
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
