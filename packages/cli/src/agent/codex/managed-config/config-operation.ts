import type { CodexLocation, CodexMarker } from '../contracts';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import {
  clearJournal,
  fingerprint,
  isLiveJournal,
  readJournal,
  releaseJournalOwner,
  startJournal,
  updateJournal,
} from './journal';
import { deleteMarker, writeMarker } from './marker';
import { ensureManagedRoot, readRegularFile, syncParent, writeTomlAtomically } from './storage';

const readText = async (location: CodexLocation) => readRegularFile(location.configPath);

const operations = new Map<string, Promise<void>>();

export const runExclusive = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const prior = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  operations.set(key, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (operations.get(key) === current) operations.delete(key);
  }
};

export const withInstallationLease = <T>(
  location: CodexLocation,
  lease: CodexLease | undefined,
  operation: (owned: CodexLease) => Promise<T>,
): Promise<T> => {
  if (lease !== undefined) return lease.withOwnership(async () => operation(lease));
  return withCodexInstallation(location, AbortSignal.timeout(15_000), operation);
};

export async function recoverPending(location: CodexLocation, assertOwned?: () => Promise<void>): Promise<void> {
  await ensureManagedRoot(location);
  const pending = await readJournal(location);
  if (pending === undefined) return;
  if (await isLiveJournal(pending)) throw new Error('A live Codex configuration operation is pending');
  const current = await readText(location);
  const currentFingerprint = current === undefined ? undefined : fingerprint(current.text);
  const beforeMatches =
    currentFingerprint === pending.beforeFingerprint && pending.originalExists === (current !== undefined);
  const afterMatches = currentFingerprint === pending.afterFingerprint;
  if (pending.stage === 'prepared' && beforeMatches) {
    await assertOwned?.();
    await clearJournal(location);
    return;
  }
  if (afterMatches) {
    await assertOwned?.();
    if (pending.operation === 'remove') await deleteMarker(location);
    else await writeMarker(location, pending.targetMarker);
    await assertOwned?.();
    await clearJournal(location);
    return;
  }
  if (pending.stage === 'config-written' && beforeMatches) {
    await assertOwned?.();
    await clearJournal(location);
    return;
  }
  throw new Error('Codex configuration operation has an unknown recovery state; manual review is required');
}

export async function completeOperation(
  location: CodexLocation,
  journal: Parameters<typeof startJournal>[1],
  original: Awaited<ReturnType<typeof readText>>,
  nextText: string,
  marker: CodexMarker | undefined,
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnershipFence(async (assertOwned) => {
    const ownedJournal = await startJournal(location, journal);
    try {
      await assertOwned();
      await writeTomlAtomically(location, original, nextText);
      await updateJournal(location, { ...ownedJournal, stage: 'config-written' });
      await assertOwned();
      if (marker === undefined) await deleteMarker(location);
      else await writeMarker(location, marker);
      await updateJournal(location, { ...ownedJournal, stage: 'marker-written' });
      await clearJournal(location);
      await syncParent(location.markerPath);
    } catch (error) {
      await releaseJournalOwner(location, ownedJournal).catch(() => undefined);
      throw error;
    }
  });
}
