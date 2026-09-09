import { expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from '../location';
import { configureCodexConfig, inspectCodexConfig, removeCodexConfig } from './index';

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
    const result = Bun.TOML.parse(await Bun.file(location.configPath).text());
    expect(result.model).toBe('after');
    expect(result.model_provider).toBe('openai');
    expect(result.model_providers).toBeUndefined();
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
    expect(Bun.TOML.parse(await Bun.file(location.configPath).text()).model_providers).toEqual({
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
    expect(Bun.TOML.parse(await Bun.file(location.configPath).text()).model_provider).toBe('openai');
    expect(Bun.TOML.parse(await Bun.file(location.configPath).text()).model_providers).toBeUndefined();
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
