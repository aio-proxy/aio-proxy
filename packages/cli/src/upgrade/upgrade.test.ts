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

import { NPM_REGISTRY } from './constants';
import { buildBunInstallArgs, buildHomebrewUpdateArgs, buildNpmInstallArgs, buildPnpmInstallArgs } from './methods';

test('buildBunInstallArgs pins registry and version', () => {
  expect(buildBunInstallArgs('1.2.3', NPM_REGISTRY)).toEqual([
    'add',
    '-g',
    `--registry=${NPM_REGISTRY}`,
    'aio-proxy@1.2.3',
  ]);
});
test('buildNpmInstallArgs pins registry and version', () => {
  expect(buildNpmInstallArgs('1.2.3', NPM_REGISTRY)).toEqual([
    'install',
    '-g',
    `--registry=${NPM_REGISTRY}`,
    'aio-proxy@1.2.3',
  ]);
});
test('buildPnpmInstallArgs pins registry and version', () => {
  expect(buildPnpmInstallArgs('1.2.3', NPM_REGISTRY)).toEqual([
    'add',
    '-g',
    `--registry=${NPM_REGISTRY}`,
    'aio-proxy@1.2.3',
  ]);
});
test('buildHomebrewUpdateArgs switches on force', () => {
  expect(buildHomebrewUpdateArgs(false)).toEqual(['upgrade', 'aio-proxy/tap/aio-proxy']);
  expect(buildHomebrewUpdateArgs(true)).toEqual(['reinstall', 'aio-proxy/tap/aio-proxy']);
});

import { existsSync, readFileSync } from 'node:fs';

import { replaceBinaryForUpdate, sweepStaleBackups } from './binary';

test('replaceBinaryForUpdate rolls back when verify fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-'));
  const target = join(root, 'aio-proxy');
  const temp = join(root, 'aio-proxy.new');
  const backup = join(root, 'aio-proxy.1.2.bak');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  const res = await replaceBinaryForUpdate({
    targetPath: target,
    tempPath: temp,
    backupPath: backup,
    expectedVersion: '9.9.9',
    verify: async () => ({ ok: false }),
  });
  expect(res.ok).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('OLD'); // 回滚到旧二进制
  expect(existsSync(temp)).toBe(false);
});

test('replaceBinaryForUpdate swaps in new binary when verify ok', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-'));
  const target = join(root, 'aio-proxy');
  const temp = join(root, 'aio-proxy.new');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  const res = await replaceBinaryForUpdate({
    targetPath: target,
    tempPath: temp,
    backupPath: join(root, 'aio-proxy.1.2.bak'),
    expectedVersion: '1.0.0',
    verify: async () => ({ ok: true, actual: '1.0.0' }),
  });
  expect(res.ok).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('NEW');
});

test('sweepStaleBackups removes only timestamped .bak siblings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-sweep-'));
  const target = join(root, 'aio-proxy');
  writeFileSync(target, 'x');
  writeFileSync(join(root, 'aio-proxy.123.456.bak'), 'x');
  writeFileSync(join(root, 'aio-proxy.unrelated.txt'), 'x');
  await sweepStaleBackups(target);
  expect(existsSync(join(root, 'aio-proxy.123.456.bak'))).toBe(false);
  expect(existsSync(join(root, 'aio-proxy.unrelated.txt'))).toBe(true);
});
