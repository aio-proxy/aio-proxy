import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CliExit } from '../exit';
import { resolveInstalledLauncher } from '../upgrade';
import { resolveAgentExecutable, resolveGrokExecutable } from './index';

const writeExecutable = (path: string, body = '#!/bin/sh\n'): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

const withEmptyManagerPath = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = process.env['PATH'];
  process.env['PATH'] = '/usr/bin:/bin';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
};

test('resolveAgentExecutable prefers the stable PATH launcher over its versioned symlink target', () => {
  const versioned = '/opt/homebrew/Cellar/aio-proxy/0.3.0/bin/aio-proxy';
  const launcher = '/opt/homebrew/bin/aio-proxy';
  expect(
    resolveAgentExecutable(
      () => launcher,
      versioned,
      (path) => (path === launcher ? versioned : path),
    ),
  ).toBe(launcher);
});

test('Homebrew symlink retarget keeps the stable prefix launcher', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-grok-brew-'));
  const cellar = join(prefix, 'Cellar', 'aio-proxy', '1.2.3', 'bin', 'aio-proxy');
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'brew'));
  writeExecutable(cellar);
  symlinkSync(cellar, bin);
  await withEmptyManagerPath(async () => {
    expect(
      await resolveGrokExecutable(
        () => bin,
        cellar,
        (path) => (path === bin ? cellar : path),
        () => true,
      ),
    ).toBe(bin);
  });
});

test('npm launcher ownership is saved as the prefix entry', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-grok-npm-'));
  const pkg = join(prefix, 'lib', 'node_modules', 'aio-proxy');
  const pkgBin = join(pkg, 'bin', 'aio-proxy.js');
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'npm'));
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"aio-proxy","bin":{"aio-proxy":"bin/aio-proxy.js"}}\n');
  writeExecutable(pkgBin, '#!/usr/bin/env node\n');
  symlinkSync(pkgBin, bin);
  await withEmptyManagerPath(async () => {
    expect(
      await resolveGrokExecutable(
        () => bin,
        bin,
        (path) => path,
        () => true,
      ),
    ).toBe(bin);
  });
});

test('pnpm shim is saved as the stable launcher', async () => {
  const pnpmHome = join(mkdtempSync(join(tmpdir(), 'aio-grok-pnpm-')), 'pnpm');
  const pkg = join(pnpmHome, 'global', 'node_modules', 'aio-proxy');
  const pkgBin = join(pkg, 'bin', 'aio-proxy.js');
  const bin = join(pnpmHome, 'aio-proxy');
  writeExecutable(join(pnpmHome, 'pnpm'));
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"aio-proxy","bin":{"aio-proxy":"bin/aio-proxy.js"}}\n');
  writeExecutable(pkgBin, '#!/usr/bin/env node\n');
  symlinkSync(pkgBin, bin);
  await withEmptyManagerPath(async () => {
    expect(
      await resolveGrokExecutable(
        () => bin,
        bin,
        (path) => path,
        () => true,
      ),
    ).toBe(bin);
  });
});

test('Bun dev launcher cannot be saved without a published PATH entry', async () => {
  await withEmptyManagerPath(async () => {
    try {
      await resolveGrokExecutable(
        () => null,
        '/opt/homebrew/bin/bun',
        (path) => path,
        () => true,
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CliExit);
    }
  });
});

test('PATH may fall back to an existing standalone release entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-grok-bin-'));
  const bin = join(root, 'aio-proxy');
  writeExecutable(bin);
  await withEmptyManagerPath(async () => {
    expect(
      await resolveGrokExecutable(
        () => bin,
        '/opt/homebrew/bin/bun',
        (path) => path,
        () => true,
      ),
    ).toBe(bin);
  });
});

test('native package paths are not a stable launcher', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-grok-native-'));
  const native = join(prefix, 'node_modules', '@aio-proxy', 'cli-linux-x64', 'bin', 'aio-proxy');
  writeExecutable(native);
  await withEmptyManagerPath(async () => {
    await expect(resolveInstalledLauncher(native)).rejects.toThrow(/stable/i);
  });
});
