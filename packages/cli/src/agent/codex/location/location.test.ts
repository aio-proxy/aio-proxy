import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from './index';

test('resolves CODEX_HOME and fixed managed paths', () => {
  const location = resolveCodexLocation('/tmp/project', {
    CODEX_HOME: '~/codex-home',
    HOME: '/tmp/user',
  });

  expect(location.home).toBe('/tmp/user/codex-home');
  expect(location.configPath).toBe('/tmp/user/codex-home/config.toml');
  expect(location.managedRoot).toBe('/tmp/user/codex-home/.aio-proxy');
  expect(location.markerPath).toBe('/tmp/user/codex-home/.aio-proxy/codex-config.json');
});

test('uses an explicit absolute home and ignores blank CODEX_HOME', () => {
  const location = resolveCodexLocation('/tmp/project', { CODEX_HOME: '   ', HOME: '/tmp/user' });
  expect(location.home).toBe('/tmp/project');
});

test('discovers sqlite_home from the global Codex config and enables verified legacy fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-location-'));
  try {
    await writeFile(join(root, 'config.toml'), 'sqlite_home = "state"\n');
    const location = resolveCodexLocation(root, { HOME: root });
    expect(location.sqliteHome).toBe(join(root, 'state'));
    expect(location.legacyScanAllowed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps explicit CODEX_SQLITE_HOME precedence over global sqlite_home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-location-explicit-'));
  try {
    await mkdir(join(root, 'from-config'), { recursive: true });
    await writeFile(join(root, 'config.toml'), 'sqlite_home = "from-config"\n');
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: 'explicit' });
    expect(location.sqliteHome).toBe(join(root, 'explicit'));
    expect(location.legacyScanAllowed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an unsafe home-relative sqlite_home value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-location-invalid-'));
  try {
    await writeFile(join(root, 'config.toml'), 'sqlite_home = "~other/state"\n');
    const location = resolveCodexLocation(root, { HOME: root });
    expect(location.sqliteHome).toBeUndefined();
    expect(location.legacyScanAllowed).toBe(false);
    await writeFile(join(root, 'config.toml'), 'sqlite_home = "../outside"\n');
    expect(resolveCodexLocation(root, { HOME: root }).sqliteHome).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
