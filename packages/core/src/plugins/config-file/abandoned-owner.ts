import type { Stats } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { isNodeError, sameFileSnapshot } from "../../file-lock/fs";

type AbandonedLockOwner = {
  readonly owner: string;
  readonly identity: Stats;
  readonly text: string;
};

const abandonedLockOwners = new Map<string, AbandonedLockOwner>();

function ownerFrom(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = (value as Record<string, unknown>)["owner"];
    return typeof owner === "string" ? owner : undefined;
  } catch {
    return undefined;
  }
}

export function clearAbandonedLock(path: string): void {
  abandonedLockOwners.delete(path);
}

export function rememberAbandonedLock(path: string, abandoned: AbandonedLockOwner): void {
  abandonedLockOwners.set(path, abandoned);
}

export async function reclaimAbandonedLock(path: string, assertFence: () => Promise<void>): Promise<boolean> {
  const abandoned = abandonedLockOwners.get(path);
  if (abandoned === undefined) return false;
  try {
    const [text, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (
      ownerFrom(text) !== abandoned.owner ||
      text !== abandoned.text ||
      metadata.dev !== abandoned.identity.dev ||
      metadata.ino !== abandoned.identity.ino
    ) {
      clearAbandonedLock(path);
      return false;
    }
    await assertFence();
    const [currentText, currentMetadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (
      ownerFrom(currentText) !== abandoned.owner ||
      currentText !== abandoned.text ||
      !sameFileSnapshot(metadata, currentMetadata)
    ) {
      clearAbandonedLock(path);
      return false;
    }
    await unlink(path);
    clearAbandonedLock(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      clearAbandonedLock(path);
      return true;
    }
    throw error;
  }
}
