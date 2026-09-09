import type { Stats } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';

import { isPlainObject } from 'es-toolkit/predicate';

import { isNodeError, sameFileSnapshot } from './fs';

type AbandonedOwner = {
  readonly owner: string;
  readonly identity: Stats;
  readonly text: string;
};

const abandonedOwners = new Map<string, AbandonedOwner>();

function ownerFrom(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return undefined;
    const owner = (value as Record<string, unknown>)['owner'];
    return typeof owner === 'string' ? owner : undefined;
  } catch {
    return undefined;
  }
}

export function clearAbandonedOwner(path: string): void {
  abandonedOwners.delete(path);
}

export function rememberAbandonedOwner(path: string, abandoned: AbandonedOwner): void {
  abandonedOwners.set(path, abandoned);
}

export async function reclaimAbandonedOwner(path: string, assertFence: () => Promise<void>): Promise<boolean> {
  const abandoned = abandonedOwners.get(path);
  if (abandoned === undefined) return false;
  try {
    const [text, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    if (
      ownerFrom(text) !== abandoned.owner ||
      text !== abandoned.text ||
      metadata.dev !== abandoned.identity.dev ||
      metadata.ino !== abandoned.identity.ino
    ) {
      clearAbandonedOwner(path);
      return false;
    }
    await assertFence();
    const [currentText, currentMetadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    if (
      ownerFrom(currentText) !== abandoned.owner ||
      currentText !== abandoned.text ||
      !sameFileSnapshot(metadata, currentMetadata)
    ) {
      clearAbandonedOwner(path);
      return false;
    }
    await unlink(path);
    clearAbandonedOwner(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      clearAbandonedOwner(path);
      return true;
    }
    throw error;
  }
}
