import { readCursorClaims } from '../jwt/index';

// cursor.com only accepts ids in this charset; a claim outside it means an opaque upstream 401.
const USER_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * cursor.com keys its session cookie on the last `|`-separated segment of the JWT `sub`
 * (`auth0|user_01ABC` -> `user_01ABC`). Empty segments are dropped, so a trailing `|` is ignored.
 */
export function cursorUserId(accessToken: string, fallbackSubject?: string): string {
  const claim = readCursorClaims(accessToken)['sub'];
  const subject = typeof claim === 'string' && claim.trim() !== '' ? claim.trim() : fallbackSubject;
  if (subject === undefined) throw new Error('Cursor access token has no account subject');
  const userId = subject
    .split('|')
    .filter((segment) => segment !== '')
    .at(-1);
  if (userId === undefined || !USER_ID_PATTERN.test(userId)) {
    throw new Error('Cursor access token has an invalid account subject');
  }
  return userId;
}

/** The separator is stored percent-encoded on cursor.com, so it is sent as the literal `%3A%3A`. */
export function cursorSessionCookie(accessToken: string, fallbackSubject?: string): string {
  return `WorkosCursorSessionToken=${cursorUserId(accessToken, fallbackSubject)}%3A%3A${accessToken}`;
}
