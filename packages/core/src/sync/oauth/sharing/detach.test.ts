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
