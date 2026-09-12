import { createHash } from 'node:crypto';

import {
  confirmLocalCommit,
  encodeCandidate,
  prepareLocalCommit,
  type JsonValue,
  type LocalCommitPort,
  type PluginSecretCommit,
  type SyncRepository,
} from '@aio-proxy/core';

export type SyncCommitHooks = {
  readonly prepare: (
    before: Record<string, unknown>,
    candidate: Record<string, unknown>,
    accountOperationIds?: readonly string[],
    origin?: 'local' | 'remote',
    pluginSecrets?: readonly PluginSecretCommit[],
  ) => string;
  readonly confirm: (commitId: string) => Promise<void>;
  /** Confirm from a caller that already holds the local commit fence. */
  readonly confirmWithinFence: (commitId: string) => Promise<void>;
};

export function createSyncCommitHooks(input: {
  readonly path: string;
  readonly repo: SyncRepository;
  readonly bindingId: string;
  readonly port: LocalCommitPort;
}): SyncCommitHooks {
  const digest = (raw: Record<string, unknown>): string =>
    createHash('sha256')
      .update(encodeCandidate(raw as Record<string, JsonValue>, input.path))
      .digest('hex');
  return {
    prepare(before, candidate, accountOperationIds = [], origin = 'local', pluginSecrets) {
      const commitId = crypto.randomUUID();
      prepareLocalCommit(input.repo, input.bindingId, {
        commitId,
        origin,
        beforeDigest: digest(before),
        afterDigest: digest(candidate),
        rawAfter: candidate as Record<string, JsonValue>,
        accountOperationIds: [...accountOperationIds],
        // A secret lives outside the configuration file: without this the commit reads as a no-op
        // and no device ever learns the new credential.
        ...(pluginSecrets === undefined || pluginSecrets.length === 0 ? {} : { pluginSecrets: [...pluginSecrets] }),
      });
      return commitId;
    },
    confirm(commitId) {
      return confirmLocalCommit(input.repo, input.bindingId, commitId, input.port);
    },
    // The fence is the configuration mutation queue, which is not reentrant. A mutation that
    // confirms inside its own queue slot already has the exclusivity the fence provides, and
    // queueing again from there would wait on the slot the caller is holding.
    confirmWithinFence(commitId) {
      return confirmLocalCommit(input.repo, input.bindingId, commitId, {
        ...input.port,
        withFence: (run) => run(),
      });
    },
  };
}
