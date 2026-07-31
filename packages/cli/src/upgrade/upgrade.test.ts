import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPathInDirectory, resolveUpgradeMethod } from './detect';

test('isPathInDirectory: lexical match', () => {
  expect(isPathInDirectory('/opt/bun/bin/aio-proxy', '/opt/bun/bin')).toBe(true);
  expect(isPathInDirectory('/usr/local/bin/aio-proxy', '/opt/bun/bin')).toBe(false);
});

test('isPathInDirectory: resolves symlinked binary (Homebrew Cellar)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-brew-'));
  const cellarBin = join(root, 'Cellar/aio-proxy/1.0.0/bin');
  const optBin = join(root, 'opt/aio-proxy/bin');
  mkdirSync(cellarBin, { recursive: true });
  mkdirSync(join(root, 'opt/aio-proxy'), { recursive: true });
  writeFileSync(join(cellarBin, 'aio-proxy'), '#!/bin/sh\n');
  symlinkSync(cellarBin, optBin);
  // PATH 解析到 opt 软链目录，词法不落在 Cellar，realpath 兜底应判 true
  expect(isPathInDirectory(join(optBin, 'aio-proxy'), cellarBin)).toBe(true);
});

test('resolveUpgradeMethod: priority brew > bun > npm > pnpm', () => {
  const dirs = { brew: '/brew/bin', bun: '/bun/bin', npm: '/npm/bin', pnpm: '/pnpm/bin' };
  expect(resolveUpgradeMethod('/brew/bin/aio-proxy', dirs)).toBe('brew');
  expect(resolveUpgradeMethod('/bun/bin/aio-proxy', { bun: '/bun/bin', npm: '/npm/bin' })).toBe('bun');
  expect(resolveUpgradeMethod('/npm/bin/aio-proxy', { npm: '/npm/bin', pnpm: '/pnpm/bin' })).toBe('npm');
  expect(resolveUpgradeMethod('/pnpm/bin/aio-proxy', { pnpm: '/pnpm/bin' })).toBe('pnpm');
  expect(resolveUpgradeMethod('/home/u/.local/bin/aio-proxy', dirs)).toBe('binary');
});
