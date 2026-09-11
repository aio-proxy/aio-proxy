import { expect, test } from 'bun:test';
import { chmod, link, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configureGrok, configureGrokForTest, inspectGrok, withGrokInstallation } from './grok';
import * as grokPublic from './index';
import { grokFixture } from './test-fixture';

const budget = () => ({ deadline: Date.now() + 5_000, signal: AbortSignal.timeout(5_000) });

test('configure preserves the first baseline and refuses user drift', async () => {
  const f = await grokFixture();
  try {
    const config = join(f.root, 'config.toml');
    await writeFile(config, '[ui]\ntheme="dark"\n', { mode: 0o640 });
    const first = await configureGrok(f.input, f.deps);
    const second = await configureGrok(f.input, f.deps);
    expect(second.marker.installationId).toBe(first.marker.installationId);
    expect((await stat(config)).mode & 0o777).toBe(0o640);
    const owned = await readFile(config, 'utf8');
    await writeFile(config, owned.replace('"AIO Proxy"', '"Mine"'));
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/modified/);
    expect((await inspectGrok(f.root, f.input.adapterVersion)).marker?.installationId).toBe(
      first.marker.installationId,
    );
    expect(await readFile(config, 'utf8')).toContain('"Mine"');
  } finally {
    await f.cleanup();
  }
});

test('public grok index does not export test-only write hooks', () => {
  expect('configureGrokForTest' in grokPublic).toBe(false);
  expect('replaceGrokFile' in grokPublic).toBe(false);
  expect('beforeRename' in grokPublic).toBe(false);
});

test('first configure refuses policy conflicts before creating the private directory', async () => {
  const f = await grokFixture();
  try {
    await expect(
      configureGrok(f.input, {
        ...f.deps,
        policy: async () => ({ env: { GROK_MODELS_BASE_URL: 'https://api.x.ai/v1' }, sources: [] }),
      }),
    ).rejects.toThrow(/routing conflict/);
    await expect(inspectGrok(f.root, f.input.adapterVersion)).resolves.toMatchObject({
      integration: 'absent',
    });
    expect(await Bun.file(join(f.root, 'aio-proxy')).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test('a private directory without a marker is a conflict and is not taken over', async () => {
  const f = await grokFixture();
  try {
    await mkdir(join(f.root, 'aio-proxy'), { mode: 0o700 });
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/already exists/);
    expect(await inspectGrok(f.root, f.input.adapterVersion)).toMatchObject({ integration: 'conflict' });
  } finally {
    await f.cleanup();
  }
});

test('inspect reports pending ownership without recovering it', async () => {
  const f = await grokFixture();
  try {
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'marker') throw new Error('crash after marker');
        },
      }),
    ).rejects.toThrow(/crash after marker/);
    const pending = await readFile(join(f.root, 'aio-proxy', 'ownership.json'), 'utf8');
    expect(pending).toContain('"pending"');
    const inspected = await inspectGrok(f.root, f.input.adapterVersion);
    expect(inspected.configuration).toBe('recovery_required');
    expect(await readFile(join(f.root, 'aio-proxy', 'ownership.json'), 'utf8')).toBe(pending);
    const recovered = await configureGrok(f.input, f.deps);
    expect(recovered.status).toBe('updated');
    expect((await inspectGrok(f.root, f.input.adapterVersion)).configuration).toBe('current');
  } finally {
    await f.cleanup();
  }
});

test('a crash after writing config is recovered from pending after values', async () => {
  const f = await grokFixture();
  try {
    await writeFile(join(f.root, 'config.toml'), '[ui]\ntheme="dark"\n');
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'config') throw new Error('crash after config');
        },
      }),
    ).rejects.toThrow(/crash after config/);
    expect(await readFile(join(f.root, 'config.toml'), 'utf8')).toContain('AIO Proxy');
    expect(await readFile(join(f.root, 'aio-proxy', 'ownership.json'), 'utf8')).toContain('"pending"');
    const recovered = await configureGrok(f.input, f.deps);
    expect(recovered.marker.installationId).toBe(f.deps.randomUUID());
    expect((await inspectGrok(f.root, f.input.adapterVersion)).configuration).toBe('current');
  } finally {
    await f.cleanup();
  }
});

test('an external rewrite before rename keeps the foreign config', async () => {
  const f = await grokFixture();
  try {
    const config = join(f.root, 'config.toml');
    await writeFile(config, '[ui]\ntheme="dark"\n');
    await expect(
      configureGrokForTest(f.input, f.deps, {
        beforeRename: async () => {
          await writeFile(config, '[ui]\ntheme="external"\n');
        },
      }),
    ).rejects.toThrow(/changed during update/);
    expect(await readFile(config, 'utf8')).toBe('[ui]\ntheme="external"\n');
  } finally {
    await f.cleanup();
  }
});

test('unknown marker format is newer and is not downgraded', async () => {
  const f = await grokFixture();
  try {
    const first = await configureGrok(f.input, f.deps);
    await writeFile(
      join(f.root, 'aio-proxy', '.aio-proxy-managed.json'),
      JSON.stringify({ ...first.marker, format: 2 }) + '\n',
      { mode: 0o600 },
    );
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/newer/);
    expect(await inspectGrok(f.root, f.input.adapterVersion)).toMatchObject({ integration: 'newer' });
  } finally {
    await f.cleanup();
  }
});

test('endpoint changes are refused without echoing the new origin', async () => {
  const f = await grokFixture();
  try {
    await configureGrok(f.input, f.deps);
    await expect(configureGrok({ ...f.input, endpoint: 'http://127.0.0.1:19000' }, f.deps)).rejects.toThrow(
      /endpoint changed/,
    );
    expect(await readFile(join(f.root, 'aio-proxy', '.aio-proxy-managed.json'), 'utf8')).not.toContain('19000');
  } finally {
    await f.cleanup();
  }
});

test('symlink and hardlink config paths are refused', async () => {
  const f = await grokFixture();
  try {
    const config = join(f.root, 'config.toml');
    const real = join(f.root, 'real.toml');
    await writeFile(real, '[ui]\ntheme="dark"\n');
    await symlink(real, config);
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/symlink/);
    await f.cleanup();
    const g = await grokFixture();
    try {
      const target = join(g.root, 'config.toml');
      await writeFile(target, '[ui]\ntheme="dark"\n');
      await link(target, join(g.root, 'hard.toml'));
      await expect(configureGrok(g.input, g.deps)).rejects.toThrow(/hardlink/);
    } finally {
      await g.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test('unknown private files are kept and group-writable private files are refused', async () => {
  const f = await grokFixture();
  try {
    const first = await configureGrok(f.input, f.deps);
    const note = join(f.root, 'aio-proxy', 'notes.txt');
    await writeFile(note, 'keep me\n', { mode: 0o600 });
    const again = await configureGrok(f.input, f.deps);
    expect(again.marker.installationId).toBe(first.marker.installationId);
    expect(await readFile(note, 'utf8')).toBe('keep me\n');
    await chmod(join(f.root, 'aio-proxy', 'ownership.json'), 0o664);
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/unsafe permissions/);
  } finally {
    await f.cleanup();
  }
});

test('installation id mismatch and missing owned fields are refused', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    await expect(
      withGrokInstallation(
        {
          root: f.root,
          installationId: '22222222-2222-4222-8222-222222222222',
          adapterVersion: f.input.adapterVersion,
          budget: budget(),
          policy: f.deps.policy,
        },
        async () => 'must not run',
      ),
    ).rejects.toThrow(/mismatch/);
    const config = join(f.root, 'config.toml');
    const owned = await readFile(config, 'utf8');
    await writeFile(config, owned.replace(/models_base_url = ".*"\n/, ''));
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/modified/);
    expect(installed.marker.installationId).toBe(f.deps.randomUUID());
  } finally {
    await f.cleanup();
  }
});

test('withGrokInstallation uses the lock owner and checks routing before credentials', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    const seen: string[] = [];
    const owner = await withGrokInstallation(
      {
        root: f.root,
        installationId: installed.marker.installationId,
        adapterVersion: f.input.adapterVersion,
        budget: budget(),
        policy: f.deps.policy,
      },
      async (context) => {
        seen.push('action');
        expect(context.lockOwner).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        );
        await context.writeCredential({ token: 'secret' });
        expect(await context.readCredential()).toEqual({ token: 'secret' });
        await context.clearCredential();
        expect(await context.readCredential()).toBeUndefined();
        return context.lockOwner;
      },
    );
    expect(seen).toEqual(['action']);
    expect(owner).toBeString();
    const config = join(f.root, 'config.toml');
    const owned = await readFile(config, 'utf8');
    await writeFile(config, owned + '\n[model.cloud]\nbase_url = "https://api.x.ai/v1"\n');
    await expect(
      withGrokInstallation(
        {
          root: f.root,
          installationId: installed.marker.installationId,
          adapterVersion: f.input.adapterVersion,
          budget: budget(),
          policy: f.deps.policy,
        },
        async () => 'must not run',
      ),
    ).rejects.toThrow(/routing conflict/);
  } finally {
    await f.cleanup();
  }
});

test('tests never create or read the user Grok home', async () => {
  const f = await grokFixture();
  try {
    expect(f.root.startsWith(join(homedir(), '.grok'))).toBe(false);
    await configureGrok(f.input, f.deps);
    expect(await Bun.file(join(homedir(), '.grok', 'config.toml')).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test('a failed first install only removes files this run created', async () => {
  const f = await grokFixture();
  try {
    const rootMode = (await stat(f.root)).mode & 0o777;
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'private_dir') throw new Error('crash after private dir');
        },
      }),
    ).rejects.toThrow(/crash after private dir/);
    expect(await Bun.file(join(f.root, 'aio-proxy')).exists()).toBe(false);
    expect((await stat(f.root)).mode & 0o777).toBe(rootMode);
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'ownership_pending') throw new Error('crash after ownership');
        },
      }),
    ).rejects.toThrow(/crash after ownership/);
    expect(await Bun.file(join(f.root, 'aio-proxy')).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test('invalid endpoints are rejected without echoing untrusted values', async () => {
  const f = await grokFixture();
  try {
    await expect(configureGrok({ ...f.input, endpoint: 'http://127.0.0.1:9317/v1' }, f.deps)).rejects.toThrow(
      /invalid endpoint/,
    );
    await expect(configureGrok({ ...f.input, endpoint: 'https://api.x.ai' }, f.deps)).rejects.toThrow(
      /invalid endpoint/,
    );
  } finally {
    await f.cleanup();
  }
});
