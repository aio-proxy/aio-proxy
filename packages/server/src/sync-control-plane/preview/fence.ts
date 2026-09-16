import { createHash, randomBytes } from 'node:crypto';

import type { LocalBinding, LocalEntity, SyncRepository } from '@aio-proxy/core';

export type PreviewFence = {
  readonly bindingId: string;
  readonly sessionGeneration: number;
  readonly localCommitId: string;
  readonly rangeRevision: number;
  readonly remoteVersions: Record<string, string | null>;
  /**
   * Digest of the authored configuration, carried only while no binding exists. A first connect has
   * no commit history for `localCommitId` to name, so this is the local half of its fence.
   */
  readonly sourceDigest?: string;
  /**
   * Digest of the row state a reviewed decision publishes, carried by connect, join and overrides.
   * An override applied between preview and Apply rewrites the body a `local` choice sends — and is
   * itself the thing a second overrides preview would replace wholesale — while moving neither the
   * commit ID nor the range revision, so nothing else in the fence would notice it.
   */
  readonly entitiesDigest?: string;
};

// Only the row state a reviewed decision publishes. Epoch, baseline and pending reason are left out
// on purpose: ordinary reconciliation moves those, and reading that as a stale preview would make an
// Apply unlandable on a busy device.
export const entitiesDigest = (entities: readonly LocalEntity[]): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...entities]
          .sort((left, right) => left.objectId.localeCompare(right.objectId))
          .map((entity) => [entity.objectId, entity.mode, entity.overrides]),
      ),
    )
    .digest('hex');

export function sameFence(a: PreviewFence, b: PreviewFence): boolean {
  return (
    a.bindingId === b.bindingId &&
    a.sessionGeneration === b.sessionGeneration &&
    a.localCommitId === b.localCommitId &&
    a.rangeRevision === b.rangeRevision &&
    (a.sourceDigest ?? '') === (b.sourceDigest ?? '') &&
    (a.entitiesDigest ?? '') === (b.entitiesDigest ?? '') &&
    JSON.stringify(Object.entries(a.remoteVersions).sort()) === JSON.stringify(Object.entries(b.remoteVersions).sort())
  );
}

// Hex, not base64url: the id is handed to the user to paste into `aio-proxy sync apply <previewId>`,
// and a base64url token beginning with `-` is parsed there as an unknown option, so roughly one
// preview in sixty-four could not be applied from the CLI at all.
export function createPreviewToken(bytes = 24, source: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(source(bytes)).toString('hex');
}

export function latestCommitId(repo: SyncRepository, binding: LocalBinding): string {
  const latest = (repo as Partial<SyncRepository>).latestConfirmedCommit;
  return latest === undefined ? '' : (latest(binding.id)?.commitId ?? '');
}
