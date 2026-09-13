import { expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processStarttime } from '@aio-proxy/core';

import { resolveCodexLocation } from '../location';
import { configureCodexConfig, inspectCodexConfig, recoverCodexConfigOperation, removeCodexConfig } from './index';
import { fingerprint, startJournal } from './journal';
import { readRegularFile, writeTomlAtomically } from './storage';

const keep = (token: string) => ({ mode: 'keep-chatgpt' as const, token });

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
      auth: keep('test-key'),
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

test('reports a non-object managed marker as a conflict', async () => {
  const { root, location } = await fixture();
  try {
    await mkdir(location.managedRoot, { recursive: true, mode: 0o700 });
    await Bun.write(location.markerPath, '[1]\n');
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ status: 'conflict' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports malformed TOML as a conflict instead of throwing', async () => {
  const { root, location } = await fixture('model_provider = [\n');
  try {
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ status: 'conflict', activeProviderId: '' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a user change to base_url and reports modified state', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://old/v1', auth: keep('test-key') });
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
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://old/v1',
      auth: keep('old-token'),
    });
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://new/v1',
      auth: keep('new-token'),
    });
    await removeCodexConfig(location);
    const result = Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>;
    expect(result['model_provider']).toBe('openai');
    expect(result['model_providers']).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renaming a managed provider restores the original active provider', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://old/v1', auth: keep('key') });
    await configureCodexConfig({ location, providerId: 'custom.proxy', baseUrl: 'http://new/v1', auth: keep('key') });
    await removeCodexConfig(location);
    const result = Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>;
    expect(result['model_provider']).toBe('openai');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('round-trips command authentication and upgrades the marker to V2', async () => {
  const { root, location } = await fixture('# keep\nmodel = "custom-model"\nmodel_provider = "openai"\n');
  try {
    const auth = {
      mode: 'command' as const,
      installationId: '11111111-1111-4111-8111-111111111111',
      command: '/tmp/AIO Proxy/bin/aiop',
    };
    await configureCodexConfig({ location, providerId: 'custom.proxy', baseUrl: 'http://127.0.0.1:9317/v1', auth });
    const commandText = await Bun.file(location.configPath).text();
    expect(Bun.TOML.parse(commandText)).toMatchObject({
      model: 'custom-model',
      model_providers: {
        'custom.proxy': {
          name: 'AIO Proxy',
          auth: {
            command: auth.command,
            args: ['agent', 'auth', 'codex', '--installation-id', auth.installationId],
            timeout_ms: 5000,
            refresh_interval_ms: 300000,
          },
        },
      },
    });
    expect(JSON.parse(await Bun.file(location.markerPath).text())).toMatchObject({
      format: 2,
      authMode: 'command',
      installationId: auth.installationId,
    });
    await configureCodexConfig({
      location,
      providerId: 'custom.proxy',
      baseUrl: 'http://127.0.0.1:9317/v1',
      auth: keep('token'),
    });
    const staticText = await Bun.file(location.configPath).text();
    const parsed = Bun.TOML.parse(staticText) as Record<string, any>;
    expect(parsed.model).toBe('custom-model');
    expect(parsed.model_providers['custom.proxy'].auth).toBeUndefined();
    expect(parsed.model_providers['custom.proxy'].experimental_bearer_token).toBe('token');
    expect(JSON.parse(await Bun.file(location.markerPath).text())).toMatchObject({
      format: 2,
      authMode: 'keep-chatgpt',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V1 static ownership rejects user-authored command fields', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', auth: keep('key') });
    const marker = JSON.parse(await Bun.file(location.markerPath).text()) as Record<string, any>;
    marker.format = 1;
    delete marker.authMode;
    delete marker.installationId;
    marker.fields = marker.fields.filter((field: { path: string[] }) => field.path.length < 4);
    await Bun.write(location.markerPath, `${JSON.stringify(marker)}\n`);
    const before = await Bun.file(location.configPath).text();
    await Bun.write(
      location.configPath,
      `${before}[model_providers.aio-proxy.auth]\ncommand = "user-command"\nargs = ["user"]\n`,
    );
    const changed = await Bun.file(location.configPath).text();
    await expect(
      configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v2', auth: keep('new-key') }),
    ).rejects.toThrow('authentication');
    expect(await Bun.file(location.configPath).text()).toBe(changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not claim or remove an existing empty auth table', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', auth: keep('key') });
    const marker = JSON.parse(await Bun.file(location.markerPath).text()) as Record<string, any>;
    marker.format = 1;
    delete marker.authMode;
    delete marker.installationId;
    marker.fields = marker.fields.filter((field: { path: string[] }) => field.path.length < 4);
    await Bun.write(location.markerPath, `${JSON.stringify(marker)}\n`);
    const before = await Bun.file(location.configPath).text();
    await Bun.write(location.configPath, `${before}[model_providers.aio-proxy.auth]\n`);
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      auth: { mode: 'command', installationId: '11111111-1111-4111-8111-111111111111', command: 'aiop' },
    });
    const commandMarker = JSON.parse(await Bun.file(location.markerPath).text()) as { createdTables: string[][] };
    expect(commandMarker.createdTables).toEqual([['model_providers', 'aio-proxy']]);
    await configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', auth: keep('key') });
    expect(await Bun.file(location.configPath).text()).toContain('[model_providers.aio-proxy.auth]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed nested table ownership in a marker', async () => {
  const { root, location } = await fixture();
  try {
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      auth: { mode: 'command', installationId: '11111111-1111-4111-8111-111111111111', command: 'aiop' },
    });
    const marker = JSON.parse(await Bun.file(location.markerPath).text()) as { createdTables: string[][] };
    marker.createdTables.push(['model_providers', 'aio-proxy', 'other']);
    await Bun.write(location.markerPath, `${JSON.stringify(marker)}\n`);
    await expect(inspectCodexConfig(location)).resolves.toMatchObject({ status: 'conflict' });
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
      auth: keep('test-key'),
    });
    expect((await lstat(location.managedRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(location.markerPath)).mode & 0o777).toBe(0o600);
    await chmod(location.configPath, 0o644);
    await configureCodexConfig({
      location,
      providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1/v1',
      auth: keep('test-key'),
    });
    expect((await lstat(location.configPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(location.markerPath)).toString()).toContain('experimental_bearer_token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not take over a provider declared with dotted leaf assignments', async () => {
  const { root, location } = await fixture('model_provider = "openai"\nmodel_providers.proxy.name = "Custom"\n');
  try {
    await expect(
      configureCodexConfig({
        location,
        providerId: 'proxy',
        baseUrl: 'http://proxy/v1',
        auth: keep('key'),
      }),
    ).rejects.toThrow('not managed');
    expect(await Bun.file(location.configPath).text()).toBe(
      'model_provider = "openai"\nmodel_providers.proxy.name = "Custom"\n',
    );
    await expect(Bun.file(location.markerPath).exists()).resolves.toBe(false);
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
        auth: keep('key'),
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
      auth: keep('key'),
    });
    const text = await Bun.file(second.location.configPath).text();
    await Bun.write(second.location.configPath, `${text}env_key = "USER_KEY"\n`);
    await expect(
      configureCodexConfig({
        location: second.location,
        providerId: 'aio-proxy',
        baseUrl: 'http://new/v1',
        auth: keep('key2'),
      }),
    ).rejects.toThrow('authentication');
  } finally {
    await rm(second.root, { recursive: true, force: true });
  }
});

test('reconfigures command authentication on an inline provider', async () => {
  const f = await fixture('model_provider = "openai"\nmodel_providers = { other = { name = "keep" } }\n');
  try {
    const auth = {
      mode: 'command' as const,
      installationId: '11111111-1111-4111-8111-111111111111',
      command: '/tmp/AIO Proxy/bin/aiop',
    };
    await configureCodexConfig({ location: f.location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', auth });
    await configureCodexConfig({ location: f.location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v2', auth });
    const parsed = Bun.TOML.parse(await Bun.file(f.location.configPath).text()) as Record<string, any>;
    expect(parsed.model_providers.other).toEqual({ name: 'keep' });
    expect(parsed.model_providers['aio-proxy'].base_url).toBe('http://proxy/v2');
    expect(parsed.model_providers['aio-proxy'].auth.command).toBe(auth.command);
    expect(JSON.parse(await Bun.file(f.location.markerPath).text())).toMatchObject({
      format: 2,
      authMode: 'command',
      installationId: auth.installationId,
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('switches an inline command provider back to keep-chatgpt', async () => {
  const f = await fixture('model_provider = "openai"\nmodel_providers = { other = { name = "keep" } }\n');
  try {
    const auth = {
      mode: 'command' as const,
      installationId: '11111111-1111-4111-8111-111111111111',
      command: '/tmp/AIO Proxy/bin/aiop',
    };
    await configureCodexConfig({ location: f.location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', auth });
    expect(Bun.TOML.parse(await Bun.file(f.location.configPath).text())).toMatchObject({
      model_providers: {
        other: { name: 'keep' },
        'aio-proxy': { auth: { command: auth.command } },
      },
    });
    await configureCodexConfig({
      location: f.location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      auth: keep('token'),
    });
    const parsed = Bun.TOML.parse(await Bun.file(f.location.configPath).text()) as Record<string, any>;
    expect(parsed.model_providers.other).toEqual({ name: 'keep' });
    expect(parsed.model_providers['aio-proxy'].auth).toBeUndefined();
    expect(parsed.model_providers['aio-proxy'].experimental_bearer_token).toBe('token');
    expect(JSON.parse(await Bun.file(f.location.markerPath).text())).toMatchObject({
      format: 2,
      authMode: 'keep-chatgpt',
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('removes an owned inline provider while preserving neighboring providers', async () => {
  const f = await fixture('model_provider = "openai"\nmodel_providers = { other = { name = "keep" } }\n');
  try {
    await configureCodexConfig({
      location: f.location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      auth: keep('key'),
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
      auth: keep('key'),
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

test('rejects an unvalidated config journal instead of deleting the marker', async () => {
  const f = await fixture();
  try {
    await configureCodexConfig({
      location: f.location,
      providerId: 'aio-proxy',
      baseUrl: 'http://proxy/v1',
      auth: keep('key'),
    });
    const text = await Bun.file(f.location.configPath).text();
    await Bun.write(
      join(f.location.managedRoot, 'config-operation.json'),
      `${JSON.stringify({
        operation: 'configure',
        originalExists: true,
        afterFingerprint: fingerprint(text),
        stage: 'config-written',
        owner: { pid: 999999999, token: 'dead-owner', leaseUntil: Date.now() - 1 },
      })}\n`,
    );
    await expect(recoverCodexConfigOperation(f.location)).rejects.toThrow(/invalid|journal/i);
    expect(await Bun.file(f.location.markerPath).exists()).toBe(true);
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

test('recovers an expired journal whose PID has been reused', async () => {
  const f = await fixture();
  const journal = join(f.location.managedRoot, 'config-operation.json');
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
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
        owner: {
          pid: child.pid,
          token: 'reused-owner',
          leaseUntil: Date.now() - 1,
          starttime: 'previous-process-incarnation',
        },
      })}\n`,
    );
    await expect(removeCodexConfig(f.location)).resolves.toMatchObject({ status: 'absent' });
    expect(await Bun.file(journal).exists()).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('does not recover an expired journal owned by another live process incarnation', async () => {
  const f = await fixture();
  const journal = join(f.location.managedRoot, 'config-operation.json');
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const starttime = await processStarttime(child.pid);
    await mkdir(f.location.managedRoot, { recursive: true });
    await Bun.write(
      journal,
      `${JSON.stringify({
        operation: 'remove',
        originalExists: true,
        beforeFingerprint: 'before',
        afterFingerprint: 'after',
        stage: 'prepared',
        owner: {
          pid: child.pid,
          token: 'live-incarnation',
          leaseUntil: Date.now() - 1,
          ...(starttime === null ? {} : { starttime }),
        },
      })}\n`,
    );
    await expect(removeCodexConfig(f.location)).rejects.toThrow(/live|pending|owner/i);
    expect(await Bun.file(journal).exists()).toBe(true);
  } finally {
    child.kill();
    await child.exited;
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
      configureCodexConfig({ location, providerId: 'aio-proxy', baseUrl: 'http://proxy/v1', auth: keep('key') }),
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
      configureCodexConfig({
        location: f.location,
        providerId: 'aio-proxy',
        baseUrl: 'http://proxy/v1',
        auth: keep('key'),
      }),
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
      auth: keep('old-key'),
    });
    const before = await Bun.file(f.location.configPath).text();
    await Bun.write(f.location.configPath, `${before}\n[model_providers.existing]\nname = "user-owned"\n`);
    const occupied = await Bun.file(f.location.configPath).text();
    await expect(
      configureCodexConfig({
        location: f.location,
        providerId: 'existing',
        baseUrl: 'http://new/v1',
        auth: keep('new-key'),
      }),
    ).rejects.toThrow('occupied');
    expect(await Bun.file(f.location.configPath).text()).toBe(occupied);
    expect(await Bun.file(join(f.location.managedRoot, 'config-operation.json')).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('recovery cancellation leaves an absent managed root untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-config-'));
  const location = resolveCodexLocation(root, {});
  try {
    let prompted = false;
    await expect(
      recoverCodexConfigOperation(location, async () => {
        prompted = true;
        return false;
      }),
    ).resolves.toBe('none');
    expect(prompted).toBe(false);
    expect(await Bun.file(location.markerPath).exists()).toBe(false);
    expect(await Bun.file(join(location.managedRoot, 'config-operation.json')).exists()).toBe(false);
    await expect(Bun.file(location.managedRoot).exists()).resolves.toBe(false);

    await mkdir(location.managedRoot, { recursive: true });
    await Bun.write(
      join(location.managedRoot, 'config-operation.json'),
      `${JSON.stringify({
        operation: 'remove',
        originalExists: false,
        stage: 'prepared',
        owner: { pid: 999999999, token: 'cancelled-owner', leaseUntil: Date.now() - 1 },
      })}\n`,
    );
    await expect(recoverCodexConfigOperation(location, async () => false)).resolves.toBe('declined');
    await expect(
      recoverCodexConfigOperation(location, async () => {
        throw new Error('aborted');
      }),
    ).rejects.toThrow('aborted');
    expect(await Bun.file(join(location.managedRoot, 'config-operation.json')).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
