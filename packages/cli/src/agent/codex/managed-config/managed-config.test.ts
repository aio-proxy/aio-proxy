import { expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from '../location';
import { configureCodexConfig, inspectCodexConfig, removeCodexConfig } from './index';
import { startJournal } from './journal';
import { readRegularFile, writeTomlAtomically } from './storage';

const fixture = async (text = 'model = "before"\nmodel_provider = "openai"\n') => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-config-'));
  const location = resolveCodexLocation(root, {});
  await mkdir(location.home, { recursive: true });
  await Bun.write(location.configPath, text);
  return { root, location };
};

test('remove restores managed fields and retains a later model choice', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1:9317/v1',
      token: 'test-key',
    });
    const configured = await Bun.file(location.configPath).text();
    await Bun.write(location.configPath, configured.replace('model = "before"', 'model = "after"'));
    await removeCodexConfig(location);
    const result = Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>;
    expect(result['model']).toBe('after');
    expect(result['model_provider']).toBe('openai');
    expect(result['model_providers']).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a user change to base_url and reports modified state', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://old/v1', token: 'test-key' });
    const configured = await Bun.file(location.configPath).text();
    await Bun.write(location.configPath, configured.replace('http://old/v1', 'http://user/v1'));
    const inspection = await inspectCodexConfig(location);
    expect(inspection.status).toBe('modified');
    expect(inspection.changedPaths).toEqual([['model_providers', 'aio-proxy', 'base_url']]);
    const removed = await removeCodexConfig(location);
    expect(removed.status).toBe('partial');
    expect(removed.preservedPaths).toEqual([['model_providers', 'aio-proxy', 'base_url']]);
    expect(
      (Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>)['model_providers'],
    ).toEqual({
      'aio-proxy': { base_url: 'http://user/v1' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reconfigure keeps the original before values', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://old/v1', token: 'old-token' });
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://new/v1', token: 'new-token' });
    await removeCodexConfig(location);
    const result = Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>;
    expect(result['model_provider']).toBe('openai');
    expect(result['model_providers']).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a foreign marker and marker symlink', async () => {
  const { root, location } = await fixture();
  try {
    await mkdir(location.managedRoot, { recursive: true });
    await Bun.write(location.markerPath, JSON.stringify({ format: 1, managedBy: 'someone-else' }));
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ status: 'conflict' });
    await rm(location.markerPath);
    await Bun.write(join(root, 'foreign-marker'), '{}');
    await symlink(join(root, 'foreign-marker'), location.markerPath);
    await expect(removeCodexConfig(location)).rejects.toThrow('symbolic link');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses private modes for managed directory and marker', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1/v1',
      token: 'test-key',
    });
    expect((await lstat(location.managedRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(location.markerPath)).mode & 0o777).toBe(0o600);
    await chmod(location.configPath, 0o644);
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1/v1',
      token: 'test-key',
    });
    expect((await lstat(location.configPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(location.markerPath)).toString()).toContain('experimental_bearer_token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not take over an unmarked provider or remove user auth fields', async () => {
  const first = await fixture('model_provider = "aio-proxy"\n[model_providers.aio-proxy]\nname = "user"\n');
  try {
    await expect(
      configureCodexConfig({
        location: first.location,
        providerId: 'aio-proxy',
        baseUrl: 'http://proxy/v1',
        token: 'key',
      }),
    ).rejects.toThrow('not managed');
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }

  const second = await fixture();
  try {
    await configureCodexConfig({
      location: second.location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      token: 'key',
    });
    const text = await Bun.file(second.location.configPath).text();
    await Bun.write(second.location.configPath, `${text}env_key = "USER_KEY"\n`);
    await expect(
      configureCodexConfig({
        location: second.location,
        providerId: 'aio-proxy',
        baseUrl: 'http://new/v1',
        token: 'key2',
      }),
    ).rejects.toThrow('authentication');
  } finally {
    await rm(second.root, { recursive: true, force: true });
  }
});

test('removes an owned inline provider while preserving neighboring providers', async () => {
  const f = await fixture('model_provider = "openai"\nmodel_providers = { other = { name = "keep" } }\n');
  try {
    await configureCodexConfig({
      location: f.location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      token: 'key',
    });
    await removeCodexConfig(f.location);
    const result = Bun.TOML.parse(await Bun.file(f.location.configPath).text()) as Record<string, unknown>;
    expect(result['model_providers']).toEqual({ other: { name: 'keep' } });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rejects a partial ownership marker instead of taking it over', async () => {
  const f = await fixture();
  try {
    await configureCodexConfig({
      location: f.location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      token: 'key',
    });
    const marker = JSON.parse(await Bun.file(f.location.markerPath).text()) as { fields: unknown[] };
    marker.fields.pop();
    await Bun.write(f.location.markerPath, `${JSON.stringify(marker)}\n`);
    await expect(inspectCodexConfig(f.location)).resolves.toMatchObject({ status: 'conflict' });
    await expect(removeCodexConfig(f.location)).rejects.toThrow('marker');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('does not recover a journal owned by a live process', async () => {
  const f = await fixture();
  try {
    await startJournal(f.location, {
      operation: 'remove',
      originalExists: true,
      beforeFingerprint: 'before',
      afterFingerprint: 'after',
      stage: 'prepared',
    });
    await expect(removeCodexConfig(f.location)).rejects.toThrow(/live|pending|owner/i);
    expect(await Bun.file(join(f.location.managedRoot, 'config-operation.json')).exists()).toBe(true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('recovers a prepared journal owned by a dead process', async () => {
  const f = await fixture();
  const journal = join(f.location.managedRoot, 'config-operation.json');
  try {
    await mkdir(f.location.managedRoot, { recursive: true });
    const text = await Bun.file(f.location.configPath).text();
    await Bun.write(
      journal,
      `${JSON.stringify({
        operation: 'remove',
        originalExists: true,
        beforeFingerprint: Bun.hash(text).toString(16),
        afterFingerprint: 'different',
        stage: 'prepared',
        owner: { pid: 999999999, token: 'dead-owner', leaseUntil: Date.now() - 1 },
      })}\n`,
    );
    await expect(removeCodexConfig(f.location)).resolves.toMatchObject({ status: 'absent' });
    expect(await Bun.file(journal).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rejects an existing symlinked parent before creating managed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-config-'));
  const real = join(root, 'real');
  const linked = join(root, 'linked');
  await mkdir(real, { recursive: true });
  await symlink(real, linked);
  const location = resolveCodexLocation(join(linked, 'codex'), {});
  try {
    await expect(
      configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', token: 'key' }),
    ).rejects.toThrow('Refusing symbolic link parent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a symlinked operation journal without following its target', async () => {
  const f = await fixture();
  const journalTarget = join(f.root, 'foreign-journal');
  const journal = join(f.location.managedRoot, 'config-operation.json');
  try {
    await mkdir(f.location.managedRoot, { recursive: true });
    await Bun.write(journalTarget, '{}\n');
    await symlink(journalTarget, journal);
    await expect(removeCodexConfig(f.location)).rejects.toThrow('symbolic link');
    expect(await Bun.file(journalTarget).text()).toBe('{}\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('refuses a symlinked managed root before deleting a foreign journal', async () => {
  const f = await fixture();
  const foreignRoot = join(f.root, 'foreign-managed');
  const foreignJournal = join(foreignRoot, 'config-operation.json');
  try {
    await mkdir(foreignRoot, { recursive: true });
    await Bun.write(foreignJournal, '{}\n');
    await symlink(foreignRoot, f.location.managedRoot);
    await expect(removeCodexConfig(f.location)).rejects.toThrow('symbolic link');
    expect(await Bun.file(foreignJournal).text()).toBe('{}\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('refuses a symlinked TOML destination before any replacement', async () => {
  const f = await fixture();
  const foreign = join(f.root, 'foreign-config.toml');
  try {
    await Bun.write(foreign, 'model = "foreign"\n');
    await rm(f.location.configPath);
    await symlink(foreign, f.location.configPath);
    await expect(
      configureCodexConfig({ location: f.location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', token: 'key' }),
    ).rejects.toThrow('symbolic link');
    expect(await Bun.file(foreign).text()).toBe('model = "foreign"\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('refuses a destination replacement in the final atomic-write check', async () => {
  const f = await fixture();
  try {
    const original = await readRegularFile(f.location.configPath);
    await expect(
      writeTomlAtomically(f.location, original, 'model = "replacement"\n', {
        beforeFinalCheck: async () => {
          await rm(f.location.configPath);
          await Bun.write(f.location.configPath, 'model = "foreign"\n');
        },
      }),
    ).rejects.toThrow('changed during update');
    expect(Bun.TOML.parse(await Bun.file(f.location.configPath).text())).toEqual({ model: 'foreign' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rejects switching to an occupied provider before changing the old configuration', async () => {
  const f = await fixture();
  try {
    await configureCodexConfig({
      location: f.location,
      providerId: 'old-proxy',
      baseUrl: 'http://old/v1',
      token: 'old-key',
    });
    const before = await Bun.file(f.location.configPath).text();
    await Bun.write(f.location.configPath, `${before}\n[model_providers.existing]\nname = "user-owned"\n`);
    const occupied = await Bun.file(f.location.configPath).text();
    await expect(
      configureCodexConfig({
        location: f.location,
        providerId: 'existing',
        baseUrl: 'http://new/v1',
        token: 'new-key',
      }),
    ).rejects.toThrow('occupied');
    expect(await Bun.file(f.location.configPath).text()).toBe(occupied);
    expect(await Bun.file(join(f.location.managedRoot, 'config-operation.json')).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
