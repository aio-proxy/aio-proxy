import { expect, test } from 'bun:test';

import type { LocalEntity, SyncRepository } from '../repository';
import { storedAccount } from '../test-support';
import { seedAuthoredEntities } from './authored';
import { projectCommitted } from './projection';

function repository(initial: readonly LocalEntity[] = []): SyncRepository & { rows: LocalEntity[] } {
  const rows = [...initial];
  return {
    rows,
    entities: () => rows,
    putEntity: (_bindingId: string, entity: LocalEntity) => {
      rows.push(entity);
    },
  } as unknown as SyncRepository & { rows: LocalEntity[] };
}

test('every authored object becomes a selectable row that publishes nothing until joined', () => {
  const repo = repository();
  seedAuthoredEntities(repo, 'binding', {
    providers: { work: { kind: 'api', apiKey: 'k' } },
    router: { models: { 'shared-model': { providers: { work: {} } } } },
    plugins: ['@example/business'],
    server: { port: 1 },
  });
  expect(repo.rows.map((row) => `${row.kind}:${row.logicalKey}`).sort()).toEqual([
    'model-rule:shared-model',
    'plugin-business:@example/business',
    'provider:work',
    'routing-defaults:routing-defaults',
    'service-access:service-access',
  ]);
  // Seeding must never publish: selection is an explicit user act.
  expect(repo.rows.every((row) => row.mode === 'excluded' && row.desired === null && row.baseline === null)).toBe(true);
});

test('an OAuth provider seeds the plugin object it depends on even with no authored plugins entry', () => {
  // `aio-proxy login` writes the Provider and nothing else, so the plugin it needs is named only by
  // the Provider. Without a row of its own the Provider has no dependency to publish and drops out
  // of the projection, taking its account with it.
  const raw = {
    providers: { copilot: { kind: 'oauth', plugin: '@example/oauth', capability: 'chat' } },
  };
  const repo = repository();
  seedAuthoredEntities(repo, 'binding', raw);
  expect(repo.rows.map((row) => `${row.kind}:${row.logicalKey}`).sort()).toEqual([
    'plugin-business:@example/oauth',
    'provider:copilot',
  ]);

  const joined = projectCommitted(
    {
      raw,
      accounts: new Map([['copilot', storedAccount('copilot', 'copilot-token')]]),
      pluginSecrets: new Map(),
      pluginVersions: new Map([['@example/oauth', '2.0.0']]),
    },
    repo.rows.map((row) => ({ ...row, mode: 'included' as const })),
  );
  const provider = repo.rows.find((row) => row.kind === 'provider')!;
  const plugin = repo.rows.find((row) => row.kind === 'plugin-business')!;
  expect(joined.entities.get(provider.objectId)?.dependencies).toEqual([
    { objectId: plugin.objectId, packageName: '@example/oauth', version: '2.0.0' },
  ]);
  expect(joined.accounts.has(provider.objectId)).toBe(true);
  expect(joined.entities.get(plugin.objectId)?.value).toMatchObject({
    packageName: '@example/oauth',
    version: '2.0.0',
  });
});

test('an existing row keeps its selection and object identity when the config is re-read', () => {
  const existing: LocalEntity = {
    objectId: 'cloud-work',
    logicalKey: 'work',
    kind: 'provider',
    mode: 'included',
    epoch: 3,
    desired: null,
    baseline: 'op-1',
    overrides: [],
    pendingReason: null,
  };
  const repo = repository([existing]);
  const seeded = seedAuthoredEntities(repo, 'binding', { providers: { work: { kind: 'api', apiKey: 'k' } } });
  expect(seeded).toEqual([]);
  expect(repo.rows).toEqual([existing]);
});
