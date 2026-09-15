import { expect, test } from 'bun:test';

import type { LocalBinding, LocalEntity, SyncRepository } from '../../repository';
import { entityFor } from './detach';

const entity = (objectId: string, kind: LocalEntity['kind']): LocalEntity => ({
  objectId,
  logicalKey: 'provider-1',
  kind,
  mode: 'included',
  epoch: 0,
  desired: null,
  baseline: null,
  overrides: [],
  pendingReason: null,
});

test('credential coordination never binds a same-key entity of another kind', () => {
  const rows = [entity('model-rule-object', 'model-rule'), entity('provider-object', 'provider')];
  const repo = { entities: () => rows } as unknown as SyncRepository;
  expect(entityFor(repo, { id: 'binding' } as LocalBinding, 'provider-1')?.objectId).toBe('provider-object');
});

// Re-creating a deleted Provider under the same ID keeps the tombstone and appends a fresh row, and
// the tombstone comes first in row order. Binding ownership to the dead object shares a credential
// nothing publishes any more, while the live Provider keeps refreshing alone.
test('credential coordination binds the live row, not the tombstone that held the Provider ID', () => {
  const rows = [
    { ...entity('retired-object', 'provider'), baseline: 'deleted:operation-1' },
    {
      ...entity('provider-object', 'provider'),
      desired: { kind: 'provider', logicalKey: 'provider-1', value: {}, dependencies: [] },
    },
  ] satisfies LocalEntity[];
  const repo = { entities: () => rows } as unknown as SyncRepository;
  expect(entityFor(repo, { id: 'binding' } as LocalBinding, 'provider-1')?.objectId).toBe('provider-object');
});
