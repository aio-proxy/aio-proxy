import { expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CodexCatalog } from '@aio-proxy/server';

import { resolveCodexLocation } from '../location';
import type { CodexLease } from '../storage/installation-lock';
import { withCodexInstallation } from '../storage/installation-lock';
import {
  configureCodexConfig,
  prepareCodexCatalog,
  pruneCodexCatalogs,
  recoverCodexConfigOperation,
  removeCodexConfig,
  updateManagedCodexCatalog,
  validateCodexConfig,
} from './index';
import { journalPath } from './journal';

const baseUrl = 'http://127.0.0.1:9317/v1';
const auth = { mode: 'keep-chatgpt' as const, token: 'test-token' };
const catalog = (message = 'complete official instruction'): CodexCatalog => ({
  models: [
    { slug: 'official', model_messages: { instructions: message, extra: ['uncropped additional message'] } },
    { slug: 'synthetic', model_messages: { instructions: 'complete synthetic instruction' } },
  ],
});
const fixture = async (text = 'model_provider = "openai"\n') => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-catalog-'));
  const location = resolveCodexLocation(root, {});
  await mkdir(location.home, { recursive: true });
  await Bun.write(location.configPath, text);
  const input = { location, providerId: 'aio-proxy', baseUrl, auth };
  const update = (value = catalog()) =>
    updateManagedCodexCatalog({ location, baseUrl, catalog: value, signal: AbortSignal.timeout(15000) });
  const prepare = (value = catalog()) =>
    withCodexInstallation(location, AbortSignal.timeout(15000), (lease) => prepareCodexCatalog(location, value, lease));
  const active = async () =>
    (Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>)[
      'model_catalog_json'
    ] as string;
  return { root, location, input, update, prepare, active };
};
const use = async (body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, text?: string) => {
  const f = await fixture(text);
  try {
    await body(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
};

test('identical catalog does not rewrite file or config; missing active digest is repaired', () =>
  use(async (f) => {
    const first = await f.prepare();
    await configureCodexConfig({ ...f.input, catalogPath: first.path });
    const before = await Promise.all([
      lstat(first.path),
      Bun.file(f.location.configPath).text(),
      Bun.file(f.location.markerPath).text(),
    ]);
    expect(await f.update()).toBe('unchanged');
    const after = await lstat(first.path);
    expect(after.ino).toBe(before[0].ino);
    expect(after.mtimeMs).toBe(before[0].mtimeMs);
    expect(after.mode & 0o777).toBe(0o600);
    expect((await lstat(join(f.location.managedRoot, 'model-catalogs'))).mode & 0o777).toBe(0o700);
    await rm(first.path);
    expect(await f.update()).toBe('unchanged');
    expect(JSON.parse(await Bun.file(first.path).text())).toEqual(catalog());
    expect(await Bun.file(f.location.configPath).text()).toBe(before[1]);
    expect(await Bun.file(f.location.markerPath).text()).toBe(before[2]);
  }));

test('changed catalog commits a complete new path including additional message changes', () =>
  use(async (f) => {
    const first = await f.prepare();
    await configureCodexConfig({ ...f.input, catalogPath: first.path });
    const next = catalog();
    (next.models[0]!['model_messages'] as Record<string, unknown>)['extra'] = ['changed additional message'];
    expect(await f.update(next)).toBe('updated');
    const path = await f.active();
    expect(path).not.toBe(first.path);
    expect(JSON.parse(await Bun.file(path).text())).toEqual(next);
    expect(JSON.parse(await Bun.file(first.path).text())).toEqual(catalog());
    expect(await f.update(next)).toBe('unchanged');
    expect(await Bun.file(first.path).exists()).toBe(true);
  }));

test('user catalog is restored on remove and outside content stays intact', () =>
  use(async (f) => {
    const user = join(f.root, 'user.json');
    await Bun.write(user, '{"user":true}');
    await Bun.write(f.location.configPath, `model_provider = "openai"\nmodel_catalog_json = ${JSON.stringify(user)}\n`);
    const prepared = await f.prepare();
    await configureCodexConfig({ ...f.input, catalogPath: prepared.path });
    expect((await removeCodexConfig(f.location)).status).toBe('removed');
    expect(await f.active()).toBe(user);
    expect(await Bun.file(user).text()).toBe('{"user":true}');
  }));

test('partial remove preserves a user-reselected digest catalog', () =>
  use(async (f) => {
    const a = await f.prepare(catalog('A'));
    await configureCodexConfig({ ...f.input, catalogPath: a.path });
    await f.update(catalog('B'));
    const b = await f.active();
    await Bun.write(f.location.configPath, (await Bun.file(f.location.configPath).text()).replace(b, a.path));
    expect((await removeCodexConfig(f.location)).status).toBe('partial');
    expect(await f.active()).toBe(a.path);
    expect(JSON.parse(await Bun.file(a.path).text())).toEqual(catalog('A'));
  }));

test('catalog pruning preserves a digest-valued before across updates', () =>
  use(async (f) => {
    const a = await f.prepare(catalog('A'));
    await Bun.write(
      f.location.configPath,
      `model_provider = "openai"\nmodel_catalog_json = ${JSON.stringify(a.path)}\n`,
    );
    const b = await f.prepare(catalog('B'));
    await configureCodexConfig({ ...f.input, catalogPath: b.path });
    await f.update(catalog('C'));
    const c = await f.active();
    await f.update(catalog('D'));
    const d = await f.active();
    await withCodexInstallation(f.location, AbortSignal.timeout(15000), (lease) =>
      pruneCodexCatalogs(f.location, [c, d], lease),
    );
    expect(await Bun.file(a.path).exists()).toBe(true);
    expect(await Bun.file(b.path).exists()).toBe(false);
    await removeCodexConfig(f.location);
    expect(await f.active()).toBe(a.path);
    expect(JSON.parse(await Bun.file(a.path).text())).toEqual(catalog('A'));
  }));

for (const unsafe of ['config', 'marker', 'reference', 'journal', 'symlink-reference', 'symlink-parent-reference']) {
  test(`uncertain ${unsafe} prevents pruning`, () =>
    use(async (f) => {
      const a = await f.prepare();
      await configureCodexConfig({ ...f.input, catalogPath: a.path });
      const unreferenced = await f.prepare(catalog('unreferenced'));
      if (unsafe === 'config') await Bun.write(f.location.configPath, 'broken = [');
      if (unsafe === 'marker') await Bun.write(f.location.markerPath, '{broken');
      if (unsafe === 'reference') await Bun.write(f.location.configPath, 'model_catalog_json = "relative.json"\n');
      if (unsafe === 'journal') await Bun.write(journalPath(f.location), '{pending');
      if (unsafe === 'symlink-reference' || unsafe === 'symlink-parent-reference') {
        const alias = join(f.root, 'catalog-alias');
        await symlink(unsafe === 'symlink-reference' ? a.path : join(f.location.managedRoot, 'model-catalogs'), alias);
        const reference = unsafe === 'symlink-reference' ? alias : join(alias, a.path.split('/').at(-1)!);
        await Bun.write(f.location.configPath, `model_catalog_json = ${JSON.stringify(reference)}\n`);
      }
      await withCodexInstallation(f.location, AbortSignal.timeout(15000), (lease) =>
        pruneCodexCatalogs(f.location, [], lease),
      );
      expect(await Bun.file(unreferenced.path).exists()).toBe(true);
    }));
}

for (const format of [1, 2]) {
  for (const authored of [false, true]) {
    test(`legacy format ${format} migrates only without authored catalog (${authored})`, () =>
      use(async (f) => {
        await configureCodexConfig(f.input);
        if (format === 1) {
          const marker = JSON.parse(await Bun.file(f.location.markerPath).text());
          marker.format = 1;
          delete marker.authMode;
          marker.fields = marker.fields.filter((field: { path: string[] }) => field.path.length < 4);
          await Bun.write(f.location.markerPath, JSON.stringify(marker));
        }
        if (authored)
          await Bun.write(
            f.location.configPath,
            `model_catalog_json = "/user/catalog.json"\n${await Bun.file(f.location.configPath).text()}`,
          );
        expect(await f.update()).toBe(authored ? 'skipped' : 'updated');
        if (authored) expect(await f.active()).toBe('/user/catalog.json');
        else expect(JSON.parse(await Bun.file(await f.active()).text())).toEqual(catalog());
      }));
  }
}

test('catalog drift, invalid catalog paths, and symlinks are preserved', () =>
  use(async (f) => {
    const a = await f.prepare();
    await configureCodexConfig({ ...f.input, catalogPath: a.path });
    await Bun.write(a.path, '{"user":true}');
    await expect(f.update()).rejects.toThrow();
    await expect(configureCodexConfig({ ...f.input, catalogPath: a.path })).rejects.toThrow();
    await expect(configureCodexConfig({ ...f.input, catalogPath: '/tmp/user.json' })).rejects.toThrow();
    await withCodexInstallation(f.location, AbortSignal.timeout(15000), (lease) =>
      pruneCodexCatalogs(f.location, [], lease),
    );
    expect(await Bun.file(a.path).text()).toBe('{"user":true}');
    await rm(a.path);
    const target = join(f.root, 'external');
    await Bun.write(target, 'external');
    await symlink(target, a.path);
    await expect(f.prepare()).rejects.toThrow();
    await expect(validateCodexConfig({ ...f.input, catalogPath: a.path })).rejects.toThrow();
    await withCodexInstallation(f.location, AbortSignal.timeout(15000), (lease) =>
      pruneCodexCatalogs(f.location, [], lease),
    );
    expect((await lstat(a.path)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe('external');
    await rm(a.path);
    const directory = join(f.location.managedRoot, 'model-catalogs');
    await rm(directory, { recursive: true });
    const externalDirectory = join(f.root, 'outside');
    await mkdir(externalDirectory);
    await symlink(externalDirectory, directory);
    await expect(f.prepare()).rejects.toThrow();
  }));

test('managed field drift and wrong endpoint skip background update', () =>
  use(async (f) => {
    const a = await f.prepare();
    await configureCodexConfig({ ...f.input, catalogPath: a.path });
    expect(
      await updateManagedCodexCatalog({
        location: f.location,
        baseUrl: 'http://another/v1',
        catalog: catalog('B'),
        signal: AbortSignal.timeout(15000),
      }),
    ).toBe('skipped');
    await Bun.write(
      f.location.configPath,
      (await Bun.file(f.location.configPath).text()).replace(a.path, '/user/catalog.json'),
    );
    expect(await f.update(catalog('B'))).toBe('skipped');
    expect(await f.active()).toBe('/user/catalog.json');
  }));

for (const afterToml of [false, true]) {
  test(`interrupted catalog switch recovers via config journal (after TOML ${afterToml})`, () =>
    use(async (f) => {
      const a = await f.prepare(catalog('A'));
      await configureCodexConfig({ ...f.input, catalogPath: a.path });
      await withCodexInstallation(f.location, AbortSignal.timeout(15000), async (lease) => {
        const failing: CodexLease = {
          ...lease,
          withOwnershipFence: (action) =>
            lease.withOwnershipFence(async (assertOwned) =>
              action(async () => {
                await assertOwned();
                if (await Bun.file(journalPath(f.location)).exists()) {
                  const journal = JSON.parse(await Bun.file(journalPath(f.location)).text());
                  if (journal.stage === (afterToml ? 'config-written' : 'prepared'))
                    throw new Error('injected interruption');
                }
              }),
            ),
        };
        await expect(
          updateManagedCodexCatalog(
            { location: f.location, baseUrl, catalog: catalog('B'), signal: AbortSignal.timeout(15000) },
            failing,
          ),
        ).rejects.toThrow('injected interruption');
      });
      expect(await Bun.file(journalPath(f.location)).exists()).toBe(true);
      if (afterToml) expect(await f.update(catalog('B'))).toBe('unchanged');
      else await recoverCodexConfigOperation(f.location);
      expect(JSON.parse(await Bun.file(await f.active()).text())).toEqual(catalog(afterToml ? 'B' : 'A'));
      expect(await Bun.file(journalPath(f.location)).exists()).toBe(false);
      expect(await f.update(catalog('B'))).toBe(afterToml ? 'unchanged' : 'updated');
    }));
}

test('concurrent update and remove share the installation lock and validateOnly writes no catalog', () =>
  use(async (f) => {
    await validateCodexConfig(f.input);
    expect(await lstat(join(f.location.managedRoot, 'model-catalogs')).catch(() => undefined)).toBeUndefined();
    const a = await f.prepare();
    await configureCodexConfig({ ...f.input, catalogPath: a.path });
    let blocked: Promise<unknown> | undefined;
    await withCodexInstallation(f.location, AbortSignal.timeout(15000), async (lease) => {
      blocked = f.update(catalog('B'));
      await removeCodexConfig(f.location, lease);
    });
    expect(await blocked).toBe('skipped');
    expect(await f.update(catalog('B'))).toBe('skipped');
    expect(await Bun.file(f.location.markerPath).exists()).toBe(false);
    expect(await f.active()).toBeUndefined();
    expect(await readdir(f.location.managedRoot)).not.toContain('config-operation.json');
  }));

test('explicitly adopts an authored matching digest even when TOML needs no rewrite', () =>
  use(async (f) => {
    const a = await f.prepare();
    await configureCodexConfig(f.input);
    await Bun.write(
      f.location.configPath,
      `model_catalog_json = ${JSON.stringify(a.path)}\n${await Bun.file(f.location.configPath).text()}`,
    );
    expect(await f.update()).toBe('skipped');
    expect((await configureCodexConfig({ ...f.input, catalogPath: a.path })).status).toBe('configured');
    expect(await f.update(catalog('B'))).toBe('updated');
    await removeCodexConfig(f.location);
    expect(await f.active()).toBe(a.path);
    expect(await Bun.file(a.path).exists()).toBe(true);
  }));

test('unresolvable original catalog reference skips cleanup after remove', () =>
  use(async (f) => {
    await Bun.write(f.location.configPath, 'model_provider = "openai"\nmodel_catalog_json = "relative-user.json"\n');
    const a = await f.prepare();
    await configureCodexConfig({ ...f.input, catalogPath: a.path });
    expect((await removeCodexConfig(f.location)).status).toBe('removed');
    expect(await f.active()).toBe('relative-user.json');
    expect(await Bun.file(a.path).exists()).toBe(true);
  }));
