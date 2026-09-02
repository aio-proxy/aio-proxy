/**
 * A dot-joined digit run is one version, captured whole. The dot is part of the version; a dash is
 * not — `gemini-3.7` is a newer `gemini-3`, while `claude-opus-5-thinking` is a variant of
 * `claude-opus-5` rather than a later release of it.
 */
const VERSION = /(\d+(?:\.\d+)*)/;

/** Segments, never a decimal: read as 4.1 the tenth revision would lose to `4.6`. */
type Version = readonly number[];

// Model IDs are ASCII identifiers, never translated copy, so a fixed locale keeps the order the same
// for every user instead of quietly reshuffling the list per browser locale.
const collator = new Intl.Collator('en', { sensitivity: 'base' });

const tokenize = (value: string): readonly (string | Version)[] =>
  value
    .split(VERSION)
    .filter((part) => part !== '')
    .map((part) => (VERSION.test(part) ? part.split('.').map(Number) : part));

const compareVersions = (left: Version, right: Version): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const leftSegment = left[index] ?? 0;
    const rightSegment = right[index] ?? 0;
    if (leftSegment !== rightSegment) return rightSegment - leftSegment;
  }
  // Equal so far, so the one that keeps going is the later release: `3.7` after `3`.
  return right.length - left.length;
};

/**
 * Orders model IDs for display: names ascending so families group together, version numbers
 * descending so the newest release of a family sits on top — `gpt-5.6-sol` above `gpt-5-mini`,
 * `gemini-3.7-flash` above `gemini-3-flash`.
 *
 * This is a display order only. `clientModels` itself keeps its configured order, which is the
 * client-facing listing contract shared with `/v1/models`.
 */
export const compareModelIds = (left: string, right: string): number => {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);

  for (let index = 0; index < Math.min(leftTokens.length, rightTokens.length); index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === undefined || rightToken === undefined) break;

    const leftIsVersion = typeof leftToken !== 'string';
    const rightIsVersion = typeof rightToken !== 'string';

    if (leftIsVersion && rightIsVersion) {
      const compared = compareVersions(leftToken, rightToken);
      if (compared !== 0) return compared;
      continue;
    }
    // A version sorts before the text it is compared against, so `gpt-5` leads `gpt-mini`.
    if (leftIsVersion) return -1;
    if (rightIsVersion) return 1;

    const compared = collator.compare(leftToken, rightToken);
    if (compared !== 0) return compared;
  }

  // One is a prefix of the other: the shorter, less qualified id leads (`gpt-5` before `gpt-5-mini`).
  return leftTokens.length - rightTokens.length;
};

export const sortModelIds = (models: readonly string[]): readonly string[] => [...models].sort(compareModelIds);
