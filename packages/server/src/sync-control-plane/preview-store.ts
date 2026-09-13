import type { PreviewRecord, RemoteEntity } from './preview';

/**
 * A candidate backend opened for previewing but not yet bound. Connecting has to read the
 * candidate's cloud state before the swap — otherwise the preview cannot show what connecting would
 * import, and applying it would start reconciling against objects the user never reviewed.
 */
export type SyncConnectCandidate = {
  readonly remote: readonly RemoteEntity[];
  /** Re-reads the candidate's cloud state through its own session, before it is bound. */
  readonly refresh: () => Promise<readonly RemoteEntity[]>;
  /** Swaps the binding onto the candidate backend, leaving its engine deferred. */
  readonly commit: () => Promise<void>;
  /**
   * Starts the committed backend's engine. Reconciliation imports remote objects under its default
   * inclusion behavior, so it must not run until the reviewed decisions have been applied.
   */
  readonly activate: () => void;
  /** Releases the candidate when its preview is replaced, expires, or fails to apply. */
  readonly dispose: () => Promise<void>;
};

/**
 * The previews awaiting a decision and the backend sessions they hold open. `expiresAt` is only read
 * when the user submits Apply, so closing the dialog or abandoning a CLI preview would otherwise
 * leave the record here until shutdown, pinning `preview-required` and suppressing background engine
 * outcomes long after the advertised TTL. A connect candidate additionally holds an open backend
 * session — for CloudKit, a native helper process — which the same expiry has to dispose.
 */
export function createPreviewStore(input: { readonly now: () => number; readonly onExpire: () => void }) {
  const previews = new Map<string, PreviewRecord>();
  const candidates = new Map<string, SyncConnectCandidate>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const takeCandidate = (previewId: string): SyncConnectCandidate | undefined => {
    const timer = timers.get(previewId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(previewId);
    const candidate = candidates.get(previewId);
    candidates.delete(previewId);
    return candidate;
  };

  return {
    get: (previewId: string): PreviewRecord | undefined => previews.get(previewId),
    size: (): number => previews.size,

    /** Retires a preview and the candidate it holds together: both Apply and expiry consume the pair. */
    take(previewId: string): { record: PreviewRecord | undefined; candidate: SyncConnectCandidate | undefined } {
      const record = previews.get(previewId);
      previews.delete(previewId);
      return { record, candidate: takeCandidate(previewId) };
    },

    retain(previewId: string, record: PreviewRecord, expiresAt: number, candidate?: SyncConnectCandidate): void {
      previews.set(previewId, record);
      if (candidate !== undefined) candidates.set(previewId, candidate);
      const timer = setTimeout(
        () => {
          previews.delete(previewId);
          void takeCandidate(previewId)
            ?.dispose()
            .catch(() => {});
          input.onExpire();
        },
        Math.max(0, expiresAt - input.now()),
      );
      timer.unref?.();
      timers.set(previewId, timer);
    },

    /** Releases candidates the user walked away from, each still holding an open backend session. */
    async disposePending(): Promise<void> {
      for (const previewId of [...candidates.keys()]) {
        previews.delete(previewId);
        await takeCandidate(previewId)
          ?.dispose()
          .catch(() => {});
      }
    },
  };
}
