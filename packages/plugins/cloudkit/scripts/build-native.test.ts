import { describe, expect, test } from 'bun:test';

import { resolveBundleVersion } from './build-native';

describe('CloudKit native bundle version', () => {
  test('uses a numeric release version suitable for CFBundleVersion', () => {
    expect(resolveBundleVersion('1.2.3')).toBe('1.2.3');
  });

  test('rejects a missing release manifest version', () => {
    expect(() => resolveBundleVersion(undefined)).toThrow('release manifest');
  });
});
