import { expect, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { chmod, link, mkdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  configureGrok,
  configureGrokForTest,
  inspectGrok,
  removeGrok,
  removeGrokForTest,
  withGrokInstallation,
} from './grok';
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
  expect('removeGrokForTest' in grokPublic).toBe(false);
  expect('replaceGrokFile' in grokPublic).toBe(false);
  expect('beforeRename' in grokPublic).toBe(false);
  expect(typeof grokPublic.readGrokObservation).toBe('function');
  expect(typeof grokPublic.removeGrok).toBe('function');
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

test('first-install all-before crash stays recovery_required after recover persist', async () => {
  const f = await grokFixture();
  try {
    await writeFile(join(f.root, 'config.toml'), '[ui]\ntheme="dark"\n');
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'marker') throw new Error('crash after marker');
        },
      }),
    ).rejects.toThrow(/crash after marker/);
    const ownershipPath = join(f.root, 'aio-proxy', 'ownership.json');
    const pendingOnDisk = await readFile(ownershipPath, 'utf8');
    expect(pendingOnDisk).toContain('"pending"');
    const inspected = await inspectGrok(f.root, f.input.adapterVersion);
    expect(inspected.configuration).toBe('recovery_required');
    expect(inspected.configuration).not.toBe('current');
    const marker = JSON.parse(await readFile(join(f.root, 'aio-proxy', '.aio-proxy-managed.json'), 'utf8')) as {
      installationId: string;
    };
    await expect(
      withGrokInstallation(
        {
          root: f.root,
          installationId: marker.installationId,
          adapterVersion: f.input.adapterVersion,
          budget: budget(),
          policy: f.deps.policy,
        },
        async () => 'must not run',
      ),
    ).rejects.toThrow(/recovery/);
    const afterAuth = JSON.parse(await readFile(ownershipPath, 'utf8')) as {
      pending?: unknown;
      leaves?: unknown[];
    };
    expect(afterAuth.pending).toBeDefined();
    const afterInspect = await inspectGrok(f.root, f.input.adapterVersion);
    expect(afterInspect.configuration).toBe('recovery_required');
    expect(afterInspect.configuration).not.toBe('current');
    expect(afterInspect.fields.length).toBeGreaterThan(0);
    expect(afterAuth.leaves ?? []).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('configure does not persist a first-install all-before rollback before policy fails', async () => {
  const f = await grokFixture();
  try {
    await writeFile(join(f.root, 'config.toml'), '[ui]\ntheme="dark"\n');
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'marker') throw new Error('crash after marker');
        },
      }),
    ).rejects.toThrow(/crash after marker/);
    await expect(
      configureGrok(f.input, {
        ...f.deps,
        policy: async () => ({ env: { GROK_MODELS_BASE_URL: 'https://api.x.ai/v1' }, sources: [] }),
      }),
    ).rejects.toThrow(/routing conflict/);
    const ownership = JSON.parse(await readFile(join(f.root, 'aio-proxy', 'ownership.json'), 'utf8')) as {
      pending?: unknown;
      leaves?: unknown[];
    };
    expect(ownership.pending).toBeDefined();
    const inspected = await inspectGrok(f.root, f.input.adapterVersion);
    expect(inspected.configuration).toBe('recovery_required');
    expect(inspected.configuration).not.toBe('current');
    expect(ownership.leaves ?? []).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('mixed recovery pending survives a second recover persist', async () => {
  const f = await grokFixture();
  try {
    const config = join(f.root, 'config.toml');
    await writeFile(
      config,
      '[auth]\nauth_provider_label = "Cloud"\n[endpoints]\nmodels_base_url = "http://127.0.0.1:9317/v1"\n',
    );
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'marker') throw new Error('crash after marker');
        },
      }),
    ).rejects.toThrow(/crash after marker/);
    const ownershipPath = join(f.root, 'aio-proxy', 'ownership.json');
    const marker = JSON.parse(await readFile(join(f.root, 'aio-proxy', '.aio-proxy-managed.json'), 'utf8')) as {
      installationId: string;
    };
    const auth = () =>
      withGrokInstallation(
        {
          root: f.root,
          installationId: marker.installationId,
          adapterVersion: f.input.adapterVersion,
          budget: budget(),
          policy: f.deps.policy,
        },
        async () => 'must not run',
      );
    await expect(auth()).rejects.toThrow(/recovery/);
    const afterFirst = JSON.parse(await readFile(ownershipPath, 'utf8')) as { pending?: unknown };
    expect(afterFirst.pending).toBeDefined();
    await expect(auth()).rejects.toThrow(/recovery/);
    const afterSecond = JSON.parse(await readFile(ownershipPath, 'utf8')) as { pending?: unknown };
    expect(afterSecond.pending).toBeDefined();
    const inspected = await inspectGrok(f.root, f.input.adapterVersion);
    expect(inspected.configuration).toBe('recovery_required');
    expect(inspected.configuration).not.toBe('current');
  } finally {
    await f.cleanup();
  }
});

test('mixed after/before recovery stays recovery_required until configure finishes', async () => {
  const f = await grokFixture();
  try {
    const config = join(f.root, 'config.toml');
    await writeFile(
      config,
      '[auth]\nauth_provider_label = "Cloud"\n[endpoints]\nmodels_base_url = "http://127.0.0.1:9317/v1"\n',
    );
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'marker') throw new Error('crash after marker');
        },
      }),
    ).rejects.toThrow(/crash after marker/);
    const ownershipPath = join(f.root, 'aio-proxy', 'ownership.json');
    const pendingOnDisk = await readFile(ownershipPath, 'utf8');
    expect(pendingOnDisk).toContain('"pending"');
    const inspected = await inspectGrok(f.root, f.input.adapterVersion);
    expect(inspected.configuration).toBe('recovery_required');
    expect(inspected.fields).toContain('auth.auth_provider_label');
    expect(inspected.fields).not.toContain('endpoints.models_base_url');
    expect(await readFile(ownershipPath, 'utf8')).toBe(pendingOnDisk);
    const marker = JSON.parse(await readFile(join(f.root, 'aio-proxy', '.aio-proxy-managed.json'), 'utf8')) as {
      installationId: string;
    };
    await expect(
      withGrokInstallation(
        {
          root: f.root,
          installationId: marker.installationId,
          adapterVersion: f.input.adapterVersion,
          budget: budget(),
          policy: f.deps.policy,
        },
        async () => 'must not run',
      ),
    ).rejects.toThrow(/recovery/);
    const afterAuth = JSON.parse(await readFile(ownershipPath, 'utf8')) as { pending?: unknown };
    expect(afterAuth.pending).toBeDefined();
    expect((await inspectGrok(f.root, f.input.adapterVersion)).configuration).toBe('recovery_required');
    const recovered = await configureGrok(f.input, f.deps);
    expect(recovered.status).toBe('updated');
    expect((await inspectGrok(f.root, f.input.adapterVersion)).configuration).toBe('current');
    expect(JSON.parse(await readFile(ownershipPath, 'utf8'))).not.toHaveProperty('pending');
  } finally {
    await f.cleanup();
  }
});

test('third-value recovery stays recovery_required with conflict fields', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    await expect(
      configureGrokForTest({ ...f.input, executable: '/opt/bin/aio-proxy-next' }, f.deps, {
        failpoint: (point) => {
          if (point === 'ownership_pending') throw new Error('crash after pending');
        },
      }),
    ).rejects.toThrow(/crash after pending/);
    const config = join(f.root, 'config.toml');
    await writeFile(config, (await readFile(config, 'utf8')).replace('"AIO Proxy"', '"Mine"'));
    const ownershipPath = join(f.root, 'aio-proxy', 'ownership.json');
    const pendingOnDisk = await readFile(ownershipPath, 'utf8');
    expect(pendingOnDisk).toContain('"pending"');
    const inspected = await inspectGrok(f.root, f.input.adapterVersion);
    expect(inspected.configuration).toBe('recovery_required');
    expect(inspected.fields).toEqual(['auth.auth_provider_label']);
    expect(await readFile(ownershipPath, 'utf8')).toBe(pendingOnDisk);
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/modified/);
    const afterConfigure = JSON.parse(await readFile(ownershipPath, 'utf8')) as { pending?: unknown };
    expect(afterConfigure.pending).toBeDefined();
    const afterConflict = await inspectGrok(f.root, f.input.adapterVersion);
    expect(afterConflict.configuration).toBe('recovery_required');
    expect(afterConflict.configuration).not.toBe('current');
    expect(afterConflict.fields).toEqual(['auth.auth_provider_label']);
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
    ).rejects.toThrow();
    expect((await inspectGrok(f.root, f.input.adapterVersion)).configuration).toBe('recovery_required');
  } finally {
    await f.cleanup();
  }
});

test('a crash after committed ownership recovers a current install', async () => {
  const f = await grokFixture();
  try {
    await expect(
      configureGrokForTest(f.input, f.deps, {
        failpoint: (point) => {
          if (point === 'ownership_committed') throw new Error('crash after committed ownership');
        },
      }),
    ).rejects.toThrow(/crash after committed ownership/);
    const ownership = JSON.parse(await readFile(join(f.root, 'aio-proxy', 'ownership.json'), 'utf8')) as {
      pending?: unknown;
      leaves?: unknown[];
    };
    expect(ownership).not.toHaveProperty('pending');
    expect((ownership.leaves ?? []).length).toBeGreaterThan(0);
    const inspected = await inspectGrok(f.root, f.input.adapterVersion);
    expect(inspected.configuration).toBe('current');
    expect(inspected.fields).toEqual([]);
    const recovered = await configureGrok(f.input, f.deps);
    expect(recovered.status).toBe('updated');
    expect((await inspectGrok(f.root, f.input.adapterVersion)).configuration).toBe('current');
  } finally {
    await f.cleanup();
  }
});

test('a crash after marker version recover keeps the new adapter version current', async () => {
  const f = await grokFixture();
  try {
    const first = await configureGrok(f.input, f.deps);
    await expect(
      configureGrokForTest({ ...f.input, adapterVersion: '0.22.0' }, f.deps, {
        failpoint: (point) => {
          if (point === 'marker_version') throw new Error('crash after marker version');
        },
      }),
    ).rejects.toThrow(/crash after marker version/);
    const marker = JSON.parse(await readFile(join(f.root, 'aio-proxy', '.aio-proxy-managed.json'), 'utf8')) as {
      adapterVersion: string;
      installationId: string;
    };
    expect(marker.adapterVersion).toBe('0.22.0');
    expect(marker.installationId).toBe(first.marker.installationId);
    const inspected = await inspectGrok(f.root, '0.22.0');
    expect(inspected.configuration).toBe('current');
    expect(inspected.marker?.adapterVersion).toBe('0.22.0');
    const recovered = await configureGrok({ ...f.input, adapterVersion: '0.22.0' }, f.deps);
    expect(recovered.status).toBe('updated');
    expect(recovered.marker.adapterVersion).toBe('0.22.0');
    expect((await inspectGrok(f.root, '0.22.0')).configuration).toBe('current');
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

test('failed revoke keeps retryable state and prevents helper use', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    await expect(
      removeGrok(f.root, f.input.adapterVersion, {
        ...f.deps,
        revoke: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow('offline');
    const local = await inspectGrok(f.root, f.input.adapterVersion);
    expect(local.marker?.installationId).toBe(installed.marker.installationId);
    expect(local.configuration).toBe('recovery_required');
    await expect(
      withGrokInstallation(
        {
          root: f.root,
          installationId: installed.marker.installationId,
          adapterVersion: f.input.adapterVersion,
          budget: { deadline: Date.now() + 1_000, signal: AbortSignal.timeout(1_000) },
        },
        async () => 'must not run',
      ),
    ).rejects.toThrow(/remov/);
    await removeGrok(f.root, f.input.adapterVersion, f.deps);
    expect(f.revoked[0]?.endpoint).toBe(f.input.endpoint);
  } finally {
    await f.cleanup();
  }
});

const helperInput = (
  root: string,
  installationId: string,
  adapterVersion: string,
  policy: typeof grokPublic.loadGrokPolicy,
) => ({
  root,
  installationId,
  adapterVersion,
  budget: budget(),
  policy,
});

test('remove revokes the original endpoint for only this installation', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    const result = await removeGrok(f.root, f.input.adapterVersion, f.deps);
    expect(result.installationId).toBe(installed.marker.installationId);
    expect(result.revokeStatus).toBe('revoked');
    expect(f.revoked).toEqual([{ endpoint: f.input.endpoint, installationId: installed.marker.installationId }]);
    expect(await Bun.file(join(f.root, 'aio-proxy')).exists()).toBe(false);
    expect((await inspectGrok(f.root, f.input.adapterVersion)).integration).toBe('absent');
  } finally {
    await f.cleanup();
  }
});

test('unlogged remove accepts a missing revoke and restores owned fields', async () => {
  const f = await grokFixture();
  try {
    await writeFile(join(f.root, 'config.toml'), '[ui]\ntheme="dark"\n', { mode: 0o640 });
    await configureGrok(f.input, f.deps);
    const result = await removeGrok(f.root, f.input.adapterVersion, {
      ...f.deps,
      revoke: async (endpoint, installationId) => {
        f.revoked.push({ endpoint, installationId });
        return 'missing';
      },
    });
    expect(result.revokeStatus).toBe('missing');
    expect(result.skippedFields).toEqual([]);
    expect(await readFile(join(f.root, 'config.toml'), 'utf8')).toBe('[ui]\ntheme="dark"\n');
    expect(await Bun.file(join(f.root, 'aio-proxy', 'credential.json')).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test('failed revoke keeps credential, marker, and removing without reverting to active', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    await withGrokInstallation(
      helperInput(f.root, installed.marker.installationId, f.input.adapterVersion, f.deps.policy),
      async (context) => {
        await context.writeCredential({ token: 'secret' });
      },
    );
    await expect(
      removeGrok(f.root, f.input.adapterVersion, {
        ...f.deps,
        revoke: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow('offline');
    expect(await readFile(join(f.root, 'aio-proxy', 'credential.json'), 'utf8')).toContain('secret');
    expect(await Bun.file(join(f.root, 'aio-proxy', '.aio-proxy-managed.json')).exists()).toBe(true);
    const ownership = JSON.parse(await readFile(join(f.root, 'aio-proxy', 'ownership.json'), 'utf8')) as {
      status?: string;
      cleanupComplete?: unknown;
    };
    expect(ownership.status).toBe('removing');
    expect(ownership.cleanupComplete).toBeUndefined();
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/remov/);
  } finally {
    await f.cleanup();
  }
});

test('field drift is skipped and a missing config is not created', async () => {
  const f = await grokFixture();
  try {
    await configureGrok(f.input, f.deps);
    const config = join(f.root, 'config.toml');
    await writeFile(config, (await readFile(config, 'utf8')).replace('"AIO Proxy"', '"Mine"'));
    const drifted = await removeGrok(f.root, f.input.adapterVersion, f.deps);
    expect(drifted.skippedFields).toContain('auth.auth_provider_label');
    expect(await readFile(config, 'utf8')).toContain('"Mine"');
    expect(await Bun.file(config).exists()).toBe(true);
    const g = await grokFixture();
    try {
      await configureGrok(g.input, g.deps);
      await unlink(join(g.root, 'config.toml'));
      const missing = await removeGrok(g.root, g.input.adapterVersion, g.deps);
      expect(missing.revokeStatus).toBe('revoked');
      expect(await Bun.file(join(g.root, 'config.toml')).exists()).toBe(false);
    } finally {
      await g.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test('unknown private files are retained and owned tmp is removed', async () => {
  const f = await grokFixture();
  try {
    await configureGrok(f.input, f.deps);
    await writeFile(join(f.root, 'aio-proxy', 'notes.txt'), 'keep me\n', { mode: 0o600 });
    const tmp = join(f.root, 'aio-proxy', `ownership.json.aio-${crypto.randomUUID()}`);
    await writeFile(tmp, 'tmp\n', { mode: 0o600 });
    const result = await removeGrok(f.root, f.input.adapterVersion, f.deps);
    expect(result.retainedFiles).toEqual(['notes.txt']);
    expect(await readFile(join(f.root, 'aio-proxy', 'notes.txt'), 'utf8')).toBe('keep me\n');
    expect(await Bun.file(tmp).exists()).toBe(false);
    expect(await Bun.file(join(f.root, 'aio-proxy', '.aio-proxy-managed.json')).exists()).toBe(false);
    expect(await Bun.file(join(f.root, 'aio-proxy', 'ownership.json')).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test('remove does not read or change Grok auth.json', async () => {
  const f = await grokFixture();
  const openSpy = spyOn(fsPromises, 'open');
  const readSpy = spyOn(fsPromises, 'readFile');
  try {
    await configureGrok(f.input, f.deps);
    const authPath = join(f.root, 'auth.json');
    await writeFile(authPath, '{"token":"keep"}\n', { mode: 0o600 });
    const before = await stat(authPath);
    const beforeText = await readFile(authPath, 'utf8');
    openSpy.mockClear();
    readSpy.mockClear();
    await removeGrok(f.root, f.input.adapterVersion, f.deps);
    const touched = [...openSpy.mock.calls, ...readSpy.mock.calls].some((args) => String(args[0]) === authPath);
    expect(touched).toBe(false);
    const after = await stat(authPath);
    expect(await readFile(authPath, 'utf8')).toBe(beforeText);
    expect(after.mode).toBe(before.mode);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  } finally {
    openSpy.mockRestore();
    readSpy.mockRestore();
    await f.cleanup();
  }
});

const REMOVE_CRASH_POINTS = [
  'removing',
  'revoked',
  'credential',
  'ownership_pending',
  'config',
  'ownership_committed',
  'cleanup_complete',
  'marker_removed',
] as const;

test('remove retries after each stage crash including marker-gone completed ownership', async () => {
  for (const point of REMOVE_CRASH_POINTS) {
    const f = await grokFixture();
    try {
      const installed = await configureGrok(f.input, f.deps);
      await withGrokInstallation(
        helperInput(f.root, installed.marker.installationId, f.input.adapterVersion, f.deps.policy),
        async (context) => {
          await context.writeCredential({ token: 'secret' });
        },
      );
      const configBefore = await readFile(join(f.root, 'config.toml'), 'utf8');
      await expect(
        removeGrokForTest(f.root, f.input.adapterVersion, f.deps, {
          failpoint: (seen) => {
            if (seen === point) throw new Error(`crash at ${point}`);
          },
        }),
      ).rejects.toThrow(`crash at ${point}`);
      const credentialExists = await Bun.file(join(f.root, 'aio-proxy', 'credential.json')).exists();
      if (point === 'removing' || point === 'revoked') expect(credentialExists).toBe(true);
      else expect(credentialExists).toBe(false);
      if (point === 'marker_removed') {
        expect(await Bun.file(join(f.root, 'aio-proxy', '.aio-proxy-managed.json')).exists()).toBe(false);
        expect(await Bun.file(join(f.root, 'aio-proxy', 'ownership.json')).exists()).toBe(true);
        expect(await readFile(join(f.root, 'config.toml'), 'utf8')).not.toBe(configBefore);
        await expect(
          withGrokInstallation(
            helperInput(f.root, installed.marker.installationId, f.input.adapterVersion, f.deps.policy),
            async () => 'must not run',
          ),
        ).rejects.toThrow();
        await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/already exists/);
      }
      const retried = await removeGrok(f.root, f.input.adapterVersion, f.deps);
      expect(retried.installationId).toBe(installed.marker.installationId);
      expect(retried.revokeStatus).toBe('revoked');
      expect(await Bun.file(join(f.root, 'aio-proxy')).exists()).toBe(false);
    } finally {
      await f.cleanup();
    }
  }
});

test('a private directory without a completed removal record is not taken over', async () => {
  const f = await grokFixture();
  try {
    await mkdir(join(f.root, 'aio-proxy'), { mode: 0o700 });
    await writeFile(
      join(f.root, 'aio-proxy', 'ownership.json'),
      `${JSON.stringify({
        format: 1,
        agent: 'grok',
        installationId: f.deps.randomUUID(),
        endpoint: f.input.endpoint,
        status: 'active',
        leaves: [],
        createdTables: [],
      })}\n`,
      { mode: 0o600 },
    );
    await expect(removeGrok(f.root, f.input.adapterVersion, f.deps)).rejects.toThrow(/already exists/);
    expect(await Bun.file(join(f.root, 'aio-proxy', 'ownership.json')).exists()).toBe(true);
    expect(f.revoked).toEqual([]);
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/already exists/);
  } finally {
    await f.cleanup();
  }
});
