import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import { updateCheckPath } from '../paths';

export type UpdateCheckState = {
  readonly latest: string;
  readonly checkedAt: number;
  readonly notifiedVersion?: string;
};

const isNewer = (left: string, right: string): boolean => {
  try {
    return Bun.semver.order(left, right) > 0;
  } catch {
    return false;
  }
};

export type UpdateCheckIncoming = {
  readonly latest: string;
  readonly checkedAt: number;
  readonly fetchStartedAt: number;
};

export const mergeUpdateCheckState = (incoming: UpdateCheckIncoming, existing?: UpdateCheckState): UpdateCheckState => {
  if (existing === undefined) return { latest: incoming.latest, checkedAt: incoming.checkedAt };
  // A slower overlapping fetch can finish after a newer check. Keep the on-disk
  // latest only when that record was written after this fetch started.
  // A later successful check (fetchStartedAt >= existing.checkedAt) is
  // authoritative, including an npm `latest` rollback.
  const staleOverlap = existing.checkedAt > incoming.fetchStartedAt && isNewer(existing.latest, incoming.latest);
  if (staleOverlap) return existing;
  return {
    latest: incoming.latest,
    checkedAt: incoming.checkedAt,
    ...(existing.notifiedVersion === undefined ? {} : { notifiedVersion: existing.notifiedVersion }),
  };
};

const isSemver = (value: string): boolean => {
  try {
    Bun.semver.order(value, '0.0.0');
    return true;
  } catch {
    return false;
  }
};

const parseState = (value: unknown): UpdateCheckState | undefined => {
  if (!isPlainObject(value)) return undefined;
  const latest = value['latest'];
  const checkedAt = value['checkedAt'];
  if (typeof latest !== 'string' || !isSemver(latest)) return undefined;
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return undefined;
  const notified = value['notifiedVersion'];
  if (notified !== undefined && (typeof notified !== 'string' || !isSemver(notified))) return undefined;
  return {
    latest,
    checkedAt,
    ...(notified === undefined ? {} : { notifiedVersion: notified }),
  };
};

export const readUpdateCheckState = (path: string = updateCheckPath()): UpdateCheckState | undefined => {
  try {
    return parseState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
};

export const writeUpdateCheckState = async (
  state: UpdateCheckState,
  path: string = updateCheckPath(),
): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`);
  renameSync(temp, path);
};
