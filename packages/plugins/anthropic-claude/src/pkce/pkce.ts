export type PKCE = {
  readonly challenge: string;
  readonly verifier: string;
};

export function generateState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function generatePKCE(): Promise<PKCE> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Bun.CryptoHasher('sha256').update(verifier).digest();
  return { challenge: base64url(digest), verifier };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
