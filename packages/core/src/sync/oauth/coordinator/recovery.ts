import { SyncBackendError } from '@aio-proxy/plugin-sdk';

import type { OAuthJournalRow } from '../../repository';
import { SyncOAuthError, type LiveAccount } from '../protocol';
import { readCurrent, publishResult, fenceClaim, discardJournal, type CoordinatorContext } from './refresh';

/**
 * Whether the account has moved past anything this `started` journal could ever publish: a later
 * login replaced it at a newer epoch, a newer generation was published, or the operation already
 * completed. `publishResult` refuses all three, so the row is dead — and a dead row left in place
 * reads as a retained shared-OAuth hold that blocks detach and backend replacement forever.
 */
function supersededClaim(current: LiveAccount, journal: OAuthJournalRow): boolean {
  return (
    current.epoch !== journal.epoch ||
    current.generation > journal.baseGeneration ||
    current.lastCompletedOperationId === journal.operationId
  );
}

/**
 * Whether the account proves this `started` journal's claim never landed: publishing it moves the
 * phase off `ready`, and a fence only ever parks it in `uncertain` or `login-required`, so a `ready`
 * account still at the row's own baseline can only mean the claim CAS did not apply. The exchange
 * never ran, and a row left in place reads as a retained shared-OAuth hold that blocks detach and
 * backend replacement forever. A claim attempt still in flight in this process has proved nothing.
 */
function unclaimedRow(context: CoordinatorContext, current: LiveAccount, journal: OAuthJournalRow): boolean {
  return (
    current.phase === 'ready' &&
    current.epoch === journal.epoch &&
    current.generation === journal.baseGeneration &&
    !context.activeOperations.has(journal.operationId)
  );
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
      if (
        unclaimedRow(context, current.account as LiveAccount, journal) ||
        supersededClaim(current.account as LiveAccount, journal)
      ) {
        discardJournal(context, journal.operationId);
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
