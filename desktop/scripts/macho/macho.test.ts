import { expect, test } from 'bun:test';

import { machOProblems, parseMinos, versionAtMost } from './macho';

const UNIVERSAL = `Sparkle (architecture x86_64):
Load command 9
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 12.0
      sdk 15.0
Sparkle (architecture arm64):
Load command 9
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 12.0
      sdk 15.0
`;

test('reads every slice minos', () => {
  expect(parseMinos(UNIVERSAL)).toEqual(['12.0', '12.0']);
});

test('compares dotted versions numerically', () => {
  expect(versionAtMost('12.0', '13.0')).toBe(true);
  expect(versionAtMost('13.0', '13.0')).toBe(true);
  expect(versionAtMost('13.1', '13.0')).toBe(false);
  expect(versionAtMost('9.9', '13.0')).toBe(true);
});

test('the host and sidecar must be arm64 only; Sparkle only needs to include it', () => {
  const vtool = ' platform MACOS\n    minos 13.0\n';
  expect(machOProblems({ path: 'host', archs: 'arm64\n', vtool, exactArm64: true })).toEqual([]);
  expect(machOProblems({ path: 'host', archs: 'x86_64 arm64', vtool, exactArm64: true })).toHaveLength(1);
  expect(machOProblems({ path: 'Sparkle', archs: 'x86_64 arm64', vtool: UNIVERSAL, exactArm64: false })).toEqual([]);
});

test('a minos above 13.0 or a missing one fails', () => {
  expect(machOProblems({ path: 'x', archs: 'arm64', vtool: '    minos 14.0\n', exactArm64: true })).toHaveLength(1);
  expect(machOProblems({ path: 'x', archs: 'arm64', vtool: 'garbage', exactArm64: true })).toEqual([
    'x: vtool reported no minos',
  ]);
});
