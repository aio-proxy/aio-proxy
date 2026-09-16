// Failure vocabulary and the pure result classifiers shared by the live runner
// and its refresh assertions. Kept dependency-free so both can import it without
// a cycle.

export type LiveFailureCode =
  | 'setup-sync-binding-required'
  | 'setup-backend-required'
  | 'setup-backend-unavailable'
  | 'setup-source-account-invalid'
  | 'setup-remote-object-missing'
  | 'setup-remote-object-invalid'
  | 'assertion-copied-use-failed'
  | 'assertion-rotation-failed'
  | 'assertion-recovery-failed'
  | 'assertion-device-binding-failed'
  | 'assertion-login-effects-failed'
  | 'assertion-detach-failed';

export type AssertionResult = 'pass' | 'fail' | 'blocked';

export class BlockedError extends Error {
  constructor(readonly code: LiveFailureCode) {
    super(code);
  }
}

export class AssertionError extends Error {
  constructor(readonly code: LiveFailureCode) {
    super(code);
  }
}

export function matchesOAuthAdapter(
  account: Readonly<{ plugin: string; capability: string }>,
  plugin: string,
  capability: string,
): boolean {
  return account.plugin === plugin && account.capability === capability;
}

function isInfrastructureFailure(reason: unknown): boolean {
  return reason instanceof Error && (reason.name === 'SyncBackendError' || reason.name === 'AbortError');
}

export function classifyRotationResults(results: readonly PromiseSettledResult<unknown>[]): AssertionResult {
  if (results.length === 0) return 'blocked';
  if (results.every((result) => result.status === 'fulfilled')) return 'pass';
  if (results.some((result) => result.status === 'rejected' && isInfrastructureFailure(result.reason)))
    return 'blocked';
  return 'fail';
}

export type InterruptedRefreshObservation = {
  readonly result: 'fulfilled' | 'rejected';
  readonly exchangeCompleted: boolean;
  readonly uncertainStateObserved: boolean;
  readonly recovered: boolean;
};

export function classifyInterruptedRefresh(observation: InterruptedRefreshObservation): AssertionResult {
  if (!observation.exchangeCompleted) return 'blocked';
  if (observation.result === 'fulfilled') return 'fail';
  if (!observation.uncertainStateObserved) return 'fail';
  return observation.recovered ? 'pass' : 'fail';
}
