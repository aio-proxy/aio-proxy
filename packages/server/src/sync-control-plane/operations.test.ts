import { expect, test } from 'bun:test';

import type { EntityBody, LocalEntity } from '@aio-proxy/core';
import type { SyncPreviewInput } from '@aio-proxy/types';

import { applyPreview, assertDecisions, SyncOperationError, type OperationInput } from './operations';
import type { PreviewCandidate, PreviewFence, PreviewRecord, RemoteEntity } from './preview';

const fence: PreviewFence = {
  bindingId: 'binding',
  sessionGeneration: 1,
  localCommitId: '',
  rangeRevision: 0,
  remoteVersions: {},
};

function body(kind: EntityBody['kind'], logicalKey: string): EntityBody {
  return { kind, logicalKey, value: {}, dependencies: [] };
}

function candidate(objectId: string, kind: EntityBody['kind'], logicalKey: string): PreviewCandidate {
  return {
    row: {
      objectId,
      logicalKey,
      kind,
      change: 'update',
      local: {},
      cloud: {},
      secretChange: 'none',
      dependencies: [],
      choices: ['local', 'cloud'],
    },
    local: body(kind, logicalKey),
    cloud: body(kind, logicalKey),
  };
}

function localEntity(objectId: string, kind: EntityBody['kind'], logicalKey: string): LocalEntity {
  return {
    objectId,
    logicalKey,
    kind,
    mode: 'included',
    epoch: 1,
    desired: body(kind, logicalKey),
    baseline: null,
    overrides: [],
    pendingReason: null,
  } as LocalEntity;
}

function remoteEntity(objectId: string, kind: EntityBody['kind'], logicalKey: string): RemoteEntity {
  return { objectId, logicalKey, kind, version: 'v1', revision: 'r1', body: body(kind, logicalKey) };
}

function harness(overrides: Partial<OperationInput> = {}): {
  input: OperationInput;
  purged: string[];
  appliedLocal: number;
  persistedOverrides: string[];
} {
  const purged: string[] = [];
  const persistedOverrides: string[] = [];
  const state = { appliedLocal: 0 };
  const input: OperationInput = {
    repo: { putEntity: () => {} } as never,
    binding: () => ({ id: 'binding' }) as never,
    localEntities: () => [],
    remoteEntities: async () => [],
    fence: async () => fence,
    status: () => ({ state: 'idle' }) as never,
    applyLocal: async () => {
      state.appliedLocal += 1;
    },
    applyCloud: async () => {},
    restore: async () => {},
    purge: async (objectId) => {
      purged.push(objectId);
    },
    persistOverrides: async (objectId) => {
      persistedOverrides.push(objectId);
    },
    ...overrides,
  };
  return {
    input,
    purged,
    persistedOverrides,
    get appliedLocal() {
      return state.appliedLocal;
    },
  };
}

function record(input: SyncPreviewInput, rows: readonly PreviewCandidate[], extra: Partial<PreviewRecord> = {}) {
  return {
    fence,
    input,
    local: rows.map((row) => localEntity(row.row.objectId, row.row.kind as EntityBody['kind'], row.row.logicalKey)),
    remote: rows.map((row) => remoteEntity(row.row.objectId, row.row.kind as EntityBody['kind'], row.row.logicalKey)),
    rows,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...extra,
  } satisfies PreviewRecord;
}

// `optional` is what buildPreview stamps on a connect row that joins nothing; no other kind gets it.
function localOnly(objectId: string, logicalKey: string, optional = false): PreviewCandidate {
  const base = candidate(objectId, 'provider', logicalKey);
  return {
    ...base,
    cloud: null,
    row: { ...base.row, change: 'add', cloud: null, choices: ['local'], ...(optional ? { optional: true } : {}) },
  };
}

test('connecting may leave out a decision only for a row with nothing on the cloud side', () => {
  const connect: SyncPreviewInput = { kind: 'connect', plugin: '@example/backend', capability: 'cloud', options: {} };

  // Connect's default is "every object excluded until it is joined", so a local-only row is skipped.
  expect(() => assertDecisions(record(connect, [localOnly('provider-a', 'work', true)]), [])).not.toThrow();
  // A row carrying cloud state would be imported unreviewed by the post-swap reconciliation.
  expect(() => assertDecisions(record(connect, [candidate('provider-a', 'provider', 'work')]), [])).toThrow(
    SyncOperationError,
  );
  expect(() =>
    assertDecisions(record({ kind: 'join', providerId: 'work' }, [localOnly('provider-a', 'work')]), []),
  ).toThrow(SyncOperationError);
});

test('a plugin purge refuses to erase the transitive dependents the preview listed', async () => {
  const scenario = harness();
  const rows = [
    candidate('plugin-a', 'plugin-business', '@example/plugin'),
    candidate('provider-b', 'provider', 'work'),
  ];

  await expect(
    applyPreview(scenario.input, record({ kind: 'purge', scope: 'plugin', objectId: '@example/plugin' }, rows), []),
  ).rejects.toThrow(SyncOperationError);
  expect(scenario.purged).toEqual([]);
});

test('a purge erases every cloud object for the requested identity', async () => {
  const scenario = harness();
  const rows = [
    candidate('plugin-a', 'plugin-business', '@example/plugin'),
    candidate('plugin-a-duplicate', 'plugin-business', '@example/plugin'),
  ];

  await applyPreview(scenario.input, record({ kind: 'purge', scope: 'plugin', objectId: '@example/plugin' }, rows), []);

  expect(scenario.purged).toEqual(['plugin-a', 'plugin-a-duplicate']);
});

test('an apply that omits a row decision is rejected before anything is mutated', async () => {
  const scenario = harness();
  const rows = [candidate('object-a', 'provider', 'work'), candidate('object-b', 'provider', 'home')];

  await expect(
    applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
      { objectId: 'object-a', choice: 'cloud' },
    ]),
  ).rejects.toThrow(SyncOperationError);
  expect(scenario.appliedLocal).toBe(0);
});

test('duplicate and unknown decision object IDs are rejected', async () => {
  const scenario = harness();
  const rows = [candidate('object-a', 'provider', 'work'), candidate('object-b', 'provider', 'home')];

  await expect(
    applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
      { objectId: 'object-a', choice: 'cloud' },
      { objectId: 'object-a', choice: 'local' },
    ]),
  ).rejects.toThrow(SyncOperationError);
  await expect(
    applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
      { objectId: 'object-a', choice: 'cloud' },
      { objectId: 'object-missing', choice: 'cloud' },
    ]),
  ).rejects.toThrow(SyncOperationError);
  expect(scenario.appliedLocal).toBe(0);
});

test('an override preview does not persist its paths when the row decision is missing', async () => {
  const scenario = harness();
  const rows = [candidate('object-a', 'provider', 'work')];

  await expect(
    applyPreview(
      scenario.input,
      record({ kind: 'overrides', objectId: 'object-a', paths: [['limits', 'timeout']] }, rows),
      [],
    ),
  ).rejects.toThrow(SyncOperationError);
  expect(scenario.persistedOverrides).toEqual([]);
});

test('an override persists the value from the row the preview projected, not the published one', async () => {
  const rows = [candidate('object-a', 'provider', 'work')];
  const authored: EntityBody = { kind: 'provider', logicalKey: 'work', value: { region: 'eu' }, dependencies: [] };
  const seen: (EntityBody | null)[] = [];
  const scenario = harness({
    persistOverrides: async (_objectId, _paths, _current, body) => void seen.push(body),
  });

  await applyPreview(
    scenario.input,
    record({ kind: 'overrides', objectId: 'object-a', paths: [['region']] }, [{ ...rows[0]!, local: authored }]),
    [{ objectId: 'object-a', choice: 'local' }],
  );

  // The row's local body is projected from the authored configuration; the snapshot entity's
  // `desired` is empty for anything never published, and pinning from it stores a deletion.
  expect(seen).toEqual([authored]);
});

test('applying an override keeps the paths it just persisted and concurrent OAuth ownership', async () => {
  const rows = [candidate('object-a', 'provider', 'work')];
  const stored: LocalEntity[] = [];
  // persistOverrides() and an OAuth login both write this row outside the fence, so the preview
  // snapshot is already stale by the time applying upserts the row.
  const persisted = {
    ...localEntity('object-a', 'provider', 'work'),
    overrides: [['limits', 'timeout']],
    oauth: { revision: 'login-revision' },
  } as LocalEntity;
  const scenario = harness({
    localEntities: () => [persisted],
    repo: { putEntity: (_binding: string, entity: LocalEntity) => void stored.push(entity) } as never,
  });

  await applyPreview(
    scenario.input,
    record({ kind: 'overrides', objectId: 'object-a', paths: [['limits', 'timeout']] }, rows),
    [{ objectId: 'object-a', choice: 'local' }],
  );

  expect(scenario.persistedOverrides).toEqual(['object-a']);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    mode: 'included',
    pendingReason: null,
    overrides: [['limits', 'timeout']],
    oauth: { revision: 'login-revision' },
  });
});

// The swap carries the previous binding's rows onto the new binding, mode included. A row the user
// left out of the connect decisions has not been joined on this backend, so keeping it included
// reported it as synchronized and let the next local commit publish it.
test('connecting excludes a row the decisions left out instead of carrying its old mode', async () => {
  const rows = [localOnly('provider-a', 'work', true), candidate('provider-b', 'provider', 'other')];
  const stored: LocalEntity[] = [];
  const carried = [
    localEntity('provider-a', 'provider', 'work'),
    localEntity('provider-b', 'provider', 'other'),
  ] satisfies LocalEntity[];
  const scenario = harness({
    localEntities: () => carried,
    repo: { putEntity: (_binding: string, entity: LocalEntity) => void stored.push(entity) } as never,
  });

  await applyPreview(
    scenario.input,
    record({ kind: 'connect', plugin: '@example/backend', capability: 'cloud', options: {} }, rows),
    [{ objectId: 'provider-b', choice: 'local' }],
  );

  expect(stored).toMatchObject([
    { objectId: 'provider-a', mode: 'excluded' },
    { objectId: 'provider-b', mode: 'included' },
  ]);
});
