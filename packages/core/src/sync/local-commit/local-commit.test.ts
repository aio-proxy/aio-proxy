import { expect, test } from 'bun:test';

import { AtomicConfigFile } from '../../plugins/config-file';
import { withSyncCommitFixture } from '../test-support';
import { prepareLocalCommit, recoverLocalCommits } from './local-commit';

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
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    const first = f.repo.outbox(f.bindingId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ objectId: 'provider-work', kind: 'put', commitId: f.intent.commitId });
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.latestConfirmedCommit(f.bindingId)?.commitId).toBe(f.intent.commitId);
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
    const port = {
      ...f.port,
      async committedSource() {
        const source = await f.port.committedSource();
        return { ...source, sourceRevisions };
      },
    };
    prepareLocalCommit(f.repo, f.bindingId, intent);
    await recoverLocalCommits(f.repo, f.bindingId, port);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
    expect(f.repo.latestConfirmedCommit(f.bindingId)?.sourceRevisions).toEqual(sourceRevisions);
  });
});
