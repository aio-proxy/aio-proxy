import { SyncBackendError } from '@aio-proxy/plugin-sdk';

import { SyncOAuthError, type LiveAccount } from '../protocol';
import { readCurrent, publishResult, fenceClaim, type CoordinatorContext } from './refresh';

function discardJournal(context: CoordinatorContext, operationId: string): void {
  try {
    const row = context.repo.oauthJournals(context.binding.id).find((item) => item.operationId === operationId);
    if (row === undefined) return;
    context.repo.writeOAuthJournal(context.binding.id, { ...row, phase: 'complete' });
    context.repo.clearOAuthJournal(context.binding.id, operationId);
  } catch {
    // A stale journal is harmless and can be retried on the next recovery pass.
  }
}

export async function recoverAccount(
  context: CoordinatorContext,
  objectId: string,
  signal: AbortSignal,
): Promise<LiveAccount | null> {
  const journals = context.repo.oauthJournals(context.binding.id).filter((journal) => journal.objectId === objectId);
  for (const pending of context.pendingResults.values()) {
    if (pending.journal.objectId !== objectId) continue;
    try {
      context.repo.writeOAuthJournal(context.binding.id, pending.journal);
      context.pendingResults.delete(pending.journal.operationId);
      journals.push(pending.journal);
    } catch {
      throw new SyncOAuthError('result-uncertain', 'The OAuth result is waiting for durable storage');
    }
  }
  const current = await readCurrent(context, objectId, signal).catch((error: unknown) => {
    if (error instanceof SyncOAuthError && error.code === 'login-required') return null;
    throw error;
  });
  if (current === null || current.account.phase === 'deleted') {
    for (const journal of journals) discardJournal(context, journal.operationId);
    return null;
  }
  for (const journal of journals) {
    if (journal.phase === 'started') {
      if (current.account.phase === 'refreshing' && current.account.claim?.operationId === journal.operationId) {
        // The exchange is gone — the process exited, or its terminal fence never landed — so
        // nothing will ever publish this result. Retry the fence here; leaving the claim in
        // `refreshing` locks every device out, including a fresh login.
        if (context.activeOperations.has(journal.operationId)) {
          throw new SyncOAuthError('result-uncertain', 'The OAuth refresh is still running');
        }
        await fenceClaim(context, { account: current.account, version: current.version }, 'uncertain', signal);
        discardJournal(context, journal.operationId);
        throw new SyncOAuthError('result-uncertain', 'The OAuth process stopped before recording a result');
      }
      continue;
    }
    try {
      const result = await publishResult(
        context,
        current.account as LiveAccount,
        current.version,
        journal,
        async (value) => value,
        signal,
      );
      return result.account;
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') throw error;
      if (error instanceof SyncOAuthError && ['refresh-deferred', 'unverified'].includes(error.code)) throw error;
      if (error instanceof SyncOAuthError && ['login-required', 'deleted'].includes(error.code)) {
        discardJournal(context, journal.operationId);
        return null;
      }
      throw error;
    }
  }
  return current.account as LiveAccount;
}
