import { expect, test } from 'bun:test';

import { releaseNotes } from './release-notes';

test('preserves only the requested release notes, including nested headings and links', () => {
  const changelog =
    '# Changelog\n\n## 2.0.0\n\nNewer\n\n## 1.2.3\n\n### Patch Changes\n\n- Fixed [uploads](https://example.com).\n\n## 1.2.2\n\nOlder\n';
  expect(releaseNotes(changelog, '1.2.3')).toBe('### Patch Changes\n\n- Fixed [uploads](https://example.com).');
});

test('does not produce a release body from an absent or empty entry', () => {
  expect(releaseNotes('## 1.2.3\n\n## 1.2.2\nOlder', '1.2.3')).toBeUndefined();
  expect(releaseNotes('## 1.2.30\nWrong version', '1.2.3')).toBeUndefined();
});
