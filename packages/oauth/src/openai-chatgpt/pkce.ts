const PKCE_BYTE_LENGTH = 32;
const PKCE_VERIFIER_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const PKCE_VERIFIER_CHARSET_LIMIT = Math.floor(256 / PKCE_VERIFIER_CHARSET.length) * PKCE_VERIFIER_CHARSET.length;

export type PKCE = {
  readonly challenge: string;
  readonly verifier: string;
};

export function generateState(): string {
  return base64url(randomBytes(PKCE_BYTE_LENGTH));
}

export async function generatePKCE(): Promise<PKCE> {
  const verifier = generateVerifier();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    challenge: base64url(new Uint8Array(digest)),
    verifier,
  };
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function generateVerifier(): string {
  const verifier: string[] = [];
  while (verifier.length < 43) {
    const byte = randomBytes(1)[0];
    if (byte === undefined) {
      continue;
    }
    if (byte >= PKCE_VERIFIER_CHARSET_LIMIT) {
      continue;
    }
    verifier.push(PKCE_VERIFIER_CHARSET.charAt(byte % PKCE_VERIFIER_CHARSET.length));
  }
  return verifier.join("");
}
