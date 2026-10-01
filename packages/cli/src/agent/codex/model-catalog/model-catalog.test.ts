import { expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CodexCatalog, CodexCatalogSync } from '@aio-proxy/server';

import { resolveCodexLocation } from '../location';
import {
  configureCodexConfig,
  prepareCodexCatalog,
  removeCodexConfig,
  updateManagedCodexCatalog,
} from '../managed-config';
import { fingerprint, journalPath } from '../managed-config/journal';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import { createLocalCodexCatalogSync } from './model-catalog';

const endpoint = 'http://127.0.0.1:9317';
const baseUrl = `${endpoint}/v1`;
const catalog = (slug: string): CodexCatalog => ({
  models: [{ slug, model_messages: { instructions: 'complete prompt' } }],
});
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) {
    if (await condition()) return;
    await Bun.sleep(2);
  }
  throw new Error('sync did not settle');
};
const use = async (body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) => {
  const f = await fixture();
  try {
    await body(f);
  } finally {
    f.sync?.close();
    await rm(f.root, { recursive: true, force: true });
  }
};
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-sync-'));
  const location = resolveCodexLocation(root, {});
  await mkdir(location.home, { recursive: true });
  const input = {
    location,
    providerId: 'aio-proxy',
    baseUrl,
    auth: { mode: 'keep-chatgpt' as const, token: 'test-only' },
  };
  let callback = () => {};
  let cleared = 0;
  let sync: CodexCatalogSync | undefined;
  const errors: unknown[] = [];
  const active = async () =>
    (Bun.TOML.parse(await Bun.file(location.configPath).text()) as Record<string, unknown>)[
      'model_catalog_json'
    ] as string;
  const f = {
    root,
    location,
    input,
    errors,
    active,
    get sync() {
      return sync;
    },
    get cleared() {
      return cleared;
    },
    periodic: () => callback(),
    start(load: (signal: AbortSignal) => Promise<CodexCatalog>, target = endpoint) {
      sync = createLocalCodexCatalogSync({
        location,
        endpoint: target,
        onError: (error) => errors.push(error),
        clock: {
          setInterval(fn, ms) {
            expect(ms).toBe(6 * 60 * 60_000);
            callback = fn;
            return {
              clear() {
                cleared++;
              },
            };
          },
        },
      })({ load });
      return sync;
    },
    async configure() {
      const prepared = await withCodexInstallation(location, AbortSignal.timeout(15000), (lease) =>
        prepareCodexCatalog(location, catalog('old'), lease),
      );
      await configureCodexConfig({ ...input, catalogPath: prepared.path });
    },
  };
  return f;
};

test('all sync reasons load full and update the managed catalog', () =>
  use(async (f) => {
    await f.configure();
    let calls = 0;
    const sync = f.start(async () => catalog(`model-${++calls}`));
    let expected = 0;
    for (const reason of ['startup', 'models-changed', 'request', 'periodic'] as const) {
      expected++;
      sync.schedule(reason);
      await until(
        async () => JSON.parse(await Bun.file(await f.active()).text()).models[0].slug === `model-${expected}`,
      );
    }
    f.periodic();
    await until(async () => JSON.parse(await Bun.file(await f.active()).text()).models[0].slug === 'model-5');
    expect(calls).toBe(5);
  }));

test('notifications during a flight run once more with the latest catalog', () =>
  use(async (f) => {
    await f.configure();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let latest = 'first';
    let concurrent = 0;
    let maximum = 0;
    const sync = f.start(async () => {
      calls++;
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      const current = latest;
      if (calls === 1) await pending;
      concurrent--;
      return catalog(current);
    });
    sync.schedule('startup');
    await until(() => calls === 1);
    latest = 'latest';
    for (let i = 0; i < 10; i++) sync.schedule('models-changed');
    release();
    await until(async () => JSON.parse(await Bun.file(await f.active()).text()).models[0].slug === 'latest');
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
  }));

test('no managed target or mismatched endpoint performs no load', () =>
  use(async (f) => {
    let calls = 0;
    let sync = f.start(async () => {
      calls++;
      return catalog('new');
    });
    sync.schedule('startup');
    await Bun.sleep(20);
    expect(calls).toBe(0);
    expect(await lstat(f.location.managedRoot).catch(() => undefined)).toBeUndefined();
    expect(await Bun.file(`${f.location.home}/.aio-proxy.lock`).exists()).toBe(false);
    sync.close();
    await f.configure();
    sync = f.start(async () => {
      calls++;
      return catalog('new');
    }, 'http://127.0.0.1:9999');
    sync.schedule('startup');
    await Bun.sleep(20);
    expect(calls).toBe(0);
  }));

for (const [format, mismatch] of [
  ['current', false],
  [1, false],
  [2, false],
  [1, true],
  [2, true],
] as const) {
  test(`startup recovers an interrupted catalog switch or legacy migration (${format}, mismatched endpoint ${mismatch})`, () =>
    use(async (f) => {
      if (format === 'current') await f.configure();
      else {
        await configureCodexConfig(f.input);
        if (format === 1) {
          const marker = JSON.parse(await Bun.file(f.location.markerPath).text());
          marker.format = 1;
          delete marker.authMode;
          marker.fields = marker.fields.filter((field: { path: string[] }) => field.path.length < 4);
          await Bun.write(f.location.markerPath, JSON.stringify(marker));
        }
      }
      await withCodexInstallation(f.location, AbortSignal.timeout(15000), async (lease) => {
        const failing: CodexLease = {
          ...lease,
          withOwnershipFence: (action) =>
            lease.withOwnershipFence((assertOwned) =>
              action(async () => {
                await assertOwned();
                if (await Bun.file(journalPath(f.location)).exists()) {
                  const journal = JSON.parse(await Bun.file(journalPath(f.location)).text());
                  if (journal.stage === 'config-written') throw new Error('injected interruption');
                }
              }),
            ),
        };
        await expect(
          updateManagedCodexCatalog(
            { location: f.location, baseUrl, catalog: catalog('recovered'), signal: AbortSignal.timeout(15000) },
            failing,
          ),
        ).rejects.toThrow('injected interruption');
      });
      let calls = 0;
      f.start(
        async () => {
          calls++;
          return catalog('recovered');
        },
        mismatch ? 'http://127.0.0.1:9999' : endpoint,
      ).schedule('startup');
      if (!mismatch) await until(() => calls === 1);
      await until(async () => !(await Bun.file(journalPath(f.location)).exists()));
      expect(calls).toBe(mismatch ? 0 : 1);
      const path = await f.active();
      expect(JSON.parse(await Bun.file(path).text())).toEqual(catalog('recovered'));
      const marker = JSON.parse(await Bun.file(f.location.markerPath).text());
      expect(
        marker.fields.find((field: { path: string[] }) => field.path[0] === 'model_catalog_json').applied.value,
      ).toBe(path);
    }));
}

test('unknown journal blocks sync without overwrite', () =>
  use(async (f) => {
    await f.configure();
    await Bun.write(journalPath(f.location), '{unknown');
    const before = await Bun.file(f.location.configPath).text();
    let calls = 0;
    f.start(async () => {
      calls++;
      return catalog('new');
    }).schedule('startup');
    await until(() => f.errors.length === 1);
    expect(calls).toBe(0);
    expect(await Bun.file(f.location.configPath).text()).toBe(before);
    expect(await Bun.file(journalPath(f.location)).text()).toBe('{unknown');
  }));

test('background failure preserves old catalog and retries on next notification', () =>
  use(async (f) => {
    await f.configure();
    let calls = 0;
    const before = await f.active();
    const sync = f.start(async () => {
      if (++calls === 1) throw new Error('private-token-text');
      return catalog('new');
    });
    sync.schedule('startup');
    await until(() => f.errors.length === 1);
    expect(await f.active()).toBe(before);
    await Bun.sleep(20);
    expect(calls).toBe(1);
    sync.schedule('request');
    await until(async () => JSON.parse(await Bun.file(await f.active()).text()).models[0].slug === 'new');
    expect(calls).toBe(2);
  }));

test('load race with removal or user catalog drift never overwrites it', () =>
  use(async (f) => {
    await f.configure();
    let resolve: (value: CodexCatalog) => void = () => {};
    let started = false;
    const sync = f.start(() => {
      started = true;
      return new Promise((done) => {
        resolve = done;
      });
    });
    sync.schedule('startup');
    await until(() => started);
    await removeCodexConfig(f.location);
    resolve(catalog('new'));
    await Bun.sleep(30);
    expect(await Bun.file(f.location.markerPath).exists()).toBe(false);
    expect(await f.active()).toBeUndefined();
  }));

test('close cancels the timer and pending load', () =>
  use(async (f) => {
    await f.configure();
    let captured: AbortSignal | undefined;
    let calls = 0;
    const sync = f.start((signal) => {
      calls++;
      captured = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    });
    sync.schedule('startup');
    await until(() => captured !== undefined);
    sync.close();
    sync.close();
    expect(f.cleared).toBe(1);
    expect(captured!.aborted).toBe(true);
    sync.schedule('request');
    f.periodic();
    await Bun.sleep(20);
    expect(calls).toBe(1);
    expect(JSON.parse(await Bun.file(await f.active()).text())).toEqual(catalog('old'));
  }));

test('live journal blocks source loading and preserves every managed file', () =>
  use(async (f) => {
    await f.configure();
    const beforeConfig = await Bun.file(f.location.configPath).text();
    const beforeMarker = await Bun.file(f.location.markerPath).text();
    const path = await f.active();
    const beforeCatalog = await Bun.file(path).text();
    const journal = {
      operation: 'configure',
      originalExists: true,
      beforeFingerprint: fingerprint(beforeConfig),
      afterFingerprint: fingerprint(beforeConfig),
      targetMarker: JSON.parse(beforeMarker),
      stage: 'prepared',
      owner: { pid: process.pid, token: 'live-test-owner', leaseUntil: Date.now() + 60000 },
    };
    const text = JSON.stringify(journal);
    await Bun.write(journalPath(f.location), text);
    let calls = 0;
    f.start(async () => {
      calls++;
      return catalog('new');
    }).schedule('startup');
    await until(() => f.errors.length === 1);
    expect(calls).toBe(0);
    expect(await Bun.file(f.location.configPath).text()).toBe(beforeConfig);
    expect(await Bun.file(f.location.markerPath).text()).toBe(beforeMarker);
    expect(await Bun.file(path).text()).toBe(beforeCatalog);
    expect(await Bun.file(journalPath(f.location)).text()).toBe(text);
  }));

for (const drift of ['owned-content', 'user-path', 'unowned-catalog'] as const) {
  test(`preload eligibility preserves ${drift} without source loading`, () =>
    use(async (f) => {
      if (drift === 'unowned-catalog') {
        await configureCodexConfig(f.input);
        await Bun.write(
          f.location.configPath,
          `model_catalog_json = "/user/catalog.json"\n${await Bun.file(f.location.configPath).text()}`,
        );
      } else {
        await f.configure();
        if (drift === 'owned-content') await Bun.write(await f.active(), '{"user":true}');
        else
          await Bun.write(
            f.location.configPath,
            (await Bun.file(f.location.configPath).text()).replace(await f.active(), '/user/catalog.json'),
          );
      }
      let calls = 0;
      const before = await Bun.file(f.location.configPath).text();
      f.start(async () => {
        calls++;
        return catalog('new');
      }).schedule('startup');
      if (drift === 'owned-content') await until(() => f.errors.length === 1);
      else await Bun.sleep(30);
      expect(calls).toBe(0);
      expect(await Bun.file(f.location.configPath).text()).toBe(before);
    }));
}

test('missing digest is repaired and user drift during loading is preserved', () =>
  use(async (f) => {
    await f.configure();
    const path = await f.active();
    await rm(path);
    const sync = f.start(async () => catalog('old'));
    sync.schedule('startup');
    await until(() => Bun.file(path).exists());
    expect(JSON.parse(await Bun.file(path).text())).toEqual(catalog('old'));
    sync.close();
    let release: (value: CodexCatalog) => void = () => {};
    let loaded = false;
    f.start(() => {
      loaded = true;
      return new Promise((done) => {
        release = done;
      });
    }).schedule('startup');
    await until(() => loaded);
    const modified = (await Bun.file(f.location.configPath).text()).replace(path, '/user/catalog.json');
    await Bun.write(f.location.configPath, modified);
    release(catalog('new'));
    await Bun.sleep(30);
    expect(await Bun.file(f.location.configPath).text()).toBe(modified);
    expect(JSON.parse(await Bun.file(path).text())).toEqual(catalog('old'));
  }));

test('unsafe lock errors and write errors preserve old catalog and retry only on notification', () =>
  use(async (f) => {
    await f.configure();
    const path = await f.active();
    const candidate = catalog('new');
    const prepared = await withCodexInstallation(f.location, AbortSignal.timeout(15000), (lease) =>
      prepareCodexCatalog(f.location, candidate, lease),
    );
    const candidatePath = prepared.path;
    await rm(candidatePath);
    const lock = `${f.location.home}/.aio-proxy.lock`;
    await rm(lock, { force: true, recursive: true });
    const outside = join(f.root, 'outside');
    await Bun.write(outside, 'private');
    await symlink(outside, lock);
    let calls = 0;
    const sync = f.start(async () => {
      calls++;
      if (calls === 1) await symlink(outside, candidatePath);
      else await rm(candidatePath);
      return candidate;
    });
    sync.schedule('startup');
    await until(() => f.errors.length === 1);
    expect(calls).toBe(0);
    await rm(lock);
    sync.schedule('request');
    await until(() => f.errors.length === 2);
    expect(await f.active()).toBe(path);
    expect(JSON.parse(await Bun.file(path).text())).toEqual(catalog('old'));
    await Bun.sleep(20);
    expect(calls).toBe(1);
    sync.schedule('request');
    await until(async () => JSON.parse(await Bun.file(await f.active()).text()).models[0].slug === 'new');
    expect(calls).toBe(2);
  }));
