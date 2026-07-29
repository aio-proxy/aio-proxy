import { AsyncLocalStorage } from 'node:async_hooks';

import { withContext } from '@logtape/logtape';

const requestIdStorage = new AsyncLocalStorage<string>();

// LogTape has no public API to read back an implicit context value, so we keep
// our own store for `currentRequestId()` while `withContext` enriches every log
// record emitted in scope with `requestId` (requires `contextLocalStorage` in
// `configureLogging`).
export function withRequestId<T>(requestId: string, operation: () => T): T {
  return requestIdStorage.run(requestId, () => withContext({ requestId }, operation));
}

export function currentRequestId(): string | undefined {
  return requestIdStorage.getStore();
}
