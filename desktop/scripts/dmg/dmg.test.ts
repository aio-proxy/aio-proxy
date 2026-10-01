import { expect, test } from 'bun:test';

import { teamIdentifier } from './dmg';

test('reads the signing team from codesign -dv output, and none for an ad-hoc signature', () => {
  const developerId =
    'Executable=/x\nAuthority=Developer ID Application: Team (ABCDE12345)\nTeamIdentifier=ABCDE12345\n';
  expect(teamIdentifier(developerId)).toBe('ABCDE12345');
  expect(teamIdentifier('Signature=adhoc\nTeamIdentifier=not set\n')).toBeUndefined();
  expect(teamIdentifier('code object is not signed at all\n')).toBeUndefined();
});
