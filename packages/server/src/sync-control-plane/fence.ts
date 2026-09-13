import { createHash } from 'node:crypto';

import type { CommittedSource, LocalBinding, LocalEntity, SyncRepository } from '@aio-proxy/core';

import {
  latestCommitId,
  snapshotLocalEntities,
  SyncPreviewError,
  type PreviewFence,
  type RemoteEntity,
} from './preview';

export type FenceReaderInput = {
  readonly repo: SyncRepository;
  readonly binding: () => LocalBinding | null;
  readonly localEntities: () => readonly LocalEntity[];
  readonly remoteEntities: () => Promise<readonly RemoteEntity[]>;
  readonly committedSource?: () => Promise<CommittedSource>;
  readonly rangeRevision: () => number;
};

/** The local state a preview was reviewed from, read in one synchronous block. */
export type LocalCapture = {
  readonly binding: LocalBinding | null;
  readonly entities: readonly LocalEntity[];
  readonly localCommitId: string;
  readonly rangeRevision: number;
};

// Only the row state a reviewed decision publishes. Epoch, baseline and pending reason are left out
// on purpose: ordinary reconciliation moves those, and reading that as a stale preview would make an
// Apply unlandable on a busy device.
const entitiesDigest = (entities: readonly LocalEntity[]): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...entities]
          .sort((left, right) => left.objectId.localeCompare(right.objectId))
          .map((entity) => [entity.objectId, entity.mode, entity.overrides]),
      ),
    )
    .digest('hex');

/**
 * The authored state a preview's rows were projected from. The configuration file alone is not it:
 * `projectCommitted()` reads the repository-backed plugin secret and installed version into the
 * `plugin-business` body, and updating plugin options rewrites that secret while leaving the file
 * byte-identical — before a binding exists that mutation also produces no outbox entry, so nothing
 * later republishes the newer secret. Accounts contribute presence only, because an OAuth Provider
 * with no credential projects no body at all: hashing the credential itself would let a background
 * token refresh expire a preview the user is still reading.
 */
export function sourceDigest(source: CommittedSource | undefined): string {
  if (source === undefined) return '';
  const sorted = (entries: Iterable<readonly [string, unknown]>): unknown[] =>
    [...entries].sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(
      JSON.stringify([
        source.raw,
        [...source.accounts.keys()].sort(),
        sorted(source.pluginSecrets),
        sorted(source.pluginVersions),
      ]),
    )
    .digest('hex');
}

/**
 * Builds the fence a preview is reviewed against and re-checked by, and captures the local half it
 * is built from. Both live together because they must observe the same instant: a capture paired
 * with a fence read later would pass `sameFence()` against state the review never saw.
 */
export function createFenceReader(input: FenceReaderInput): {
  readonly fence: (
    capture?: LocalCapture,
    remote?: readonly RemoteEntity[],
    /**
     * Whether the captured rows are part of the fence. Passed by connect only: an override Apply
     * landing between its preview and its Apply changes the body a `local` choice publishes without
     * moving any other half of the fence.
     */
    reviewedEntities?: boolean,
    /**
     * The digest of the source the caller has already read, from {@link sourceDigest}. Connect's
     * preview passes it so the fence names the exact configuration its rows were projected from:
     * sampling `committedSource()` a second time here would record an edit that landed in between,
     * and Apply would then observe that same newer digest and pass while its reviewed decisions
     * still carry the older bodies.
     */
    reviewedSourceDigest?: string,
  ) => Promise<PreviewFence>;
  readonly captureLocal: () => LocalCapture;
} {
  const authoredDigest = async (): Promise<string> =>
    sourceDigest(await input.committedSource?.().catch(() => undefined));

  return {
    async fence(capture, remote, reviewedEntities = false, reviewedSourceDigest) {
      const current = capture === undefined ? input.binding() : capture.binding;
      const snapshot = remote ?? (await input.remoteEntities());
      return {
        bindingId: current?.id ?? '',
        sessionGeneration: current?.sessionGeneration ?? 0,
        localCommitId: current === null ? '' : (capture?.localCommitId ?? latestCommitId(input.repo, current)),
        // The revision the local rows were read at, not the one live when the fence is built: a Leave
        // completing in between — the preview reads the committed source and the remote range over the
        // network first — would otherwise pair the pre-Leave included row with the post-Leave revision,
        // pass `sameFence()`, and let the reviewed join re-include the Provider Leave reported success
        // for. Applying uses the live value, so the fence rejects the preview instead.
        rangeRevision: capture?.rangeRevision ?? input.rangeRevision(),
        // Before the first binding there is no commit history for `localCommitId` to name, so a
        // configuration edit between preview and Apply would pass the fence: a `cloud` decision would
        // overwrite the newer Provider, and a `local` decision would publish the reviewed body and
        // record it as synchronized. The authored file is that history until a binding exists.
        ...(current === null ? { sourceDigest: reviewedSourceDigest ?? (await authoredDigest()) } : {}),
        ...(reviewedEntities && capture !== undefined ? { entitiesDigest: entitiesDigest(capture.entities) } : {}),
        remoteVersions: Object.fromEntries(snapshot.map((entity) => [entity.objectId, entity.version])),
      };
    },
    captureLocal() {
      const capturedBinding = input.binding();
      // Read with the rows, in one synchronous block, so nothing can land between the two.
      const capturedRangeRevision = input.rangeRevision();
      if (capturedBinding === null)
        return { binding: null, entities: [], localCommitId: '', rangeRevision: capturedRangeRevision };
      const before = latestCommitId(input.repo, capturedBinding);
      const entities = snapshotLocalEntities(input.localEntities());
      const afterBinding = input.binding();
      const after = afterBinding?.id === capturedBinding.id ? latestCommitId(input.repo, capturedBinding) : '';
      if (afterBinding?.id !== capturedBinding.id || before !== after) throw new SyncPreviewError('preview-stale');
      return { binding: capturedBinding, entities, localCommitId: after, rangeRevision: capturedRangeRevision };
    },
  };
}
