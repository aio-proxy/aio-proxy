import { expect, test } from 'bun:test';

import type { LocalEntity, SyncRepository } from '../repository';
import { seedAuthoredEntities } from './authored';

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
