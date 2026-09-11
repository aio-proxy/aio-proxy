import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigExpectedDigestError,
  AtomicConfigFile,
  createPluginRepository,
  encodeCandidate,
  type PluginRegistrySnapshot,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import type { ServerRuntime } from '../lifecycle';
import { createSyncIntegration } from './sync-integration';

test('remote apply rejects a stale digest without overwriting an external edit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-integration-'));
  const configPath = join(home, 'config.jsonc');
  const initial = { providers: { local: { kind: 'api', baseUrl: 'https://local.example.test' } } };
  const external = { providers: { external: { kind: 'api', baseUrl: 'https://external.example.test' } } };
  const remote = { providers: { remote: { kind: 'api', baseUrl: 'https://remote.example.test' } } };
  writeFileSync(configPath, encodeCandidate(initial, configPath));
  const db = openDb({ home });
  const file = new AtomicConfigFile(configPath);
  const digest = createHash('sha256').update(encodeCandidate(initial, configPath)).digest('hex');
  const runtime = { options: { configPath }, remoteConfigFence: undefined } as unknown as ServerRuntime;
  const accounts = createPluginRepository(db.sqlite);

  try {
    await file.replace(() => external);
    const integration = createSyncIntegration(
      runtime,
      db,
      accounts,
      () => ({ plugins: new Map(), registry: {} }) as unknown as PluginRegistrySnapshot,
      file,
      { configPath } as never,
      async <T>(run: () => Promise<T>) => run(),
    );
    await expect(
      integration.syncApplyCandidate(remote, 'remote', 'remote-operation', undefined, digest),
    ).rejects.toBeInstanceOf(AtomicConfigExpectedDigestError);
    expect(await file.read()).toEqual(external);
    expect(runtime.remoteConfigFence).toBeUndefined();
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
