import { SyncBackendError, type JsonValue } from '@aio-proxy/plugin-sdk';

import { accountKey, encode, SyncProtocolError } from '../../protocol';
import type { SyncObjectStore } from '../../publication';
import type { OAuthJournalRow, SyncRepository } from '../../repository';
import { decodeAccount, type AccountRecord, type LiveAccount, type RefreshClaim, SyncOAuthError } from '../protocol';
import type { ExchangeResult, SharedRefreshInput, SharedRefreshResult } from './coordinator';

export type CoordinatorContext = {
  readonly binding: { readonly id: string; readonly deviceId: string };
  readonly store: SyncObjectStore;
  readonly repo: SyncRepository;
  readonly pendingResults: Map<string, PendingResult>;
};

export type PendingResult = {
  readonly journal: OAuthJournalRow;
  readonly value: JsonValue;
};

export async function readCurrent(
  context: CoordinatorContext,
  objectId: string,
  signal: AbortSignal,
): Promise<{ account: AccountRecord; version: string }> {
  signal.throwIfAborted();
  const value = await context.store.session.read(accountKey(objectId), signal);
  if (value.kind === 'absent') throw new SyncOAuthError('login-required', 'No shared OAuth account exists');
  let account: AccountRecord;
  try {
    account = decodeAccount(value.value);
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      throw new SyncOAuthError(error.code === 'upgrade-required' ? 'upgrade-required' : 'unverified', error.message);
    }
    throw error;
  }
  if (account.objectId !== objectId) throw new SyncOAuthError('upgrade-required', 'OAuth account identity mismatch');
  return { account, version: value.version };
}

export async function claimReady(
  context: CoordinatorContext,
  current: LiveAccount,
  version: string,
  signal: AbortSignal,
): Promise<{ account: LiveAccount; version: string } | null> {
  const claim: RefreshClaim = {
    operationId: crypto.randomUUID(),
    ownerDeviceId: context.binding.deviceId,
    baseGeneration: current.generation,
  };
  const claimed: LiveAccount = { ...current, phase: 'refreshing', claim };
  const bytes = encode(claimed);
  try {
    const accepted = await context.store.session.compareAndSwap(accountKey(current.objectId), version, bytes, signal);
    if (accepted.kind === 'written') return { account: claimed, version: accepted.version };
    return null;
  } catch (error) {
    if (!(error instanceof SyncBackendError) || error.code !== 'outcome-unknown') throw error;
    const reread = await readCurrent(context, current.objectId, signal);
    if (
      reread.account.phase === 'refreshing' &&
      reread.account.claim?.operationId === claim.operationId &&
      reread.account.claim.baseGeneration === claim.baseGeneration
    ) {
      return { account: reread.account, version: reread.version };
    }
    throw new SyncOAuthError('refresh-deferred', 'The shared OAuth claim outcome is unknown');
  }
}

async function releaseUnstartedClaim(
  context: CoordinatorContext,
  claimed: { account: LiveAccount; version: string },
  signal: AbortSignal,
): Promise<void> {
  const ready: LiveAccount = { ...claimed.account, phase: 'ready', claim: null };
  try {
    await context.store.session.compareAndSwap(
      accountKey(claimed.account.objectId),
      claimed.version,
      encode(ready),
      signal,
    );
  } catch {
    // A failed release leaves the claim as a fence and recovery can inspect it.
  }
}

export function toJsonExchangeResult<C>(result: ExchangeResult<C>): JsonValue {
  const value: Record<string, JsonValue> = { value: result.value as JsonValue };
  if (result.metadata?.accountLabel !== undefined) value['metadata'] = { accountLabel: result.metadata.accountLabel };
  if (result.metadata?.expiresAt !== undefined) {
    const metadata = (value['metadata'] ?? {}) as Record<string, JsonValue>;
    metadata['expiresAt'] = result.metadata.expiresAt;
    value['metadata'] = metadata;
  }
  encode(value);
  return value;
}

function journalResult(journal: OAuthJournalRow): {
  value: JsonValue;
  metadata?: { accountLabel?: string; expiresAt?: number };
} {
  if (journal.phase !== 'result' && journal.phase !== 'complete') {
    throw new SyncOAuthError('result-uncertain', 'The OAuth result was not durably recorded');
  }
  if (journal.payload === null || typeof journal.payload !== 'object' || Array.isArray(journal.payload)) {
    throw new SyncOAuthError('upgrade-required', 'The OAuth journal result is invalid');
  }
  const payload = journal.payload as Record<string, JsonValue>;
  const metadata = payload['metadata'];
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw new SyncOAuthError('upgrade-required', 'The OAuth journal metadata is invalid');
  }
  if (metadata !== undefined) {
    const metadataRecord = metadata as Record<string, JsonValue>;
    if (
      (metadataRecord['accountLabel'] !== undefined && typeof metadataRecord['accountLabel'] !== 'string') ||
      (metadataRecord['expiresAt'] !== undefined &&
        (typeof metadataRecord['expiresAt'] !== 'number' || !Number.isFinite(metadataRecord['expiresAt'])))
    ) {
      throw new SyncOAuthError('upgrade-required', 'The OAuth journal metadata is invalid');
    }
  }
  return {
    value: payload['value']!,
    ...(metadata === undefined ? {} : { metadata: metadata as { accountLabel?: string; expiresAt?: number } }),
  };
}

function resolvedByRemote(account: LiveAccount, journal: OAuthJournalRow): boolean {
  return (
    account.lastCompletedOperationId === journal.operationId ||
    (account.phase === 'ready' && account.generation > journal.baseGeneration)
  );
}

export function confirmJournal(context: CoordinatorContext, objectId: string, operationId: string): void {
  const journal = context.repo.oauthJournals(context.binding.id).find((row) => row.operationId === operationId);
  if (journal === undefined) return;
  if (journal.objectId !== objectId) throw new SyncOAuthError('upgrade-required', 'OAuth journal identity mismatch');
  if (journal.phase === 'started') throw new SyncOAuthError('result-uncertain', 'OAuth result is not durable yet');
  context.repo.writeOAuthJournal(context.binding.id, { ...journal, phase: 'complete' });
  context.repo.clearOAuthJournal(context.binding.id, operationId);
}

export async function publishResult<C>(
  context: CoordinatorContext,
  current: LiveAccount,
  version: string,
  journal: OAuthJournalRow,
  validate: (value: unknown) => Promise<C>,
  signal: AbortSignal,
): Promise<{ account: LiveAccount; value: C; status: 'updated' | 'superseded' }> {
  if (current.objectId !== journal.objectId || current.epoch !== journal.epoch) {
    throw new SyncOAuthError('login-required', 'The shared OAuth account was replaced');
  }
  if (current.phase === 'login-required' && current.claim?.operationId === journal.operationId) {
    throw new SyncOAuthError('unverified', 'The journaled OAuth result is quarantined');
  }
  if (resolvedByRemote(current, journal)) {
    if (current.phase !== 'ready')
      throw new SyncOAuthError('result-uncertain', 'The shared OAuth result is unresolved');
    const value = await validate(current.payload.credential);
    return { account: current, value, status: 'superseded' };
  }
  if (
    current.generation > journal.baseGeneration ||
    current.phase === 'ready' ||
    current.claim?.operationId !== journal.operationId ||
    current.claim.baseGeneration !== journal.baseGeneration
  ) {
    if (current.phase === 'ready' && current.generation > journal.baseGeneration) {
      const value = await validate(current.payload.credential);
      return { account: current, value, status: 'superseded' };
    }
    throw new SyncOAuthError('refresh-deferred', 'Another device owns the shared OAuth refresh');
  }

  const result = journalResult(journal);
  let value: C;
  try {
    value = await validate(result.value);
  } catch {
    const quarantined: LiveAccount = { ...current, phase: 'login-required' };
    const written = await context.store.session.compareAndSwap(
      accountKey(current.objectId),
      version,
      encode(quarantined),
      signal,
    );
    if (written.kind === 'conflict')
      throw new SyncOAuthError('result-uncertain', 'OAuth validation raced with another update');
    throw new SyncOAuthError('unverified', 'The OAuth provider returned an invalid credential');
  }
  const nextPayload = {
    ...current.payload,
    credential: result.value,
    ...(result.metadata?.accountLabel === undefined ? {} : { label: result.metadata.accountLabel }),
    ...(result.metadata?.expiresAt === undefined ? {} : { expiresAt: result.metadata.expiresAt }),
  };
  const next: LiveAccount = {
    ...current,
    generation: journal.baseGeneration + 1,
    phase: 'ready',
    payload: nextPayload,
    claim: null,
    lastCompletedOperationId: journal.operationId,
  };
  try {
    const written = await context.store.session.compareAndSwap(
      accountKey(current.objectId),
      version,
      encode(next),
      signal,
    );
    if (written.kind === 'conflict') {
      const reread = await readCurrent(context, current.objectId, signal);
      if (resolvedByRemote(reread.account as LiveAccount, journal)) {
        const remote = reread.account as LiveAccount;
        const remoteValue = await validate(remote.payload.credential);
        return { account: remote, value: remoteValue, status: 'superseded' };
      }
      throw new SyncOAuthError('refresh-deferred', 'The shared OAuth result lost its account CAS');
    }
  } catch (error) {
    if (!(error instanceof SyncBackendError)) throw error;
    if (error.code !== 'outcome-unknown') {
      throw new SyncOAuthError('refresh-deferred', 'The shared OAuth result could not be published');
    }
    const reread = await readCurrent(context, current.objectId, signal);
    if (reread.account.phase === 'ready' && resolvedByRemote(reread.account, journal)) {
      const remoteValue = await validate(reread.account.payload.credential);
      return { account: reread.account, value: remoteValue, status: 'superseded' };
    }
    throw new SyncOAuthError('result-uncertain', 'The OAuth publication outcome is unknown');
  }
  return { account: next, value, status: 'updated' };
}

export async function refreshAccount<C>(
  context: CoordinatorContext,
  input: SharedRefreshInput<C>,
  signal: AbortSignal,
): Promise<SharedRefreshResult<C>> {
  const current = await readCurrent(context, input.objectId, signal);
  if (current.account.phase === 'deleted') throw new SyncOAuthError('deleted', 'The shared OAuth account was deleted');
  if (current.account.epoch !== input.epoch)
    throw new SyncOAuthError('login-required', 'The OAuth account epoch changed');
  if (current.account.generation !== input.generation) {
    if (current.account.generation > input.generation && current.account.phase === 'ready') {
      const value = await input.validate(current.account.payload.credential);
      return { status: 'superseded', account: current.account, value };
    }
    throw new SyncOAuthError('refresh-deferred', 'The shared OAuth account generation changed');
  }
  if (current.account.phase !== 'ready')
    throw new SyncOAuthError('refresh-deferred', 'A shared OAuth refresh is already active');
  const original = await input.validate(current.account.payload.credential);
  const claimed = await claimReady(context, current.account, current.version, signal);
  if (claimed === null) {
    return refreshAfterReread(context, input, signal);
  }
  await input.validate(claimed.account.payload.credential);
  const journal: OAuthJournalRow = {
    operationId: claimed.account.claim!.operationId,
    objectId: input.objectId,
    epoch: claimed.account.epoch,
    baseGeneration: claimed.account.generation,
    phase: 'started',
    payload: null,
  };
  try {
    context.repo.writeOAuthJournal(context.binding.id, journal);
  } catch {
    context.pendingResults.delete(journal.operationId);
    await releaseUnstartedClaim(context, claimed, signal);
    throw new SyncOAuthError('refresh-deferred', 'Could not durably record the OAuth refresh');
  }
  let result: { value: C; metadata?: { accountLabel?: string; expiresAt?: number } };
  try {
    result = await input.exchange(original, signal);
  } catch {
    try {
      const uncertain = { ...claimed.account, phase: 'uncertain' as const };
      await context.store.session.compareAndSwap(
        accountKey(input.objectId),
        claimed.version,
        encode(uncertain),
        signal,
      );
    } catch {
      // The refreshing claim remains a fence when its uncertain marker cannot be published.
    }
    throw new SyncOAuthError('result-uncertain', 'The OAuth exchange outcome is unknown');
  }
  let payload: JsonValue;
  try {
    payload = toJsonExchangeResult(result);
  } catch {
    throw new SyncOAuthError('unverified', 'The OAuth result is not serializable');
  }
  const resultJournal = { ...journal, phase: 'result' as const, payload };
  try {
    context.repo.writeOAuthJournal(context.binding.id, resultJournal);
    context.pendingResults.delete(journal.operationId);
  } catch {
    context.pendingResults.set(journal.operationId, { journal: resultJournal, value: payload });
    try {
      context.repo.writeOAuthJournal(context.binding.id, resultJournal);
      context.pendingResults.delete(journal.operationId);
    } catch {
      throw new SyncOAuthError('result-uncertain', 'The OAuth result could not be durably recorded');
    }
  }
  const published = await publishResult(
    context,
    claimed.account,
    claimed.version,
    resultJournal,
    input.validate,
    signal,
  );
  return { status: published.status, account: published.account, value: published.value };
}

export async function refreshAfterReread<C>(
  context: CoordinatorContext,
  input: SharedRefreshInput<C>,
  signal: AbortSignal,
): Promise<SharedRefreshResult<C>> {
  const reread = await readCurrent(context, input.objectId, signal);
  if (reread.account.phase === 'deleted') throw new SyncOAuthError('deleted', 'The shared OAuth account was deleted');
  if (reread.account.epoch !== input.epoch) {
    throw new SyncOAuthError('login-required', 'The OAuth account epoch changed');
  }
  if (reread.account.generation > input.generation && reread.account.phase === 'ready') {
    const value = await input.validate(reread.account.payload.credential);
    return { status: 'superseded', account: reread.account, value };
  }
  if (reread.account.phase === 'ready' && reread.account.generation === input.generation) {
    return refreshAccount(context, input, signal);
  }
  throw new SyncOAuthError('refresh-deferred', 'Another device owns the shared OAuth refresh');
}
