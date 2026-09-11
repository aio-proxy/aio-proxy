import { expect, test } from 'bun:test';

import type { EntityBody, LocalEntity } from '@aio-proxy/core';
import type { SyncPreviewInput } from '@aio-proxy/types';

import { applyPreview, SyncOperationError, type OperationInput } from './operations';
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
