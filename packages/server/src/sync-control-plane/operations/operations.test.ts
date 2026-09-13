import { expect, test } from 'bun:test';

import type { EntityBody, LocalEntity } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncPreviewInput } from '@aio-proxy/types';

import {
  SyncPreviewError,
  buildPreview,
  type PreviewCandidate,
  type PreviewFence,
  type PreviewRecord,
  type RemoteEntity,
} from '../preview';
import {
  applyPreview,
  assertDecisions,
  assertNoRetainedOAuth,
  SyncOperationError,
  type OperationInput,
  type SyncDecision,
} from './operations';
import { rewireProviderReferences } from './provider-identity';

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

// The backend the harness reports, kept in step with the heads each `record()` reviews: a cloud
// import re-reads them before it writes, so a double that answers with nothing would read as a peer
// having retired every object mid-apply.
const remoteHeads: RemoteEntity[] = [];

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
    remoteEntities: async () => remoteHeads,
    fence: async () => fence,
    status: () => ({ state: 'idle' }) as never,
    applyLocal: async () => {
      state.appliedLocal += 1;
    },
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async (objectId) => {
      persistedOverrides.push(objectId);
    },
    ...overrides,
    purge: async (objectId, expectedVersion) => {
      await (overrides.purge ?? (async () => purged.push(objectId)))(objectId, expectedVersion);
      // An erase retires the head, and applying reads the backend again to confirm it: a double that
      // kept answering with the live object would report every purge as still pending.
      const index = remoteHeads.findIndex((entity) => entity.objectId === objectId);
      if (index >= 0) remoteHeads.splice(index, 1);
    },
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
  const reviewed = {
    fence,
    input,
    local: rows.map((row) => localEntity(row.row.objectId, row.row.kind as EntityBody['kind'], row.row.logicalKey)),
    remote: rows.map((row) => remoteEntity(row.row.objectId, row.row.kind as EntityBody['kind'], row.row.logicalKey)),
    rows,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...extra,
  } satisfies PreviewRecord;
  remoteHeads.splice(0, remoteHeads.length, ...reviewed.remote);
  return reviewed;
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

// The reviewed fence is checked once, before the first erase, and erasing every object of an
// identity is several round trips. Reconciliation applies the resulting tombstones to the
// configuration, so a commit landing mid-purge would be deleted by an erase it was never shown
// against — and erasing is not undoable.
test('a configuration commit landing mid-purge stops the remaining erases', async () => {
  let commitId = 'commit-1';
  const purged: string[] = [];
  const scenario = harness({
    repo: { latestConfirmedCommit: () => ({ commitId }) } as never,
    purge: async (objectId) => {
      purged.push(objectId);
      commitId = 'commit-2';
    },
  });
  const rows = [
    candidate('plugin-a', 'plugin-business', '@example/plugin'),
    candidate('plugin-a-duplicate', 'plugin-business', '@example/plugin'),
  ];

  await expect(
    applyPreview(scenario.input, record({ kind: 'purge', scope: 'plugin', objectId: '@example/plugin' }, rows), []),
  ).rejects.toThrow(SyncPreviewError);
  expect(purged).toEqual(['plugin-a']);
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

test('a local tombstone does not collide with the cloud object that took over its Provider ID', async () => {
  const scenario = harness();
  const rows = [candidate('provider-new', 'provider', 'work')];
  // Deleting the old object freed `work`, another device published a new one under it, and this
  // device still retains the tombstone — so both rows legitimately name the same Provider ID.
  const tombstone: LocalEntity = {
    ...localEntity('provider-old', 'provider', 'work'),
    desired: null,
    baseline: 'deleted:1',
  };

  await applyPreview(
    scenario.input,
    record({ kind: 'join', providerId: 'work' }, rows, {
      local: [tombstone, localEntity('provider-new', 'provider', 'work')],
    }),
    [{ objectId: 'provider-new', choice: 'cloud' }],
  );

  expect(scenario.appliedLocal).toBe(1);
});

test('a rename may take the Provider ID a local tombstone still carries', async () => {
  // The preview offers the freed ID as a replacement because its collision check skips tombstones.
  // Counting the tombstone here would reject the decision the user was just shown.
  const persisted: LocalEntity[][] = [];
  const scenario = harness({
    persistProviderIdentity: async (_old, _new, entities) => persisted.push([...entities]),
  });
  const rows = [candidate('provider-new', 'provider', 'work')];
  const tombstone: LocalEntity = {
    ...localEntity('provider-old', 'provider', 'freed'),
    desired: null,
    baseline: 'deleted:1',
  };

  await applyPreview(
    scenario.input,
    record({ kind: 'join', providerId: 'work' }, rows, {
      local: [tombstone, localEntity('provider-new', 'provider', 'work')],
    }),
    [{ objectId: 'provider-new', choice: 'local', newProviderId: 'freed' }],
  );

  expect(persisted[0]?.map((entity) => entity.logicalKey)).toEqual(['freed']);
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

// The fence is checked once, before rows that each take a network round trip. A configuration
// commit landing in that window is not in the reviewed bodies: publishing one anyway marks the row
// synchronized against a body the user never edited, and nothing republishes what they did.
test('applying stops on a configuration commit that lands mid-apply, but not on its own', async () => {
  const rows = [candidate('object-a', 'provider', 'work'), candidate('object-b', 'provider', 'home')];
  const join: SyncPreviewInput = { kind: 'join', providerId: 'work' };
  const decisions = (choice: 'local' | 'cloud'): SyncDecision[] =>
    rows.map(({ row }) => ({ objectId: row.objectId, choice }));
  const repo = (commitId: () => string) => ({
    putEntity: () => {},
    latestConfirmedCommit: () => ({ commitId: commitId() }),
  });

  // Importing a cloud body writes the local configuration, so applying advances the very commit it
  // compares against. Reading that back as drift would fail every multi-row apply on its own row.
  let own = 'commit-1';
  const imported: string[] = [];
  const mine = harness({
    repo: repo(() => own) as never,
    applyLocal: async (_body, _current, objectId) => {
      imported.push(objectId);
      own = `remote:${objectId}`;
    },
  });
  await applyPreview(mine.input, record(join, rows), decisions('cloud'));
  expect(imported).toEqual(['object-a', 'object-b']);

  let foreign = 'commit-1';
  const published: string[] = [];
  const drifted = harness({
    repo: repo(() => foreign) as never,
    applyCloud: async (_body, current) => {
      published.push(current!.objectId);
      foreign = 'edited-while-publishing';
    },
  });
  await expect(applyPreview(drifted.input, record(join, rows), decisions('local'))).rejects.toThrow(SyncPreviewError);
  expect(published).toEqual(['object-a']);
});

// The guard above runs before the publication, and a single-row apply has no next row to catch a
// commit that lands during it. Recording the join anyway reports the reviewed body as synchronized
// while the edit the user made during exclusion is never published.
test('a single-row apply records no join when a configuration commit lands during its publication', async () => {
  const rows = [candidate('object-a', 'provider', 'work')];
  const stored: LocalEntity[] = [];
  let commitId = 'commit-1';
  const scenario = harness({
    localEntities: () => [localEntity('object-a', 'provider', 'work')],
    repo: {
      putEntity: (_binding: string, entity: LocalEntity) => void stored.push(entity),
      latestConfirmedCommit: () => ({ commitId }),
    } as never,
    applyCloud: async () => {
      commitId = 'edited-while-publishing';
    },
  });

  await expect(
    applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
      { objectId: 'object-a', choice: 'local' },
    ]),
  ).rejects.toThrow(SyncPreviewError);
  expect(stored).toEqual([]);
});

// A Provider ID is user data, so `__proto__` is a valid replacement. Plain assignment reaches the
// legacy prototype setter instead of creating an entry, and deleting the old key right after left
// the rewritten rule pointing at neither ID — then persisted and published that way.
test('rewiring onto a Provider named __proto__ keeps the reference as an own entry', () => {
  const authored = JSON.parse(
    '{"providers":{"work":{"kind":"api"}},"router":{"models":{"gpt-5":{"providers":{"work":{"priority":10}}}}}}',
  ) as Record<string, JsonValue>;

  const rewired = rewireProviderReferences(authored, 'work', '__proto__') as Record<string, Record<string, JsonValue>>;

  expect(Object.hasOwn(rewired['providers']!, '__proto__')).toBe(true);
  expect(Object.hasOwn(rewired['providers']!, 'work')).toBe(false);
  const models = (rewired['router']!['models'] as Record<string, Record<string, JsonValue>>)['gpt-5']!;
  const rulePolicies = models['providers'] as Record<string, JsonValue>;
  expect(Object.hasOwn(rulePolicies, '__proto__')).toBe(true);
  expect(Object.hasOwn(rulePolicies, 'work')).toBe(false);
  expect(rulePolicies['__proto__']).toEqual({ priority: 10 });
});

test('retiring a binding is refused while any row still holds a shared credential', () => {
  const repo = (entities: LocalEntity[], journalObjectIds: string[] = []) =>
    ({
      entities: () => entities,
      oauthJournals: () => journalObjectIds.map((objectId) => ({ objectId })),
    }) as never;
  const row = (objectId: string, mode?: 'shared' | 'detach-pending' | 'independent'): LocalEntity => ({
    ...localEntity(objectId, 'provider', objectId),
    ...(mode === undefined
      ? {}
      : { oauth: { mode, epoch: 0, generation: 1, localRevision: 1, pluginVersion: '1.0.0', formatVersion: 1 } }),
  });

  expect(() => assertNoRetainedOAuth(repo([row('a'), row('b', 'shared')]), 'binding')).toThrow(SyncOperationError);
  expect(() => assertNoRetainedOAuth(repo([row('b', 'detach-pending')]), 'binding')).toThrow(SyncOperationError);
  // An interrupted share may already have published the credential, so a journal row blocks even
  // though no ownership was recorded before the crash.
  expect(() => assertNoRetainedOAuth(repo([row('a')], ['a']), 'binding')).toThrow(SyncOperationError);
  // A detached Provider owns its credential alone, so nothing follows it across the retire.
  expect(() => assertNoRetainedOAuth(repo([row('a'), row('b', 'independent')]), 'binding')).not.toThrow();
});

test('restoring a revision writes it to the local configuration, not just the row', async () => {
  const written: LocalEntity[] = [];
  let restoredOperationId = '';
  const scenario = harness({
    repo: { putEntity: (_binding: string, entity: LocalEntity) => written.push(entity) } as never,
    localEntities: () => [localEntity('provider-a', 'provider', 'work')],
    restore: async (_objectId, _candidateBody, operationId) => {
      restoredOperationId = operationId;
    },
  });
  const row = candidate('provider-a', 'provider', 'work');
  const rows = [{ ...row, row: { ...row.row, choices: ['restore' as const] } }];

  await applyPreview(scenario.input, record({ kind: 'restore', objectId: 'provider-a', operationId: 'r0' }, rows), [
    { objectId: 'provider-a', choice: 'restore' },
  ]);

  // Without this the configuration file keeps the pre-restore value and the next local commit
  // projects it back over the revision the user just restored.
  expect(scenario.appliedLocal).toBe(1);
  // Recording the pre-restore remote revision would leave the row behind its own publication.
  expect(written[0]).toMatchObject({ baseline: restoredOperationId });
});

// The restore's round trip is the window: the historical body is then written over whatever the file
// holds, and the apply adopts that as the new baseline, so an edit committed while the restore was
// in flight is lost with nothing left to republish it.
test('a configuration commit landing during the restore is not overwritten by the historical body', async () => {
  let commitId = 'commit-1';
  const scenario = harness({
    repo: { putEntity: () => {}, latestConfirmedCommit: () => ({ commitId }) } as never,
    localEntities: () => [localEntity('provider-a', 'provider', 'work')],
    restore: async () => {
      commitId = 'edited-while-restoring';
    },
  });
  const row = candidate('provider-a', 'provider', 'work');
  const rows = [{ ...row, row: { ...row.row, choices: ['restore' as const] } }];

  await expect(
    applyPreview(scenario.input, record({ kind: 'restore', objectId: 'provider-a', operationId: 'r0' }, rows), [
      { objectId: 'provider-a', choice: 'restore' },
    ]),
  ).rejects.toThrow(SyncPreviewError);
  expect(scenario.appliedLocal).toBe(0);
});

// A deleted head leaves the local row bodiless, so a restore of it classifies as `add` and the row
// offers `cloud` rather than `restore`. That choice still has to publish the historical revision:
// importing it locally alone leaves the cloud head a tombstone, and the next reconciliation deletes
// the entity again.
test('restoring a deleted head publishes the revision through the choice the row offers', async () => {
  const historical: EntityBody = { kind: 'provider', logicalKey: 'work', value: { value: 'past' }, dependencies: [] };
  const deleted = { ...localEntity('provider-a', 'provider', 'work'), desired: null };
  const { record: built } = buildPreview({
    request: { kind: 'restore', objectId: 'provider-a', operationId: 'r0' },
    local: [deleted],
    remote: [
      {
        objectId: 'provider-a',
        logicalKey: 'work',
        kind: 'provider',
        version: 'v1',
        revision: null,
        body: null,
        tombstone: true,
        revisions: { r0: historical },
        restoreBody: historical,
      },
    ],
    fence,
    previewId: 'preview',
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const restored: EntityBody[] = [];
  const scenario = harness({
    localEntities: () => [deleted],
    restore: async (_objectId, candidateBody) => void restored.push(candidateBody),
  });
  const decisions: SyncDecision[] = built.rows.map((row) => ({
    objectId: row.row.objectId,
    choice: row.row.choices[0]!,
  }));

  expect(decisions).toEqual([{ objectId: 'provider-a', choice: 'cloud' }]);
  assertDecisions(built, decisions);
  await applyPreview(scenario.input, built, decisions);

  expect(restored).toEqual([historical]);
  // The restored body still has to reach the configuration file, or the next commit projects the
  // deletion back over it.
  expect(scenario.appliedLocal).toBe(1);
});

test('a leave that completes during a publication is not undone by the recorded join', async () => {
  const written: LocalEntity[] = [];
  const scenario = harness({
    repo: { putEntity: (_binding: string, entity: LocalEntity) => written.push(entity) } as never,
    localEntities: () => [{ ...localEntity('provider-a', 'provider', 'work'), mode: 'excluded' }],
    // `setRange` writes no configuration commit, so the commit fence cannot see the Leave.
    rangeRevision: () => fence.rangeRevision + 1,
  });
  const rows = [candidate('provider-a', 'provider', 'work')];

  await applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
    { objectId: 'provider-a', choice: 'local' },
  ]);

  expect(written[0]).toMatchObject({ mode: 'excluded', pendingReason: null });
});

test('a join still marks the row included while the range is unchanged', async () => {
  const written: LocalEntity[] = [];
  const scenario = harness({
    repo: { putEntity: (_binding: string, entity: LocalEntity) => written.push(entity) } as never,
    localEntities: () => [{ ...localEntity('provider-a', 'provider', 'work'), mode: 'excluded' }],
    rangeRevision: () => fence.rangeRevision,
  });
  const rows = [candidate('provider-a', 'provider', 'work')];

  await applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
    { objectId: 'provider-a', choice: 'local' },
  ]);

  expect(written[0]).toMatchObject({ mode: 'included' });
});

// Applying writes the Provider's configuration only. Its credential is coordinated by
// reconciliation's activation check and the sharing service, both of which skip a row already holding
// the cloud baseline with nothing pending — so a join that clears the pending reason leaves the
// Provider on an uncoordinated credential for good.
test('joining an OAuth Provider keeps the credential due until the row records ownership', async () => {
  const oauth = (): EntityBody => ({
    kind: 'provider',
    logicalKey: 'work',
    value: { kind: 'oauth', plugin: '@example/plugin', capability: 'chat' },
    dependencies: [],
  });
  const rows = [{ ...candidate('provider-a', 'provider', 'work'), local: oauth(), cloud: oauth() }];
  const join = async (
    readAccount: () => never,
    choice: SyncDecision['choice'],
    oauth?: LocalEntity['oauth'],
  ): Promise<LocalEntity | undefined> => {
    const written: LocalEntity[] = [];
    const scenario = harness({
      repo: { putEntity: (_binding: string, entity: LocalEntity) => written.push(entity) } as never,
      localEntities: () => [
        { ...localEntity('provider-a', 'provider', 'work'), ...(oauth === undefined ? {} : { oauth }) },
      ],
      accounts: { readAccount },
    });
    await applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
      { objectId: 'provider-a', choice },
    ]);
    return written[0];
  };

  expect(await join(() => null as never, 'cloud')).toMatchObject({ pendingReason: 'oauth-unverified' });
  // Publishing a local body has the same gap: `share()` reports `pending` for a Provider this device
  // holds no account for, so nothing imports the credential the other device published.
  expect(await join(() => null as never, 'local')).toMatchObject({ pendingReason: 'oauth-unverified' });
  // An account this device authorized on its own shares nothing with the account published for this
  // object: the row holds no ownership, so the resolver leaves the credential on the local refresh
  // path and it rotates away from every device following the shared one.
  expect(await join(() => ({ providerId: 'work' }) as never, 'cloud')).toMatchObject({
    pendingReason: 'oauth-unverified',
  });
  // Ownership recorded is the verification: holding that row pending would report a coordinated
  // credential as unverified.
  const owned: LocalEntity['oauth'] = {
    mode: 'shared',
    epoch: 0,
    generation: 0,
    localRevision: 1,
    pluginVersion: '1.0.0',
    formatVersion: 1,
    multiDeviceEvidenceId: 'evidence',
  };
  expect(await join(() => ({ providerId: 'work' }) as never, 'cloud', owned)).toMatchObject({ pendingReason: null });
});

// A rename republishes the configuration as a new object, so the row to join is the renamed one.
// Joining the pre-rename row reported success while leaving the Provider outside synchronization:
// reconciliation had already quarantined the colliding row, and the rename deletes the head it held.
test('a rename records the join on the renamed row against the revision it just published', async () => {
  const written: LocalEntity[] = [];
  const scenario = harness({
    repo: { putEntity: (_binding: string, entity: LocalEntity) => void written.push(entity) } as never,
    persistProviderIdentity: async () => {},
    applyCloud: async () => 'renamed-revision',
  });
  const rows = [candidate('provider-a', 'provider', 'work')];

  await applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
    { objectId: 'provider-a', choice: 'local', newProviderId: 'work-2' },
  ]);

  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ logicalKey: 'work-2', mode: 'included', pendingReason: null });
  // The reviewed remote revision names the object the rename vacated, and it is one publication old.
  expect(written[0]).toMatchObject({ baseline: 'renamed-revision' });
  expect(written[0]?.objectId).not.toBe('provider-a');
});

// The identity hook renames the authored configuration and moves the OAuth account with it. Running
// it again from the failure handler commits the very rename whose error is about to be rethrown, so
// the caller is told the apply was stale while the local rename actually landed.
test('a failed rename marks its rows uncertain without re-running the identity hook', async () => {
  const renames: string[] = [];
  const written: LocalEntity[] = [];
  const scenario = harness({
    repo: { putEntity: (_binding: string, entity: LocalEntity) => void written.push(entity) } as never,
    persistProviderIdentity: async (_oldProviderId, newProviderId) => void renames.push(newProviderId),
    applyCloud: async () => {
      throw new Error('backend unavailable');
    },
  });
  const rows = [candidate('provider-a', 'provider', 'work')];

  await expect(
    applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
      { objectId: 'provider-a', choice: 'local', newProviderId: 'work-2' },
    ]),
  ).rejects.toThrow('backend unavailable');

  expect(renames).toEqual(['work-2']);
  expect(written).toMatchObject([{ logicalKey: 'work-2', pendingReason: 'result-uncertain' }]);
});

// The reviewed fence is taken once and every row is a network round trip. Importing is not
// epoch-exact, so a peer publishing this object in that window gets its body overwritten by the
// reviewed one, and the row then records the reviewed revision as its baseline — drift the next
// reconciliation cannot see.
test('a cloud import stops when the head moved after the preview was reviewed', async () => {
  const scenario = harness({
    remoteEntities: async () => [{ ...remoteEntity('provider-a', 'provider', 'work'), version: 'v2' }],
  });
  const rows = [candidate('provider-a', 'provider', 'work')];

  await expect(
    applyPreview(scenario.input, record({ kind: 'join', providerId: 'work' }, rows), [
      { objectId: 'provider-a', choice: 'cloud' },
    ]),
  ).rejects.toThrow(SyncPreviewError);
  expect(scenario.appliedLocal).toBe(0);
});
