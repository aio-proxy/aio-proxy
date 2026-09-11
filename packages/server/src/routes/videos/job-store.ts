import { VIDEO_ID_PATTERN } from '@aio-proxy/core';

export const VIDEO_JOB_CAPACITY = 1024;
export const VIDEO_JOB_TTL_MS = 24 * 60 * 60 * 1000;
export { VIDEO_ID_PATTERN };

export type VideoJobOwner = { readonly kind: string; readonly id?: string };

export type VideoJobRecord = {
  readonly videoId: string;
  readonly providerId: string;
  readonly accountId?: string;
  readonly runtimeRevision?: number;
  readonly model: string;
  readonly owner: VideoJobOwner;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export type VideoCapacitySlot = { readonly release: () => void };

export type VideoJobStore = {
  readonly insert: (record: VideoJobRecord) => boolean;
  readonly lookup: (videoId: string) => VideoJobRecord | undefined;
  readonly remove: (videoId: string, expected?: VideoJobRecord) => void;
  readonly reserveCapacity: () => VideoCapacitySlot | undefined;
  readonly size: () => number;
  readonly close: () => void;
};

export function isValidVideoId(videoId: string | undefined): videoId is string {
  return videoId !== undefined && VIDEO_ID_PATTERN.test(videoId);
}

export function sameVideoOwner(left: VideoJobOwner, right: VideoJobOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function expiresAtFromUpstream(expiresAt: unknown, createdAt: number): number {
  const fallback = createdAt + VIDEO_JOB_TTL_MS;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return fallback;
  return Math.min(expiresAt * 1000, fallback);
}

export function createVideoJobStore(
  options: { readonly now?: () => number; readonly capacity?: number } = {},
): VideoJobStore {
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? VIDEO_JOB_CAPACITY;
  const entries = new Map<string, VideoJobRecord>();
  let pending = 0;
  let closed = false;

  const live = (videoId: string): VideoJobRecord | undefined => {
    const record = entries.get(videoId);
    if (record === undefined) return undefined;
    if (record.expiresAt > now()) return record;
    entries.delete(videoId);
    return undefined;
  };

  const sweep = (): void => {
    const current = now();
    for (const [videoId, record] of entries) if (record.expiresAt <= current) entries.delete(videoId);
  };

  return {
    insert(record) {
      if (closed) return false;
      if (live(record.videoId) !== undefined) return false;
      entries.set(record.videoId, record);
      return true;
    },
    lookup(videoId) {
      return live(videoId);
    },
    remove(videoId, expected) {
      const record = entries.get(videoId);
      if (record === undefined) return;
      if (expected !== undefined && record !== expected) return;
      entries.delete(videoId);
    },
    reserveCapacity() {
      sweep();
      if (closed || entries.size + pending >= capacity) return undefined;
      pending += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          pending -= 1;
        },
      };
    },
    size() {
      sweep();
      return entries.size;
    },
    close() {
      if (closed) return;
      closed = true;
      entries.clear();
    },
  };
}
