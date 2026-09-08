import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';

import { AtomicConfigFile, AtomicConfigLockReleaseError } from '../../plugins/config-file';
import { encodeCandidate } from '../../plugins/config-file/serialization';
import type { SyncRepository } from '../repository';
import { withSyncCommitFixture } from '../test-support';
import { confirmLocalCommit, prepareLocalCommit, recoverLocalCommits } from './local-commit';

test('a candidate rejected by verify never becomes an outgoing commit', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await expect(
      file.replace(() => f.intent.rawAfter as Record<string, unknown>, {
        verify: async () => {
          throw new Error('invalid runtime');
        },
      }),
    ).rejects.toThrow('invalid runtime');
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.outbox(f.bindingId)).toEqual([]);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
  });
});

test('a verified candidate becomes one stable outgoing operation', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    let failConfirm = true;
    const retryingRepo: SyncRepository = {
      ...f.repo,
      confirm(...args) {
        if (failConfirm) {
          failConfirm = false;
          throw new Error('outbox transaction interrupted');
        }
        f.repo.confirm(...args);
      },
    };
    await expect(recoverLocalCommits(retryingRepo, f.bindingId, f.port)).rejects.toThrow(
      'outbox transaction interrupted',
    );
    expect(retryingRepo.pendingCommits(f.bindingId)).toHaveLength(1);
    await recoverLocalCommits(retryingRepo, f.bindingId, f.port);
    const first = f.repo.outbox(f.bindingId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ objectId: 'provider-work', kind: 'put', commitId: f.intent.commitId });
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.latestConfirmedCommit(f.bindingId)?.commitId).toBe(f.intent.commitId);
    const operationId = first[0]?.operationId;
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.outbox(f.bindingId)[0]?.operationId).toBe(operationId);
  });
});

test('removing a previously published authored entity creates an explicit delete operation', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    f.repo.putEntity(f.bindingId, {
      objectId: 'provider-work',
      logicalKey: 'work',
      kind: 'provider',
      mode: 'included',
      epoch: 3,
      desired: {
        kind: 'provider',
        logicalKey: 'work',
        value: { kind: 'api', baseUrl: 'https://example.test' },
        dependencies: [],
      },
      baseline: 'published-operation',
      overrides: [],
      pendingReason: null,
    });
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    const before = (await file.read()) as Record<string, unknown>;
    const after = { providers: {} } as Record<string, unknown>;
    const digest = (value: Record<string, unknown>) =>
      createHash('sha256').update(encodeCandidate(value, f.configPath)).digest('hex');
    const deletion = {
      ...f.intent,
      commitId: 'authored-delete',
      beforeDigest: digest(before),
      afterDigest: digest(after),
      rawAfter: after,
    };
    prepareLocalCommit(f.repo, f.bindingId, deletion);
    await file.replace(() => after);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.outbox(f.bindingId)).toContainEqual({
      operationId: expect.any(String),
      objectId: 'provider-work',
      epoch: 3,
      kind: 'delete',
      body: null,
      commitId: 'authored-delete',
    });
  });
});

test('dependency filtered authored entities remain pending instead of becoming deletes', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    f.repo.putEntity(f.bindingId, {
      objectId: 'provider-work',
      logicalKey: 'work',
      kind: 'provider',
      mode: 'included',
      epoch: 3,
      desired: null,
      baseline: 'published-operation',
      overrides: [],
      pendingReason: null,
    });
    const before = (await file.read()) as Record<string, unknown>;
    const after = { providers: { work: { kind: 'oauth', plugin: '@missing' } } } as Record<string, unknown>;
    const digest = (value: Record<string, unknown>) =>
      createHash('sha256').update(encodeCandidate(value, f.configPath)).digest('hex');
    const pending = {
      ...f.intent,
      commitId: 'filtered-authored',
      beforeDigest: digest(before),
      afterDigest: digest(after),
      rawAfter: after,
    };
    prepareLocalCommit(f.repo, f.bindingId, pending);
    await file.replace(() => after);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.outbox(f.bindingId)).toEqual([]);
  });
});

test('account operations without source revisions are never hidden by a watcher no-op', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);

    const accountChange = {
      ...f.intent,
      commitId: 'account-change-without-revision',
      beforeDigest: f.intent.afterDigest,
      afterDigest: f.intent.afterDigest,
      accountOperationIds: ['account-operation'],
    };
    prepareLocalCommit(f.repo, f.bindingId, accountChange);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.outbox(f.bindingId)).toHaveLength(2);
    expect(f.repo.outbox(f.bindingId)[1]?.commitId).toBe(accountChange.commitId);
  });
});

test('a before-digest recovery discards the prepared intent', async () => {
  await withSyncCommitFixture(async (f) => {
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.outbox(f.bindingId)).toEqual([]);
  });
});

test('an unknown raw digest remains pending for a later recovery', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await file.replace(() => ({ providers: { other: { kind: 'api', baseUrl: 'https://other.test' } } }));
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toHaveLength(1);
    expect(f.repo.outbox(f.bindingId)).toEqual([]);
  });
});

test('an unsettled account operation remains pending until settlement', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    const intent = { ...f.intent, accountOperationIds: ['account-operation'] };
    prepareLocalCommit(f.repo, f.bindingId, intent);
    f.control.setAccountOperationsSettled(false);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toHaveLength(1);
    f.control.setAccountOperationsSettled(true);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.outbox(f.bindingId)).toHaveLength(1);
  });
});

test('public confirmation acquires the fence exactly once', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    await confirmLocalCommit(f.repo, f.bindingId, f.intent.commitId, f.port);
    expect(f.control.fenceCalls()).toBe(1);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
  });
});

test('a fence failure leaves recovery pending until the fence is available', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    f.control.setFence(async () => {
      throw new Error('fence unavailable');
    });
    await expect(recoverLocalCommits(f.repo, f.bindingId, f.port)).rejects.toThrow('fence unavailable');
    expect(f.repo.pendingCommits(f.bindingId)).toHaveLength(1);
    f.control.setFence(async (action) => action());
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
  });
});

test('a source-revision mismatch remains pending and recovers after the revision catches up', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    const intent = { ...f.intent, sourceRevisions: { account: 2 } };
    prepareLocalCommit(f.repo, f.bindingId, intent);
    f.control.setSourceRevisions({ account: 1 });
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toHaveLength(1);
    f.control.setSourceRevisions({ account: 2 });
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
  });
});

test('an afterCommit failure leaves a recoverable committed candidate', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await expect(
      file.replace(() => f.intent.rawAfter as Record<string, unknown>, {
        afterCommit: async () => {
          throw new Error('account finalization interrupted');
        },
      }),
    ).rejects.toThrow('account finalization interrupted');
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.outbox(f.bindingId)).toHaveLength(1);
  });
});

test('a remote-origin commit confirms its baseline without an outbox echo', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    const intent = {
      ...f.intent,
      origin: 'remote' as const,
      remoteOperations: [{ objectId: 'provider-work', operationId: 'remote-operation' }],
    };
    prepareLocalCommit(f.repo, f.bindingId, intent);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.outbox(f.bindingId)).toEqual([]);
    expect(f.repo.entities(f.bindingId)[0]?.baseline).toBe('remote-operation');
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
  });
});

test('an account-only commit with a settled source revision is confirmed', async () => {
  await withSyncCommitFixture(async (f) => {
    const sourceRevisions = { account: 2 };
    const intent = {
      ...f.intent,
      beforeDigest: f.intent.beforeDigest,
      afterDigest: f.intent.beforeDigest,
      rawAfter: { providers: {} },
      accountOperationIds: ['account-operation'],
      sourceRevisions,
    };
    f.control.setSourceRevisions(sourceRevisions);
    f.control.setAccountOperationsSettled(true);
    prepareLocalCommit(f.repo, f.bindingId, intent);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.latestConfirmedCommit(f.bindingId)?.sourceRevisions).toEqual(sourceRevisions);
  });
});

test('watcher reload with the same digest and revisions is a restart-safe no-op', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    const originalOutbox = f.repo.outbox(f.bindingId);

    const reload = { ...f.intent, commitId: 'watcher-reload' };
    prepareLocalCommit(f.repo, f.bindingId, reload);
    const reopened = f.control.reopen();
    await recoverLocalCommits(reopened, f.bindingId, f.port);
    expect(reopened.pendingCommits(f.bindingId)).toEqual([]);
    expect(reopened.outbox(f.bindingId)).toEqual(originalOutbox);
  });
});

test('a prepared commit survives close and reopen between file commit and recovery', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await file.replace(() => f.intent.rawAfter as Record<string, unknown>);
    const reopened = f.control.reopen();
    await recoverLocalCommits(reopened, f.bindingId, f.port);
    expect(reopened.pendingCommits(f.bindingId)).toEqual([]);
    expect(reopened.outbox(f.bindingId)).toHaveLength(1);
  });
});

test('lock-release uncertainty survives close and reopen before local recovery', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    const lockPath = `${f.configPath}.lock`;
    const realUnlink = fsPromises.unlink.bind(fsPromises);
    let failed = false;
    const unlink = spyOn(fsPromises, 'unlink').mockImplementation(async (target) => {
      if (target === lockPath && !failed) {
        failed = true;
        throw new Error('release failed');
      }
      return realUnlink(target);
    });
    try {
      prepareLocalCommit(f.repo, f.bindingId, f.intent);
      await expect(file.replace(() => f.intent.rawAfter as Record<string, unknown>)).rejects.toBeInstanceOf(
        AtomicConfigLockReleaseError,
      );
      const reopened = f.control.reopen();
      await recoverLocalCommits(reopened, f.bindingId, f.port);
      expect(reopened.pendingCommits(f.bindingId)).toEqual([]);
      expect(reopened.outbox(f.bindingId)).toHaveLength(1);
    } finally {
      unlink.mockRestore();
    }
  });
});
