/**
 * The server accepts any nonempty string as an option path segment, so the single-line editor
 * needs an escape: `\.` is a literal dot inside a segment and `\\` a literal backslash. Everything
 * else — spaces, slashes, non-ASCII — is taken verbatim, and nothing is trimmed, because trimming
 * would make a segment with a leading or trailing space impossible to express.
 */
export const parseOverridePath = (input: string): readonly string[] | undefined => {
  const segments: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '.') {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  segments.push(current);
  // A trailing backslash escapes nothing, and an empty segment names no option.
  return escaped || segments.some((segment) => segment === '') ? undefined : segments;
};

/** Inverse of {@link parseOverridePath}, used for the pinned-path chips and their labels. */
export const formatOverridePath = (path: readonly string[]): string =>
  path.map((segment) => segment.replace(/[\\.]/gu, '\\$&')).join('.');
