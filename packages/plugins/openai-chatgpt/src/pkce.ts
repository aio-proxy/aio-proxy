export type PKCE = {
  readonly challenge: string;
  readonly verifier: string;
};

export function generateState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function generatePKCE(): Promise<PKCE> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { challenge: base64url(new Uint8Array(digest)), verifier };
}

export function base64url(bytes: Uint8Array): string {
  const encoded = btoa(String.fromCharCode(...bytes));
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
