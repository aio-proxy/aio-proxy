export type PKCE = {
  readonly challenge: string;
  readonly verifier: string;
};

export async function generatePKCE(): Promise<PKCE> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { challenge: base64url(new Uint8Array(digest)), verifier };
}

function base64url(bytes: Uint8Array): string {
  return bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
}
