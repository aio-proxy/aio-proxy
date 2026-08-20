import { expect, test } from 'bun:test';

import manifest from './package.json' with { type: 'json' };

const forbiddenPackageImport =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bimport\s+|\brequire\s*\(\s*)["'](?:@aio-proxy\/|@earendil-works\/|@oh-my-pi\/)/u;
const relativeRuntimeImport =
  /(?:\bexport\s[\s\S]*?\bfrom\s*|\bfrom\s*|\bimport\s*(?:\(\s*)?|\bimport\s+|\brequire\s*\(\s*)["']\.\.?\/[^"']+["']/u;

test('manifest selects one explicit entry per host', () => {
  expect(manifest.scripts.build).toBe('rslib --lib pi-family');
  expect(manifest.pi.extensions).toEqual(['./dist/official-pi.js']);
  expect(manifest.omp.extensions).toEqual(['./dist/omp.js']);
  expect(new Set([...manifest.pi.extensions, ...manifest.omp.extensions]).size).toBe(2);
});

test.each(['official-pi', 'omp'])('%s artifact is self-contained', async (entry) => {
  const url = new URL(`./dist/${entry}.js`, import.meta.url);
  const code = await Bun.file(url).text();
  expect(forbiddenPackageImport.test(code)).toBe(false);
  expect(relativeRuntimeImport.test(code)).toBe(false);
  expect(typeof (await import(url.href)).default).toBe('function');
});
