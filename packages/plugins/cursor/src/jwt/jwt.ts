import { isPlainObject } from 'es-toolkit/predicate';
export function readCursorClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    const value: unknown = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function readClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function cursorTokenExpiry(token: string, now: number): number {
  const exp = readCursorClaims(token)['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 - 5 * 60_000 : now + 3_600_000;
}

export function cursorIdentity(input: { readonly accessToken: string }): {
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly label: string;
  readonly subject?: string;
  readonly email?: string;
} {
  const claims = readCursorClaims(input.accessToken);
  const subject = readClaim(claims, 'sub');
  const email = readClaim(claims, 'email')?.toLowerCase();
  if (subject === undefined && email === undefined) {
    throw new Error('Cursor authentication did not return a stable account identifier');
  }
  const identity = subject !== undefined ? `sub:${subject}` : `email:${email}`;
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `cursor-${digest.slice(0, 12)}`,
    label: 'Cursor',
    ...(subject === undefined ? {} : { subject }),
    ...(email === undefined ? {} : { email }),
  };
}
