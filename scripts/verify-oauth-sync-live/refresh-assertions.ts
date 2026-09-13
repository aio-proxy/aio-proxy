// Shared-OAuth refresh assertions: the two-device rotation race and the
// interrupted-refresh recovery it enables. Split out of the live runner so the
// runner keeps only setup, evidence assembly and cleanup.

import {
  accountKey,
  applySyncedAccount,
  createPluginRepository,
  createSharedOAuthCoordinator,
  createSyncObjectStore,
  encode,
  type LiveAccount,
  type LocalBinding,
  type SharedOAuthCoordinator,
  type SharedRefreshResult,
  type SyncRepository,
} from '../../packages/core/src/index';
import type { OAuthAdapter, RuntimeFetch, SyncSession } from '../../packages/plugin-sdk/src';
import {
  AssertionError,
  BlockedError,
  classifyInterruptedRefresh,
  classifyRotationResults,
  type AssertionResult,
  type LiveFailureCode,
} from './assertion-results';
import { readRemote } from './ports';

type PluginRepository = ReturnType<typeof createPluginRepository>;

export type RefreshAssertionContext = {
  readonly providerId: string;
  readonly remoteObjectId: string;
  readonly adapter: OAuthAdapter;
  readonly remoteAccount: LiveAccount;
  readonly sessions: readonly SyncSession[];
  readonly locals: readonly LocalBinding[];
  readonly repositories: readonly SyncRepository[];
  readonly accountRepositories: readonly PluginRepository[];
  readonly signal: AbortSignal;
};

// The runner owns `evidence` and the first failure code, so verdicts are
// reported back rather than returned: a failed recovery has to record its
// verdict before aborting the run.
export type RefreshAssertionReport = {
  readonly rotation: (result: AssertionResult) => void;
  readonly uncertainRecovery: (result: AssertionResult) => void;
  readonly fail: (code: LiveFailureCode) => void;
};

export function confirmRecoveredOAuthOperation(
  input: Parameters<typeof applySyncedAccount>[0] & { readonly coordinator: Pick<SharedOAuthCoordinator, 'confirm'> },
): void {
  if (input.account.lastCompletedOperationId === null) throw new Error('recovered-operation-missing');
  applySyncedAccount(input);
  input.coordinator.confirm(input.account.objectId, input.account.lastCompletedOperationId);
}

function applyCredential(
  repository: PluginRepository,
  providerId: string,
  account: LiveAccount,
  credential: unknown,
): void {
  const current = repository.readAccount(providerId);
  if (current === null) throw new Error('copied-account-missing');
  const owner = crypto.randomUUID();
  const now = Date.now();
  if (!repository.tryAcquireRefreshLease(providerId, owner, now, now + 60_000)) throw new Error('local-refresh-lease');
  try {
    const updated = repository.compareAndSwapCredential(providerId, current.revision, owner, credential, {
      ...(account.payload.label === undefined ? {} : { label: account.payload.label }),
      ...(account.payload.expiresAt === undefined ? {} : { expiresAt: account.payload.expiresAt }),
    });
    if (updated === null) throw new Error('local-credential-apply');
  } finally {
    repository.releaseRefreshLease(providerId, owner);
  }
}

function coordinator(repo: SyncRepository, session: SyncSession, local: LocalBinding): SharedOAuthCoordinator {
  return createSharedOAuthCoordinator({
    binding: local,
    store: createSyncObjectStore(session),
    repo,
  });
}

type SharedRefreshInput = Parameters<SharedOAuthCoordinator['refresh']>[0];
type RefreshInput = (account: LiveAccount) => SharedRefreshInput;
type Exchange = SharedRefreshInput['exchange'];

// Both devices refresh the same expired shared credential concurrently: exactly
// one rotation must win, both must converge on it locally, and the remote object
// must end one generation ahead with no journal left behind.
async function assertRotation(
  context: RefreshAssertionContext,
  report: RefreshAssertionReport,
  refreshInput: RefreshInput,
  coordinators: readonly SharedOAuthCoordinator[],
): Promise<AssertionResult> {
  const initial = await readRemote(context.sessions[0]!, context.remoteObjectId, context.signal);
  if (initial === null) throw new BlockedError('setup-remote-object-missing');
  const expired = {
    ...initial.account,
    payload: { ...initial.account.payload, expiresAt: Date.now() - 1 },
  };
  if (
    (
      await context.sessions[0]!.compareAndSwap(
        accountKey(context.remoteObjectId),
        initial.version,
        encode(expired),
        context.signal,
      )
    ).kind !== 'written'
  )
    throw new BlockedError('setup-remote-object-missing');
  const results = await Promise.allSettled([
    coordinators[0]!.refresh(refreshInput(initial.account), context.signal),
    coordinators[1]!.refresh(refreshInput(initial.account), context.signal),
  ]);
  let rotation = classifyRotationResults(results);
  for (const [index, result] of results.entries()) {
    if (result.status !== 'fulfilled') continue;
    try {
      applyCredential(
        context.accountRepositories[index]!,
        context.providerId,
        result.value.account,
        result.value.value,
      );
      const operationId = result.value.account.lastCompletedOperationId;
      if (operationId !== null) coordinators[index]!.confirm(context.remoteObjectId, operationId);
    } catch {
      rotation = 'fail';
      report.fail('assertion-rotation-failed');
    }
  }
  if (rotation !== 'pass') return rotation;
  const refreshed = await readRemote(context.sessions[0]!, context.remoteObjectId, context.signal);
  const updated = results.find(
    (result): result is PromiseFulfilledResult<SharedRefreshResult<unknown>> =>
      result.status === 'fulfilled' && result.value.status === 'updated',
  );
  const journalsResolved = context.repositories.every(
    (repository, index) => repository.oauthJournals(context.locals[index]!.id).length === 0,
  );
  const localCredentialsApplied = context.accountRepositories.every(
    (repository) =>
      JSON.stringify(repository.readAccount(context.providerId)?.credential) ===
      JSON.stringify(refreshed?.account.payload.credential),
  );
  if (
    refreshed === null ||
    refreshed.account.phase !== 'ready' ||
    refreshed.account.generation <= initial.account.generation ||
    updated === undefined ||
    refreshed.account.generation !== updated.value.account.generation ||
    JSON.stringify(refreshed.account.payload.credential) !== JSON.stringify(updated.value.value) ||
    !journalsResolved ||
    !localCredentialsApplied
  ) {
    report.fail('assertion-rotation-failed');
    return 'fail';
  }
  return 'pass';
}

// A refresh whose upstream exchange succeeded but whose caller was aborted must
// leave an uncertain state that recover() resolves to exactly that credential,
// locally and remotely.
async function assertUncertainRecovery(
  context: RefreshAssertionContext,
  report: RefreshAssertionReport,
  refreshInput: RefreshInput,
  exchange: Exchange,
  coordinators: readonly SharedOAuthCoordinator[],
): Promise<void> {
  const current = await readRemote(context.sessions[0]!, context.remoteObjectId, context.signal);
  if (current === null) throw new BlockedError('setup-remote-object-missing');
  const caller = new AbortController();
  let exchangeCompleted = false;
  let interruptedCredential: unknown;
  const interruptedResults = await Promise.allSettled([
    coordinators[0]!.refresh(
      {
        ...refreshInput(current.account),
        exchange: async (value, signal) => {
          const result = await exchange(value, signal);
          interruptedCredential = result.value;
          exchangeCompleted = true;
          caller.abort();
          return result;
        },
      },
      caller.signal,
    ),
  ]);
  const interruptedResult = interruptedResults[0];
  const interruptedRemote = await readRemote(context.sessions[0]!, context.remoteObjectId, context.signal);
  const uncertainStateObserved =
    interruptedRemote?.account.phase === 'uncertain' ||
    interruptedRemote?.account.phase === 'refreshing' ||
    context.repositories[0]!.oauthJournals(context.locals[0]!.id).some((journal) => journal.phase !== 'complete');
  let recoveredAccount: LiveAccount | null = null;
  if (interruptedResult?.status === 'rejected' && uncertainStateObserved) {
    try {
      recoveredAccount = await coordinators[0]!.recover(context.remoteObjectId, context.signal);
      if (recoveredAccount?.phase === 'ready') {
        confirmRecoveredOAuthOperation({
          account: recoveredAccount,
          providerId: context.providerId,
          binding: context.locals[0]!,
          repo: context.repositories[0]!,
          accounts: context.accountRepositories[0]!,
          coordinator: coordinators[0]!,
        });
      }
    } catch {
      report.uncertainRecovery('fail');
      report.fail('assertion-recovery-failed');
      throw new AssertionError('assertion-recovery-failed');
    }
  }
  const reread = await readRemote(context.sessions[0]!, context.remoteObjectId, context.signal);
  const local = context.accountRepositories[0]!.readAccount(context.providerId);
  const ownership = context.repositories[0]!.entities(context.locals[0]!.id).find(
    (entity) => entity.objectId === context.remoteObjectId,
  )?.oauth;
  const journalResolved = context.repositories[0]!.oauthJournals(context.locals[0]!.id).length === 0;
  const recovered =
    recoveredAccount?.phase === 'ready' &&
    recoveredAccount.generation === current.account.generation + 1 &&
    JSON.stringify(recoveredAccount.payload.credential) === JSON.stringify(interruptedCredential) &&
    reread?.account.phase === 'ready' &&
    reread.account.generation === recoveredAccount.generation &&
    JSON.stringify(reread.account.payload.credential) === JSON.stringify(interruptedCredential) &&
    JSON.stringify(local?.credential) === JSON.stringify(interruptedCredential) &&
    ownership?.generation === recoveredAccount.generation &&
    journalResolved;
  const uncertainRecovery = classifyInterruptedRefresh({
    result: interruptedResult?.status ?? 'rejected',
    exchangeCompleted,
    uncertainStateObserved,
    recovered,
  });
  report.uncertainRecovery(uncertainRecovery);
  if (uncertainRecovery === 'fail') {
    report.fail('assertion-recovery-failed');
    throw new AssertionError('assertion-recovery-failed');
  }
}

// Rotation is the precondition for the recovery assertion: without a clean
// two-device rotation an uncertain state cannot be attributed to the interrupt.
export async function assertSharedRefresh(
  context: RefreshAssertionContext,
  report: RefreshAssertionReport,
): Promise<void> {
  const refreshCredential = context.adapter.refreshCredential;
  if (refreshCredential === undefined) return;
  const exchange: Exchange = (value, signal) =>
    refreshCredential({
      credential: value,
      options: context.remoteAccount.payload.options,
      signal,
      fetch: globalThis.fetch as RuntimeFetch,
    });
  const refreshInput: RefreshInput = (account) => ({
    objectId: context.remoteObjectId,
    epoch: account.epoch,
    generation: account.generation,
    exchange,
    validate: async (value: unknown) => context.adapter.credentials.parse(value),
  });
  const coordinators = context.locals.map((local, index) =>
    coordinator(context.repositories[index]!, context.sessions[index]!, local),
  );
  const rotation = await assertRotation(context, report, refreshInput, coordinators);
  report.rotation(rotation);
  if (rotation === 'fail') report.fail('assertion-rotation-failed');
  if (rotation !== 'pass') return;
  await assertUncertainRecovery(context, report, refreshInput, exchange, coordinators);
}
