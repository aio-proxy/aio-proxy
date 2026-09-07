import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import { updateCheckPath } from '../paths';

export type UpdateCheckState = {
  readonly latest: string;
  readonly checkedAt: number;
  readonly notifiedVersion?: string;
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
