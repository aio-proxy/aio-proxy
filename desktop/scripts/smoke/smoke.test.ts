import { expect, test } from 'bun:test';

import { hasJitRegion } from './smoke';

const jitRows = `
MALLOC_SMALL                 150000000-150800000    [ 8192K   212K   212K     0K] rw-/rwx SM=PRV
JS JIT Generated Code       121e04000-121e08000    [   16K     0K     0K     0K] ---/rwx SM=NUL
JS JIT Generated Code       121e08000-141e08000    [512.0M  2016K  2016K     0K] rwx/rwx SM=PRV
`;

test('finds the JIT region vmmap lists while JavaScriptCore can JIT', () => {
  expect(hasJitRegion(jitRows)).toBe(true);
});

test('an interpreted-only process (no allow-jit) or empty output has no JIT region', () => {
  expect(hasJitRegion('MALLOC_SMALL   150000000-150800000 [ 8192K ] rw-/rwx SM=PRV\n')).toBe(false);
  expect(hasJitRegion('')).toBe(false);
});
