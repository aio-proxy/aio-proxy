import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigFile, encodeCandidate, type JsonValue, type LocalEntity } from '@aio-proxy/core';

import { renameProviderIdentity } from './sync-rename';

test('renaming a Provider rewrites the authored configuration and its references with the rows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-rename-'));
  const configPath = join(home, 'config.jsonc');
  const authored = {
    providers: { work: { kind: 'api', baseUrl: 'https://work.example.test' }, other: { kind: 'api' } },
    router: { models: { 'gpt-5': { providers: { work: { priority: 10 } } } } },
    // Plugin options are opaque, so a key that merely looks like a Provider reference names
    // something upstream and must survive the rename untouched.
    plugins: [['@example/business', { providerId: 'work', providers: 'all' }]],
  };
  writeFileSync(configPath, encodeCandidate(authored, configPath));
  const rows: LocalEntity[] = [
    {
      objectId: 'object',
      logicalKey: 'personal',
      kind: 'provider',
      mode: 'included',
      epoch: 1,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    },
  ];
  try {
    const file = new AtomicConfigFile(configPath);
    let applied: Record<string, JsonValue> | undefined;
    let origin: string | undefined;
    let written: readonly LocalEntity[] | undefined;
    await renameProviderIdentity(
      {
        configFile: file,
        repo: {
          readBinding: () => ({ id: 'binding' }),
          putEntities: (_bindingId: string, entities: readonly LocalEntity[]) => void (written = entities),
        } as never,
        applyCandidate: async (raw, candidateOrigin) => {
          applied = raw;
          origin = candidateOrigin;
        },
      },
      'work',
      'personal',
      rows,
    );
    // Leaving `providers.work` behind makes the next projection miss the renamed included row.
    expect(applied?.['providers']).toEqual({
      personal: { kind: 'api', baseUrl: 'https://work.example.test' },
      other: { kind: 'api' },
    });
    expect(applied?.['router']).toEqual({ models: { 'gpt-5': { providers: { personal: { priority: 10 } } } } });
    expect(applied?.['plugins']).toEqual([['@example/business', { providerId: 'work', providers: 'all' }]]);
    // A local-origin commit would enqueue a second publication of what applyPreview already wrote.
    expect(origin).toBe('remote');
    expect(written).toEqual(rows);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
